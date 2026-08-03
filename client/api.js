/**
 * API calls made by the frontend go to the same-origin server plugin. Search
 * and detail requests never go directly from the browser to a card site, and
 * this project uses no public CORS relay. Direct thumbnail mode is the explicit
 * exception: image elements load from an adapter-approved image host.
 *
 * SillyBunny has no plugin-discovery endpoint (loadedPlugins is module-private in
 * src/plugin-loader.js), so server-plugin availability is checked by
 * probing our own /healthz. That probe is a GET because csrf-sync skips
 * GET/HEAD/OPTIONS; state-changing calls send the token via getRequestHeaders().
 */

import { PROTOCOL_VERSION } from '../shared/schema.js';
import { PLUGIN_BASE, LOG_TAG } from './constants.js';

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

    if (imageMode === 'proxy') {
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
 * @returns {Promise<any>}
 */
export async function post(path, body) {
    const response = await fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: context().getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
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
