import test from 'node:test';
import assert from 'node:assert/strict';

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
