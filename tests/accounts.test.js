import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotbooruAccounts } from '../server/accounts.js';
import { UpstreamError } from '../server/guards.js';

function fakeStore(overrides = {}) {
    const calls = [];
    let account = {
        username: 'alice-upstream',
        showNsfw: true,
        showNsfl: true,
        showNsflActive: true,
    };
    const adapter = {
        id: 'botbooru',
        async login(_ctx, username, password) {
            calls.push({ kind: 'login', username, password });
            return 'opaque-secret-token';
        },
        async getAccount(ctx, fallbackUsername) {
            calls.push({ kind: 'account', bearerToken: ctx.bearerToken, fallbackUsername });
            return account;
        },
        async updateNsfw(ctx, enabled) {
            calls.push({ kind: 'nsfw', bearerToken: ctx.bearerToken, enabled });
            account = { ...account, showNsfw: enabled };
        },
        ...overrides.adapter,
    };
    let now = overrides.now ?? 1000;
    let nonce = 0;
    const store = createBotbooruAccounts({
        adapter,
        makeContext: (_source, options = {}) => ({ bearerToken: options.bearerToken }),
        now: () => now,
        randomNonce: () => `nonce-${++nonce}`,
        validationTtlMs: overrides.validationTtlMs ?? 60_000,
    });
    return {
        store,
        calls,
        setNow(value) { now = value; },
        setAccount(value) { account = value; },
    };
}

test('BotBooru sessions preserve the password only in flight and isolate profiles', async () => {
    const { store, calls } = fakeStore();
    const password = '  p&a ss+word  ';
    const loggedIn = await store.login('profile-a', '  Alice  ', password);

    assert.deepEqual(calls[0], { kind: 'login', username: 'Alice', password });
    assert.deepEqual(loggedIn, {
        source: 'botbooru',
        loggedIn: true,
        username: 'alice-upstream',
        nsfwEnabled: true,
        nsflEnabled: true,
        nsflActive: true,
    });
    assert.doesNotMatch(JSON.stringify(loggedIn), /secret|password|bearer|token/i);
    assert.deepEqual(await store.status('profile-b'), {
        source: 'botbooru',
        loggedIn: false,
        username: null,
        nsfwEnabled: false,
        nsflEnabled: false,
        nsflActive: null,
    });
    await assert.rejects(
        () => store.searchRequest('profile-b', false),
        (error) => error.code === 'botbooru_login_required' && error.status === 401,
    );

    const protectedRequest = await store.searchRequest('profile-a', false);
    assert.equal(protectedRequest.context.bearerToken, 'opaque-secret-token');
    assert.equal(protectedRequest.sessionNonce, 'nonce-1');
    const publicRequest = await store.searchRequest(null, true);
    assert.equal(publicRequest.context.bearerToken, undefined, 'SFW searches stay anonymous');
    const omittedFilter = await store.searchRequest(null, undefined);
    assert.equal(omittedFilter.context.bearerToken, undefined, 'missing SFW input must fail closed');
    assert.equal(protectedRequest.sessionNonce === password, false);

    assert.doesNotThrow(() => store.preflightSearch(null, true));
    assert.throws(
        () => store.preflightSearch('profile-b', false),
        (error) => error.code === 'botbooru_login_required',
    );

    const publicDetail = await store.detailRequest(null, null);
    assert.equal(publicDetail.context.bearerToken, undefined, 'public details stay anonymous while logged out');
    const protectedDetail = await store.detailRequest('profile-a', 'nonce-1');
    assert.equal(protectedDetail.context.bearerToken, 'opaque-secret-token');
    await assert.rejects(
        () => store.detailRequest('profile-a', 'stale-nonce'),
        (error) => error.code === 'botbooru_account_changed',
    );
    const protectedThumb = await store.thumbnailRequest('profile-a', 'nonce-1');
    assert.equal(protectedThumb.bearerToken, undefined, 'validated previews must not receive the bearer');
});

test('a failed replacement login leaves the existing session usable', async () => {
    let attempts = 0;
    const { store } = fakeStore({
        adapter: {
            async login() {
                attempts += 1;
                if (attempts > 1) {
                    throw new UpstreamError('http_error', '401');
                }
                return 'first-token';
            },
        },
    });

    await store.login('profile-a', 'alice', 'first password');
    await assert.rejects(
        () => store.login('profile-a', 'alice', 'wrong replacement'),
        (error) => error.code === 'botbooru_invalid_credentials',
    );
    assert.equal((await store.status('profile-a')).loggedIn, true);
    assert.equal((await store.searchRequest('profile-a', false)).context.bearerToken, 'first-token');
});

test('stale sessions are revalidated and cleared after an upstream rejection', async () => {
    let accountCalls = 0;
    const fixture = fakeStore({
        validationTtlMs: 50,
        adapter: {
            async getAccount() {
                accountCalls += 1;
                if (accountCalls > 1) {
                    throw new UpstreamError('http_error', '401');
                }
                return { username: 'alice', showNsfw: true, showNsfl: false, showNsflActive: null };
            },
        },
    });

    await fixture.store.login('profile-a', 'alice', 'password');
    fixture.setNow(1049);
    assert.equal((await fixture.store.status('profile-a')).loggedIn, true);
    assert.equal(accountCalls, 1);

    fixture.setNow(1050);
    await assert.rejects(
        () => fixture.store.status('profile-a'),
        (error) => error.code === 'botbooru_session_expired',
    );
    assert.equal((await fixture.store.status('profile-a')).loggedIn, false);
});

