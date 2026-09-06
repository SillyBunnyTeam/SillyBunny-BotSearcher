import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter, once } from 'node:events';
import { gzipSync } from 'node:zlib';
import express from 'express';

import { createRouter } from '../server/router.js';
import { createBotbooruAccounts, createSaucepanAccounts } from '../server/accounts.js';
import { acquire } from '../server/limits.js';
import { clearAll, markFailure, reasonOf, stateOf } from '../server/health.js';
import { mintToken, verifyToken } from '../server/refs.js';
import { SOURCES } from '../server/registry.js';
import { MAX_INGEST_BYTES, MAX_REQUEST_BYTES } from '../shared/schema.js';

const UUID = '311a6844-61d6-4468-aa98-91ecc7fbae86';
const CARD = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Synthetic', description: 'A card.' } };
let callerNumber = 0;

beforeEach(() => clearAll());

async function listen(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

function reply(response, body, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}

async function upstream(t, handler) {
    const base = await listen(t, handler);
    const calls = [];
    // Keep the real adapter, allowlist, fetch, deadline and socket cancellation.
    // Only the transport destination changes; no request can reach a live site.
    t.mock.method(https, 'request', (target, options) => {
        const url = new URL(target);
        calls.push(url);
        return http.request(new URL(url.pathname + url.search, base), options);
    });
    return calls;
}

async function mount(t, state = {}) {
    const auth = { user: { profile: { handle: `server-routing-${++callerNumber}`, admin: false } } };
    const requests = new EventEmitter();
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((request, _response, next) => {
        request.user = auth.user;
        requests.emit('request', request);
        next();
    });
    const router = express.Router();
    createRouter(router, { startedAt: Date.now(), ...state });
    app.use(router);
    const base = await listen(t, app);
    return {
        auth,
        requests,
        base,
        post: (path, body, options = {}) => fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...options,
        }),
    };
}

test('all shared Janny bridge entry points require the host administrator flag', async (t) => {
    const calls = [];
    const jannyBrowser = {
        status: async () => { calls.push('status'); return { ready: true }; },
        login: async () => { calls.push('login'); return { ready: true }; },
        logout: async () => { calls.push('logout'); return { ready: true }; },
        fetchCard: async () => { calls.push('fetchCard'); return { card: CARD }; },
    };
    const app = await mount(t, { jannyBrowser });
    const body = { source: 'jannyai', url: `https://janitorai.com/characters/${UUID}`, admin: true };
    for (const user of [undefined, {}, { profile: {} }, ...[false, 'true', 1].map((admin) => ({ profile: { admin } }))]) {
        app.auth.user = user;
        for (const path of ['/janny/status', '/janny/login', '/janny/logout', '/url-card']) {
            const response = await app.post(path, body);
            assert.equal(response.status, 403, path);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await response.json(), { error: 'janny_admin_required' });
        }
    }
    assert.deepEqual(calls, [], 'a denied request must not touch the shared browser');

    const health = await fetch(app.base + '/healthz');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const janny = (await health.json()).sources.find((source) => source.id === 'jannyai');
    assert.equal(janny.bridgeAllowed, false);
    assert.equal(janny.nativeImport, true, 'native host downloads are not bridge operations');

    app.auth.user = { profile: { handle: 'bridge-admin', admin: true } };
    for (const path of ['/janny/status', '/janny/login', '/janny/logout', '/url-card']) {
        const response = await app.post(path, body);
        assert.equal(response.status, 200, path);
        await response.arrayBuffer();
    }
    assert.deepEqual(calls, ['status', 'login', 'logout', 'fetchCard']);
    const allowedHealth = await (await fetch(app.base + '/healthz')).json();
    assert.equal(allowedHealth.sources.find((source) => source.id === 'jannyai').bridgeAllowed, true);
});

