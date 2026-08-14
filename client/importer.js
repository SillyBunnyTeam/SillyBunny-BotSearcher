/**
 * Importing a card, and getting hold of its bytes first.
 *
 * Every card now reaches the intake screen as bytes, whichever source it came
 * from, so one report can describe all of them.
 *
 * For a native source those bytes come from SillyBunny's own `/api/content/importURL`,
 * which downloads a card and hands it back to the browser rather than importing
 * it (src/endpoints/content-manager.js:1716). That matters more than it looks:
 * the bytes inspected are then the exact bytes imported, the fork's per-site
 * downloaders keep doing the downloading — including the Cloudflare-aware
 * Janitor path — and this plugin gains no new outbound request. `/card` still
 * refuses native sources for the same reason it always did.
 */

import { isAllowedUpstreamUrl } from './render.js';
import { PLUGIN_BASE } from './constants.js';
import { MAX_CARD_BYTES } from '../shared/schema.js';
import { readResponseBytes } from './api.js';

/** Host route that downloads a card and returns it without importing it. */
const HOST_IMPORT_URL = '/api/content/importURL';

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

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
 * Fetches a byte-card without adding it to SillyBunny. The caller retains the
 * returned object until the user explicitly confirms the import.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
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
    const bytes = await readResponseBytes(cardResponse, MAX_CARD_BYTES, requestSignal);
    const fileName = `${source.id}-${String(card.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64)}.${kind}`;
    return { file: fileFrom(bytes, fileName, kind), kind };
}

/** Fetches a validated card from one of the server's fixed URL-import bridges. */
export async function fetchUrlCard(url, source, { signal } = {}) {
    if (typeof url !== 'string' || url.trim() === '' || typeof source?.id !== 'string') {
        throw new Error('bad_import_url');
    }

    const ctx = context();
    const requestSignal = signal ?? AbortSignal.timeout(120_000);
    const response = await fetch(`${PLUGIN_BASE}/url-card`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ source: source.id, url: url.trim() }),
        signal: requestSignal,
    });
    if (!response.ok) {
        throw await cardResponseError(response);
    }

    const kind = response.headers.get('X-SBBS-Card-Kind') === 'png' ? 'png' : 'json';
    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    return { file: fileFrom(bytes, `${source.id}-url.${kind}`, kind), kind };
}

/**
 * Asks SillyBunny to download a native source's card and hand back the bytes,
 * so the intake screen can describe what the import would actually bring in.
 *
 * The URL is the one the adapter built and is re-checked here, exactly as the
 * unscanned native import re-checks it. Nothing is imported by this call.
 *
 * @param {any} card
 * @param {{ nativeImport?: boolean, clientHosts?: readonly string[] }} source
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function fetchNativeCardBytes(card, source, { signal } = {}) {
    if (source?.nativeImport !== true || typeof card?.importUrl !== 'string') {
        throw new Error('import_unsupported');
    }
    if (!isAllowedUpstreamUrl(card.importUrl, source.clientHosts)) {
        throw new Error('import_url_rejected');
    }

    const ctx = context();
    const requestSignal = signal ?? AbortSignal.timeout(60_000);
    const response = await fetch(HOST_IMPORT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ url: card.importUrl }),
        signal: requestSignal,
    });

    if (!response.ok) {
        throw new Error('native_download_failed');
    }
    // The same route serves lorebooks. Only a character may reach the importer.
    if (response.headers.get('X-Custom-Content-Type') !== 'character') {
        throw new Error('not_a_character');
    }

    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    // Magic bytes decide the kind, for the same reason the server ignores the
    // upstream Content-Type: the header is the part nobody here controls.
    const kind = looksPng(bytes) ? 'png' : 'json';
    const slug = String(card.id ?? 'card').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'card';
    return { file: fileFrom(bytes, `${source.id ?? 'card'}-${slug}.${kind}`, kind), kind };
}

/**
 * Reads a card the user chose from their own machine.
 * @param {File} file
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function readLocalCardFile(file) {
    if (!(file instanceof File)) {
        throw new Error('card_invalid');
    }
    if (file.size > MAX_CARD_BYTES) {
        throw new Error('too_large');
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = looksPng(bytes) ? 'png' : 'json';
    const name = file.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 96) || `card.${kind}`;
    return { file: fileFrom(bytes, name, kind), kind };
}

/**
 * Reports what is inside card bytes. Sends the bytes, receives a description —
 * this route hands nothing back that could be imported.
 *
 * @param {File} file
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object>}
 */
export async function inspectBytes(file, { signal } = {}) {
    const response = await postBytes('/inspect', file, signal);
    if (!response.ok) {
        throw await cardResponseError(response);
    }
    return response.json();
}

/**
 * Returns the same card with the fixed clean profile applied.
 *
 * @param {{ file: File, kind: 'json' | 'png' }} prepared
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function cleanBytes(prepared, { signal } = {}) {
    const requestSignal = signal ?? AbortSignal.timeout(30_000);
    const response = await postBytes('/clean', prepared.file, requestSignal);
    if (!response.ok) {
        throw await cardResponseError(response);
    }

    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    const name = prepared.file.name.replace(/(\.[^.]+)?$/, `-clean.${prepared.kind}`);
    return { file: fileFrom(bytes, name, prepared.kind), kind: prepared.kind };
}

function postBytes(path, file, signal) {
    const ctx = context();
    return fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        // The CSRF token and session come from the host's own header builder;
        // only the content type differs from every other call we make.
        headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: signal ?? AbortSignal.timeout(30_000),
    });
}

function looksPng(bytes) {
    return bytes.length >= PNG_SIGNATURE.length
        && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function fileFrom(bytes, name, kind) {
    return new File([bytes], name, { type: kind === 'json' ? 'application/json' : 'image/png' });
}

/**
 * Commits card bytes the intake screen has already described.
 *
 * `replaceAvatar` overwrites an installed character instead of adding a second
 * copy, using the host importer's own `preserved_name` field
 * (src/endpoints/characters.js:1934).
 *
 * @param {{ file: File, kind: 'json' | 'png' }} prepared
 * @param {{ replaceAvatar?: string }} [options]
 * @returns {Promise<{ avatar: string, name: string }>}
 */
export async function commitPreparedCardImport(prepared, { replaceAvatar } = {}) {
    if (!prepared?.file || (prepared.kind !== 'json' && prepared.kind !== 'png')) {
        throw new Error('card_invalid');
    }

    return serializeImport(async () => {
        const ctx = context();
        const form = new FormData();
        form.append('avatar', prepared.file);
        form.append('file_type', prepared.kind);
        if (typeof replaceAvatar === 'string' && replaceAvatar !== '') {
            form.append('preserved_name', replaceAvatar);
        }

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

        // Replacing adds nothing to the list, so the diff cannot report it.
        if (typeof replaceAvatar === 'string' && replaceAvatar !== '') {
            await ctx.getCharacters();
            return { avatar: replaceAvatar, name: nameOfAvatar(replaceAvatar) };
        }

        return addedCharacter(before);
    });
}

/**
 * Compatibility helper for callers that do not need an inspection pause.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @returns {Promise<{ avatar: string, name: string }>}
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

function nameOfAvatar(avatar) {
    return snapshotCharacters().find((entry) => entry.avatar === avatar)?.name ?? '';
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
