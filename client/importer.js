/**
 * Importing a card.
 *
 * Native sources use SillyBunny's URL importer. Other sources use the server
 * plugin to download or assemble and validate card bytes before passing them to
 * SillyBunny's file importer.
 */

import { isAllowedUpstreamUrl } from './render.js';
import { PLUGIN_BASE } from './constants.js';
import { MAX_CARD_BYTES } from '../shared/schema.js';
import { readResponseBytes } from './api.js';

/** Serializes host imports because the host only reports success via a global list diff. */
let importTail = Promise.resolve();

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {any} card a normalized CardSummary/CardDetail
 * @param {{ nativeImport?: boolean, clientHosts?: readonly string[] }} source immutable source metadata
 * @returns {Promise<{ avatar: string, name: string }>} the newly added character
 */
export async function importCard(card, source) {
    if (source?.nativeImport !== true || typeof card?.importUrl !== 'string') {
        throw new Error('import_unsupported');
    }

    // Belt and braces: the server built this URL, but re-check scheme and host
    // here too, so a server-side mistake still cannot send the host importer
    // somewhere unexpected.
    if (!isAllowedUpstreamUrl(card.importUrl, source.clientHosts)) {
        throw new Error('import_url_rejected');
    }

    return serializeImport(async () => {
        // importFromExternalUrl resolves with undefined on both success and
        // failure. The host list diff is therefore the only success signal.
        const before = new Set(snapshotAvatars());
        await context().importFromExternalUrl(card.importUrl);
        return addedCharacter(before);
    });
}

/**
 * Fetches and inspects a byte-card without adding it to SillyBunny. The caller
 * retains the returned object until the user explicitly confirms the import.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png', inside: object | null }>}
 */
export async function prepareCardImport(card, source, { signal } = {}) {
    const ctx = context();
    const requestSignal = signal ?? AbortSignal.timeout(20_000);
    const cardResponse = await fetch(`${PLUGIN_BASE}/card`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ source: source?.id, id: card?.id }),
        signal: requestSignal,
    });

    if (!cardResponse.ok) {
        throw await cardResponseError(cardResponse);
    }

    const kind = cardResponse.headers.get('X-SBBS-Card-Kind') === 'json' ? 'json' : 'png';
    const inside = readInside(cardResponse.headers.get('X-SBBS-Card-Inside'));
    const bytes = await readResponseBytes(cardResponse, MAX_CARD_BYTES, requestSignal);
    const fileName = `${source.id}-${String(card.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64)}.${kind}`;
    const type = kind === 'json' ? 'application/json' : 'image/png';
    return { file: new File([bytes], fileName, { type }), kind, inside };
}

/**
 * Commits byte-card bytes that `prepareCardImport()` already inspected.
 *
 * @param {{ file: File, kind: 'json' | 'png', inside: object | null }} prepared
 * @returns {Promise<{ avatar: string, name: string, inside: object | null }>}
 */
export async function commitPreparedCardImport(prepared) {
    if (!prepared?.file || (prepared.kind !== 'json' && prepared.kind !== 'png')) {
        throw new Error('card_invalid');
    }

    return serializeImport(async () => {
        const ctx = context();
        const form = new FormData();
        form.append('avatar', prepared.file);
        form.append('file_type', prepared.kind);

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

        const added = await addedCharacter(before);
        return { ...added, inside: prepared.inside };
    });
}

/**
 * Compatibility helper for callers that do not need an inspection pause.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @returns {Promise<{ avatar: string, name: string, inside: object | null }>}
 */
export async function importCardBytes(card, source) {
    return commitPreparedCardImport(await prepareCardImport(card, source));
}

function serializeImport(operation) {
    const run = importTail.then(operation, operation);
    importTail = run.catch(() => {});
    return run;
}

async function addedCharacter(before) {
    await context().getCharacters();
    const added = snapshotCharacters().filter((entry) => !before.has(entry.avatar));
    if (added.length === 0) {
        throw new Error('import_failed');
    }
    return added[added.length - 1];
}

async function cardResponseError(response) {
    let code = `http_${response.status}`;
    try {
        const payload = await response.json();
        if (typeof payload?.error === 'string') {
            code = payload.error;
        }
    } catch {
        // Not JSON; the status is enough.
    }
    return new Error(code);
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