test('merged continuations keep page sizes after another source is exhausted', async (t) => {
    const calls = await upstream(t, (request, response) => {
        const url = new URL(request.url, 'http://local.test');
        if (url.pathname === '/posts/') {
            reply(response, { total: 1, posts: [{ id: 1, character_name: 'Short source' }] });
            return;
        }
        const size = Number(url.searchParams.get('first'));
        const start = (Number(url.searchParams.get('page')) - 1) * size;
        reply(response, { data: { count: 6, nodes: Array.from({ length: Math.min(size, 6 - start) }, (_, index) => ({
            fullPath: `author/card-${start + index + 1}`, name: `Card ${start + index + 1}`,
        })) } });
    });
    const app = await mount(t);
    const body = { sources: ['chub', 'botbooru'], limit: 4 };
    const first = await (await app.post('/search', body)).json();
    assert.deepEqual(verifyToken('cursor:multi', first.nextCursor).s.chub, [2, { p: 2 }]);
    const second = await (await app.post('/search', { ...body, cursor: first.nextCursor })).json();
    const third = await (await app.post('/search', { ...body, cursor: second.nextCursor })).json();
    assert.deepEqual([first, second, third].flatMap((page) => page.items)
        .filter((item) => item.source === 'chub').map((item) => item.id),
    Array.from({ length: 6 }, (_, index) => `author/card-${index + 1}`));
    assert.equal(third.nextCursor, null);
    assert.deepEqual(calls.filter((url) => url.pathname === '/search').map((url) => url.searchParams.get('first')), ['2', '2', '2']);
});

test('a small merged page defers sources without fetching or advancing discarded cards', async (t) => {
    const calls = await upstream(t, (request, response) => {
        const url = new URL(request.url, 'http://local.test');
        if (url.pathname === '/posts/') {
            const id = Number(url.searchParams.get('offset')) + 1;
            reply(response, { total: 2, posts: [{ id, character_name: `Botbooru ${id}` }] });
        } else {
            const page = Number(url.searchParams.get('page'));
            reply(response, { data: { count: 2, nodes: [{ fullPath: `author/card-${page}`, name: `Chub ${page}` }] } });
        }
    });
    const app = await mount(t);
    const items = [];
    let cursor = null;
    for (let page = 0; page < 4; page++) {
        const result = await (await app.post('/search', { sources: ['botbooru', 'chub'], limit: 1, cursor })).json();
        assert.equal(result.items.length, 1);
        items.push(`${result.items[0].source}:${result.items[0].id}`);
        cursor = result.nextCursor;
        if (page < 3) {
            assert.equal(typeof cursor, 'string');
        }
    }
    assert.deepEqual(items, ['botbooru:1', 'chub:author/card-1', 'botbooru:2', 'chub:author/card-2']);
    assert.equal(cursor, null);
    assert.equal(calls.length, 4, 'one returned item must not advance two sources');
});

test('merged cursor sizes are validated and full dedupe state still fits the signed token', async (t) => {
    const calls = await upstream(t, (_request, response) => reply(response, {}));
    const app = await mount(t);
    for (const entry of [{ p: 2 }, [0, { p: 2 }], [49, { p: 2 }], [2, 'bad'], [2, null, 3]]) {
        const cursor = mintToken('cursor:multi', { s: { chub: entry } });
        const response = await app.post('/search', { sources: ['chub'], cursor, limit: 24 });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'bad_cursor' });
    }
    assert.equal(calls.length, 0);
    const s = Object.fromEntries(Object.values(SOURCES).filter((source) => source.capabilities.search)
        .map((source) => [source.id, [48, source.capabilities.paging === 'offset'
            ? { o: 5000 }
            : (source.id === 'risurealm' ? { p: 1000, i: 256 } : { p: 1000 })]]));
    const payload = { s, d: Array(64).fill('1234567890abcdef') };
    const cursor = mintToken('cursor:multi', payload);
    assert.equal(typeof cursor, 'string');
    assert.deepEqual(verifyToken('cursor:multi', cursor), payload);
});

