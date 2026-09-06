/**
 * Clean import.
 *
 * The stripper edits a file the user is about to import, so these tests care as
 * much about what SURVIVES as about what goes: a cleaner that quietly damages
 * the image, drops the lorebook, or leaves a stale copy of the uncleaned card
 * in a second chunk would be worse than no cleaner at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { cleanCard } from '../server/cardclean.js';
import { validateCardBytes, CardBytesError } from '../server/cardbytes.js';

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

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

const IHDR = chunk('IHDR', Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
    Buffer.from([8, 6, 0, 0, 0]),
]));
const IDAT = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])));
const IEND = chunk('IEND', Buffer.alloc(0));

function textChunk(keyword, text) {
    return chunk('tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'latin1'),
    ]));
}

function cardChunk(keyword, cardObject) {
    return textChunk(keyword, Buffer.from(JSON.stringify(cardObject)).toString('base64'));
}

/** A card with one of everything the profile has an opinion about. */
function dirtyCard(spec = 'chara_card_v2') {
    return {
        spec,
        spec_version: spec === 'chara_card_v3' ? '3.0' : '2.0',
        data: {
            name: 'Dirty',
            description: 'Written by jane.doe@example.com in C:\\Users\\jdoe\\cards',
            personality: 'Curious',
            first_mes: 'Hello there.',
            system_prompt: 'You are a test.',
            post_history_instructions: 'Stay in character.',
            alternate_greetings: ['Hi.', 'Hey.'],
            character_book: { entries: [{ keys: ['a'] }, { keys: ['b'] }] },
            tags: ['test'],
            creator: 'jdoe',
            extensions: {
                depth_prompt: { prompt: 'keep me', depth: 4 },
                regex_scripts: [{ scriptName: 'rewrite', findRegex: '/a/g', replaceString: 'b' }],
                risu_ext: { anything: true },
            },
            secret_field: 'not in the spec',
        },
    };
}

function pngWith(...chunks) {
    return Buffer.concat([SIGNATURE, IHDR, ...chunks, IDAT, IEND]);
}

function cardInside(buffer) {
    return validateCardBytes(buffer).inside;
}

// ---- what goes ----

test('the profile removes exactly what it says it removes', () => {
    const { inside } = validateCardBytes(pngWith(cardChunk('chara', dirtyCard())));
    assert.equal(inside.regexScripts, 1, 'the fixture must actually be dirty');

    const cleaned = cleanCard(pngWith(cardChunk('chara', dirtyCard())));
    const after = cardInside(cleaned.buffer);

    assert.equal(after.regexScripts, 0);
    assert.deepEqual(after.extensions.unknown, [], 'unknown extension blocks are gone');
    assert.ok(!after.malformed.some((problem) => problem.field === 'secret_field'));
    assert.deepEqual(after.privateInfo, [], 'the email and the home path are gone');
});

test('every removal is reported by kind', () => {
    const { removed } = cleanCard(pngWith(cardChunk('chara', dirtyCard())));
    const kinds = new Set(removed.map((entry) => entry.kind));

    assert.ok(kinds.has('regexScripts'));
    assert.ok(kinds.has('unknownExtensions'));
    assert.ok(kinds.has('unrecognisedFields'));
    assert.ok(kinds.has('privateInfo'));
    assert.ok(removed.some((entry) => entry.kind === 'unknownExtensions' && entry.detail === 'risu_ext'));
});

// ---- what stays ----

test('the character survives the clean', () => {
    const cleaned = cleanCard(pngWith(cardChunk('chara', dirtyCard())));
    const after = cardInside(cleaned.buffer);

    assert.equal(after.lorebookEntries, 2, 'a lorebook is the character, not clutter');
    assert.equal(after.alternateGreetings, 2);
    assert.equal(after.hasSystemPrompt, true);
    assert.equal(after.hasPostHistoryInstructions, true);
    assert.equal(after.hasDepthPrompt, true, 'depth_prompt is a block SillyBunny reads');
    assert.equal(after.promptText.fields.personality, 'Curious');
    assert.equal(after.promptText.fields.firstMessage, 'Hello there.');
});

