import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRouter } from '../server/router.js';
import { AccountError } from '../server/accounts.js';
import { UpstreamError } from '../server/guards.js';
import { clearAll, stateOf } from '../server/health.js';
import { mintRef } from '../server/refs.js';

function mount(accounts) {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((request, _response, next) => {
        const handle = request.get('X-Test-Profile');
        if (handle) {
            request.user = { profile: { handle } };
        }
        next();
    });
    const router = express.Router();
    createRouter(router, { startedAt: Date.now(), accounts });
    app.use(router);

    const server = app.listen(0, '127.0.0.1');
    const ready = new Promise((resolve) => server.once('listening', resolve));
    return {
        async post(path, body, handle) {
            await ready;
            const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(handle ? { 'X-Test-Profile': handle } : {}),
                },
                body: JSON.stringify(body),
            });
            return {
                status: response.status,
                cacheControl: response.headers.get('cache-control'),
                body: await response.json(),
            };
        },
        async get(path, handle) {
            await ready;
            const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                headers: handle ? { 'X-Test-Profile': handle } : {},
            });
            const contentType = response.headers.get('content-type') ?? '';
            return {
                status: response.status,
                cacheControl: response.headers.get('cache-control'),
                body: contentType.includes('application/json')
                    ? await response.json()
                    : Buffer.from(await response.arrayBuffer()),
            };
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function publicAccount(loggedIn = true) {
    return {
        source: 'botbooru',
        loggedIn,
        username: loggedIn ? 'alice' : null,
        nsfwEnabled: loggedIn,
        nsflEnabled: loggedIn,
        nsflActive: loggedIn ? false : null,
    };
}

test('account routes require a real profile and return only public no-store state', async (t) => {
    const calls = [];
    const accounts = {
        async status(handle) {
            calls.push({ kind: 'status', handle });
            return publicAccount();
        },
        async login(handle, username, password) {
            calls.push({ kind: 'login', handle, username, password });
            return publicAccount();
        },
        async setNsfw(handle, enabled) {
            calls.push({ kind: 'nsfw', handle, enabled });
            return { ...publicAccount(), nsfwEnabled: enabled };
        },
        logout(handle) {
            calls.push({ kind: 'logout', handle });
            return publicAccount(false);
        },
    };
    const server = mount(accounts);
    t.after(() => server.close());

    const missing = await server.post('/account/status', { source: 'botbooru' });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'account_profile_required');
    assert.equal(missing.cacheControl, 'no-store');
    assert.equal(calls.length, 0);

    const login = await server.post('/account/login', {
        source: 'botbooru', username: 'Alice', password: ' exact password ',
    }, 'route-profile-a');
    assert.equal(login.status, 200);
    assert.equal(login.cacheControl, 'no-store');
    assert.deepEqual(calls[0], {
        kind: 'login', handle: 'route-profile-a', username: 'Alice', password: ' exact password ',
    });
    assert.doesNotMatch(JSON.stringify(login.body), /password|bearer|token|secret/i);

    const updated = await server.post('/account/nsfw', { source: 'botbooru', enabled: false }, 'route-profile-a');
    assert.equal(updated.body.nsfwEnabled, false);
    const logout = await server.post('/account/logout', { source: 'botbooru' }, 'route-profile-a');
    assert.equal(logout.status, 200);
    assert.equal(logout.body.loggedIn, false);

    const unsupported = await server.post('/account/status', { source: 'chub' }, 'route-profile-a');
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.error, 'account_unsupported');
});

