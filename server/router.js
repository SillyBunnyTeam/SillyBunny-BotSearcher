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
 */

import { PROTOCOL_VERSION, VERSION, FIELD_LIMITS } from '../shared/schema.js';
import { describeSources, getSource } from './registry.js';
import { wrap, jsonGuard, fail } from './guards.js';
import { clampInt, pick, own, readSourceId, isPlainObject } from './validate.js';
import { contextFor } from './http.js';
import { consume, acquire, callerKey } from './limits.js';

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
            sources: describeSources(() => 'unknown'),
        });
    }));

    router.post('/search', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        const gate = await gateRequest(request, response, adapter.id, 'search');
        if (!gate) {
            return;
        }

        const body = request.body;
        const filters = isPlainObject(own(body, 'filters')) ? own(body, 'filters') : {};
        const rawQuery = own(body, 'query');

        const args = {
            // Cap before the adapter sees it, so no adapter can be tricked into
            // building a giant upstream URL.
            query: typeof rawQuery === 'string' ? rawQuery.slice(0, 128).trim() : '',
            limit: clampInt(own(body, 'limit'), 1, FIELD_LIMITS.itemsPerPage, 24),
            offset: clampInt(own(body, 'offset'), 0, 5000, 0),
            sort: pick(own(body, 'sort'), adapter.capabilities.sorts, adapter.capabilities.sorts[0]),
            // Only honour a filter the source can actually apply, so the UI is
            // never able to imply filtering that is not happening.
            sfwOnly: adapter.capabilities.sfwToggle ? own(filters, 'sfwOnly') === true : false,
            hideAi: own(filters, 'hideAi') === true,
        };

        try {
            const result = await adapter.search(contextFor(adapter), args);
            response.json({
                total: typeof result.total === 'number' ? result.total : null,
                hasMore: result.hasMore === true,
                items: Array.isArray(result.items) ? result.items : [],
            });
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

        const gate = await gateRequest(request, response, adapter.id, 'search');
        if (!gate) {
            return;
        }

        try {
            response.json(await adapter.getDetail(contextFor(adapter), id));
        } finally {
            gate.release();
        }
    }));
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
 * Applies the per-user limit, the per-source limit and the in-flight cap.
 * @returns {Promise<{ release: () => void } | null>}
 */
async function gateRequest(request, response, sourceId, limiterName) {
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

    const release = acquire('source', sourceId);
    if (!release) {
        fail(response, 503, 'source_busy');
        return null;
    }

    return { release };
}
