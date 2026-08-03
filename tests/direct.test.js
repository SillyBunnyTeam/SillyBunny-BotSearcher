/**
 * The browser-direct request path.
 *
 * Chub sits behind Cloudflare and answers datacenter ranges with a flat 403, so
 * a SillyBunny hosted anywhere but a home connection cannot reach it while the
 * user's own browser can. When that happens the fetch moves to the browser and
 * the response comes back to /ingest to be parsed here.
 *
 * That moves ONE hop and nothing else. These tests pin the parts that would make
 * it a hole instead of a route: /ingest must not become a way to feed arbitrary
 * data in under a source's name, and the direct result must be identical to what
 * the server-side path would have produced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRouter } from '../server/router.js';
import { chub } from '../server/sources/chub.js';
import { SOURCES } from '../server/registry.js';
import { markFailure, clearAll } from '../server/health.js';
import { mintCursor, mintToken } from '../server/refs.js';
import { MAX_FANOUT } from '../shared/schema.js';
import { readFileSync } from 'node:fs';

function fixture(name) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/** Mounts the real router and returns a fetch-like caller. */
function mount() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    const router = express.Router();
    createRouter(router, { startedAt: Date.now() });
    app.use(router);

    const server = app.listen(0, '127.0.0.1');
    const ready = new Promise((resolve) => server.once('listening', resolve));

    return {
        ready,
        async post(path, body) {
            await ready;
            const { port } = server.address();
            const response = await fetch(`http://127.0.0.1:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            let payload = null;
            try {
                payload = await response.json();
            } catch {
                // Some failures answer with no body; the status carries it.
            }
            return { status: response.status, body: payload };
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/** Marks a source blocked the way a Cloudflare 403 does. */
function block(sourceId) {
    markFailure(sourceId, { code: 'http_error', detail: '403' });
}

test('a blocked source is handed to the browser instead of failing', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    block('chub');

    const { status, body } = await app.post('/search', { source: 'chub', query: 'elf', limit: 3 });

    assert.equal(status, 200);
    assert.equal(body.mode, 'direct');
    assert.equal(body.kind, 'search');
    assert.equal(body.reason, 'forbidden', 'the client needs the real reason, not "not responding"');

    // The URL is built here, from the adapter's fixed base, and stays on a host
    // the adapter is allowed to reach.
    const url = new URL(body.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(chub.allowedHosts.includes(url.hostname));
    assert.equal(url.searchParams.get('search'), 'elf');
    assert.equal(url.searchParams.get('first'), '3');
});

test('a timeout is not treated as a reason to use the browser', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    // Three transient failures trip the breaker without being reroutable: a slow
    // request is a blip, and routing every blip through the user's connection
    // would trade their address away for nothing.
    for (let i = 0; i < 3; i++) {
        markFailure('chub', { code: 'timeout' });
    }

    const { status, body } = await app.post('/search', { source: 'chub', query: 'elf' });

    assert.equal(status, 503);
    assert.equal(body.error, 'source_down');
});

test('ingesting a payload yields exactly what the server-side path would have', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    const node = fixture('chub-detail.json').node ?? fixture('chub-detail.json');
    const payload = { data: { count: 1, nodes: [node] } };
    const args = { query: '', cursor: null, limit: 24, sort: 'default', sfwOnly: false };

    const { status, body } = await app.post('/ingest', {
        source: 'chub',
        kind: 'search',
        limit: 24,
        payload,
    });

    assert.equal(status, 200);
    // Compared after a JSON round-trip on both sides: normalize.js builds records
    // with a null prototype, which the wire cannot carry and which deepEqual
    // would otherwise flag as a difference in values that are in fact identical.
    assert.deepEqual(body.items, JSON.parse(JSON.stringify(chub.parseSearch(payload, args).items)));
    assert.equal(body.items.length, 1);
    assert.equal(body.total, 1);
});

test('ingest refuses a source that has not declared the browser path', async (t) => {
    const app = mount();
    t.after(() => app.close());

    const { status, body } = await app.post('/ingest', {
        source: 'botbooru',
        kind: 'search',
        payload: { posts: [] },
    });

    assert.equal(status, 400);
    assert.equal(body.error, 'direct_unsupported');
});

test('ingest refuses a prototype-poisoning payload', async (t) => {
    const app = mount();
    t.after(() => app.close());

    const { status, body } = await app.post('/ingest', {
        source: 'chub',
        kind: 'search',
        payload: JSON.parse('{"data":{"nodes":[{"__proto__":{"polluted":true}}]}}'),
    });

    assert.equal(status, 422);
    assert.equal(body.error, 'unsafe_json');
    assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
});

test('ingest refuses an unknown kind rather than guessing', async (t) => {
    const app = mount();
    t.after(() => app.close());

    for (const kind of ['card', 'toString', '__proto__', '', null]) {
        const { status, body } = await app.post('/ingest', { source: 'chub', kind, payload: {} });
        assert.equal(status, 400, `kind=${String(kind)} should be refused`);
        assert.equal(body.error, 'bad_ingest_kind');
    }
});

test('ingest still validates the card id against the adapter pattern', async (t) => {
    const app = mount();
    t.after(() => app.close());

    for (const id of ['../../etc/passwd', 'no-slash', 'a/b/c/../d', '']) {
        const { status, body } = await app.post('/ingest', {
            source: 'chub',
            kind: 'detail',
            id,
            payload: { node: { name: 'x' } },
        });
        assert.equal(status, 400, `id=${id} should be refused`);
        assert.equal(body.error, 'bad_id');
    }
});

test('a cursor the server did not mint is refused on the direct path too', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    const forged = await app.post('/ingest', {
        source: 'chub',
        kind: 'search',
        cursor: 'eyJwIjo5OTl9.notasignature',
        payload: { data: { nodes: [] } },
    });

    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, 'bad_cursor');
});

test('only sources whose CORS was actually checked declare the browser path', () => {
    // corsDirect says "this site's headers let a browser call it", which is a
    // fact about the site. Assuming it for a source nobody checked would produce
    // a fallback that always fails.
    for (const [id, adapter] of Object.entries(SOURCES)) {
        if (adapter.corsDirect !== true) {
            continue;
        }
        assert.equal(typeof adapter.buildSearchUrl, 'function', `${id}: corsDirect needs buildSearchUrl`);
        assert.equal(typeof adapter.parseSearch, 'function', `${id}: corsDirect needs parseSearch`);
        assert.equal(id, 'chub', `${id}: verify its CORS headers and update this test before enabling`);
    }
});

test('a merged search reports a blocked source without losing the others', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    // Every source in this list is down, so nothing goes to the network — but
    // the shape of the answer is the point: partial failures are reported
    // alongside results rather than replacing them.
    block('chub');
    block('botbooru');

    const { status, body } = await app.post('/search', {
        sources: ['chub', 'botbooru'],
        query: 'elf',
        limit: 12,
    });

    assert.equal(status, 200, 'a failed source must not fail the query');
    assert.deepEqual(body.items, []);
    assert.deepEqual(
        body.partial.map((entry) => entry.source).sort(),
        ['botbooru', 'chub'],
    );
    assert.ok(body.partial.every((entry) => entry.error === 'source_down'));
    assert.equal(typeof body.nextCursor, 'string', 'failed sources retain a retry cursor');
});

test('a merged search caps its fan-out and ignores unknown sources', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    for (const id of Object.keys(SOURCES)) {
        block(id);
    }

    const { body } = await app.post('/search', {
        // Seven real sources, one that does not exist, and a duplicate.
        sources: [...Object.keys(SOURCES), 'chub', 'not-a-source'],
        limit: 12,
    });

    assert.equal(body.partial.length, MAX_FANOUT, 'the fan-out must be bounded on a small box');
    assert.ok(body.partial.every((entry) => SOURCES[entry.source]), 'an unknown id must not reach an adapter');
});

test('a merged cursor cannot be replayed as a single-source one', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    // Minted for one source, offered to a merged search.
    const single = mintCursor('chub', { p: 2 });
    const asMulti = await app.post('/search', { sources: ['chub'], cursor: single });
    assert.equal(asMulti.status, 400);
    assert.equal(asMulti.body.error, 'bad_cursor');

    // And a merged cursor offered to a single-source search.
    const multi = mintToken('cursor:multi', { s: { chub: { p: 2 } } });
    const asSingle = await app.post('/search', { source: 'chub', cursor: multi });
    assert.equal(asSingle.status, 400);
    assert.equal(asSingle.body.error, 'bad_cursor');
});

test('an active merged cursor is not re-parsed as a single-source cursor', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    // This is the normal second-page shape. Before the fix, searchMany() passed
    // this multi cursor through buildSearchArgs(), which tried to verify it under
    // cursor:chub and returned an internal error before checking source health.
    block('chub');
    const cursor = mintToken('cursor:multi', { s: { chub: { p: 2 } } });
    const { status, body } = await app.post('/search', {
        sources: ['chub'],
        cursor,
        limit: 12,
    });

    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
    assert.deepEqual(body.partial, [{ source: 'chub', error: 'source_down' }]);
    assert.equal(typeof body.nextCursor, 'string', 'the carried cursor is retained for retry');
});

test('a signed merged cursor still rejects malformed carried dedupe state', async (t) => {
    const app = mount();
    t.after(() => app.close());

    const cursor = mintToken('cursor:multi', {
        s: { chub: { p: 2 } },
        d: ['not-a-16-character-fingerprint'],
    });
    const { status, body } = await app.post('/search', { sources: ['chub'], cursor });

    assert.equal(status, 400);
    assert.equal(body.error, 'bad_cursor');
});

test('an exhausted merged search stops rather than restarting its sources', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    // The cursor names only chub, so botbooru is finished. Asking it again would
    // hand back its first page a second time.
    const cursor = mintToken('cursor:multi', { s: { chub: { p: 2 } } });
    const { body } = await app.post('/search', { sources: ['botbooru'], cursor, limit: 12 });

    assert.deepEqual(body.items, []);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(body.partial, [], 'a finished source is not a failure');
});

test('the browser path can be asked for, but only for a source that has it', async (t) => {
    clearAll();
    const app = mount();
    t.after(async () => {
        await app.close();
        clearAll();
    });

    // A user who knows their server is blocked can choose this route up front
    // rather than waiting for a failure first.
    const chosen = await app.post('/search', { source: 'chub', route: 'direct', query: 'elf' });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.mode, 'direct');

    // Asking is not enough on its own: `corsDirect` is declared in the adapter,
    // not requested by the client, so naming the route for a source without the
    // browser path changes nothing. The sources that have it are pinned by
    // 'only sources whose CORS was actually checked declare the browser path'
    // above; asserting it again here would mean a real request to a card site,
    // which does not belong in this suite.
    for (const [id, adapter] of Object.entries(SOURCES)) {
        if (id !== 'chub') {
            assert.notEqual(adapter.corsDirect, true, `${id} would honour route:direct`);
        }
    }
});