test('private details are replaced in place, leaving the sentence around them', () => {
    const cleaned = cleanCard(pngWith(cardChunk('chara', dirtyCard())));
    const description = cardInside(cleaned.buffer).promptText.fields.description;

    assert.ok(!description.includes('jane.doe@example.com'));
    assert.ok(!description.includes('jdoe\\cards'));
    assert.ok(description.startsWith('Written by '), 'the author\'s own words stay');
    assert.ok(description.includes('[removed]'));
});

test('the image is spliced, not re-encoded', () => {
    const original = pngWith(cardChunk('chara', dirtyCard()));
    const cleaned = cleanCard(original).buffer;

    for (const piece of [IHDR, IDAT, IEND]) {
        assert.ok(cleaned.includes(piece), 'image chunks must pass through byte for byte');
    }
    assert.ok(cleaned.subarray(0, 8).equals(SIGNATURE));
});

test('indexed avatars keep their palette, transparency and pixels through cleaning', () => {
    const header = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 0, 0, 0]));
    const palette = chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255]));
    const transparency = chunk('tRNS', Buffer.from([0, 255]));
    const image = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0x40])));
    const card = cardChunk('chara', dirtyCard());
    const original = Buffer.concat([SIGNATURE, header, palette, transparency, card, image, IEND]);
    const cleaned = cleanCard(original).buffer;
    for (const piece of [header, palette, transparency, image, IEND]) {
        assert.ok(cleaned.includes(piece));
    }
    assert.deepEqual(cardInside(cleaned).privateInfo, []);
    assert.throws(() => cleanCard(Buffer.concat([SIGNATURE, header, card, image, IEND])), { code: 'png_malformed' });
});

// ---- the trap ----

test('both card chunks are rewritten so no stale copy survives', () => {
    // The host writes `chara` and `ccv3` as a pair and prefers `ccv3` on read.
    // Cleaning only the one this plugin reads would leave the uncleaned card
    // sitting in the other, reachable by any v2 reader.
    const original = pngWith(
        cardChunk('chara', dirtyCard('chara_card_v2')),
        cardChunk('ccv3', dirtyCard('chara_card_v3')),
    );

    const cleaned = cleanCard(original).buffer;

    assert.ok(!cleaned.toString('latin1').includes('risu_ext'), 'via either chunk');
    assert.ok(!cleaned.includes(Buffer.from('jane.doe@example.com')));
    // Both chunks are still present, and both now carry the cleaned card.
    const text = cleaned.toString('latin1');
    assert.ok(text.includes('chara\0') && text.includes('ccv3\0'), 'neither chunk is dropped');
    assert.equal(cardInside(cleaned).regexScripts, 0);
});

test('a clean card comes back importable and unchanged in substance', () => {
    const plain = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Clean', description: 'Nothing to strip.' } };
    const { buffer, removed } = cleanCard(pngWith(cardChunk('chara', plain)));

    assert.deepEqual(removed, []);
    assert.equal(cardInside(buffer).promptText.fields.description, 'Nothing to strip.');
});

// ---- JSON cards ----

test('a JSON card is cleaned too', () => {
    const bytes = Buffer.from(JSON.stringify(dirtyCard()), 'utf8');
    const { buffer } = cleanCard(bytes);
    const after = cardInside(buffer);

    assert.equal(after.regexScripts, 0);
    assert.equal(after.lorebookEntries, 2);
    assert.deepEqual(after.privateInfo, []);
});

test('a v1 card keeps its fields, having no field list to measure against', () => {
    const v1 = { name: 'Old', description: 'Plain v1 card.', custom_thing: 'kept' };
    const { buffer, removed } = cleanCard(Buffer.from(JSON.stringify(v1), 'utf8'));

    assert.deepEqual(removed, []);
    assert.equal(JSON.parse(buffer.toString('utf8')).custom_thing, 'kept');
});

// ---- refusal ----

test('bytes that are not a card are refused rather than cleaned', () => {
    for (const bytes of [Buffer.from('not a card'), Buffer.alloc(0), pngWith(textChunk('Comment', 'no card here'))]) {
        assert.throws(() => cleanCard(bytes), CardBytesError);
    }
});

