/**
 * The /inspect and /clean routes.
 *
 * These are the only routes on this plugin that name no source and make no
 * outbound request — they exist so that a card the browser already holds can be
 * described before it is imported, whether it came from a source, from
 * SillyBunny's own downloader, or off the user's disk.
 *
 * The properties worth pinning: they read bytes and never return anything
 * importable from /inspect, they refuse oversized and wrongly-typed bodies
 * before parsing, and they cannot be talked into accepting a body larger than
 * the cap by lying about its length.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import zlib from 'node:zlib';

import { createRouter } from '../server/router.js';
import { MAX_CARD_BYTES } from '../shared/schema.js';

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

const IHDR = chunk('IHDR', Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from([8, 6, 0, 0, 0])]));
const IDAT = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0])));
const IEND = chunk('IEND', Buffer.alloc(0));

const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: 'Inspectable',
        description: 'Reach me at jane.doe@example.com',
        extensions: { regex_scripts: [{ scriptName: 'x' }], mystery_block: { a: 1 } },
    },
};

function cardPng(card = CARD) {
    const base64 = Buffer.from(JSON.stringify(card)).toString('base64');
    const text = chunk('tEXt', Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(base64, 'latin1')]));
    return Buffer.concat([SIGNATURE, IHDR, text, IDAT, IEND]);
}

/** Mounts the real router. The host's json parser runs first, as it does live. */
function mount() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    const router = express.Router();
    createRouter(router, { startedAt: Date.now() });
    app.use(router);

    const server = app.listen(0, '127.0.0.1');
    const ready = new Promise((resolve) => server.once('listening', resolve));

    return {
        async send(path, body, { contentType = 'application/octet-stream', headers = {} } = {}) {
            await ready;
            const { port } = server.address();
            return fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': contentType, ...headers },
                body,
                duplex: 'half',
            });
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test('/inspect describes the bytes and returns nothing importable', async () => {
    const app = mount();
    try {
        const response = await app.send('/inspect', cardPng());
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/);

        const body = await response.json();
        assert.equal(body.kind, 'png');
        assert.equal(body.spec, 'chara_card_v2');
        assert.equal(body.inside.name, 'Inspectable');
        assert.equal(body.inside.regexScripts, 1);
        assert.deepEqual(body.inside.extensions.unknown, ['mystery_block']);
        assert.equal(body.inside.privateInfo[0].kind, 'email');
        assert.match(body.inside.sha256, /^[0-9a-f]{64}$/);

        // The report is a description. Nothing here is a card.
        assert.equal(body.bytes, undefined);
        assert.equal(body.card, undefined);
    } finally {
        await app.close();
    }
});

test('/inspect refuses bytes that are not a card', async () => {
    const app = mount();
    try {
        const response = await app.send('/inspect', Buffer.from('just some text'));
        assert.equal(response.status, 422);
        assert.equal((await response.json()).error, 'card_invalid');
    } finally {
        await app.close();
    }
});

test('/inspect refuses a body that is not octet-stream', async () => {
    const app = mount();
    try {
        const response = await app.send('/inspect', JSON.stringify({ hi: true }), { contentType: 'application/json' });
        assert.equal(response.status, 415);
        assert.equal((await response.json()).error, 'unsupported_media_type');
    } finally {
        await app.close();
    }
});

test('/inspect refuses an empty body', async () => {
    const app = mount();
    try {
        const response = await app.send('/inspect', Buffer.alloc(0));
        assert.equal(response.status, 400);
    } finally {
        await app.close();
    }
});

test('a body over the cap is refused on its declared length, before parsing', async () => {
    const app = mount();
    try {
        // A plain oversized buffer carries an honest Content-Length, which is
        // the branch that rejects without reading the body at all.
        const response = await app.send('/inspect', Buffer.alloc(MAX_CARD_BYTES + 1));
        assert.equal(response.status, 413);
        assert.equal((await response.json()).error, 'payload_too_large');
    } finally {
        await app.close();
    }
});

test('a body that outgrows the cap while streaming is cut off', async () => {
    // Content-Length is absent on a streamed body, so the only defence is the
    // running total. Without it a chunked body could allocate without limit.
    const app = mount();
    try {
        const oversized = new ReadableStream({
            start(controller) {
                for (let sent = 0; sent <= MAX_CARD_BYTES; sent += 64 * 1024) {
                    controller.enqueue(new Uint8Array(64 * 1024));
                }
                controller.close();
            },
        });

        const response = await app.send('/inspect', oversized);
        assert.equal(response.status, 413);
    } finally {
        await app.close();
    }
});

test('/clean returns importable bytes with the profile applied', async () => {
    const app = mount();
    try {
        const response = await app.send('/clean', cardPng());
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/octet-stream');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

        const cleaned = Buffer.from(await response.arrayBuffer());

        // Feed the result straight back to /inspect: the route's own output must
        // satisfy the route's own validator.
        const report = await (await app.send('/inspect', cleaned)).json();
        assert.equal(report.inside.regexScripts, 0);
        assert.deepEqual(report.inside.extensions.unknown, []);
        assert.deepEqual(report.inside.privateInfo, []);
        assert.equal(report.inside.name, 'Inspectable');
    } finally {
        await app.close();
    }
});

test('/clean refuses bytes that are not a card', async () => {
    const app = mount();
    try {
        const response = await app.send('/clean', Buffer.from(JSON.stringify({ not: 'a card' })));
        assert.equal(response.status, 422);
    } finally {
        await app.close();
    }
});
