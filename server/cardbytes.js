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

import { hasForbiddenKey, isPlainObject, own } from './validate.js';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** A real card has a few dozen chunks; this only bounds a hostile file. */
const MAX_CHUNKS = 4096;

/** Card JSON larger than this is not a card. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Card metadata remains bounded before Base64 decoding. */
const MAX_CARD_METADATA_BYTES = 4 * 1024 * 1024;

/** Bounds the image decoder work a tiny compressed PNG can request. */
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;

/** Legal PNG bit depths for each colour type from the PNG specification. */
const BIT_DEPTHS_BY_COLOR_TYPE = Object.freeze({
    0: Object.freeze([1, 2, 4, 8, 16]),
    2: Object.freeze([8, 16]),
    3: Object.freeze([1, 2, 4, 8]),
    4: Object.freeze([8, 16]),
    6: Object.freeze([8, 16]),
});

const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const KNOWN_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const ADAM7_PASSES = Object.freeze([
    Object.freeze([0, 0, 8, 8]),
    Object.freeze([4, 0, 8, 8]),
    Object.freeze([0, 4, 4, 8]),
    Object.freeze([2, 0, 4, 4]),
    Object.freeze([0, 2, 2, 4]),
    Object.freeze([1, 0, 2, 2]),
    Object.freeze([0, 1, 1, 2]),
]);

/** Keywords SillyTavern and the card specs use for embedded card data. */
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let value = n;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        }
        table[n] = value >>> 0;
    }
    return table;
})();

function crc32Range(buffer, start, end) {
    let crc = 0xFFFFFFFF;
    for (let index = start; index < end; index++) {
        crc = CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class CardBytesError extends Error {
    constructor(code, detail) {
        super(code);
        this.name = 'CardBytesError';
        this.code = code;
        this.detail = detail;
    }
}

function validateImageBudget(width, height, bitDepth, colorType, interlace) {
    const channels = CHANNELS_BY_COLOR_TYPE[colorType];
    const passes = imagePasses(width, height, channels, bitDepth, interlace);
    const decodedBytes = passes.reduce((total, pass) => total + (pass.rowBytes + 1) * pass.height, 0);
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_DECODED_IMAGE_BYTES) {
        throw new CardBytesError('png_malformed', 'decoded image exceeds budget');
    }
    return { decodedBytes, passes };
}

function imagePasses(width, height, channels, bitDepth, interlace) {
    if (interlace === 0) {
        return [{ width, height, rowBytes: Math.ceil((width * channels * bitDepth) / 8) }];
    }

    return ADAM7_PASSES.flatMap(([x, y, xStep, yStep]) => {
        const passWidth = width <= x ? 0 : Math.ceil((width - x) / xStep);
        const passHeight = height <= y ? 0 : Math.ceil((height - y) / yStep);
        return passWidth > 0 && passHeight > 0
            ? [{ width: passWidth, height: passHeight, rowBytes: Math.ceil((passWidth * channels * bitDepth) / 8) }]
            : [];
    });
}

function validateImageData(chunks, layout) {
    let inflated;
    try {
        inflated = inflateSync(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks), {
            maxOutputLength: layout.decodedBytes,
        });
    } catch {
        throw new CardBytesError('png_malformed', 'invalid or oversized IDAT');
    }

    if (inflated.length !== layout.decodedBytes) {
        throw new CardBytesError('png_malformed', 'IDAT scanline length mismatch');
    }

    let offset = 0;
    for (const pass of layout.passes) {
        for (let row = 0; row < pass.height; row++) {
            if (inflated[offset] > 4) {
                throw new CardBytesError('png_malformed', 'invalid PNG filter type');
            }
            offset += pass.rowBytes + 1;
        }
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
    let sawHeader = false;
    let sawImageData = false;
    let imageDataEnded = false;
    let cardMetadataBytes = 0;
    let imageLayout = null;
    const imageDataChunks = [];

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
        if (!/^[A-Za-z]{4}$/.test(type)) {
            throw new CardBytesError('png_malformed', 'invalid chunk type');
        }
        if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90 && !KNOWN_CRITICAL_CHUNKS.has(type)) {
            throw new CardBytesError('png_malformed', `unknown critical chunk ${type}`);
        }
        if (type === 'acTL') {
            throw new CardBytesError('png_malformed', 'animated PNGs are not supported');
        }

        const expectedCrc = buffer.readUInt32BE(dataEnd);
        const actualCrc = crc32Range(buffer, offset + 4, dataEnd);
        if (expectedCrc !== actualCrc) {
            throw new CardBytesError('png_malformed', `${type} CRC mismatch`);
        }

        if (!sawHeader) {
            if (type !== 'IHDR' || length !== 13) {
                throw new CardBytesError('png_malformed', 'IHDR must be first and 13 bytes');
            }
            const width = buffer.readUInt32BE(dataStart);
            const height = buffer.readUInt32BE(dataStart + 4);
            const bitDepth = buffer[dataStart + 8];
            const colorType = buffer[dataStart + 9];
            const legalBitDepths = BIT_DEPTHS_BY_COLOR_TYPE[colorType];
            if (width === 0 || height === 0
                || width > MAX_IMAGE_DIMENSION
                || height > MAX_IMAGE_DIMENSION
                || width * height > MAX_IMAGE_PIXELS
                || !legalBitDepths?.includes(bitDepth)
                || buffer[dataStart + 10] !== 0
                || buffer[dataStart + 11] !== 0
                || buffer[dataStart + 12] > 1) {
                throw new CardBytesError('png_malformed', 'invalid IHDR');
            }
            imageLayout = validateImageBudget(width, height, bitDepth, colorType, buffer[dataStart + 12]);
            sawHeader = true;
        } else if (type === 'IHDR') {
            throw new CardBytesError('png_malformed', 'duplicate IHDR');
        }

        if (type === 'IDAT') {
            if (imageDataEnded) {
                throw new CardBytesError('png_malformed', 'non-consecutive IDAT');
            }
            sawImageData = true;
            imageDataChunks.push(buffer.subarray(dataStart, dataEnd));
        } else if (sawImageData) {
            imageDataEnded = true;
        }

        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const data = buffer.subarray(dataStart, dataEnd);
            const separator = data.indexOf(0);

            // A keyword is 1-79 bytes and must be followed by a null.
            if (separator > 0 && separator <= 79) {
                const keyword = data.toString('latin1', 0, separator);
                const normalizedKeyword = keyword.toLowerCase();

                if (CARD_KEYWORDS.has(normalizedKeyword)) {
                    // SillyBunny reads only case-insensitive tEXt carriers. A
                    // zTXt/iTXt or mixed-case twin could make our inspection and
                    // its import select different card data, so reject it.
                    if (type !== 'tEXt' || keyword !== normalizedKeyword) {
                        throw new CardBytesError('png_malformed', 'ambiguous card metadata');
                    }
                    const text = data.subarray(separator + 1);
                    cardMetadataBytes += text.length;
                    if (cardMetadataBytes > MAX_CARD_METADATA_BYTES) {
                        throw new CardBytesError('png_malformed', 'card metadata exceeds budget');
                    }
                    if (found.has(normalizedKeyword)) {
                        throw new CardBytesError('png_malformed', 'duplicate card metadata');
                    }
                    found.set(normalizedKeyword, text);
                }
            }
        }

        if (type === 'IEND') {
            if (length !== 0 || !sawImageData) {
                throw new CardBytesError('png_malformed', 'invalid IEND or missing IDAT');
            }
            if (dataEnd + 4 !== buffer.length) {
                throw new CardBytesError('png_malformed', 'trailing bytes after IEND');
            }
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

    validateImageData(imageDataChunks, imageLayout);

    return found;
}

