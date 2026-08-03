import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_INGEST_BYTES } from '../shared/schema.js';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function streamResponse(chunks, { headers = {}, onCancel, close = true } = {}) {
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            if (close) {
                controller.close();
            }
        },
        cancel() {
            onCancel?.();
        },
    }), { status: 200, headers });
}

function installClient(fetchImpl) {
    const previousFetch = globalThis.fetch;
    const previousSillyTavern = globalThis.SillyTavern;
    const previousWindow = globalThis.window;
    globalThis.fetch = fetchImpl;
    globalThis.window = { location: { origin: 'https://local.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }) }),
    };
    return () => {
        globalThis.fetch = previousFetch;
        globalThis.SillyTavern = previousSillyTavern;
        globalThis.window = previousWindow;
    };
}

const SOURCE = Object.freeze({ id: 'chub', directHosts: ['gateway.chub.ai'] });
const DIRECT_URL = 'https://gateway.chub.ai/api/characters?search=elf';

test('browser-direct requests stream a checked response and ingest it only after success', async () => {
    const calls = [];
    const restore = installClient(async (url, options) => {
        calls.push({ url: String(url), options });
        if (calls.length === 1) {
            return jsonResponse({ mode: 'direct', kind: 'search', url: DIRECT_URL, reason: 'forbidden' });
        }
        if (calls.length === 2) {
            return streamResponse([new TextEncoder().encode('{"data":{"nodes":[]}}')]);
        }
        return jsonResponse({ items: [], total: 0 });
    });

    try {
        const { postRouted } = await import('../client/api.js?direct-stream-success');
        const notices = [];
        const result = await postRouted('/search', { query: 'elf', limit: 24 }, SOURCE, {
            allowDirect: true,
            onDirect: (reason) => notices.push(reason),
        });

        assert.deepEqual(result, { items: [], total: 0 });
        assert.equal(calls.length, 3);
        assert.equal(calls[1].url, DIRECT_URL);
        assert.equal(calls[1].options.credentials, 'omit');
        assert.equal(calls[1].options.referrerPolicy, 'no-referrer');
        assert.equal(calls[1].options.redirect, 'error');
        assert.equal(calls[1].options.cache, 'no-store');
        assert.equal(calls[2].url.endsWith('/ingest'), true);
        assert.deepEqual(JSON.parse(calls[2].options.body), {
            query: 'elf',
            limit: 24,
            kind: 'search',
            payload: { data: { nodes: [] } },
        });
        assert.deepEqual(notices, ['forbidden']);
    } finally {
        restore();
    }
});

test('browser-direct requests reject and cancel a chunked oversized response before ingesting it', async () => {
    let cancelled = false;
    let calls = 0;
    const restore = installClient(async () => {
        calls++;
        if (calls === 1) {
            return jsonResponse({ mode: 'direct', kind: 'search', url: DIRECT_URL });
        }
        return streamResponse([new Uint8Array(MAX_INGEST_BYTES + 1)], {
            onCancel: () => { cancelled = true; },
            close: false,
        });
    });

    try {
        const { postRouted } = await import('../client/api.js?direct-stream-too-large');
        await assert.rejects(
            () => postRouted('/search', { query: 'elf' }, SOURCE, { allowDirect: true }),
            (error) => error.code === 'too_large',
        );
        assert.equal(calls, 2, 'the oversized response must never be posted to /ingest');
        assert.equal(cancelled, true, 'the stream must be cancelled when the cap is crossed');
    } finally {
        restore();
    }
});

test('browser-direct requests reject hosts outside the published direct allow-list', async () => {
    let calls = 0;
    const restore = installClient(async () => {
        calls++;
        return jsonResponse({
            mode: 'direct',
            kind: 'search',
            url: 'https://avatars.charhub.io/unsafe-browser-hop',
        });
    });

    try {
        const { postRouted } = await import('../client/api.js?direct-host-check');
        await assert.rejects(
            () => postRouted('/search', { query: 'elf' }, SOURCE, { allowDirect: true }),
            (error) => error.code === 'bad_direct_url',
        );
        assert.equal(calls, 1, 'an invalid direct URL must not be fetched');
    } finally {
        restore();
    }
});

test('bounded response reading coalesces highly fragmented bodies', async () => {
    const restore = installClient(async () => jsonResponse({}));
    try {
        const { readResponseBytes } = await import('../client/api.js?fragmented-response');
        const fragments = Array.from({ length: 4096 }, () => Uint8Array.of(120));
        const bytes = await readResponseBytes(streamResponse(fragments), MAX_INGEST_BYTES);

        assert.equal(bytes.byteLength, fragments.length);
        assert.equal(new TextDecoder().decode(bytes), 'x'.repeat(fragments.length));
    } finally {
        restore();
    }
});
