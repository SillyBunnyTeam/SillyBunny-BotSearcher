/**
 * Validation for character-card bytes fetched on the user's behalf.
 *
 * This is the one place where this plugin hands the browser something it will
 * feed straight into SillyBunny's importer, so it is the only genuinely new
 * trust surface the project adds. Everywhere else the download is done by the
 * fork's own hardened code (content-manager.js) and we only supply a URL.
 *
 * What this proves: the bytes are a structurally well-formed PNG that actually
 * carries embedded character data, or a JSON document in a recognised card
 * format. What it cannot prove — and no amount of parsing could — is that the
 * card is benign. A card is a document written by a stranger and the format
 * exists to be partially executed. That is why the UI shows what is inside
 * before the user commits, rather than pretending validation makes it safe.
 *
 * The PNG walk deliberately never allocates based on a declared length before
 * checking it against what is actually present: a four-byte length field is
 * attacker-controlled and 0xFFFFFFFF is free to write.
 */

import zlib from 'node:zlib';

import { hasForbiddenKey, isPlainObject, own } from './validate.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** A real card has a few dozen chunks; this only bounds a hostile file. */
const MAX_CHUNKS = 4096;

/** Ceiling on an inflated zTXt payload, so a compression bomb cannot expand into memory. */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/** Card JSON larger than this is not a card. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Keywords SillyTavern and the card specs use for embedded card data. */
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

export class CardBytesError extends Error {
    constructor(code, detail) {
        super(code);
        this.name = 'CardBytesError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * Walks a PNG's chunk table, returning the decoded text chunks that carry card
 * data. Rejects rather than repairs: a malformed table means we do not
 * understand the file, and guessing is how parsers become exploits.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} keyword -> raw text bytes
 */
function readPngTextChunks(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 12) {
        throw new CardBytesError('not_a_png', 'too short');
    }
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new CardBytesError('not_a_png', 'bad signature');
    }

    const found = new Map();
    let offset = PNG_SIGNATURE.length;
    let chunks = 0;
    let sawEnd = false;

    while (offset + 8 <= buffer.length) {
        if (++chunks > MAX_CHUNKS) {
            throw new CardBytesError('png_malformed', 'too many chunks');
        }

        const length = buffer.readUInt32BE(offset);

        // The PNG spec caps a chunk at 2^31-1. Anything above that, or anything
        // that would run past the end, is refused BEFORE a read is attempted.
        if (length > 0x7FFFFFFF) {
            throw new CardBytesError('png_malformed', 'chunk length out of range');
        }
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        // +4 for the trailing CRC. Computed in a way that cannot overflow.
        if (dataEnd > buffer.length - 4) {
            throw new CardBytesError('png_malformed', 'chunk length exceeds file');
        }

        const type = buffer.toString('latin1', offset + 4, offset + 8);

        if (type === 'tEXt' || type === 'zTXt') {
            const data = buffer.subarray(dataStart, dataEnd);
            const separator = data.indexOf(0);

            // A keyword is 1-79 bytes and must be followed by a null.
            if (separator > 0 && separator <= 79) {
                const keyword = data.toString('latin1', 0, separator);

                if (CARD_KEYWORDS.has(keyword) && !found.has(keyword)) {
                    found.set(keyword, type === 'tEXt'
                        ? data.subarray(separator + 1)
                        : inflateZtxt(data.subarray(separator + 1)));
                }
            }
        }

        if (type === 'IEND') {
            sawEnd = true;
            break;
        }

        offset = dataEnd + 4;
    }

    // Every PNG ends with IEND. Without it the download was cut short: the card
    // chunk may still have arrived intact, but the image data behind it has not,
    // and importing half a file gives the user a corrupt avatar.
    if (!sawEnd) {
        throw new CardBytesError('png_malformed', 'truncated: no IEND chunk');
    }

    return found;
}

/**
 * zTXt payload: one compression-method byte then a zlib stream.
 * maxOutputLength is the bomb guard — without it a few KB can inflate to
 * gigabytes and take the server with it.
 */
