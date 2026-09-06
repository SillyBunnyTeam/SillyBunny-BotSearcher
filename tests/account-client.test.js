import test from 'node:test';
import assert from 'node:assert/strict';
import { accountErrorMessage, searchErrorMessage, detailErrorMessage } from '../client/copy.js';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

test('the client account coordinator retains only public state and orders mutations', async () => {
    const previous = {
        fetch: globalThis.fetch,
        window: globalThis.window,
        SillyTavern: globalThis.SillyTavern,
    };
    const calls = [];
    let resolveStatus;
    globalThis.window = { location: { origin: 'https://local.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-test' }) }),
    };
    globalThis.fetch = async (url, options) => {
        const path = String(url);
        calls.push({ path, options, body: JSON.parse(options.body) });
        if (path.endsWith('/account/status')) {
            return new Promise((resolve) => { resolveStatus = resolve; });
        }
        if (path.endsWith('/account/login')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: true, username: 'alice',
                nsfwEnabled: false, nsflEnabled: true, nsflActive: true,
                token: 'must-be-ignored',
            });
        }
        if (path.endsWith('/account/nsfw')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: true, username: 'alice',
                nsfwEnabled: true, nsflEnabled: true, nsflActive: true,
            });
        }
        if (path.endsWith('/account/logout')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: false, username: null,
                nsfwEnabled: false, nsflEnabled: false, nsflActive: null,
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    try {
        const account = await import('../client/account.js?public-account-state');
        const observed = [];
        const unsubscribe = account.subscribeBotbooruAccount((value) => observed.push(value));
        assert.equal(observed.length, 1, 'subscription must immediately provide retained state');
        assert.equal(observed[0].known, false);

        const staleStatus = account.refreshBotbooruAccount();
        const password = ' p&+ss ';
        await account.loginBotbooruAccount('Alice', password);
        resolveStatus(jsonResponse({
            source: 'botbooru', loggedIn: false, username: null,
            nsfwEnabled: false, nsflEnabled: false, nsflActive: null,
        }));
        await staleStatus;

        assert.equal(account.getBotbooruAccount().loggedIn, true, 'late status must not overwrite login');
        assert.equal(account.getBotbooruAccount().username, 'alice');
        assert.equal(account.getBotbooruAccount().nsflActive, true);
        assert.equal('token' in account.getBotbooruAccount(), false);
        assert.doesNotMatch(JSON.stringify(account.getBotbooruAccount()), /must-be-ignored|p&\+ss/);

        const loginCall = calls.find((call) => call.path.endsWith('/account/login'));
        assert.deepEqual(loginCall.body, { source: 'botbooru', username: 'Alice', password });
        assert.equal(loginCall.options.credentials, 'same-origin');
        assert.equal(loginCall.options.headers['X-CSRF-Token'], 'csrf-test');

        await account.setBotbooruNsfw(true);
        assert.equal(account.getBotbooruAccount().nsfwEnabled, true);
        assert.deepEqual(calls.find((call) => call.path.endsWith('/account/nsfw')).body, {
            source: 'botbooru', enabled: true,
        });

        assert.equal(account.noteBotbooruAccountError({ code: 'botbooru_session_expired' }), true);
        assert.equal(account.getBotbooruAccount().loggedIn, false);
        assert.equal(account.getBotbooruAccount().error, 'botbooru_session_expired');
        assert.equal(account.noteBotbooruAccountError({ code: 'timeout' }), false);

        await account.logoutBotbooruAccount();
        assert.equal(account.getBotbooruAccount().loggedIn, false);
        assert.deepEqual(calls.find((call) => call.path.endsWith('/account/logout')).body, { source: 'botbooru' });
        unsubscribe();
    } finally {
        Object.assign(globalThis, previous);
    }
});

