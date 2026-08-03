/**
 * Route table for /api/plugins/sillybunny-botsearcher.
 *
 * Everything here is already behind whatever auth SillyBunny is configured for
 * (requireLoginMiddleware, src/server-main.js:427) and behind csrfSyncProtection
 * (:362), because plugin routers mount after both (:496). GET routes skip CSRF
 * by csrf-sync's default ignoredMethods, which is why the availability probe is
 * a GET and everything else is a POST.
 *
 * The contract is deliberately narrow: the client names a SOURCE, never a URL.
 * There is no route on this router that will fetch a URL supplied by the caller.
 * /ingest does not weaken that: it accepts a PAYLOAD the browser already fetched
 * from a URL this server built, so there is still no path from client input to an
 * outbound request.
 */

import {
    PROTOCOL_VERSION,
    VERSION,
    FIELD_LIMITS,
    THUMB_SIZES,
    MAX_INGEST_BYTES,
    INGEST_KINDS,
} from '../shared/schema.js';
import { describeSources, getSource } from './registry.js';
import { wrap, jsonGuard, jsonGuardWithLimit, fail } from './guards.js';
import { clampInt, pick, own, readSourceId, isPlainObject, hasForbiddenKey, readFilters } from './validate.js';
import { contextFor, fetchBytes } from './http.js';
import { consume, acquire, callerKey } from './limits.js';
import { mintCursor, verifyCursor, verifyRef } from './refs.js';
import { BadCursorError } from './paging.js';
import { detectImageType } from './imagetype.js';
import {
    markSuccess,
    markFailure,
    isDown,
    stateOf,
    reset,
    reasonOf,
    classify,
    REROUTABLE_FAILURES,
} from './health.js';
import { validateCardBytes, CardBytesError } from './cardbytes.js';

/** A character card is text plus one image; well past anything legitimate. */
const MAX_CARD_BYTES = 8 * 1024 * 1024;

/**
 * Default thumbnail cap. A 320px preview is 20-60 KB, so anything near this is
 * not a thumbnail. Adapters whose source has no preview endpoint raise it via
 * `maxThumbBytes` — Pygmalion serves full-resolution avatars of 40 KB to 4.3 MB
 * and its CDN ignores every resize parameter, so at 512 KB three quarters of
 * its grid failed to load.
 */
const DEFAULT_MAX_THUMB_BYTES = 512 * 1024;

/** Ceiling no adapter may exceed, so one source cannot dominate a small box. */
const HARD_MAX_THUMB_BYTES = 6 * 1024 * 1024;

/**
 * @param {import('express').Router} router
 * @param {{ startedAt: number }} state
 */
