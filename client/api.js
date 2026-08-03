/**
 * API calls made by the frontend go to the same-origin server plugin. This
 * project uses no public CORS relay.
 *
 * There are two deliberate exceptions, both of which contact an
 * adapter-approved host and nothing else:
 *   - direct thumbnail mode, where image elements load from the source's image host
 *   - direct request mode, where the server has told us it cannot reach a source
 *     itself and handed back the URL for the browser to fetch instead. The
 *     response is posted straight back to /ingest, so the server still does all
 *     the parsing and normalizing; only the hop that fetches has moved.
 *
 * SillyBunny has no plugin-discovery endpoint (loadedPlugins is module-private in
 * src/plugin-loader.js), so server-plugin availability is checked by
 * probing our own /healthz. That probe is a GET because csrf-sync skips
 * GET/HEAD/OPTIONS; state-changing calls send the token via getRequestHeaders().
 */

import {
    EXTENSION_NAME,
    PROTOCOL_VERSION,
    VERSION,
    MAX_INGEST_BYTES,
} from '../shared/schema.js';
import {
    PLUGIN_BASE,
    SERVER_PLUGIN_ADMIN_BASE,
    SERVER_VERSION_PATH,
    LOG_TAG,
} from './constants.js';
import { isAllowedUpstreamUrl } from './render.js';

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 5_000;
const DIRECT_TIMEOUT_MS = 15_000;
const ADMIN_TIMEOUT_MS = 8_000;
const APPLY_TIMEOUT_MS = 25 * 60_000;
const RESTART_TIMEOUT_MS = 180_000;
const VERIFY_TIMEOUT_MS = 30_000;
const RESTART_POLL_MS = 1_500;

/** Statuses that mean "the route isn't there", as opposed to "the call failed". */
const MISSING_STATUSES = new Set([404, 405, 501]);

export const AVAILABILITY = Object.freeze({
    OK: 'ok',
    MISSING: 'missing',
    PROTOCOL_MISMATCH: 'protocol-mismatch',
    ERROR: 'error',
});

export const UPDATE_CAPABILITY = Object.freeze({
    AVAILABLE: 'available',
    DISABLED: 'disabled',
    FORBIDDEN: 'forbidden',
    LEGACY: 'legacy',
    UNSUPPORTED: 'unsupported',
    UNAVAILABLE: 'unavailable',
});

/** @type {{ at: number, value: any } | null} */
let cached = null;

function context() {
    return globalThis.SillyTavern.getContext();
}

export function invalidateAvailability() {
    cached = null;
}

/**
 * Probes the server plugin. Results are cached so opening the dialog repeatedly does
 * not re-probe, but a negative result expires quickly so installing the plugin
 * and hitting Recheck feels immediate.
 *
 * @param {{ force?: boolean, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: string, health: any | null }>}
 */
export async function getAvailability({ force = false, signal, timeoutMs = ADMIN_TIMEOUT_MS } = {}) {
    const now = Date.now();

    if (!force && cached) {
        const ttl = cached.value.status === AVAILABILITY.OK ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
        if (now - cached.at < ttl) {
            return cached.value;
        }
    }

    let value;
    const request = timedSignal(signal, Math.max(1, timeoutMs));
    try {
        const response = await fetch(`${PLUGIN_BASE}/healthz`, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            signal: request.signal,
        });

        if (MISSING_STATUSES.has(response.status)) {
            value = { status: AVAILABILITY.MISSING, health: null };
        } else if (!response.ok) {
            value = { status: AVAILABILITY.ERROR, health: null };
        } else {
            const health = await response.json();
            value = health?.protocol === PROTOCOL_VERSION
                ? { status: AVAILABILITY.OK, health }
                : { status: AVAILABILITY.PROTOCOL_MISMATCH, health };
        }
    } catch (error) {
        if (signal?.aborted) {
            throw abortError();
        }
        console.debug(`[${LOG_TAG}] availability probe failed:`, error);
        value = { status: AVAILABILITY.ERROR, health: null };
    } finally {
        request.dispose();
    }

    cached = { at: now, value };
    return value;
}

