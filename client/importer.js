/**
 * Importing a card.
 *
 * Phase 1 only implements the native path: every source shipped so far is one
 * SillyBunny already knows how to import (src/endpoints/content-manager.js:1631),
 * so the download, the host dispatch and the PNG signature check all happen in
 * the host's existing, already-hardened code. This extension contributes no new
 * trust surface to the import itself — it only decides which URL to hand over,
 * and that URL was built server-side from a fixed base.
 */

import { isAllowedImageUrl } from './render.js';

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {any} card a normalized CardSummary/CardDetail
 * @param {readonly string[]} clientHosts the source's display hosts, from /healthz
 * @returns {Promise<{ avatar: string, name: string }>} the newly added character
 */
export async function importCard(card, clientHosts) {
    if (card?.nativeImport !== true || typeof card.importUrl !== 'string') {
        throw new Error('import_unsupported');
    }

    // Belt and braces: the server built this URL, but re-check scheme and host
    // here too, so a server-side mistake still cannot send the host importer
    // somewhere unexpected.
    if (!isAllowedImageUrl(card.importUrl, clientHosts)) {
        throw new Error('import_url_rejected');
    }

    const before = new Set(snapshotAvatars());

    // importFromExternalUrl resolves with undefined on BOTH success and failure —
    // on error it fires a toast and returns (public/scripts/utils.js:3036).
    // So its return value cannot drive the button state; diffing the character
    // list is the only reliable success signal.
    await context().importFromExternalUrl(card.importUrl);
    await context().getCharacters();

    const added = snapshotCharacters().filter((entry) => !before.has(entry.avatar));
    if (added.length === 0) {
        throw new Error('import_failed');
    }

    return added[added.length - 1];
}

function snapshotCharacters() {
    const characters = context().characters;
    if (!Array.isArray(characters)) {
        return [];
    }
    return characters
        .filter((entry) => entry && typeof entry.avatar === 'string')
        .map((entry) => ({ avatar: entry.avatar, name: typeof entry.name === 'string' ? entry.name : '' }));
}

function snapshotAvatars() {
    return snapshotCharacters().map((entry) => entry.avatar);
}

/**
 * Opens a freshly imported character.
 * @param {string} avatar
 */
export async function openCharacter(avatar) {
    const ctx = context();
    const index = (Array.isArray(ctx.characters) ? ctx.characters : []).findIndex((entry) => entry?.avatar === avatar);
    if (index >= 0) {
        await ctx.selectCharacterById(index);
    }
}