test('an older search error cannot overwrite an in-flight replacement login', async () => {
    const previous = {
        fetch: globalThis.fetch,
        window: globalThis.window,
        SillyTavern: globalThis.SillyTavern,
    };
    let loginCalls = 0;
    let resolveReplacement;
    globalThis.window = { location: { origin: 'https://local.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-test' }) }),
    };
    globalThis.fetch = async (url) => {
        if (!String(url).endsWith('/account/login')) {
            throw new Error(`unexpected request: ${url}`);
        }
        loginCalls += 1;
        if (loginCalls === 1) {
            return jsonResponse({
                source: 'botbooru', loggedIn: true, username: 'alice',
                nsfwEnabled: true, nsflEnabled: false, nsflActive: null,
            });
        }
        return new Promise((resolve) => { resolveReplacement = resolve; });
    };

    try {
        const account = await import('../client/account.js?account-error-race');
        await account.loginBotbooruAccount('Alice', 'first password');
        const replacement = account.loginBotbooruAccount('Bob', 'replacement password');
        await Promise.resolve();

        assert.equal(
            account.noteBotbooruAccountError({ code: 'botbooru_session_expired' }),
            false,
            'a response from the old session must not invalidate the replacement operation',
        );
        assert.equal(account.getBotbooruAccount().loggedIn, true);

        resolveReplacement(jsonResponse({
            source: 'botbooru', loggedIn: true, username: 'bob',
            nsfwEnabled: true, nsflEnabled: true, nsflActive: false,
        }));
        await replacement;
        assert.equal(account.getBotbooruAccount().username, 'bob');
        assert.equal(account.getBotbooruAccount().error, null);
    } finally {
        Object.assign(globalThis, previous);
    }
});

test('authoritative account-route expiry signs out retained client state', async () => {
    const previous = {
        fetch: globalThis.fetch,
        window: globalThis.window,
        SillyTavern: globalThis.SillyTavern,
    };
    let expireStatus = false;
    globalThis.window = { location: { origin: 'https://local.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-test' }) }),
    };
    globalThis.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith('/account/login')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: true, username: 'alice',
                nsfwEnabled: true, nsflEnabled: false, nsflActive: null,
            });
        }
        if (path.endsWith('/account/nsfw') || (path.endsWith('/account/status') && expireStatus)) {
            return jsonResponse({ error: 'botbooru_session_expired' }, 401);
        }
        if (path.endsWith('/account/status')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: true, username: 'alice',
                nsfwEnabled: true, nsflEnabled: false, nsflActive: null,
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    try {
        const account = await import('../client/account.js?authoritative-expiry');
        await account.loginBotbooruAccount('Alice', 'password');
        await assert.rejects(
            () => account.setBotbooruNsfw(false),
            (error) => error.code === 'botbooru_session_expired',
        );
        assert.equal(account.getBotbooruAccount().loggedIn, false);
        assert.equal(account.getBotbooruAccount().error, 'botbooru_session_expired');

        await account.loginBotbooruAccount('Alice', 'password');
        expireStatus = true;
        await assert.rejects(
            () => account.refreshBotbooruAccount(),
            (error) => error.code === 'botbooru_session_expired',
        );
        assert.equal(account.getBotbooruAccount().loggedIn, false);
    } finally {
        Object.assign(globalThis, previous);
    }
});

function pendingAccountRequests(t) {
    const previous = Object.fromEntries(['fetch', 'window', 'SillyTavern'].map((key) => [key, globalThis[key]]));
    const calls = [];
    globalThis.window = { location: { origin: 'https://local.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-test' }) }),
    };
    globalThis.fetch = (url, options) => new Promise((resolve) => {
        calls.push({ url: String(url), options, body: JSON.parse(options.body), resolve });
    });
    t.after(() => Object.assign(globalThis, previous));
    return calls;
}

