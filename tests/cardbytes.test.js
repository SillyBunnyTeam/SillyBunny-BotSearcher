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

import { validateCardBytes, parseCardJson, describeCard, CardBytesError } from '../server/cardbytes.js';

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

const IHDR = chunk('IHDR', Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), // 1x1
    Buffer.from([8, 6, 0, 0, 0]),
]));
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
    const header = ({ width = 1, height = 1, bitDepth = 8, colorType = 6 }) => chunk('IHDR', Buffer.concat([
        uint32(width),
        uint32(height),
        Buffer.from([bitDepth, colorType, 0, 0, 0]),
    ]));

    for (const badHeader of [
        header({ width: 20_000 }),
        header({ width: 16_384, height: 16_384 }),
        header({ bitDepth: 4, colorType: 6 }),
        header({ bitDepth: 8, colorType: 1 }),
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
    assert.deepEqual(inside.macros.names, ['char', 'random::a::b', 'user']);
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