export function createRouter(router, state) {
    router.get('/healthz', wrap(async (_request, response) => {
        response.json({
            ok: true,
            protocol: PROTOCOL_VERSION,
            version: VERSION,
            uptimeMs: Date.now() - state.startedAt,
            sources: describeSources(stateOf, reasonOf),
        });
    }));

    // Clears one source's cooldown so the next request retries immediately.
    router.post('/retry', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        reset(resolved.adapter.id);
        response.json({ ok: true, state: stateOf(resolved.adapter.id) });
    }));

    /**
     * Thumbnail proxy.
     *
     * A GET because it is an <img> src, which cannot carry a CSRF header —
     * and csrf-sync skips GET anyway. It takes a signed ref, never a URL: see
     * refs.js for why that distinction is the whole design.
     */
    router.get('/thumb', wrap(async (request, response) => {
        const sourceId = own(request.query, 'source');
        const adapter = typeof sourceId === 'string' ? getSource(sourceId) : null;
        if (!adapter || typeof adapter.thumbUrlFromRef !== 'function') {
            fail(response, 404, 'unknown_source');
            return;
        }

        // Verified before parsing: a ref we did not mint is never JSON.parse'd.
        const payload = verifyRef(adapter.id, own(request.query, 'ref'));
        if (!payload) {
            fail(response, 400, 'bad_ref');
            return;
        }

        const size = pick(own(request.query, 'size'), THUMB_SIZES, 'grid');
        const caller = callerKey(request);

        const limited = await consume('thumb', caller);
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited');
            return;
        }

        // One grid render fires a whole page of these at once.
        const release = await acquire('thumb', caller);
        if (!release) {
            fail(response, 503, 'busy');
            return;
        }

        try {
            let url;
            try {
                url = adapter.thumbUrlFromRef(payload, size);
            } catch {
                fail(response, 400, 'bad_ref');
                return;
            }

            const maxBytes = Math.min(
                clampInt(adapter.maxThumbBytes, 1024, HARD_MAX_THUMB_BYTES, DEFAULT_MAX_THUMB_BYTES),
                HARD_MAX_THUMB_BYTES,
            );

            const result = await fetchBytes(adapter, url, {
                accept: 'image/webp,image/png,image/jpeg,image/avif,image/gif;q=0.8,*/*;q=0.5',
                maxBytes,
                timeoutMs: 15000,
            });

            // Magic bytes decide, not the upstream header. SVG is not in the
            // whitelist, so an SVG labelled image/png is refused here.
            const contentType = detectImageType(result.buffer);
            if (!contentType) {
                fail(response, 415, 'not_an_image');
                return;
            }

            response.set({
                'Content-Type': contentType,
                'Content-Length': String(result.buffer.length),
                'X-Content-Type-Options': 'nosniff',
                // Per-response CSP works even though the app sets none globally.
                'Content-Security-Policy': "default-src 'none'; sandbox",
                'Cross-Origin-Resource-Policy': 'same-origin',
                // The browser cache absorbs repeats, which is where the savings are.
                'Cache-Control': 'private, max-age=86400, immutable',
            });
            response.send(result.buffer);
        } finally {
            release();
        }
    }));

    router.post('/search', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        let args;
        try {
            args = buildSearchArgs(adapter, request.body);
        } catch (error) {
            if (error instanceof BadCursorError) {
                fail(response, 400, 'bad_cursor');
                return;
            }
            throw error;
        }

        // The server cannot reach this source, but the browser can. Hand back the
        // URL to fetch instead of an error. No egress happens on this path, so it
        // deliberately runs before the gate: a source in cooldown is exactly when
        // this is needed.
        if (directPlanWanted(adapter, request.body)) {
            respondWithDirectPlan(response, adapter, 'search', args);
            return;
        }

        const gate = await gateRequest(request, response, adapter.id, 'search');
        if (!gate) {
            return;
        }

        try {
            let result;
            try {
                result = await callAdapter(adapter, () => adapter.search(contextFor(adapter), args));
            } catch (error) {
                if (error instanceof BadCursorError || error?.code === 'bad_cursor') {
                    fail(response, 400, 'bad_cursor');
                    return;
                }
                if (canReroute(adapter, error)) {
                    respondWithDirectPlan(response, adapter, 'search', args);
                    return;
                }
                throw error;
            }

            response.json(shapeSearchResponse(adapter, result, args.limit));
        } finally {
            gate.release();
        }
    }));

    /**
     * Normalizes a payload the BROWSER fetched, for a source this server cannot
     * reach. The client sends bytes, never a URL, so this adds no way to make the
     * server request anything — and the payload runs through the same
     * hasForbiddenKey scan and the same adapter parser as the server-side path,
     * so the field whitelist in normalize.js still governs everything that
     * reaches the DOM.
     */
    router.post('/ingest', jsonGuardWithLimit(MAX_INGEST_BYTES), wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        if (adapter.corsDirect !== true) {
            fail(response, 400, 'direct_unsupported');
            return;
        }

        const kind = pick(own(request.body, 'kind'), INGEST_KINDS, '');
        if (kind === '') {
            fail(response, 400, 'bad_ingest_kind');
            return;
        }

        const payload = own(request.body, 'payload');
        if (payload === undefined || payload === null) {
            fail(response, 400, 'bad_payload');
            return;
        }
        if (hasForbiddenKey(payload)) {
            fail(response, 422, 'unsafe_json');
            return;
        }

        // Ingesting costs no egress, but it still costs CPU on a small box, so it
        // shares the per-user search budget.
        const caller = callerKey(request);
        const limited = await consume('search', caller);
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }

        if (kind === 'detail') {
            if (typeof adapter.parseDetail !== 'function') {
                fail(response, 400, 'direct_unsupported');
                return;
            }
            const id = readId(adapter, request.body);
            if (id === null) {
                fail(response, 400, 'bad_id');
                return;
            }
            response.json(adapter.parseDetail(payload, id));
            return;
        }

        if (typeof adapter.parseSearch !== 'function') {
            fail(response, 400, 'direct_unsupported');
            return;
        }

        let args;
        try {
            args = buildSearchArgs(adapter, request.body);
        } catch (error) {
            if (error instanceof BadCursorError) {
                fail(response, 400, 'bad_cursor');
                return;
            }
            throw error;
        }

        response.json(shapeSearchResponse(adapter, adapter.parseSearch(payload, args), args.limit));
    }));

    /**
     * Downloads and validates card bytes for a source SillyBunny cannot import
     * by URL itself. This is the only route that hands the browser something it
     * will feed into the character importer, so everything here is deliberate:
     * the URL comes from the adapter's own base, the bytes are structurally
     * validated before they are sent, and nothing is re-encoded (re-encoding a
     * PNG would strip the embedded card, which IS the character).
     */
    router.post('/card', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        // Native sources must go through SillyBunny's own importer, which is
        // already hardened. Offering a second path would only add surface.
        if (adapter.nativeImport === true) {
            fail(response, 400, 'use_native_import');
            return;
        }

        const id = readId(adapter, request.body);
        if (id === null) {
            fail(response, 400, 'bad_id');
            return;
        }

        const gate = await gateRequest(request, response, adapter.id, 'card');
        if (!gate) {
            return;
        }

        try {
            const ctx = contextFor(adapter);
            const target = adapter.getImportTarget(ctx, id);

            /** @type {Buffer} */
            let buffer;

            if (target?.kind === 'bytes' && typeof target.url === 'string') {
                const result = await callAdapter(adapter, () => fetchBytes(adapter, target.url, {
                    accept: 'image/png,application/json;q=0.9,*/*;q=0.5',
                    maxBytes: MAX_CARD_BYTES,
                    timeoutMs: 20000,
                }));
                buffer = result.buffer;
            } else if (target?.kind === 'inline' && typeof adapter.buildCard === 'function') {
                // Some sources publish full card data but no downloadable file.
                // The adapter assembles a card from it; the result then goes
                // through exactly the same validation as a downloaded one, so
                // this path is not a way to bypass any of the checks.
                const card = await callAdapter(adapter, () => adapter.buildCard(ctx, id));
                buffer = Buffer.from(JSON.stringify(card), 'utf8');
                if (buffer.length > MAX_CARD_BYTES) {
                    fail(response, 422, 'too_large');
                    return;
                }
            } else {
                fail(response, 500, 'bad_import_target');
                return;
            }

            let verdict;
            try {
                verdict = validateCardBytes(buffer, target.expect === 'json' ? 'json' : 'png');
            } catch (error) {
                if (error instanceof CardBytesError) {
                    console.warn(`[BotSearcher] ${adapter.id} card rejected: ${error.code} (${error.detail ?? ''})`);
                    fail(response, 422, error.code);
                    return;
                }
                throw error;
            }

            response.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(buffer.length),
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
                'Content-Disposition': `attachment; filename="${cardFileName(adapter.id, id, verdict.kind)}"`,
                // Tells the client which extension to declare on import, and
                // what the card actually contains — from the bytes, not from
                // whatever the listing claimed.
                'X-SBBS-Card-Kind': verdict.kind,
                'X-SBBS-Card-Inside': encodeURIComponent(JSON.stringify(verdict.inside)),
            });
            response.send(buffer);
        } finally {
            gate.release();
        }
    }));

    router.post('/detail', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        if (!adapter.capabilities.detail || typeof adapter.getDetail !== 'function') {
            fail(response, 400, 'detail_unsupported');
            return;
        }

        const id = readId(adapter, request.body);
        if (id === null) {
            fail(response, 400, 'bad_id');
            return;
        }

        if (directPlanWanted(adapter, request.body) && typeof adapter.buildDetailUrl === 'function') {
            respondWithDirectPlan(response, adapter, 'detail', null, id);
            return;
        }

        const gate = await gateRequest(request, response, adapter.id, 'search');
        if (!gate) {
            return;
        }

        try {
            let detail;
            try {
                detail = await callAdapter(adapter, () => adapter.getDetail(contextFor(adapter), id));
            } catch (error) {
                if (canReroute(adapter, error) && typeof adapter.buildDetailUrl === 'function') {
                    respondWithDirectPlan(response, adapter, 'detail', null, id);
                    return;
                }
                throw error;
            }
            response.json(detail);
        } finally {
            gate.release();
        }
    }));
}