for (const [source, prefix] of [['botbooru', 'Botbooru'], ['saucepan', 'Saucepan']]) {
    test(`${source} orders status replies, skips reads during mutations, and ignores obsolete failures`, async (t) => {
        const calls = pendingAccountRequests(t);
        const account = await import(`../client/account.js?${source}-status-order`);
        const refresh = account[`refresh${prefix}Account`];
        const login = account[`login${prefix}Account`];
        const logout = account[`logout${prefix}Account`];
        const get = account[`get${prefix}Account`];
        const observed = [];
        const unsubscribe = account[`subscribe${prefix}Account`]((value) => observed.push(value));
        const response = (loggedIn) => jsonResponse({
            loggedIn, username: loggedIn ? 'alice' : '',
            token: 'never retain this', password: 'never retain this either',
        });
        assert.equal(observed[0].known, false);

        const first = refresh();
        const second = refresh();
        calls[1].resolve(response(true));
        await second;
        const afterSecond = get();
        calls[0].resolve(response(false));
        await first;
        assert.equal(get(), afterSecond, 'the most recently started status check wins');

        const staleStatus = refresh();
        const replacement = login('alice', 'password');
        await refresh();
        assert.equal(calls.length, 4, 'status must not race the session being replaced');
        calls[3].resolve(response(true));
        await replacement;
        assert.equal(get().revision, afterSecond.revision + 1, 'successful mutations invalidate even identical public state');
        const afterLogin = get();
        calls[2].resolve(jsonResponse({ error: `${source}_session_expired` }, 401));
        assert.equal(await staleStatus, afterLogin, 'an obsolete status error must not reach a control catch handler');

        const oldLogin = login('alice', 'old password');
        const signOut = logout();
        calls[5].resolve(response(false));
        await signOut;
        const afterLogout = get();
        calls[4].resolve(jsonResponse({ error: `${source}_invalid_credentials` }, 401));
        assert.equal(await oldLogin, afterLogout, 'a late failed login cannot replace the logout result');
        assert.equal(get().loggedIn, false);
        assert.equal(get().error, null);

        const signIn = login('alice', 'password');
        calls[6].resolve(response(true));
        await signIn;
        const revision = get().revision;
        const unchanged = refresh();
        calls[7].resolve(response(true));
        await unchanged;
        assert.equal(get().revision, revision, 'unchanged status must not invalidate searches');
        assert.ok(Object.isFrozen(get()));
        assert.doesNotMatch(JSON.stringify(get()), /never retain|password|token/);

        const expired = refresh();
        calls[8].resolve(jsonResponse({ error: `${source}_session_expired` }, 401));
        await assert.rejects(expired, (error) => error.code === `${source}_session_expired`);
        assert.equal(get().loggedIn, false);
        assert.equal(get().error, `${source}_session_expired`);
        unsubscribe();
        const observedCount = observed.length;
        const last = logout();
        calls[9].resolve(response(false));
        await last;
        assert.equal(observed.length, observedCount);
    });
}

test('Saucepan token replacement shares only bounded public state and protects an in-flight mutation', async (t) => {
    const calls = pendingAccountRequests(t);
    const account = await import('../client/account.js?saucepan-token');
    const signal = new AbortController().signal;
    const token = 'test-bearer-value';
    const setting = account.setSaucepanToken(token, { signal });
    assert.equal(account.noteSaucepanAccountError({ code: 'saucepan_session_expired' }), false);
    assert.deepEqual(calls[0].body, { source: 'saucepan', token });
    assert.equal(calls[0].options.signal, signal);
    assert.equal(calls[0].options.credentials, 'same-origin');
    calls[0].resolve(jsonResponse({ loggedIn: true, token, username: 'must not be retained' }));
    await setting;
    assert.deepEqual(account.getSaucepanAccount(), { known: true, loggedIn: true, error: null, revision: 1 });
    assert.equal(account.noteSaucepanAccountError({ code: 'timeout' }), false);
    assert.equal(account.noteSaucepanAccountError({ code: 'saucepan_session_expired' }), true);
    assert.equal(account.getSaucepanAccount().loggedIn, false);
    assert.equal(account.getSaucepanAccount().revision, 2);
});

test('account recovery copy names the right source and preserves Janny recovery actions', () => {
    for (const source of ['Saucepan.ai', 'JannyAI']) {
        assert.doesNotMatch(accountErrorMessage({}, source), /BotBooru/);
        assert.doesNotMatch(accountErrorMessage({ code: 'account_profile_required' }, source), /BotBooru/);
    }
    assert.doesNotMatch(accountErrorMessage({ message: 'private response detail' }), /BotBooru|private response/);
    assert.match(accountErrorMessage({ code: 'timeout' }, 'JannyAI'), /timed out.*refresh status/);
    for (const format of [accountErrorMessage, searchErrorMessage, detailErrorMessage]) {
        assert.match(format({ code: 'janny_admin_required' }, 'JannyAI'), /Only a SillyBunny administrator/);
        assert.match(format({ code: 'janny_browser_request_failed' }, 'JannyAI'), /browser window.*refresh status/);
        assert.match(format({ code: 'janny_restore_failed' }, 'JannyAI'), /settings could not be restored.*before importing again/);
        assert.match(format({ code: 'saucepan_session_expired' }, 'Saucepan.ai'), /Saucepan\.ai.*expired/);
    }
});