/**
 * Checks whether this SillyBunny host can safely update an existing server
 * plugin to an exact Git release. Unsupported hosts and non-admin sessions are
 * normal fallback states, not exceptions.
 *
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function getServerPluginUpdateCapabilities({ signal } = {}) {
    const request = timedSignal(signal, ADMIN_TIMEOUT_MS);
    try {
        const response = await fetch(`${SERVER_PLUGIN_ADMIN_BASE}/capabilities`, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: request.signal,
        });

        if (response.status === 403) {
            return { status: UPDATE_CAPABILITY.FORBIDDEN, capabilities: null };
        }
        if (MISSING_STATUSES.has(response.status)) {
            return { status: UPDATE_CAPABILITY.LEGACY, capabilities: null };
        }
        if (!response.ok) {
            return { status: UPDATE_CAPABILITY.UNAVAILABLE, capabilities: null };
        }

        const capabilities = await response.json();
        const supported = capabilities?.apiVersion === 1
            && capabilities?.exactGitRelease === true
            && capabilities?.existingPluginsOnly === true
            && capabilities?.installsDependencies === true
            && capabilities?.dependencyPolicy === 'npm-ci-production-ignore-scripts'
            && capabilities?.safeRestart === true;
        if (!supported) {
            return { status: UPDATE_CAPABILITY.UNSUPPORTED, capabilities };
        }
        if (capabilities?.serverPluginsEnabled !== true) {
            return { status: UPDATE_CAPABILITY.DISABLED, capabilities };
        }
        if (capabilities?.available !== true) {
            return { status: UPDATE_CAPABILITY.UNAVAILABLE, capabilities };
        }
        return { status: UPDATE_CAPABILITY.AVAILABLE, capabilities };
    } catch (error) {
        if (signal?.aborted) {
            throw abortError();
        }
        console.debug(`[${LOG_TAG}] server-plugin update capability probe failed:`, error);
        return { status: UPDATE_CAPABILITY.UNAVAILABLE, capabilities: null };
    } finally {
        request.dispose();
    }
}

/**
 * Stages the immutable server-plugin tag matching this frontend release. The
 * host derives and verifies the repository from the existing installation.
 *
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function applyServerPluginRelease({ signal } = {}) {
    const response = await fetch(`${SERVER_PLUGIN_ADMIN_BASE}/apply-release`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            ...context().getRequestHeaders(),
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            directoryName: EXTENSION_NAME,
            targetVersion: VERSION,
        }),
        signal,
    });

    if (!response.ok) {
        throw await responseError(response);
    }
    return response.json();
}

/**
 * Waits for the server boot marker to change after the update helper restarts
 * SillyBunny.
 *
 * @param {string} previousBootId
 * @param {{ signal?: AbortSignal, timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForServerRestart(previousBootId, {
    signal,
    timeoutMs = RESTART_TIMEOUT_MS,
    intervalMs = RESTART_POLL_MS,
} = {}) {
    if (typeof previousBootId !== 'string' || previousBootId === '') {
        throw codedError('restart_marker_missing');
    }
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw abortError();
        }

        const request = timedSignal(
            signal,
            Math.min(ADMIN_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
        try {
            const response = await fetch(SERVER_VERSION_PATH, {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { Accept: 'application/json' },
                signal: request.signal,
            });
            if (response.ok) {
                const version = await response.json();
                if (typeof version?.serverBootId === 'string'
                    && version.serverBootId !== ''
                    && version.serverBootId !== previousBootId) {
                    return version;
                }
            }
        } catch (_error) {
            if (signal?.aborted) {
                throw abortError();
            }
            // Going offline briefly is expected while the helper swaps releases.
        } finally {
            request.dispose();
        }

        await delay(Math.min(Math.max(1, intervalMs), Math.max(1, deadline - Date.now())), signal);
    }

    throw codedError('restart_timeout');
}

/**
 * Runs the complete one-click flow and verifies the active plugin before
 * reporting success.
 *
 * @param {{
 *   signal?: AbortSignal,
 *   onPhase?: (phase: string) => void,
 *   restartTimeoutMs?: number,
 *   verifyTimeoutMs?: number,
 *   applyTimeoutMs?: number,
 *   intervalMs?: number,
 * }} [options]
 * The signal cancels monitoring, but not an apply request already sent. That
 * request has its own finite timeout so UI disposal cannot leave an ambiguous
 * host transaction half-cancelled.
 */