test('BotBooru account failures stay isolated and only source failures affect health', async (t) => {
    clearAll();
    let mode = 'logged-out';
    const invalidations = [];
    const seen = [];
    const accounts = {
        preflightSearch(handle, sfwOnly) {
            if (sfwOnly === false && mode === 'logged-out') {
                throw new AccountError('botbooru_login_required', 401);
            }
        },
        async searchRequest(handle, sfwOnly) {
            seen.push({ handle, sfwOnly });
            if (sfwOnly) {
                return {
                    context: { fetchJson: async () => ({ posts: [], total: 0 }) },
                    sessionNonce: null,
                };
            }
            if (mode === 'logged-out') {
                throw new AccountError('botbooru_login_required', 401);
            }
            if (mode === 'expired') {
                return {
                    context: {
                        fetchJson: async () => { throw new UpstreamError('http_error', '401'); },
                    },
                    sessionNonce: 'session-nonce',
                };
            }
            if (mode === 'forbidden') {
                return {
                    context: {
                        fetchJson: async () => { throw new UpstreamError('http_error', '403'); },
                    },
                    sessionNonce: 'session-nonce',
                };
            }
            return {
                context: { fetchJson: async () => ({ posts: [], total: 0 }) },
                sessionNonce: 'session-nonce',
            };
        },
        invalidate(handle, nonce) {
            invalidations.push({ handle, nonce });
        },
    };
    const server = mount(accounts);
    t.after(async () => {
        await server.close();
        clearAll();
    });

    const single = await server.post('/search', {
        source: 'botbooru', filters: { sfwOnly: false },
    }, 'search-profile-a');
    assert.equal(single.status, 401);
    assert.equal(single.body.error, 'botbooru_login_required');

    const merged = await server.post('/search', {
        sources: ['botbooru'], filters: { sfwOnly: false },
    }, 'search-profile-a');
    assert.equal(merged.status, 200);
    assert.deepEqual(merged.body.partial, [{ source: 'botbooru', error: 'botbooru_login_required' }]);
    assert.deepEqual(merged.body.items, []);
    assert.equal(merged.body.nextCursor, null, 'deterministic account failures must not occupy pagination');
    assert.equal(stateOf('botbooru'), 'unknown');

    mode = 'expired';
    const expired = await server.post('/search', {
        sources: ['botbooru'], filters: { sfwOnly: false },
    }, 'search-profile-a');
    assert.equal(expired.status, 200);
    assert.deepEqual(expired.body.partial, [{ source: 'botbooru', error: 'botbooru_session_expired' }]);
    assert.deepEqual(invalidations, [{ handle: 'search-profile-a', nonce: 'session-nonce' }]);
    assert.equal(stateOf('botbooru'), 'unknown', 'an expired user account is not a global source failure');

    mode = 'ok';
    const authenticated = await server.post('/search', {
        source: 'botbooru', filters: { sfwOnly: false },
    }, 'search-profile-a');
    assert.equal(authenticated.status, 200);
    assert.deepEqual(authenticated.body.items, []);

    const anonymous = await server.post('/search', {
        source: 'botbooru', filters: { sfwOnly: true },
    });
    assert.equal(anonymous.status, 200, 'SFW BotBooru search must not require a profile');
    assert.deepEqual(seen.at(-1), { handle: null, sfwOnly: true });

    const omitted = await server.post('/search', { source: 'botbooru' });
    assert.equal(omitted.status, 200);
    assert.deepEqual(seen.at(-1), { handle: null, sfwOnly: true }, 'omitted SFW input must fail closed');
    const malformed = await server.post('/search', {
        source: 'botbooru', filters: { sfwOnly: 'false' },
    });
    assert.equal(malformed.status, 200);
    assert.deepEqual(seen.at(-1), { handle: null, sfwOnly: true }, 'malformed SFW input must fail closed');

    clearAll();
    mode = 'forbidden';
    const forbidden = await server.post('/search', {
        sources: ['botbooru'], filters: { sfwOnly: false },
    }, 'search-profile-a');
    assert.deepEqual(forbidden.body.partial, [{ source: 'botbooru', error: 'http_error' }]);
    assert.equal(stateOf('botbooru'), 'unknown', 'a bearer-dependent 403 must not disable BotBooru globally');
    assert.deepEqual(
        invalidations,
        [{ handle: 'search-profile-a', nonce: 'session-nonce' }],
        'a source-wide 403 must not erase the account session',
    );
});

test('protected thumbnails are no-store and expire with their account session', async (t) => {
    let mode = 'ok';
    const accounts = {
        async thumbnailRequest(handle, nonce) {
            assert.equal(handle, 'thumb-profile-a');
            assert.equal(nonce, 'thumb-session');
            if (mode === 'expired') {
                throw new AccountError('botbooru_session_expired', 401);
            }
            return {
                async fetchBytes() {
                    return {
                        buffer: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
                    };
                },
            };
        },
    };
    const server = mount(accounts);
    t.after(() => server.close());

    const ref = mintRef('botbooru', { f: 'abc.png', v: 1, s: 'thumb-session' });
    const path = `/thumb?source=botbooru&size=grid&ref=${encodeURIComponent(ref)}`;
    const image = await server.get(path, 'thumb-profile-a');
    assert.equal(image.status, 200);
    assert.equal(image.cacheControl, 'private, no-store');
    assert.deepEqual(image.body.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

    mode = 'expired';
    const expired = await server.get(path, 'thumb-profile-a');
    assert.equal(expired.status, 401);
    assert.equal(expired.cacheControl, 'private, no-store');
    assert.equal(expired.body.error, 'botbooru_session_expired');
});

test('only account-visible BotBooru results authorize account-linked details', async (t) => {
    const post = {
        id: 42,
        character_name: 'Protected card',
        filename: 'protected-card.png',
        tags: [{ name: 'nsfw', category: 'Meta' }],
    };
    const detailRequests = [];
    const accounts = {
        preflightSearch() {},
        async searchRequest() {
            return {
                context: { fetchJson: async () => ({ posts: [post], total: 1 }) },
                sessionNonce: 'detail-session',
            };
        },
        async detailRequest(handle, nonce) {
            detailRequests.push({ handle, nonce });
            return {
                context: { fetchJson: async () => post },
                sessionNonce: nonce,
            };
        },
    };
    const server = mount(accounts);
    t.after(() => server.close());

    const search = await server.post('/search', {
        source: 'botbooru', filters: { sfwOnly: false },
    }, 'detail-profile-a');
    assert.equal(search.status, 200);
    assert.equal(typeof search.body.items[0].accountRef, 'string');

    const protectedDetail = await server.post('/detail', {
        source: 'botbooru', id: '42', accountRef: search.body.items[0].accountRef,
    }, 'detail-profile-a');
    assert.equal(protectedDetail.status, 200);
    assert.deepEqual(detailRequests[0], { handle: 'detail-profile-a', nonce: 'detail-session' });
    assert.equal(typeof protectedDetail.body.accountRef, 'string');

    const publicDetail = await server.post('/detail', { source: 'botbooru', id: '42' });
    assert.equal(publicDetail.status, 200);
    assert.deepEqual(detailRequests[1], { handle: null, nonce: null });
    assert.equal(publicDetail.body.accountRef, undefined, 'public details must stay anonymous');

    const mismatched = await server.post('/detail', {
        source: 'botbooru', id: '43', accountRef: search.body.items[0].accountRef,
    }, 'detail-profile-a');
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.error, 'botbooru_account_changed');
});