test('the small lorebook that previously retained an inspected email now refuses partial cleaning', () => {
    const entries = Array.from({ length: 10_000 }, () => ({}));
    entries[0].content = 'private@example.test';
    const card = { spec: 'chara_card_v2', data: { name: 'Budget', character_book: { entries } } };
    const json = Buffer.from(JSON.stringify(card));
    assert.ok(json.length < 31_000, 'the regression does not depend on a large file');

    for (const bytes of [json, pngWith(cardChunk('chara', card))]) {
        const original = Buffer.from(bytes);
        assert.ok(cardInside(bytes).privateInfo.some((hit) => hit.kind === 'email'));
        assert.throws(() => cleanCard(bytes), { name: 'CardBytesError', code: 'clean_incomplete', detail: 'node_limit' });
        assert.ok(bytes.equals(original), 'refusal leaves the original file untouched');
    }
});

test('cleaning refuses over-wide retained objects rather than skipping properties', () => {
    for (const count of [255, 256, 257]) {
        const fields = Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, '']));
        fields[`field${count - 1}`] = 'private@example.test';
        for (const card of [
            { name: '', description: '', character_book: { entries: [{ nested: fields }] } },
            { spec: 'chara_card_v2', data: { name: '', extensions: { depth_prompt: fields } } },
            { spec: 'chara_card_v3', data: { name: '' }, extra: fields },
        ]) {
            const bytes = Buffer.from(JSON.stringify(card));
            if (count > 256) {
                assert.throws(() => cleanCard(bytes), { code: 'clean_incomplete', detail: 'child_limit' });
            } else {
                const cleaned = cleanCard(bytes);
                assert.ok(!cleaned.buffer.includes(Buffer.from('private@example.test')));
                assert.ok(cleaned.buffer.includes(Buffer.from('[removed]')));
            }
        }
    }
});

test('cleaning counts the exact object-node boundary without rejecting a finished traversal', () => {
    for (const total of [9999, 10_000, 10_001]) {
        const leaves = total - 42; // Root, one outer array and 40 inner arrays.
        const groups = Array.from({ length: 40 }, (_, index) =>
            Array.from({ length: Math.floor(leaves / 40) + (index < leaves % 40 ? 1 : 0) }, () => ({})));
        groups[0][0].content = 'private@example.test';
        const bytes = Buffer.from(JSON.stringify({ name: '', description: '', groups }));
        if (total > 10_000) {
            assert.throws(() => cleanCard(bytes), { code: 'clean_incomplete', detail: 'node_limit' });
        } else {
            const cleaned = cleanCard(bytes);
            assert.ok(!cleaned.buffer.includes(Buffer.from('private@example.test')));
            assert.equal(JSON.parse(cleaned.buffer).groups[0][0].content, '[removed]');
        }
    }
});

test('cleaning still scans every array element and the text beyond inspection prefixes', () => {
    const card = {
        name: '',
        description: ' '.repeat(1024 * 1024) + 'private@example.test',
        alternate_greetings: [...Array(300).fill(''), 'private@example.test'],
    };
    const bytes = Buffer.from(JSON.stringify(card));
    assert.equal(cardInside(bytes).scan.complete, false);
    const cleaned = JSON.parse(cleanCard(bytes).buffer);
    assert.equal(cleaned.description, ' '.repeat(1024 * 1024) + '[removed]');
    assert.equal(cleaned.alternate_greetings.length, 301);
    assert.equal(cleaned.alternate_greetings[300], '[removed]');
});

test('oversized blocks removed by the profile do not prevent a complete clean', () => {
    const block = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field${index}`, 'private@example.test']));
    const card = { spec: 'chara_card_v2', data: { name: 'Kept', extra: block, extensions: { unknown: block } } };
    const cleaned = cleanCard(Buffer.from(JSON.stringify(card)));
    assert.deepEqual(JSON.parse(cleaned.buffer), { spec: 'chara_card_v2', data: { name: 'Kept', extensions: {} } });
});