export async function updateServerPlugin({
    signal,
    onPhase,
    restartTimeoutMs = RESTART_TIMEOUT_MS,
    verifyTimeoutMs = VERIFY_TIMEOUT_MS,
    applyTimeoutMs = APPLY_TIMEOUT_MS,
    intervalMs = RESTART_POLL_MS,
} = {}) {
    if (signal?.aborted) {
        throw abortError();
    }
    onPhase?.('staging');
    // Once requested, let the host either queue the transaction or cancel it
    // cleanly. UI disposal may stop monitoring, but must not tear down the POST.
    const apply = timedSignal(undefined, Math.max(1, applyTimeoutMs));
    let result;
    try {
        result = await applyServerPluginRelease({ signal: apply.signal });
    } catch (error) {
        if (apply.timedOut()) {
            throw codedError('staging_timeout');
        }
        throw error;
    } finally {
        apply.dispose();
    }

    if (result?.restarting === true) {
        onPhase?.('restarting');
        await waitForServerRestart(result.serverBootId, {
            signal,
            timeoutMs: restartTimeoutMs,
            intervalMs,
        });
    }

    onPhase?.('verifying');
    const deadline = Date.now() + Math.max(1, verifyTimeoutMs);
    do {
        const remaining = Math.max(1, deadline - Date.now());
        const availability = await getAvailability({
            force: true,
            signal,
            timeoutMs: Math.min(ADMIN_TIMEOUT_MS, remaining),
        });
        if (availability.status === AVAILABILITY.OK && availability.health?.version === VERSION) {
            onPhase?.('complete');
            return { result, availability };
        }
        if (Date.now() >= deadline) {
            break;
        }
        await delay(Math.min(Math.max(1, intervalMs), Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() < deadline);

    throw codedError('plugin_verification_failed');
}

/**
 * Builds the <img> source for a card.
 *
 * In 'proxy' mode this is a same-origin URL carrying the server-minted ref. The
 * image host sees the server connection, not a direct browser connection. In
 * 'direct' mode the browser loads the upstream URL built by the server, so the
 * image host sees the browser connection and its IP address.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @param {'grid' | 'detail'} size
 * @param {'proxy' | 'direct' | 'off'} imageMode
 * @param {boolean} [sourceDirect] whether this dialog fetched this source directly
 * @returns {string | null}
 */
export function thumbSrc(card, source, size, imageMode, sourceDirect = false) {
    if (imageMode === 'off') {
        return null;
    }

    // 'off' still means off: a blocked server is a reason to change the route,
    // never a reason to start loading images the user asked not to load.
    if (imageMode === 'proxy' && !sourceDirect) {
        if (typeof card?.thumbRef !== 'string' || card.thumbRef === '') {
            return null;
        }
        const params = new URLSearchParams({ source: source.id, ref: card.thumbRef, size });
        return `${PLUGIN_BASE}/thumb?${params}`;
    }

    return typeof card?.thumbUrl === 'string' && card.thumbUrl !== '' ? card.thumbUrl : null;
}

/**
 * POSTs a flat JSON body to one of our routes. `path` is always a literal from
 * our own code. It is never built from anything a card site returned.
 *
 * @param {string} path e.g. '/search'
 * @param {Record<string, unknown>} body
 * @param {{ signal?: AbortSignal, bodyText?: string }} [options]
 * @returns {Promise<any>}
 */
export async function post(path, body, { signal, bodyText } = {}) {
    const response = await fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: context().getRequestHeaders(),
        body: typeof bodyText === 'string' ? bodyText : JSON.stringify(body ?? {}),
        signal,
    });

    if (MISSING_STATUSES.has(response.status)) {
        invalidateAvailability();
    }

    if (!response.ok) {
        let code = `http_${response.status}`;
        try {
            const payload = await response.json();
            if (typeof payload?.error === 'string') {
                code = payload.error;
            }
        } catch {
            // Body was not JSON; the status code is enough.
        }
        const error = new Error(code);
        error.status = response.status;
        error.code = code;
        throw error;
    }

    return response.json();
}

async function responseError(response) {
    let code = `http_${response.status}`;
    let message = code;
    try {
        const payload = await response.json();
        if (typeof payload?.code === 'string' && payload.code !== '') {
            code = payload.code;
        } else if (typeof payload?.error === 'string' && payload.error !== '') {
            code = payload.error;
        }
        if (typeof payload?.error === 'string' && payload.error !== '') {
            message = payload.error;
        }
    } catch {
        // The status code remains actionable when a proxy supplied the body.
    }
    const error = new Error(message);
    error.status = response.status;
    error.code = code;
    return error;
}