/**
 * Builds the adapter argument set from a request body. Shared by /search and
 * /ingest so the direct path cannot end up with different arguments than the
 * server path would have used — the cursor, limit and filters are re-derived
 * from the body both times rather than echoed back by the client.
 *
 * @throws {BadCursorError} when the cursor is not one this server minted
 */
function buildSearchArgs(adapter, body) {
    const filters = isPlainObject(own(body, 'filters')) ? own(body, 'filters') : {};
    const rawQuery = own(body, 'query');
    const rawCursor = own(body, 'cursor');
    let cursor = null;

    if (rawCursor !== undefined && rawCursor !== null) {
        cursor = verifyCursor(adapter.id, rawCursor);
        if (cursor === null) {
            throw new BadCursorError();
        }
    }

    return {
        // Cap before the adapter sees it, so no adapter can be tricked into
        // building a giant upstream URL.
        query: typeof rawQuery === 'string' ? rawQuery.slice(0, 128).trim() : '',
        limit: clampInt(own(body, 'limit'), 1, FIELD_LIMITS.itemsPerPage, 24),
        cursor,
        sort: pick(own(body, 'sort'), adapter.capabilities.sorts, adapter.capabilities.sorts[0]),
        // Only honour a filter the source can actually apply, so the UI is
        // never able to imply filtering that is not happening.
        sfwOnly: adapter.capabilities.sfwToggle ? own(filters, 'sfwOnly') === true : false,
        hideAi: adapter.capabilities.hideAiToggle ? own(filters, 'hideAi') === true : false,
        filters: readFilters(filters, adapter.capabilities.filters),
    };
}

