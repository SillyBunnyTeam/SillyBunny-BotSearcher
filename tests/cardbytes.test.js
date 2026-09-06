/**
 * Card byte validation.
 *
 * These build real PNGs byte by byte, including malformed and hostile ones,
 * because this is the only code path in the project that hands the browser
 * something it will feed straight into SillyBunny's character importer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { validateCardBytes, parseCardJson, describeCard, embedCardInPng, CardBytesError } from '../server/cardbytes.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xFFFFFFFF;
    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data, lengthOverride) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(lengthOverride ?? data.length, 0);
    const typeBuffer = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

const IHDR = imageHeader();
const IDAT = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])));
const IEND = chunk('IEND', Buffer.alloc(0));

function textChunk(keyword, text) {
    return chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

function compressedTextChunk(keyword, payload) {
    return chunk('zTXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0, 0]), // null separator + compression method 0
        zlib.deflateSync(Buffer.from(payload)),
    ]));
}

const V2_CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: 'Test Character',
        description: 'A description.',
        first_mes: 'Hello.',
        alternate_greetings: ['Hi.', 'Hey.'],
        system_prompt: 'You are a test.',
        character_book: { entries: [{ keys: ['a'] }, { keys: ['b'] }, { keys: ['c'] }] },
    },
};

function pngWith(keyword, cardObject) {
    const base64 = Buffer.from(JSON.stringify(cardObject)).toString('base64');
    return Buffer.concat([SIGNATURE, IHDR, textChunk(keyword, base64), IDAT, IEND]);
}

// ---- the happy path ----

test('a PNG carrying an embedded v2 card is accepted', () => {
    const verdict = validateCardBytes(pngWith('chara', V2_CARD), 'png');

    assert.equal(verdict.kind, 'png');
    assert.equal(verdict.spec, 'chara_card_v2');
    assert.equal(verdict.inside.lorebookEntries, 3);
    assert.equal(verdict.inside.alternateGreetings, 2);
    assert.equal(verdict.inside.hasSystemPrompt, true);
});

test('a v3 card wins when both chunks are present', () => {
    const v3 = { spec: 'chara_card_v3', data: { name: 'V3' } };
    const png = Buffer.concat([
        SIGNATURE, IHDR,
        textChunk('chara', Buffer.from(JSON.stringify(V2_CARD)).toString('base64')),
        textChunk('ccv3', Buffer.from(JSON.stringify(v3)).toString('base64')),
        IDAT,
        IEND,
    ]);

    assert.equal(validateCardBytes(png, 'png').spec, 'chara_card_v3');
});

test('a compressed zTXt card chunk is rejected to match the host importer', () => {
    const base64 = Buffer.from(JSON.stringify(V2_CARD)).toString('base64');
    const png = Buffer.concat([SIGNATURE, IHDR, compressedTextChunk('chara', base64), IDAT, IEND]);

    assert.throws(() => validateCardBytes(png, 'png'), (error) => error.code === 'png_malformed');
});

// ---- what must be refused ----

test('a valid PNG with no embedded card is refused', () => {
    // A plain picture is not a character card, however well-formed.
    const png = Buffer.concat([SIGNATURE, IHDR, textChunk('Comment', 'just a photo'), IDAT, IEND]);

    assert.throws(() => validateCardBytes(png, 'png'), (error) => {
        assert.ok(error instanceof CardBytesError);
        assert.equal(error.code, 'card_invalid');
        return true;
    });
});

test('anything that is not a PNG is refused when a PNG is expected', () => {
    for (const bytes of [
        Buffer.from('<!DOCTYPE html><html><script>alert(1)</script>'),
        Buffer.from('GIF89a' + 'x'.repeat(40)),
        Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        Buffer.alloc(4),
        Buffer.alloc(0),
    ]) {
        assert.throws(() => validateCardBytes(bytes, 'png'), CardBytesError);
    }
});

test('a truncated PNG is refused', () => {
    const full = pngWith('chara', V2_CARD);
    for (const cut of [10, 20, full.length - 10, full.length - 1]) {
        assert.throws(() => validateCardBytes(full.subarray(0, cut), 'png'), CardBytesError);
    }
});

test('an absurd chunk length is refused without allocating for it', () => {
    // 0xFFFFFFFF is free for an attacker to write. Reading it as a length and
    // allocating would be an instant out-of-memory.
    const evil = Buffer.concat([
        SIGNATURE, IHDR,
        chunk('tEXt', Buffer.from('chara\0data'), 0xFFFFFFFF),
        IEND,
    ]);

    const before = process.memoryUsage().heapUsed;
    assert.throws(() => validateCardBytes(evil, 'png'), (error) => error.code === 'png_malformed');
    const grew = process.memoryUsage().heapUsed - before;
    assert.ok(grew < 50 * 1024 * 1024, `heap grew by ${grew} bytes; the length field was trusted`);
});

test('a chunk length just past the end of the file is refused', () => {
    const data = Buffer.from('chara\0abc');
    const evil = Buffer.concat([SIGNATURE, IHDR, chunk('tEXt', data, data.length + 1), IEND]);

    assert.throws(() => validateCardBytes(evil, 'png'), (error) => error.code === 'png_malformed');
});

test('a zlib bomb in a zTXt chunk is refused', () => {
    // ~40 MB of zeros compresses to a few KB and would inflate past the cap.
    const bomb = Buffer.concat([
        SIGNATURE, IHDR,
        chunk('zTXt', Buffer.concat([
            Buffer.from('chara', 'latin1'),
            Buffer.from([0, 0]),
            zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024)),
        ])),
        IEND,
    ]);

    assert.throws(() => validateCardBytes(bomb, 'png'), (error) => {
        assert.equal(error.code, 'png_malformed');
        return true;
    });
});

test('IDAT output is bounded and has valid scanline filters', () => {
    const card = textChunk('chara', Buffer.from(JSON.stringify(V2_CARD)).toString('base64'));
    const compressedBomb = chunk('IDAT', zlib.deflateSync(Buffer.alloc(65 * 1024 * 1024)));
    const invalidFilter = chunk('IDAT', zlib.deflateSync(Buffer.from([5, 0, 0, 0, 0])));

    for (const imageData of [compressedBomb, invalidFilter]) {
        const png = Buffer.concat([SIGNATURE, IHDR, card, imageData, IEND]);
        assert.throws(() => validateCardBytes(png, 'png'), (error) => error.code === 'png_malformed');
    }
});

test('a card chunk that is not base64 is refused rather than silently truncated', () => {
    // Buffer.from(x, 'base64') skips invalid characters instead of failing, so
    // without an explicit alphabet check garbage decodes to a short buffer.
    const png = Buffer.concat([SIGNATURE, IHDR, textChunk('chara', '!!!! not base64 !!!!'), IDAT, IEND]);

    assert.throws(() => validateCardBytes(png, 'png'), (error) => error.code === 'card_invalid');
});

test('a chunk table that loops forever is bounded', () => {
    const many = [SIGNATURE, IHDR];
    for (let i = 0; i < 5000; i++) {
        many.push(chunk('tEXt', Buffer.from(`k${i}\0v`)));
    }
    many.push(IEND);

    assert.throws(() => validateCardBytes(Buffer.concat(many), 'png'), (error) => error.code === 'png_malformed');
});

test('PNG CRCs, required chunk order and the exact IEND boundary are enforced', () => {
    const valid = pngWith('chara', V2_CARD);
    const corrupt = Buffer.from(valid);
    corrupt[40] ^= 0x01;

    for (const png of [
        corrupt,
        Buffer.concat([SIGNATURE, textChunk('chara', 'e30='), IHDR, IDAT, IEND]),
        Buffer.concat([SIGNATURE, IHDR, textChunk('chara', 'e30='), IEND]),
        Buffer.concat([valid, Buffer.from('trailing')]),
    ]) {
        assert.throws(() => validateCardBytes(png, 'png'), (error) => error.code === 'png_malformed');
    }
});

test('IHDR rejects dangerous dimensions and illegal colour-depth combinations', () => {
    const cardText = textChunk('chara', Buffer.from(JSON.stringify(V2_CARD)).toString('base64'));

    for (const badHeader of [
        imageHeader({ width: 20_000 }),
        imageHeader({ width: 16_384, height: 16_384 }),
        imageHeader({ bitDepth: 4, colorType: 6 }),
        imageHeader({ bitDepth: 8, colorType: 1 }),
    ]) {
        const png = Buffer.concat([SIGNATURE, badHeader, cardText, IDAT, IEND]);
        assert.throws(() => validateCardBytes(png, 'png'), (error) => error.code === 'png_malformed');
    }
});

function uint32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return buffer;
}

function imageHeader({ width = 1, height = 1, bitDepth = 8, colorType = 6, interlace = 0 } = {}) {
    return chunk('IHDR', Buffer.concat([uint32(width), uint32(height), Buffer.from([bitDepth, colorType, 0, 0, interlace])]));
}

test('indexed cards and plain avatars require a palette before the image data', () => {
    const card = textChunk('chara', Buffer.from(JSON.stringify(V2_CARD)).toString('base64'));
    const image = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0])));
    const palette = chunk('PLTE', Buffer.alloc(6));
    for (const bitDepth of [1, 2, 4, 8]) {
        const header = imageHeader({ colorType: 3, bitDepth });
        for (const pieces of [[image], [image, palette], [palette, palette, image]]) {
            assert.throws(() => validateCardBytes(Buffer.concat([SIGNATURE, header, card, ...pieces, IEND])), { code: 'png_malformed' });
            assert.throws(() => embedCardInPng(Buffer.concat([SIGNATURE, header, ...pieces, IEND]), V2_CARD), { code: 'png_malformed' });
        }
    }
});

test('palette sizes, colour types and dependent chunk order are validated', () => {
    const header = imageHeader({ colorType: 3, bitDepth: 2 });
    const image = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0])));
    const palette = chunk('PLTE', Buffer.alloc(6));
    for (const pieces of [
        [chunk('PLTE', Buffer.alloc(0)), image],
        [chunk('PLTE', Buffer.alloc(4)), image],
        [chunk('PLTE', Buffer.alloc(15)), image],
        [chunk('PLTE', Buffer.alloc(771)), image],
        [chunk('tRNS', Buffer.from([0])), palette, image],
        [chunk('bKGD', Buffer.from([0])), palette, image],
        [chunk('hIST', Buffer.alloc(4)), palette, image],
        [palette, chunk('tRNS', Buffer.alloc(3)), image],
        [palette, chunk('bKGD', Buffer.from([2])), image],
        [palette, chunk('hIST', Buffer.alloc(2)), image],
        [palette, image, chunk('tRNS', Buffer.from([0]))],
    ]) {
        assert.throws(() => embedCardInPng(Buffer.concat([SIGNATURE, header, ...pieces, IEND]), V2_CARD), { code: 'png_malformed' });
    }

    for (const colorType of [0, 4]) {
        const pixels = chunk('IDAT', zlib.deflateSync(Buffer.alloc(colorType === 0 ? 2 : 3)));
        const png = Buffer.concat([SIGNATURE, imageHeader({ colorType }), palette, pixels, IEND]);
        assert.throws(() => embedCardInPng(png, V2_CARD), { code: 'png_malformed' });
    }
    assert.throws(() => embedCardInPng(Buffer.concat([SIGNATURE, IHDR, IDAT, palette, IEND]), V2_CARD), { code: 'png_malformed' });
});

test('all supported colour depths, interlace modes and optional truecolour palettes remain accepted', () => {
    for (const [colorType, channels, depths] of [[0, 1, [1, 2, 4, 8, 16]], [2, 3, [8, 16]], [3, 1, [1, 2, 4, 8]], [4, 2, [8, 16]], [6, 4, [8, 16]]]) {
        for (const bitDepth of depths) {
            for (const interlace of [0, 1]) {
                const paletteOptions = colorType === 3 ? [true] : ([2, 6].includes(colorType) ? [false, true] : [false]);
                for (const hasPalette of paletteOptions) {
                    const png = Buffer.concat([
                        SIGNATURE, imageHeader({ colorType, bitDepth, interlace }),
                        ...(hasPalette ? [chunk('PLTE', Buffer.alloc(3))] : []),
                        ...(colorType === 3 ? [chunk('tRNS', Buffer.from([0])), chunk('bKGD', Buffer.from([0])), chunk('hIST', Buffer.alloc(2))] : []),
                        chunk('IDAT', zlib.deflateSync(Buffer.alloc(1 + Math.ceil(channels * bitDepth / 8)))), IEND,
                    ]);
                    const card = embedCardInPng(png, V2_CARD);
                    assert.equal(validateCardBytes(card).kind, 'png');
                    assert.ok(card.subarray(0, png.length - IEND.length).equals(png.subarray(0, png.length - IEND.length)));
                }
            }
        }
    }
});

test('packed palette indices are checked without treating padding bits as pixels', () => {
    for (const bitDepth of [1, 2, 4, 8]) {
        const header = imageHeader({ colorType: 3, bitDepth });
        for (const entries of [1, 2 ** bitDepth]) {
            const palette = chunk('PLTE', Buffer.alloc(entries * 3));
            const valid = ((entries - 1) << (8 - bitDepth)) | ((1 << (8 - bitDepth)) - 1);
            const png = Buffer.concat([SIGNATURE, header, palette, chunk('IDAT', zlib.deflateSync(Buffer.from([0, valid]))), IEND]);
            assert.equal(validateCardBytes(embedCardInPng(png, V2_CARD)).kind, 'png');
        }
        const bad = Buffer.concat([
            SIGNATURE, header, chunk('PLTE', Buffer.alloc(3)),
            chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1 << (8 - bitDepth)]))), IEND,
        ]);
        assert.throws(() => embedCardInPng(bad, V2_CARD), { code: 'png_malformed' });
    }
});

test('palette index validation reconstructs all five PNG filters', () => {
    const header = imageHeader({ width: 3, height: 2, colorType: 3 });
    const palette = chunk('PLTE', Buffer.alloc(6));
    for (const row of [
        [0, 1, 0, 1],
        [1, 1, 255, 1],
        [2, 0, 255, 1],
        [3, 1, 255, 1],
        [4, 0, 255, 1],
    ]) {
        const raw = Buffer.from([0, 1, 1, 0, ...row]);
        const png = Buffer.concat([SIGNATURE, header, palette, chunk('IDAT', zlib.deflateSync(raw)), IEND]);
        assert.equal(validateCardBytes(embedCardInPng(png, V2_CARD)).kind, 'png');

        raw[raw.length - 1]++;
        const bad = Buffer.concat([SIGNATURE, header, palette, chunk('IDAT', zlib.deflateSync(raw)), IEND]);
        assert.throws(() => embedCardInPng(bad, V2_CARD), { code: 'png_malformed' });
    }
});

test('indexed Adam7 images reset the previous row at each pass', () => {
    const passes = [[1, 1], [1, 1], [2, 1], [2, 2], [4, 2], [4, 4], [8, 4]];
    const raw = Buffer.concat(passes.flatMap(([width, height]) => Array.from({ length: height }, (_, row) =>
        Buffer.concat([Buffer.from([2]), Buffer.alloc(Math.ceil(width * 2 / 8), row === 0 ? 0x55 : 0)]))));
    const header = imageHeader({ width: 8, height: 8, colorType: 3, bitDepth: 2, interlace: 1 });
    const palette = chunk('PLTE', Buffer.alloc(6));
    const png = Buffer.concat([SIGNATURE, header, palette, chunk('IDAT', zlib.deflateSync(raw)), IEND]);
    assert.equal(validateCardBytes(embedCardInPng(png, V2_CARD)).kind, 'png');

    raw[raw.length - 1] = 0x55;
    assert.throws(() => embedCardInPng(Buffer.concat([SIGNATURE, header, palette, chunk('IDAT', zlib.deflateSync(raw)), IEND]), V2_CARD), { code: 'png_malformed' });
});

// ---- JSON cards ----

test('v1, v2 and v3 JSON cards are accepted', () => {
    const v1 = Buffer.from(JSON.stringify({ name: 'Old', description: 'flat card' }));
    assert.equal(parseCardJson(v1).spec, 'chara_card_v1');

    const v2 = Buffer.from(JSON.stringify(V2_CARD));
    assert.equal(parseCardJson(v2).spec, 'chara_card_v2');

    const v3 = Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'New' } }));
    assert.equal(parseCardJson(v3).spec, 'chara_card_v3');
});

test('JSON that is not a card is refused', () => {
    for (const payload of [
        '{}',
        '[]',
        '"a string"',
        '{"spec":"chara_card_v2"}',
        '{"spec":"chara_card_v2","data":"not an object"}',
        '{"spec":"chara_card_v2","data":{}}',
        '{"name":"no description"}',
        '{"spec":"something_else","data":{"name":"x"}}',
        'not json at all',
    ]) {
        assert.throws(() => parseCardJson(Buffer.from(payload)), CardBytesError, `must refuse ${payload}`);
    }
});

test('a card carrying __proto__ is refused and the prototype is untouched', () => {
    const poisoned = '{"spec":"chara_card_v2","data":{"name":"x","__proto__":{"polluted":true}}}';

    assert.throws(() => parseCardJson(Buffer.from(poisoned)), (error) => error.code === 'card_invalid');
    assert.equal({}.polluted, undefined);
});

test('an oversized JSON card is refused', () => {
    const huge = Buffer.from(JSON.stringify({ name: 'x', description: 'y'.repeat(3 * 1024 * 1024) }));
    assert.throws(() => parseCardJson(huge), (error) => error.code === 'too_large');
});

test('a JSON body is accepted when a PNG was expected but bytes say otherwise', () => {
    // Magic bytes are authoritative; `expect` is only a hint.
    const json = Buffer.from(JSON.stringify(V2_CARD));
    assert.equal(validateCardBytes(json, 'png').kind, 'json');
});

// ---- the trust summary ----

test('the summary reports what the card actually contains', () => {
    const inside = describeCard({ spec: 'chara_card_v2', card: V2_CARD });

    assert.equal(inside.lorebookEntries, 3);
    assert.equal(inside.alternateGreetings, 2);
    assert.equal(inside.hasSystemPrompt, true);
    assert.equal(inside.hasPostHistoryInstructions, false);
    assert.equal(inside.specVersion, 'chara_card_v2');
});

test('remote images referenced in a description are counted', () => {
    // These load in chat and report back to whoever hosts them, so the user
    // should know before importing rather than after.
    const inside = describeCard({
        spec: 'chara_card_v2',
        card: { spec: 'chara_card_v2', data: {
            name: 'Tracker',
            description: 'see http://a.example/1.png and https://b.example/2.png and https://b.example/2.png',
        } },
    });

    assert.equal(inside.externalUrls.count, 2, 'duplicates count once');
    assert.deepEqual(inside.externalUrls.hosts.sort(), ['a.example', 'b.example']);
});

test('a minimal card reports zero optional contents', () => {
    const inside = describeCard({
        spec: 'chara_card_v1',
        card: { name: 'Plain', description: 'Nothing special.' },
    });

    assert.equal(inside.lorebookEntries, 0);
    assert.equal(inside.alternateGreetings, 0);
    assert.equal(inside.hasSystemPrompt, false);
    assert.equal(inside.externalUrls.count, 0);
    assert.equal(inside.macros.count, 0);
    assert.equal(inside.html.count, 0);
    assert.deepEqual(inside.privateInfo, []);
    assert.deepEqual(inside.scan, { complete: true, reasons: [] });
});

// ---- the intake report ----

function describeData(data, spec = 'chara_card_v2') {
    return describeCard({ spec, card: { spec, spec_version: '2.0', data } });
}

test('the hash and size come from the bytes, not the card', () => {
    const png = pngWith('chara', V2_CARD);
    const verdict = validateCardBytes(png);

    assert.match(verdict.inside.sha256, /^[0-9a-f]{64}$/);
    assert.equal(verdict.inside.byteSize, png.length);
    // Same card, different bytes: the hash identifies the file, not the character.
    assert.notEqual(verdict.inside.sha256, validateCardBytes(pngWith('ccv3', V2_CARD)).inside.sha256);
});

test('macros are counted and named', () => {
    const inside = describeData({
        name: 'Macro',
        description: 'Hello {{user}}, I am {{char}}. {{user}} again.',
        first_mes: '{{random::a::b}}',
    });

    assert.equal(inside.macros.count, 4);
    assert.deepEqual(inside.macros.names, ['char', 'random', 'user']);
});

test('macro arguments never reach display metadata', () => {
    const sentinel = 'PRIVATE_ARGUMENT_SENTINEL_7351';
    const description = `{{setvar::${sentinel}::value}} {{getvar::${sentinel}}} {{random ${sentinel}}} {{#if ${sentinel}}} {{/if}}`;
    const { promptText, ...display } = describeData({ name: 'Macro', description });

    assert.deepEqual(display.macros, { count: 5, names: ['getvar', 'if', 'random', 'setvar'] });
    assert.ok(!JSON.stringify(display).toLowerCase().includes(sentinel.toLowerCase()));
    assert.equal(promptText.fields.description, description, 'token-only text stays verbatim');
});

test('macro identifiers must end at a delimiter rather than a partial name', () => {
    const name = 'a'.repeat(64);
    const inside = describeData({
        name: '',
        description: `{{${name}}} {{${name}b}} {{setvar:private}} {{name/private}} {{0invalid}} {{_valid2::argument}}`,
    });

    assert.deepEqual(inside.macros, { count: 2, names: ['_valid2', name] });
});

test('HTML is reported with the field it appears in, and script tags flagged separately', () => {
    const plain = describeData({ name: 'A', description: '<b>bold</b> and <i>italic</i>' });
    assert.equal(plain.html.count, 1);
    assert.deepEqual(plain.html.fields, ['description']);
    assert.equal(plain.html.hasScriptOrIframe, false, 'formatting is not a script');

    const scripted = describeData({ name: 'B', description: 'hi <script>alert(1)</script>' });
    assert.equal(scripted.html.hasScriptOrIframe, true);
});

test('a comparison operator is not mistaken for HTML', () => {
    const inside = describeData({ name: 'C', description: 'if x < 3 and y > 4 then...' });

    assert.equal(inside.html.count, 0);
});

test('private details are reported by kind and field, never in full', () => {
    const inside = describeData({
        name: 'Leaky',
        description: 'mail me at jane.doe@example.com',
        creator_notes: 'saved in C:\\Users\\jdoe\\cards and my key is sk-abcdefghijklmnopqrstuvwx',
    });

    const kinds = inside.privateInfo.map((hit) => hit.kind).sort();
    assert.deepEqual(kinds, ['apiKey', 'email', 'homePath']);

    const email = inside.privateInfo.find((hit) => hit.kind === 'email');
    assert.equal(email.field, 'description');
    assert.ok(!email.redacted.includes('jane.doe'), 'the report must not republish the value');
    assert.match(email.redacted, /^ja\*+om$/);
});

test('a version string is not reported as an IP address', () => {
    // Bare IPv4 is deliberately not a pattern: it would fire on every changelog.
    const inside = describeData({ name: 'D', description: 'Card revision 1.2.3.4, tested on 10.0.0.1' });

    assert.deepEqual(inside.privateInfo, []);
});

test('extension blocks are split into ones SillyBunny reads and ones it does not', () => {
    const inside = describeData({
        name: 'E',
        extensions: { depth_prompt: { prompt: 'x' }, regex_scripts: [{}], risu_ext: { a: 1 }, some_client: {} },
    });

    assert.deepEqual(inside.extensions.known.sort(), ['depth_prompt', 'regex_scripts']);
    assert.deepEqual(inside.extensions.unknown.sort(), ['risu_ext', 'some_client']);
    assert.equal(inside.regexScripts, 1);
});

test('fields of the wrong type and outside the format are reported, not repaired', () => {
    const inside = describeData({
        name: 'F',
        tags: 'not-an-array',
        description: 42,
        mystery_field: 'hello',
    });

    const byField = Object.fromEntries(inside.malformed.map((problem) => [problem.field, problem.problem]));
    assert.equal(byField.tags, 'should be an array');
    assert.equal(byField.description, 'should be text');
    assert.equal(byField.mystery_field, 'is not a field in this card format');
    // Reporting only: the value is untouched.
    assert.equal(inside.malformed.length, 3);
});

test('a spec_version disagreeing with the declared spec is reported', () => {
    const inside = describeCard({
        spec: 'chara_card_v3',
        card: { spec: 'chara_card_v3', spec_version: '2.0', data: { name: 'G' } },
    });

    assert.ok(inside.malformed.some((problem) => problem.field === 'spec_version'));
});

test('prompt text comes back verbatim so the browser can measure it', () => {
    const inside = describeData({
        name: 'H',
        description: 'A description.',
        first_mes: 'Hello.',
        system_prompt: 'You are a test.',
    });

    assert.equal(inside.promptText.truncated, false);
    assert.equal(inside.promptText.fields.description, 'A description.');
    assert.equal(inside.promptText.fields.firstMessage, 'Hello.');
    assert.equal(inside.promptText.fields.systemPrompt, 'You are a test.');
    assert.equal(inside.promptText.fields.scenario, '', 'absent fields are empty, not missing');
});

test('an oversized card says it could not be measured rather than guessing', () => {
    const inside = describeData({ name: 'I', description: 'x'.repeat(2 * 1024 * 1024) });

    assert.equal(inside.promptText.truncated, true);
    assert.deepEqual(inside.promptText.fields, {});
});

test('the lorebook is split by whether an entry is always in context', () => {
    const inside = describeData({
        name: 'I',
        character_book: {
            entries: [
                { keys: ['a'], content: 'Always here.', constant: true },
                { keys: ['b'], content: 'Only on a keyword.' },
                { keys: ['c'], content: 'Also only on a keyword.' },
            ],
        },
    });

    assert.equal(inside.promptText.lorebook.truncated, false);
    assert.equal(inside.promptText.lorebook.always, 'Always here.');
    assert.equal(inside.promptText.lorebook.alwaysEntries, 1);
    assert.equal(inside.promptText.lorebook.conditional, 'Only on a keyword.\nAlso only on a keyword.');
    assert.equal(inside.promptText.lorebook.conditionalEntries, 2);
    // Keys decide whether an entry fires; they are not sent to the model, so
    // they are not counted and not shipped.
    assert.ok(!inside.promptText.lorebook.conditional.includes('b'));
});

test('a switched-off lorebook entry costs nothing and is not counted', () => {
    const inside = describeData({
        name: 'I',
        character_book: {
            entries: [
                { content: 'Live entry.' },
                { content: 'Retired entry.', enabled: false },
                { content: 'Explicitly on.', enabled: true },
            ],
        },
    });

    assert.equal(inside.promptText.lorebook.conditionalEntries, 2);
    assert.ok(!inside.promptText.lorebook.conditional.includes('Retired'));
});

test('a card with no lorebook reports none rather than zero', () => {
    assert.equal(describeData({ name: 'I' }).promptText.lorebook, null);
    assert.equal(describeData({ name: 'I', character_book: {} }).promptText.lorebook, null);
});

test('an oversized lorebook is unmeasurable on its own, without spoiling the card fields', () => {
    const inside = describeData({
        name: 'I',
        description: 'A description.',
        character_book: { entries: [{ content: 'x'.repeat(2 * 1024 * 1024) }] },
    });

    assert.equal(inside.promptText.truncated, false, 'the card fields are still measurable');
    assert.equal(inside.promptText.fields.description, 'A description.');
    assert.equal(inside.promptText.lorebook.truncated, true);
    assert.equal(inside.promptText.lorebook.conditional, '');
    assert.equal(inside.promptText.lorebook.conditionalEntries, 1, 'the count survives the cap');
});

test('the scan stays bounded on a deliberately hostile card', () => {
    // Wide and deep, with a URL at every level: the walk must return, and must
    // not be talked into unbounded work by the shape of the input.
    let node = { description: 'https://deep.example/x' };
    for (let depth = 0; depth < 500; depth++) {
        node = { nested: node, description: `https://level${depth}.example/x` };
    }
    const wide = {};
    for (let index = 0; index < 5000; index++) {
        wide[`k${index}`] = `https://wide${index}.example/x`;
    }

    const started = Date.now();
    const inside = describeData({ name: 'J', extensions: { node, wide } });

    assert.ok(Date.now() - started < 2000, 'the walk must not run away');
    assert.ok(inside.externalUrls.count <= 256, 'URL collection is capped');
    assert.ok(inside.externalUrls.hosts.length <= 32, 'host list is capped');
    assert.equal(inside.scan.complete, false);
    assert.ok(inside.scan.reasons.includes('child_limit'));
});

test('inspection reports the exact per-string byte boundary, including multibyte text', () => {
    const limit = 128 * 1024;
    for (const text of ['x', '\u00e9']) {
        const full = text.repeat(limit / Buffer.byteLength(text));
        for (const [description, complete] of [[full.slice(1), true], [full, true], [full + 'x', false]]) {
            const inside = validateCardBytes(Buffer.from(JSON.stringify({ name: '', description }))).inside;
            assert.deepEqual(inside.scan, { complete, reasons: complete ? [] : ['string_limit'] });
            assert.equal(inside.promptText.truncated, false, 'scan and token budgets are independent');
            assert.equal(inside.promptText.fields.description, description);
        }
    }
});

test('text beyond the per-string prefix is unknown, not reported as absent', () => {
    const description = ' '.repeat(128 * 1024) + 'private@example.test <script>hidden</script> {{user}}';
    const inside = describeData({ name: '', description });

    assert.deepEqual(inside.scan, { complete: false, reasons: ['string_limit'] });
    assert.deepEqual(inside.privateInfo, []);
    assert.equal(inside.html.hasScriptOrIframe, false);
    assert.equal(inside.macros.count, 0);
    assert.equal(inside.promptText.fields.description, description);
});

test('inspection reports the aggregate text boundary without skipping empty trailing nodes', () => {
    for (const delta of [-1, 0, 1]) {
        const bytes = 512 * 1024 + delta;
        const texts = Array.from({ length: Math.ceil(bytes / (128 * 1024)) }, (_, index) =>
            'x'.repeat(Math.min(128 * 1024, bytes - index * 128 * 1024)));
        const card = { name: '', description: '', empty: [null, 0, ''], texts };
        const { scan } = validateCardBytes(Buffer.from(JSON.stringify(card))).inside;
        assert.deepEqual(scan, { complete: delta <= 0, reasons: delta <= 0 ? [] : ['text_limit'] });
    }

    const inside = describeData({ name: '', character_book: {
        entries: ['private@example.test', ...Array(4).fill(' '.repeat(128 * 1024))],
    } });
    assert.equal(inside.scan.complete, false);
    assert.ok(inside.scan.reasons.includes('text_limit'));
    assert.deepEqual(inside.privateInfo, []);
});

test('inspection reports the exact node boundary even when the remaining node is empty', () => {
    for (const total of [9999, 10_000, 10_001]) {
        const leaves = total - 44; // Root, two text fields, one outer array and 40 inner arrays.
        const groups = Array.from({ length: 40 }, (_, index) =>
            Array(Math.floor(leaves / 40) + (index < leaves % 40 ? 1 : 0)).fill(null));
        const card = { name: '', description: '', groups };
        const { scan } = validateCardBytes(Buffer.from(JSON.stringify(card))).inside;
        assert.deepEqual(scan, { complete: total <= 10_000, reasons: total <= 10_000 ? [] : ['node_limit'] });
    }
});

test('inspection reports omitted object properties and array elements at any depth', () => {
    for (const count of [255, 256, 257]) {
        for (const value of [
            Array(count).fill(''),
            Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, ''])),
        ]) {
            for (const nested of [value, { deeper: { value } }]) {
                const card = { name: '', description: '', nested };
                const { scan } = validateCardBytes(Buffer.from(JSON.stringify(card))).inside;
                assert.deepEqual(scan, { complete: count <= 256, reasons: count <= 256 ? [] : ['child_limit'] });
            }
        }
    }
});

test('inspection covers wrapper fields and cannot call a skipped data object complete', () => {
    for (const spec of ['chara_card_v2', 'chara_card_v3']) {
        const card = { spec, data: { name: '', description: '{{user}}' }, extra: { value: 'private@example.test' } };
        const inside = validateCardBytes(Buffer.from(JSON.stringify(card))).inside;
        assert.deepEqual(inside.scan, { complete: true, reasons: [] });
        assert.equal(inside.privateInfo[0].field, 'extra');
        assert.deepEqual(inside.macros.names, ['user']);

        const wide = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`field${index}`, null]));
        const skipped = validateCardBytes(Buffer.from(JSON.stringify({ ...wide, ...card }))).inside;
        assert.equal(skipped.scan.complete, false);
        assert.ok(skipped.scan.reasons.includes('child_limit'));
    }
});

test('bounded findings distinguish a full list from an omitted additional finding', () => {
    const cases = [
        [256, (count) => ({ description: Array.from({ length: count }, (_, index) => `https://one.example/${index}`).join(' ') })],
        [32, (count) => ({ description: Array.from({ length: count }, (_, index) => `https://host${index}.example/`).join(' ') })],
        [64, (count) => ({ description: Array.from({ length: count }, (_, index) => `{{macro${index}}}`).join(' ') })],
        [32, (count) => ({ description: Array.from({ length: count }, (_, index) => `user${index}@example.test`).join(' ') })],
        [16, (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, '<b>text</b>']))],
    ];
    for (const [limit, fields] of cases) {
        for (const count of [limit - 1, limit, limit + 1]) {
            const card = { name: '', description: '', ...fields(count) };
            const inside = validateCardBytes(Buffer.from(JSON.stringify(card))).inside;
            assert.deepEqual(inside.scan, { complete: count <= limit, reasons: count <= limit ? [] : ['finding_limit'] });
        }
    }

    for (const count of [31, 32, 33]) {
        const fields = Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, null]));
        const inside = describeData({ name: '', ...fields });
        assert.equal(inside.malformed.length, Math.min(count, 32));
        assert.deepEqual(inside.scan, { complete: count <= 32, reasons: count <= 32 ? [] : ['finding_limit'] });
    }
});

test('duplicate findings at the collection limits do not make inspection incomplete', () => {
    const description = [
        ...Array.from({ length: 256 }, (_, index) => `https://one.example/${index}`),
        ...Array.from({ length: 64 }, (_, index) => `{{macro${index}}}`),
        ...Array.from({ length: 32 }, (_, index) => `user${index}@example.test`),
        'https://one.example/0 {{macro0}} user0@example.test',
    ].join(' ');
    const inside = describeData({ name: '', description });
    assert.deepEqual(inside.scan, { complete: true, reasons: [] });
    assert.equal(inside.externalUrls.count, 256);
    assert.equal(inside.macros.count, 65);
    assert.equal(inside.privateInfo.length, 32);
});

test('all inspection limit reasons are unique, stable codes even when several limits apply', () => {
    const card = {
        name: '', description: '',
        groups: Array.from({ length: 40 }, () => Array(256).fill(null)),
        wide: Array(300).fill(''),
        texts: Array(5).fill('x'.repeat(128 * 1024 + 1)),
        urls: Array.from({ length: 300 }, (_, index) => `https://one.example/${index}`).join(' '),
    };
    const inside = validateCardBytes(Buffer.from(JSON.stringify(card))).inside;
    assert.deepEqual(inside.scan, {
        complete: false,
        reasons: ['child_limit', 'finding_limit', 'node_limit', 'string_limit', 'text_limit'],
    });
});

test('a cycle in the card does not hang the scan', () => {
    const data = { name: 'K', description: 'https://a.example/1' };
    data.extensions = { self: data };

    assert.equal(describeData(data).externalUrls.count, 1);
});

test('a long unbroken string does not make the scan quadratic', () => {
    // Regression: the email pattern once had no leading \b, so a megabyte of
    // characters its first class accepts sent it scanning to the end from every
    // position. This card hung the inspector for minutes.
    const started = Date.now();
    describeData({ name: 'L', description: 'a.b-c_d'.repeat(200_000) });

    assert.ok(Date.now() - started < 1000, 'scanning must be linear in the text length');
});

test('a plain picture becomes a card with its image bytes untouched', () => {
    const picture = Buffer.concat([SIGNATURE, IHDR, IDAT, IEND]);

    const card = embedCardInPng(picture, V2_CARD);

    assert.ok(card.subarray(0, picture.length - 12).equals(picture.subarray(0, picture.length - 12)), 'image chunks are copied through');
    assert.ok(card.subarray(card.length - 12).equals(IEND), 'IEND stays last');
    const verdict = validateCardBytes(card, 'png');
    assert.equal(verdict.kind, 'png');
    assert.equal(verdict.inside.name, 'Test Character');
    assert.equal(verdict.inside.alternateGreetings, 2);

    assert.throws(() => embedCardInPng(card, V2_CARD), (error) => error instanceof CardBytesError);
    assert.throws(() => embedCardInPng(Buffer.from('not a png'), V2_CARD), (error) => error instanceof CardBytesError);
});