/**
 * POSTs to one of our routes and, if the server answers "I cannot reach this
 * source, you fetch it", carries that out and posts the result back for
 * normalizing.
 *
 * The URL is never constructed here — it comes from the server, which built it
 * from the adapter's own fixed base — and it is re-checked against the source's
 * published hosts before being fetched, the same double-check images get. The
 * fetch is deliberately credential-free and referrer-free: this is a public
 * catalogue request, and nothing about the user's SillyBunny session belongs in it.
 *
 * @param {string} path
 * @param {Record<string, unknown>} body
 * `allowDirect` is passed in rather than read from settings here: settings.js
 * already imports this module, and closing that loop for one boolean is not
 * worth an import cycle. It defaults to false so a caller that forgets cannot
 * route a user's connection by omission.
 *
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {{ id: string, directHosts?: string[] }} source
 * @param {{ signal?: AbortSignal, allowDirect?: boolean, onDirect?: (reason: string) => void }} [options]
 */
export async function postRouted(path, body, source, options = {}) {
    const { signal, allowDirect = false, onDirect } = options;
    const first = await post(path, body, { signal });

    if (first?.mode !== 'direct') {
        return first;
    }

    // The user has declined this route. Report the source as unreachable, which
    // is what it is from the server, rather than quietly using their connection.
    if (!allowDirect) {
        const declined = new Error('source_down');
        declined.code = 'source_down';
        throw declined;
    }

    if (!isAllowedUpstreamUrl(first.url, source?.directHosts)) {
        const error = new Error('bad_direct_url');
        error.code = 'bad_direct_url';
        throw error;
    }

    const direct = timedSignal(signal, DIRECT_TIMEOUT_MS);
    try {
        const upstream = await fetch(String(first.url), {
            method: 'GET',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'error',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: direct.signal,
        });
        if (!upstream.ok) {
            const failure = codedError('direct_blocked');
            failure.status = upstream.status;
            throw failure;
        }

        const bytes = await readResponseBytes(upstream, MAX_INGEST_BYTES, direct.signal);
        let payload;
        try {
            payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
            throw codedError('bad_json');
        }

        const ingest = { ...body, kind: first.kind, payload };
        const bodyText = JSON.stringify(ingest);
        if (new TextEncoder().encode(bodyText).byteLength > MAX_INGEST_BYTES) {
            throw codedError('too_large');
        }

        const result = await post('/ingest', ingest, { signal, bodyText });
        onDirect?.(typeof first.reason === 'string' ? first.reason : 'forbidden');
        return result;
    } catch (error) {
        if (signal?.aborted) {
            throw abortError();
        }
        if (direct.timedOut()) {
            throw codedError('timeout');
        }
        if (error?.code || error?.name === 'AbortError') {
            throw error;
        }
        throw codedError('direct_blocked');
    } finally {
        direct.dispose();
    }
}

/** Reads a response stream without allowing an unbounded browser allocation. */
export async function readResponseBytes(response, maxBytes, signal) {
    const declared = response?.headers?.get?.('content-length');
    if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
        throw codedError('too_large');
    }

    const reader = response?.body?.getReader?.();
    if (!reader) {
        throw codedError('direct_blocked');
    }

    let bytes = new Uint8Array(Math.min(maxBytes, 64 * 1024));
    let total = 0;
    try {
        while (true) {
            if (signal?.aborted) {
                throw abortError();
            }
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - total) {
                await reader.cancel();
                throw codedError('too_large');
            }
            const nextTotal = total + value.byteLength;
            if (nextTotal > bytes.byteLength) {
                const nextLength = Math.min(maxBytes, Math.max(nextTotal, bytes.byteLength * 2));
                const expanded = new Uint8Array(nextLength);
                expanded.set(bytes.subarray(0, total));
                bytes = expanded;
            }
            bytes.set(value, total);
            total = nextTotal;
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock?.();
    }

    return bytes.slice(0, total);
}

function timedSignal(external, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (external?.aborted) {
        abort();
    } else {
        external?.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose() {
            clearTimeout(timer);
            external?.removeEventListener('abort', abort);
        },
    };
}

function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const finish = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}