test('concurrent stale reads share one account validation', async () => {
    let accountCalls = 0;
    let releaseRefresh;
    const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
    const fixture = fakeStore({
        validationTtlMs: 10,
        adapter: {
            async getAccount() {
                accountCalls += 1;
                if (accountCalls > 1) {
                    await refresh;
                }
                return { username: 'alice', showNsfw: true, showNsfl: false, showNsflActive: null };
            },
        },
    });
    await fixture.store.login('profile-a', 'alice', 'password');
    fixture.setNow(1010);

    const first = fixture.store.status('profile-a');
    const second = fixture.store.status('profile-a');
    await Promise.resolve();
    assert.equal(accountCalls, 2, 'only one refresh should reach BotBooru');
    releaseRefresh();

    assert.equal((await first).loggedIn, true);
    assert.equal((await second).loggedIn, true);
    assert.equal(accountCalls, 2);
});

test('a forbidden account endpoint does not erase a valid bearer', async () => {
    let accountCalls = 0;
    const fixture = fakeStore({
        validationTtlMs: 10,
        adapter: {
            async getAccount() {
                accountCalls += 1;
                if (accountCalls === 2) {
                    throw new UpstreamError('http_error', '403');
                }
                return { username: 'alice', showNsfw: true, showNsfl: false, showNsflActive: null };
            },
        },
    });
    await fixture.store.login('profile-a', 'alice', 'password');
    fixture.setNow(1010);

    await assert.rejects(
        () => fixture.store.status('profile-a'),
        (error) => error.code === 'botbooru_auth_unavailable',
    );
    assert.equal((await fixture.store.status('profile-a')).loggedIn, true, 'only a 401 expires the session');
});

test('the NSFW action changes only that account preference and reports NSFL state', async () => {
    const fixture = fakeStore();
    fixture.setAccount({
        username: 'alice',
        showNsfw: false,
        showNsfl: true,
        showNsflActive: false,
    });
    await fixture.store.login('profile-a', 'alice', 'password');

    await assert.rejects(
        () => fixture.store.searchRequest('profile-a', false),
        (error) => error.code === 'botbooru_nsfw_disabled',
    );
    const updated = await fixture.store.setNsfw('profile-a', true);
    assert.equal(updated.nsfwEnabled, true);
    assert.equal(updated.nsflEnabled, true);
    assert.equal(updated.nsflActive, false);
    assert.deepEqual(
        fixture.calls.filter((call) => call.kind === 'nsfw'),
        [{ kind: 'nsfw', bearerToken: 'opaque-secret-token', enabled: true }],
    );
});

test('concurrent account mutations do not race upstream preferences', async () => {
    let releasePatch;
    let patchStarted;
    const started = new Promise((resolve) => { patchStarted = resolve; });
    const patch = new Promise((resolve) => { releasePatch = resolve; });
    const fixture = fakeStore({
        adapter: {
            async updateNsfw(ctx, enabled) {
                fixture.calls.push({ kind: 'nsfw', bearerToken: ctx.bearerToken, enabled });
                patchStarted();
                await patch;
            },
        },
    });
    await fixture.store.login('profile-a', 'alice', 'password');

    const first = fixture.store.setNsfw('profile-a', false);
    await started;
    await assert.rejects(
        () => fixture.store.setNsfw('profile-a', true),
        (error) => error.code === 'botbooru_account_changed',
    );
    assert.equal(fixture.calls.filter((call) => call.kind === 'nsfw').length, 1);
    releasePatch();
    await first;
});

test('logout wins a race with an in-flight login and is idempotent', async () => {
    let resolveLogin;
    const loginResult = new Promise((resolve) => { resolveLogin = resolve; });
    const { store } = fakeStore({
        adapter: {
            async login() {
                return loginResult;
            },
        },
    });

    const pending = store.login('profile-a', 'alice', 'password');
    assert.equal(store.logout('profile-a').loggedIn, false);
    assert.equal(store.logout('profile-a').loggedIn, false);
    resolveLogin('late-token');

    await assert.rejects(pending, (error) => error.code === 'botbooru_account_changed');
    assert.equal((await store.status('profile-a')).loggedIn, false);
});

test('credential and profile bounds fail before calling the upstream', async () => {
    const { store, calls } = fakeStore({
        adapter: {
            async login() {
                return 'x'.repeat(8193);
            },
        },
    });

    await assert.rejects(
        () => store.login('profile-a', 'alice', 'password'),
        (error) => error.code === 'botbooru_auth_unavailable',
    );
    await assert.rejects(
        () => store.login('', 'alice', 'password'),
        (error) => error.code === 'account_profile_required',
    );
    await assert.rejects(
        () => store.login('profile-b', 'alice', 'x'.repeat(1025)),
        (error) => error.code === 'bad_account_request',
    );
    assert.equal(calls.length, 0, 'invalid inputs and tokens must not trigger account validation');
});