/**
 * Card data is stored base64-encoded inside the text chunk.
 * @param {Buffer} raw
 */
function decodeCardPayload(raw) {
    const text = raw.toString('latin1').trim().replace(/[\r\n]/g, '');
    if (text === '') {
        throw new CardBytesError('card_invalid', 'empty card chunk');
    }

    // Strict Base64: Buffer.from otherwise skips junk silently and could allocate
    // before we know whether the decoded payload fits the card budget.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/.test(text)) {
        throw new CardBytesError('card_invalid', 'card chunk is not base64');
    }

    const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
    const unpaddedLength = text.length - padding;
    const remainder = unpaddedLength % 4;
    const decodedLength = Math.floor(unpaddedLength / 4) * 3 + (remainder === 2 ? 1 : (remainder === 3 ? 2 : 0));
    if (decodedLength === 0 || decodedLength > MAX_JSON_BYTES) {
        throw new CardBytesError('card_invalid', 'card payload size out of range');
    }

    const decoded = Buffer.from(text, 'base64');
    if (decoded.length !== decodedLength) {
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
        // Strings anywhere in a card can be rendered or injected after import.
        externalImages: countExternalUrls(data),
        originSite: null,
    };
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function countExternalUrls(value) {
    const urls = new Set();
    const seen = new Set();
    const stack = [value];
    let nodes = 0;
    let textBytes = 0;

    while (stack.length > 0 && nodes < 10_000 && urls.size < 256 && textBytes < 512 * 1024) {
        const current = stack.pop();
        nodes++;
        if (typeof current === 'string') {
            textBytes += Buffer.byteLength(current);
            const matches = current.match(/https?:\/\/[^\s)"'<>]+/gi);
            if (matches) {
                for (const url of matches) {
                    urls.add(url);
                    if (urls.size >= 256) {
                        break;
                    }
                }
            }
            continue;
        }
        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);
        if (Array.isArray(current)) {
            for (let index = 0; index < current.length && index < 256; index++) {
                stack.push(current[index]);
            }
            continue;
        }
        let keys = 0;
        for (const key in current) {
            if (Object.prototype.hasOwnProperty.call(current, key) && keys++ < 256) {
                stack.push(current[key]);
            }
        }
    }
    return urls.size;
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