/** Shapes an adapter search result into the wire response. */
function shapeSearchResponse(adapter, result, limit) {
    return {
        total: typeof result?.total === 'number' && Number.isFinite(result.total)
            ? Math.max(0, Math.floor(result.total))
            : null,
        nextCursor: result?.next && typeof result.next === 'object'
            ? mintCursor(adapter.id, result.next)
            : null,
        items: Array.isArray(result?.items) ? result.items.slice(0, limit) : [],
    };
}

/**
 * Whether to hand this request to the browser instead of fetching it here.
 *
 * True when the source supports it AND either the breaker already knows this
 * server is blocked, or the user has chosen to always route this source through
 * their browser. Not a fallback the client can demand for an arbitrary source:
 * `corsDirect` is declared in the adapter, in this repo.
 */
function directPlanWanted(adapter, body) {
    if (adapter.corsDirect !== true || typeof adapter.buildSearchUrl !== 'function') {
        return false;
    }
    if (own(body, 'route') === 'direct') {
        return true;
    }
    return isDown(adapter.id) && REROUTABLE_FAILURES.has(reasonOf(adapter.id));
}

/** Whether a failure that just happened is worth retrying from the browser. */
function canReroute(adapter, error) {
    return adapter.corsDirect === true
        && typeof adapter.buildSearchUrl === 'function'
        && REROUTABLE_FAILURES.has(classify(error));
}

