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
import { PLUGIN_BASE } from './constants.js';

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

/**
 * Import path for a source SillyBunny cannot fetch by URL itself.
 *
 * The server downloads and structurally validates the bytes; this only carries
 * them to the host's own importer. Note that /api/characters/import answers 200
 * with `{ error: true }` on failure rather than an error status, so the status
 * code alone cannot be trusted — and as with the native path, the character
 * list diff is the real success signal.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @returns {Promise<{ avatar: string, name: string, inside: object | null }>}
 */
export async function importCardBytes(card, source) {
    const ctx = context();

    const cardResponse = await fetch(`${PLUGIN_BASE}/card`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ source: source.id, id: card.id }),
    });

    if (!cardResponse.ok) {
        let code = `http_${cardResponse.status}`;
        try {
            const payload = await cardResponse.json();
            if (typeof payload?.error === 'string') {
                code = payload.error;
            }
        } catch {
            // Not JSON; the status is enough.
        }
        throw new Error(code);
    }

    const kind = cardResponse.headers.get('X-SBBS-Card-Kind') === 'json' ? 'json' : 'png';
    const inside = readInside(cardResponse.headers.get('X-SBBS-Card-Inside'));
    const blob = await cardResponse.blob();

    const fileName = `${source.id}-${String(card.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64)}.${kind}`;
    const file = new File([blob], fileName, { type: kind === 'json' ? 'application/json' : 'image/png' });

    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', kind);

    const before = new Set(snapshotAvatars());

    // omitContentType so the browser sets the multipart boundary itself.
    const importResponse = await fetch('/api/characters/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        body: form,
    });

    if (!importResponse.ok) {
        throw new Error('import_failed');
    }

    await context().getCharacters();

    const added = snapshotCharacters().filter((entry) => !before.has(entry.avatar));
    if (added.length === 0) {
        throw new Error('import_failed');
    }

    return { ...added[added.length - 1], inside };
}

/** The server sends the trust summary URI-encoded so it survives as a header. */
function readInside(raw) {
    if (typeof raw !== 'string' || raw === '') {
        return null;
    }
    try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
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
