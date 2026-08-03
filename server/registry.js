/**
 * The frozen source registry.
 *
 * Adapters are added here as they land. Everything the client can name — a
 * source id — is resolved through getSource(), which never touches the
 * prototype chain.
 */

import { botbooru } from './sources/botbooru.js';
import { chub } from './sources/chub.js';
import { pygmalion } from './sources/pygmalion.js';
import { risurealm } from './sources/risurealm.js';
import { quillgen } from './sources/quillgen.js';
import { wyvern } from './sources/wyvern.js';

/** @type {Readonly<Record<string, any>>} */
export const SOURCES = Object.freeze({
    botbooru,
    chub,
    pygmalion,
    risurealm,
    quillgen,
    wyvern,
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
 * `clientHosts` is included deliberately: the client re-checks every image and
 * link URL against it before touching the DOM, so a bug on the server side
 * still cannot point an <img> or an <a> at an arbitrary host.
 *
 * It is the union of two DIFFERENT lists, which must not be conflated:
 *   allowedHosts — hosts this server may make a request to (the egress rule)
 *   linkHosts    — hosts that may appear in a link or import URL but that we
 *                  never fetch ourselves
 * Chub is why: its API is gateway.chub.ai and its images are avatars.charhub.io,
 * but a character's page and import URL live on chub.ai, which this plugin never
 * contacts — SillyBunny's own importer does.
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
            clientHosts: [...new Set([...adapter.allowedHosts, ...(adapter.linkHosts ?? [])])],
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