/**
 * Tells the client to fetch this URL itself and post the result back to /ingest.
 *
 * The URL is built here, from the adapter's own fixed base — the client never
 * constructs one. It re-checks the host against the source's published
 * clientHosts before fetching anyway, the same double-check images already get.
 */
function respondWithDirectPlan(response, adapter, kind, args, id) {
    const url = kind === 'detail'
        ? adapter.buildDetailUrl(id)
        : adapter.buildSearchUrl(args);

    response.json({
        mode: 'direct',
        kind,
        url: String(url),
        reason: reasonOf(adapter.id) ?? 'forbidden',
    });
}

/**
 * Resolves and validates the `source` field, answering the client on failure.
 * @returns {{ adapter: any } | null}
 */
function resolveSource(request, response) {
    const parsed = readSourceId(request.body);
    if (!parsed.ok) {
        fail(response, 400, parsed.code);
        return null;
    }

    const adapter = getSource(parsed.source);
    if (!adapter) {
        fail(response, 404, 'unknown_source');
        return null;
    }

    return { adapter };
}

/**
 * Validates a card id against the adapter's own anchored pattern BEFORE it is
 * interpolated into any URL.
 * @returns {string | null}
 */
function readId(adapter, body) {
    const id = own(body, 'id');
    if (typeof id !== 'string' || id === '' || id.length > FIELD_LIMITS.id) {
        return null;
    }
    return adapter.idPattern.test(id) ? id : null;
}

/**
 * A filename the client can hand to the importer. Built from values we control
 * — never from anything upstream sent — so no sanitizer is needed.
 */
function cardFileName(sourceId, id, kind) {
    const slug = String(id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'card';
    return `${sourceId}-${slug}.${kind === 'json' ? 'json' : 'png'}`;
}

/**
 * Runs an adapter call and records the outcome with the circuit breaker, so a
 * source that has gone away stops being retried on every keystroke.
 */
async function callAdapter(adapter, fn) {
    try {
        const result = await fn();
        markSuccess(adapter.id);
        return result;
    } catch (error) {
        if (error instanceof BadCursorError || error?.code === 'bad_cursor') {
            throw error;
        }
        markFailure(adapter.id, error);
        throw error;
    }
}

/**
 * Applies the breaker, the per-user limit, the per-source limit and the
 * in-flight cap.
 * @returns {Promise<{ release: () => void } | null>}
 */
async function gateRequest(request, response, sourceId, limiterName) {
    // While a source is in cooldown, answer immediately and make no outbound
    // request at all.
    if (isDown(sourceId)) {
        fail(response, 503, 'source_down');
        return null;
    }

    const caller = callerKey(request);

    const perUser = await consume(limiterName, caller);
    if (!perUser.allowed) {
        response.set('Retry-After', String(perUser.retryAfterSeconds));
        fail(response, 429, 'rate_limited', { retryAfter: perUser.retryAfterSeconds });
        return null;
    }

    const perSource = await consume('sourceGlobal', sourceId);
    if (!perSource.allowed) {
        response.set('Retry-After', String(perSource.retryAfterSeconds));
        fail(response, 429, 'source_busy', { retryAfter: perSource.retryAfterSeconds });
        return null;
    }

    const release = await acquire('source', sourceId);
    if (!release) {
        fail(response, 503, 'source_busy');
        return null;
    }

    return { release };
}
