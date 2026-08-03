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

import { PROTOCOL_VERSION, MAX_INGEST_BYTES } from '../shared/schema.js';
import { PLUGIN_BASE, LOG_TAG } from './constants.js';
import { isAllowedUpstreamUrl } from './render.js';

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 5_000;

/** Statuses that mean "the route isn't there", as opposed to "the call failed". */
const MISSING_STATUSES = new Set([404, 405, 501]);

export const AVAILABILITY = Object.freeze({
    OK: 'ok',
    MISSING: 'missing',
    PROTOCOL_MISMATCH: 'protocol-mismatch',
    ERROR: 'error',
});

/** @type {{ at: number, value: any } | null} */
let cached = null;

/**
 * Sources this session has had to fetch from the browser.
 *
 * Thumbnails have to follow the same route. A server that cannot reach a
 * source's API is almost never able to reach its image host either — they sit
 * behind the same edge — so leaving images on the proxy would replace every card
 * with a letter tile while the results themselves loaded fine.
 */
const directSources = new Set();

/** @param {string} sourceId */
export function isSourceDirect(sourceId) {
    return directSources.has(sourceId);
}

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
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ status: string, health: any | null }>}
 */
export async function getAvailability({ force = false } = {}) {
    const now = Date.now();

    if (!force && cached) {
        const ttl = cached.value.status === AVAILABILITY.OK ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
        if (now - cached.at < ttl) {
            return cached.value;
        }
    }

    let value;
    try {
        const response = await fetch(`${PLUGIN_BASE}/healthz`, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
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
        console.debug(`[${LOG_TAG}] availability probe failed:`, error);
        value = { status: AVAILABILITY.ERROR, health: null };
    }

    cached = { at: now, value };
    return value;
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
 * @returns {string | null}
 */
export function thumbSrc(card, source, size, imageMode) {
    if (imageMode === 'off') {
        return null;
    }

    // 'off' still means off: a blocked server is a reason to change the route,
    // never a reason to start loading images the user asked not to load.
    if (imageMode === 'proxy' && !directSources.has(source?.id)) {
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
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function post(path, body, { signal } = {}) {
    const response = await fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: context().getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
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
 * @param {{ id: string, clientHosts: string[] }} source
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

    if (!isAllowedUpstreamUrl(first.url, source?.clientHosts)) {
        const error = new Error('bad_direct_url');
        error.code = 'bad_direct_url';
        throw error;
    }

    directSources.add(source.id);
    onDirect?.(typeof first.reason === 'string' ? first.reason : 'forbidden');

    let upstream;
    try {
        upstream = await fetch(String(first.url), {
            method: 'GET',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: { Accept: 'application/json' },
            signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw error;
        }
        const failure = new Error('direct_blocked');
        failure.code = 'direct_blocked';
        throw failure;
    }

    if (!upstream.ok) {
        const failure = new Error('direct_blocked');
        failure.code = 'direct_blocked';
        failure.status = upstream.status;
        throw failure;
    }

    const text = await upstream.text();
    if (text.length > MAX_INGEST_BYTES) {
        const failure = new Error('too_large');
        failure.code = 'too_large';
        throw failure;
    }

    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        const failure = new Error('bad_json');
        failure.code = 'bad_json';
        throw failure;
    }

    return post('/ingest', { ...body, kind: first.kind, payload }, { signal });
}