test('unsupported searches stay out of source health and cannot disable Saucepan imports', async (t) => {
    const calls = await upstream(t, (request, response) => {
        if (request.url.startsWith('/search')) {
            reply(response, { data: { nodes: [], count: 0 } });
        } else {
            reply(response, { companion: { display_name: 'Synthetic' }, sections: [] });
        }
    });
    const saucepan = createSaucepanAccounts();
    const app = await mount(t, { saucepan });
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await app.post('/search', { source: 'saucepan' });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'search_unsupported' });
    }
    const unsupported = await (await app.post('/search', { sources: ['saucepan'] })).json();
    assert.deepEqual(unsupported.partial, [{ source: 'saucepan', error: 'search_unsupported' }]);
    assert.equal(unsupported.nextCursor, null);
    assert.equal(calls.length, 0);
    const mixed = await (await app.post('/search', { sources: ['saucepan', 'chub'] })).json();
    assert.deepEqual(mixed.partial, unsupported.partial);
    assert.equal(stateOf('saucepan'), 'unknown');
    saucepan.setToken(app.auth.user.profile.handle, 'synthetic-token');
    const imported = await app.post('/url-card', { source: 'saucepan', url: 'https://saucepan.ai/companion/abcdef12' });
    assert.equal(imported.status, 200);
    await imported.arrayBuffer();
});

test('an old Saucepan 401 cannot clear the replacement session', { timeout: 3000 }, async (t) => {
    const started = Promise.withResolvers();
    await upstream(t, (request, response) => {
        if (request.url.startsWith('/api/v1/companion/definition')) {
            started.resolve(response);
        } else {
            reply(response, { companion: { display_name: 'Synthetic' } });
        }
    });
    const saucepan = createSaucepanAccounts();
    const app = await mount(t, { saucepan });
    const handle = app.auth.user.profile.handle;
    saucepan.setToken(handle, 'old-synthetic-token');
    const oldVersion = saucepan.cardRequest(handle).sessionVersion;
    const pending = app.post('/url-card', { source: 'saucepan', url: 'https://saucepan.ai/companion/abcdef12' });
    const stalled = await started.promise;
    saucepan.setToken(handle, 'replacement-synthetic-token');
    reply(stalled, {}, 401);
    const response = await pending;
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'saucepan_session_expired' });
    assert.equal(saucepan.status(handle).loggedIn, true);
    const currentVersion = saucepan.cardRequest(handle).sessionVersion;
    assert.notEqual(currentVersion, oldVersion);
    saucepan.invalidate(handle, currentVersion);
    assert.equal(saucepan.status(handle).loggedIn, false, 'a current-session 401 still expires it');
});

test('chunked and compressed JSON enforce both parsed-body limits', async (t) => {
    const app = await mount(t);
    for (const [path, limit, envelope] of [
        ['/retry', MAX_REQUEST_BYTES, { source: 'chub' }],
        ['/ingest', MAX_INGEST_BYTES, { source: 'chub', kind: 'search', payload: {} }],
    ]) {
        const bytes = Buffer.from(JSON.stringify({ ...envelope, padding: 'x'.repeat(limit) }));
        for (const compressed of [false, true]) {
            const received = once(app.requests, 'request');
            const headers = { 'Content-Type': 'application/json' };
            const body = compressed ? gzipSync(bytes) : new ReadableStream({
                start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                },
            });
            if (compressed) {
                headers['Content-Encoding'] = 'gzip';
                assert.ok(body.length < MAX_REQUEST_BYTES);
            }
            const response = await fetch(app.base + path, { method: 'POST', headers, body, duplex: 'half' });
            const [request] = await received;
            if (!compressed) {
                assert.equal(request.headers['content-length'], undefined);
            }
            assert.equal(response.status, 413, `${path}: compressed=${compressed}`);
            assert.deepEqual(await response.json(), { error: 'payload_too_large' });
        }
    }
});

test('ordinary read and card routes cancel sockets and free slots without health penalties', async (t) => {
    for (const [path, body, source] of [
        ['/search', { source: 'chub' }, 'chub'],
        ['/search', { sources: ['chub'] }, 'chub'],
        ['/detail', { source: 'quillgen', id: UUID }, 'quillgen'],
        ['/card', { source: 'quillgen', id: UUID }, 'quillgen'],
    ]) {
        await t.test(`${path} ${JSON.stringify(body)}`, { timeout: 3000 }, async (t) => {
            const started = Promise.withResolvers();
            await upstream(t, (_request, response) => {
                const closed = once(response, 'close');
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.write(' ');
                started.resolve({ closed });
            });
            const app = await mount(t);
            const controller = new AbortController();
            const pending = app.post(path, body, { signal: controller.signal });
            const { closed } = await started.promise;
            const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
            controller.abort();
            await rejected;
            await closed;
            const leases = await Promise.all([acquire('source', source, { timeoutMs: 100 }), acquire('source', source, { timeoutMs: 100 })]);
            assert.ok(leases.every((release) => typeof release === 'function'));
            leases.forEach((release) => release());
            assert.equal(stateOf(source), 'unknown');
            assert.equal(reasonOf(source), null, 'caller cancellation is not an upstream failure');
        });
    }
});

