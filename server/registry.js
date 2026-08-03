/**
 * The frozen source registry.
 *
 * Adapters are added here as they land. Everything the client can name — a
 * source id — is resolved through getSource(), which never touches the
 * prototype chain.
 */

import { botbooru } from './sources/botbooru.js';

/** @type {Readonly<Record<string, any>>} */
export const SOURCES = Object.freeze({
    botbooru,
});

/**
 * Pollution-proof lookup. A client-supplied `source` of "__proto__",
 * "constructor" or "toString" must not resolve to anything.
 * @param {unknown} id
 * @returns {any | null}
 */
export function getSource(id) {
    if (typeof id !== 'string' || id === '') {
        return null;
    }
    if (!Object.prototype.hasOwnProperty.call(SOURCES, id)) {
        return null;
    }
    return SOURCES[id];
}

/**
 * Public, non-secret description of every source, for /healthz.
 *
 * `allowedHosts` is included deliberately: the client re-checks every image and
 * link URL against it before touching the DOM, so a bug on the server side
 * still cannot point an <img> at an arbitrary host.
 *
 * @param {(id: string) => string} stateOf
 */
export function describeSources(stateOf) {
    return Object.keys(SOURCES).map((id) => {
        const adapter = SOURCES[id];
        return {
            id,
            label: adapter.label,
            homepage: adapter.homepage,
            allowedHosts: [...adapter.allowedHosts],
            tier: adapter.tier,
            state: stateOf(id),
            nativeImport: adapter.nativeImport === true,
            capabilities: {
                search: adapter.capabilities.search,
                query: adapter.capabilities.query,
                paging: adapter.capabilities.paging,
                sorts: [...adapter.capabilities.sorts],
                sfwToggle: adapter.capabilities.sfwToggle,
                detail: adapter.capabilities.detail,
            },
        };
    });
}