function inflateZtxt(payload) {
    if (payload.length < 2) {
        throw new CardBytesError('png_malformed', 'short zTXt');
    }
    if (payload[0] !== 0) {
        throw new CardBytesError('png_malformed', 'unknown zTXt compression');
    }

    try {
        return zlib.inflateSync(payload.subarray(1), { maxOutputLength: MAX_INFLATED_BYTES });
    } catch (error) {
        // node throws ERR_BUFFER_TOO_LARGE when maxOutputLength is exceeded.
        throw new CardBytesError('png_malformed', `zTXt inflate failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    }
}

/**
 * Card data is stored base64-encoded inside the text chunk.
 * @param {Buffer} raw
 */
function decodeCardPayload(raw) {
    const text = raw.toString('latin1').trim();
    if (text === '') {
        throw new CardBytesError('card_invalid', 'empty card chunk');
    }

    // Base64 with a strict alphabet check: Buffer.from ignores junk silently,
    // which would let malformed data through as a shorter buffer.
    if (!/^[A-Za-z0-9+/\r\n=]+$/.test(text)) {
        throw new CardBytesError('card_invalid', 'card chunk is not base64');
    }

    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 0 || decoded.length > MAX_JSON_BYTES) {
        throw new CardBytesError('card_invalid', 'card payload size out of range');
    }

    return parseCardJson(decoded);
}

/**
 * Parses and shape-checks card JSON, in either the v1 flat form or the
 * v2/v3 `{ spec, data }` form.
 *
 * @param {Buffer} buffer
 * @returns {{ spec: string, card: Record<string, unknown> }}
 */
export function parseCardJson(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new CardBytesError('card_invalid', 'empty');
    }
    if (buffer.length > MAX_JSON_BYTES) {
        throw new CardBytesError('too_large', 'card json');
    }

    let parsed;
    try {
        parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new CardBytesError('card_invalid', 'not json');
    }

    if (!isPlainObject(parsed)) {
        throw new CardBytesError('card_invalid', 'not an object');
    }
    if (hasForbiddenKey(parsed)) {
        throw new CardBytesError('card_invalid', 'unsafe keys');
    }

    const spec = own(parsed, 'spec');

    if (spec === 'chara_card_v2' || spec === 'chara_card_v3') {
        const data = own(parsed, 'data');
        if (!isPlainObject(data)) {
            throw new CardBytesError('card_invalid', `${spec} without a data object`);
        }
        if (typeof own(data, 'name') !== 'string') {
            throw new CardBytesError('card_invalid', `${spec} without a name`);
        }
        return { spec, card: parsed };
    }

    // v1: a flat object with at least a name and a description.
    if (typeof own(parsed, 'name') === 'string' && typeof own(parsed, 'description') === 'string') {
        return { spec: 'chara_card_v1', card: parsed };
    }

    throw new CardBytesError('card_invalid', 'unrecognised card format');
}

/**
 * Summarises what an imported card will bring with it, from the validated
 * bytes rather than from whatever the listing claimed.
 *
 * @param {{ spec: string, card: Record<string, unknown> }} parsed
 */
export function describeCard(parsed) {
    const root = parsed.card;
    const data = parsed.spec === 'chara_card_v1' ? root : own(root, 'data');

    const book = own(data, 'character_book');
    const entries = own(book, 'entries');
    const greetings = own(data, 'alternate_greetings');
    const assets = own(data, 'assets');
    const extensions = own(data, 'extensions');

    const description = typeof own(data, 'description') === 'string' ? own(data, 'description') : '';

    // Regex scripts rewrite messages as they pass through. They are the closest
    // thing to executable content a card can carry, so they get counted.
    const regex = own(extensions, 'regex_scripts');

    return {
        lorebookEntries: Array.isArray(entries) ? entries.length : (book ? null : 0),
        alternateGreetings: Array.isArray(greetings) ? greetings.length : 0,
        hasSystemPrompt: nonEmptyString(own(data, 'system_prompt')),
        hasPostHistoryInstructions: nonEmptyString(own(data, 'post_history_instructions')),
        hasDepthPrompt: own(extensions, 'depth_prompt') !== undefined,
        regexScripts: Array.isArray(regex) ? regex.length : 0,
        embeddedAssets: Array.isArray(assets) ? assets.length : 0,
        specVersion: parsed.spec,
        // Remote images referenced from the description render in chat and would
        // report back to whoever hosts them. Worth surfacing before importing.
        externalImages: countExternalUrls(description),
        originSite: null,
    };
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function countExternalUrls(text) {
    if (typeof text !== 'string' || text === '') {
        return 0;
    }
    const matches = text.match(/https?:\/\/[^\s)"'<>]+/gi);
    return matches ? new Set(matches).size : 0;
}

/**
 * The entry point: validates raw downloaded bytes.
 *
 * The upstream Content-Type is advisory only — magic bytes decide, because the
 * header is exactly the part an attacker controls for free.
 *
 * @param {Buffer} buffer
 * @param {'png' | 'json'} expect
 * @returns {{ kind: 'png' | 'json', spec: string, inside: object }}
 */
export function validateCardBytes(buffer, expect) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new CardBytesError('card_invalid', 'no bytes');
    }

    const looksPng = buffer.length >= PNG_SIGNATURE.length
        && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

    // The signature decides, not `expect`. An adapter saying "png" while the
    // site returns a perfectly good JSON card should import it, not fail — and
    // an adapter saying "json" cannot talk us into skipping the PNG checks.
    void expect;

    if (looksPng) {
        const chunks = readPngTextChunks(buffer);

        // Prefer v3 when a card carries both.
        const raw = chunks.get('ccv3') ?? chunks.get('chara');
        if (!raw) {
            // A plain picture is not a character card, however valid the PNG.
            throw new CardBytesError('card_invalid', 'png carries no embedded card');
        }

        const parsed = decodeCardPayload(raw);
        return { kind: 'png', spec: parsed.spec, inside: describeCard(parsed) };
    }

    const parsed = parseCardJson(buffer);
    return { kind: 'json', spec: parsed.spec, inside: describeCard(parsed) };
}