test('an abandoned queued search never contacts its source after a slot opens', { timeout: 3000 }, async (t) => {
    const calls = await upstream(t, (_request, response) => reply(response, { data: { nodes: [], count: 0 } }));
    const held = await Promise.all([acquire('source', 'chub'), acquire('source', 'chub')]);
    t.after(() => held.forEach((release) => release()));
    const app = await mount(t);
    const received = once(app.requests, 'request');
    const controller = new AbortController();
    const pending = app.post('/search', { source: 'chub', query: 'abandoned' }, { signal: controller.signal });
    const [request] = await received;
    await new Promise(setImmediate);
    const disconnected = once(request.sbbsSignal, 'abort');
    const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
    controller.abort();
    await rejected;
    await disconnected;
    assert.equal(request.sbbsSignal.aborted, true);
    held.forEach((release) => release());
    const fresh = await app.post('/search', { source: 'chub', query: 'fresh' });
    assert.equal(fresh.status, 200);
    await fresh.json();
    assert.deepEqual(calls.map((url) => url.searchParams.get('search')), ['fresh']);
});

test('queued searches recheck source cooldown before starting an upstream request', { timeout: 3000 }, async (t) => {
    const calls = await upstream(t, (_request, response) => reply(response, {}));
    const held = await Promise.all([acquire('source', 'chub'), acquire('source', 'chub')]);
    t.after(() => held.forEach((release) => release()));
    const app = await mount(t);
    const received = once(app.requests, 'request');
    const pending = app.post('/search', { source: 'chub' });
    await received;
    await new Promise(setImmediate);
    markFailure('chub', { code: 'http_error', detail: '403' });
    held.forEach((release) => release());
    const response = await pending;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'source_down' });
    assert.equal(calls.length, 0);
});

test('disconnecting an account mutation does not abandon its bounded verification', { timeout: 3000 }, async (t) => {
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const verified = Promise.withResolvers();
    let enabled = true;
    const accounts = createBotbooruAccounts({
        adapter: {
            login: async () => 'synthetic-token',
            async getAccount() {
                if (!enabled) {
                    verified.resolve();
                }
                return { username: 'synthetic', showNsfw: enabled };
            },
            async updateNsfw(context, value) {
                assert.equal(context.signal, undefined, 'the write must not inherit the browser signal');
                started.resolve();
                await finish.promise;
                enabled = value;
            },
        },
        makeContext: (_adapter, options) => options,
    });
    const app = await mount(t, { accounts });
    const handle = app.auth.user.profile.handle;
    await accounts.login(handle, 'synthetic', 'synthetic-password');
    const controller = new AbortController();
    const pending = app.post('/account/nsfw', { source: 'botbooru', enabled: false }, { signal: controller.signal });
    await started.promise;
    const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
    controller.abort();
    await rejected;
    finish.resolve();
    await verified.promise;
    await new Promise(setImmediate);
    assert.equal((await accounts.status(handle)).nsfwEnabled, false);
});

test('Character Tavern Unicode identifiers survive search, detail and card lookup literally', async () => {
    const id = 'author/Cafe\u0301';
    const hit = { path: id, name: 'Synthetic', characterDefinition: 'Definition.' };
    const context = { fetchJson: async () => ({ totalHits: 1, hits: [hit] }) };
    const source = SOURCES.charactertavern;
    assert.equal(source.idPattern.test(id), true);
    const result = await source.search(context, { query: '', cursor: null, limit: 1 });
    assert.equal(result.items[0].id, id);
    assert.equal((await source.getDetail(context, result.items[0].id)).name, 'Synthetic');
    assert.equal((await source.buildCard(context, result.items[0].id)).data.description, 'Definition.');
});
