import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRouter } from '../server/router.js';
import { SOURCES } from '../server/registry.js';
import {
    createVocabularyCache,
    getVocabulary,
    clearVocabularyCache,
    VOCABULARY_TTL_MS,
} from '../server/vocabulary.js';
import { createVocabularyLoader } from '../client/vocabulary.js';

function vocabularyAdapter(id = 'example') {
    return {
        id,
        capabilities: { tagVocabulary: true },
        fetchVocabulary: async () => [],
    };
}

test('the server vocabulary cache single-flights by source id and expires on its TTL', async () => {
    let clock = 100;
    let calls = 0;
    let release;
    const upstream = new Promise((resolve) => { release = resolve; });
    const cache = createVocabularyCache({ ttlMs: 10, now: () => clock });
    const adapter = vocabularyAdapter();

    const first = cache.get(adapter, () => {
        calls++;
        return upstream;
    });
    const second = cache.get(adapter, () => {
        calls++;
        return Promise.resolve([]);
    });

    assert.strictEqual(first, second, 'concurrent callers share the pending promise');
    assert.equal(calls, 0, 'loading begins on the next microtask');
    release([{ n: 'elf', c: 'Character', k: 20 }]);
    assert.deepEqual(await first, [{ n: 'elf', c: 'Character', k: 20 }]);
    assert.equal(calls, 1);

    clock = 109;
    const cached = await cache.get(vocabularyAdapter(), async () => {
        calls++;
        return [];
    });
    assert.equal(cached[0].n, 'elf');
    assert.equal(calls, 1, 'an adapter object with the same id shares the cache');

    clock = 110;
    const refreshed = await cache.get(adapter, async () => {
        calls++;
        return [{ n: 'orc', c: 'Character', k: 8 }];
    });
    assert.equal(refreshed[0].n, 'orc');
    assert.equal(calls, 2);
});

test('the server vocabulary TTL is twelve hours and unsupported sources never load', async () => {
    assert.equal(VOCABULARY_TTL_MS, 12 * 60 * 60 * 1000);

    let calls = 0;
    const cache = createVocabularyCache();
    const tags = await cache.get({
        id: 'unsupported',
        capabilities: { tagVocabulary: false },
        fetchVocabulary: async () => { calls++; return ['wrong']; },
    }, async () => { calls++; return ['wrong']; });
    const missingMethod = await cache.get({
        id: 'missing', capabilities: { tagVocabulary: true },
    }, async () => { calls++; return ['wrong']; });

    assert.deepEqual(tags, []);
    assert.deepEqual(missingMethod, []);
    assert.equal(calls, 0);
});

test('POST /tags returns cached capable-source tags and an empty unsupported result', async (t) => {
    clearVocabularyCache();
    await getVocabulary(SOURCES.botbooru, async () => [{ n: 'english', c: 'Language', k: 37 }]);

    const app = express();
    app.use(express.json());
    const router = express.Router();
    createRouter(router, { startedAt: Date.now() });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(async () => {
        clearVocabularyCache();
        await new Promise((resolve) => server.close(resolve));
    });

    const post = async (source) => {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source }),
        });
        return { status: response.status, body: await response.json() };
    };

    assert.deepEqual(await post('botbooru'), {
        status: 200,
        body: { tags: [{ n: 'english', c: 'Language', k: 37 }] },
    });
    assert.deepEqual(await post('chub'), { status: 200, body: { tags: [] } });
});

test('the client loads once per source and silently caches an empty failure', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });

    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        if (requests.length === 2) {
            throw new Error('offline');
        }
        return new Response(JSON.stringify({ tags: [{ n: 'elf', c: 'Character', k: 20 }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    const loader = createVocabularyLoader();
    const capable = { id: 'botbooru', capabilities: { tagVocabulary: true } };
    assert.deepEqual(await loader.load(capable), [{ n: 'elf', c: 'Character', k: 20 }]);
    assert.deepEqual(await loader.load(capable), [{ n: 'elf', c: 'Character', k: 20 }]);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/tags$/);
    assert.deepEqual(requests[0].body, { source: 'botbooru' });

    assert.deepEqual(await loader.load({ id: 'other', capabilities: { tagVocabulary: true } }), []);
    assert.deepEqual(await loader.load({ id: 'other', capabilities: { tagVocabulary: true } }), []);
    assert.deepEqual(await loader.load({ id: 'none', capabilities: {} }), []);
    assert.equal(requests.length, 2, 'failure and unsupported source do not trigger retries');
});
