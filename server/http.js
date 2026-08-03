/**
 * The single point at which this plugin talks to the outside world.
 *
 * Adapters never import a fetch implementation; they are handed `fetchJson` /
 * `fetchBytes` bound to their own adapter object, so every request is checked
 * against that adapter's own allow-list. A URL that did not come from an
 * adapter's own base cannot be fetched at all — there is no code path that
 * accepts a URL from the client.
 *
 * node-fetch rather than global fetch on purpose: SillyBunny's
 * initPrivateRequestFilter() patches http/https.globalAgent
 * (src/private-request-filter.js), which node-fetch honours and native fetch
 * does not. It is off by default, so this is defence in depth, never a control.
 */

import nodeFetch from 'node-fetch';

import { hasForbiddenKey } from './validate.js';
import { UpstreamError } from './guards.js';

export { UpstreamError };

/** Fixed and literal. Never derived from an incoming request. */
const BASE_HEADERS = Object.freeze({
    'Accept-Language': 'en-US,en;q=0.9',
    // Several card sites sit behind Cloudflare and reject unknown agents.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

const MAX_REDIRECTS = 2;

/**
 * @param {{ id: string, allowedHosts: readonly string[] }} adapter
 * @param {URL} url
 */
function assertReachable(adapter, url) {
    // `allowInsecureForTests` exists so the hardening tests can point a fake
    // adapter at a local http server. It can only be set by writing it into an
    // adapter's own source; tests/hardening.test.js asserts that no shipped
    // adapter has it, and registry.test.js re-checks on every future adapter.
    if (url.protocol !== 'https:' && adapter.allowInsecureForTests !== true) {
        throw new UpstreamError('insecure_scheme', url.protocol);
    }
    // Exact hostname match. A suffix test would accept "botbooru.com.evil.tld".
    if (!adapter.allowedHosts.includes(url.hostname.toLowerCase())) {
        throw new UpstreamError('host_not_allowed', url.hostname);
    }
}

/**
 * Performs one request, following at most MAX_REDIRECTS hops and re-validating
 * the destination at every hop. node-fetch's own `follow` does not re-check the
 * host, which is why redirects are handled manually here.
 *
 * @param {{ id: string, allowedHosts: readonly string[] }} adapter
 * @param {URL | string} target
 * @param {{ accept: string, maxBytes: number, timeoutMs: number }} options
 */
async function request(adapter, target, { accept, maxBytes, timeoutMs }) {
    let url = target instanceof URL ? target : new URL(String(target));
    const startedAt = Date.now();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        assertReachable(adapter, url);

        let response;
        try {
            response = await nodeFetch(url.toString(), {
                method: 'GET',
                redirect: 'manual',
                size: maxBytes,
                signal: AbortSignal.timeout(timeoutMs),
                headers: { ...BASE_HEADERS, Accept: accept },
            });
        } catch (error) {
            if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
                throw new UpstreamError('timeout', adapter.id);
            }
            if (error?.type === 'max-size') {
                throw new UpstreamError('too_large', adapter.id);
            }
            throw new UpstreamError('network', error?.message);
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        if (!isRedirect) {
            logUpstream(adapter, url, response.status, Date.now() - startedAt);
            return response;
        }

        const location = response.headers.get('location');
        if (!location) {
            throw new UpstreamError('bad_redirect', String(response.status));
        }

        // Resolve relative Locations against the URL we just requested.
        try {
            url = new URL(location, url);
        } catch {
            throw new UpstreamError('bad_redirect', 'unparseable');
        }
    }

    throw new UpstreamError('too_many_redirects', adapter.id);
}

/**
 * Fetches and parses JSON, then rejects prototype-poisoning payloads before the
 * caller can walk them.
 *
 * @param {{ id: string, allowedHosts: readonly string[] }} adapter
 * @param {URL | string} url
 * @param {{ maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(adapter, url, { maxBytes = 2 << 20, timeoutMs = 8000 } = {}) {
    const response = await request(adapter, url, {
        accept: 'application/json,text/plain;q=0.8,*/*;q=0.5',
        maxBytes,
        timeoutMs,
    });

    if (!response.ok) {
        throw new UpstreamError('http_error', String(response.status));
    }

    let text;
    try {
        text = await response.text();
    } catch (error) {
        if (error?.type === 'max-size') {
            throw new UpstreamError('too_large', adapter.id);
        }
        throw new UpstreamError('network', error?.message);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new UpstreamError('bad_json', adapter.id);
    }

    if (hasForbiddenKey(parsed)) {
        throw new UpstreamError('unsafe_json', adapter.id);
    }

    return parsed;
}

/**
 * Fetches raw bytes with the same host and size discipline. Used by the card
 * byte path and the thumbnail proxy.
 *
 * @param {{ id: string, allowedHosts: readonly string[] }} adapter
 * @param {URL | string} url
 * @param {{ accept?: string, maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ buffer: Buffer, contentType: string, status: number }>}
 */
export async function fetchBytes(adapter, url, { accept = '*/*', maxBytes = 8 << 20, timeoutMs = 20000 } = {}) {
    const response = await request(adapter, url, { accept, maxBytes, timeoutMs });

    if (!response.ok) {
        throw new UpstreamError('http_error', String(response.status));
    }

    let buffer;
    try {
        buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
        if (error?.type === 'max-size') {
            throw new UpstreamError('too_large', adapter.id);
        }
        throw new UpstreamError('network', error?.message);
    }

    return {
        buffer,
        contentType: String(response.headers.get('content-type') ?? ''),
        status: response.status,
    };
}

/**
 * Logs shape, not content: never an upstream body, never a query string (which
 * would put the user's search terms in the server log).
 */
function logUpstream(adapter, url, status, ms) {
    console.debug(`[BotSearcher] ${adapter.id} ${url.origin}${url.pathname} -> ${status} in ${ms}ms`);
}

/**
 * Builds the per-adapter context handed to search()/getDetail().
 * @param {{ id: string, allowedHosts: readonly string[] }} adapter
 */
export function contextFor(adapter) {
    return Object.freeze({
        fetchJson: (url, options) => fetchJson(adapter, url, options),
        fetchBytes: (url, options) => fetchBytes(adapter, url, options),
    });
}
