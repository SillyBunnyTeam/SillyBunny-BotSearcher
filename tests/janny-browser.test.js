import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import https from 'node:https';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import { Response } from 'node-fetch';
import { chromium } from 'playwright';

import { createJannyBrowser, JannyBrowserError } from '../server/janny-browser.js';
import { embedCardInPng, validateCardBytes } from '../server/cardbytes.js';

const ORIGIN = 'https://janitorai.com';
const ID = '311a6844-61d6-4468-aa98-91ecc7fbae86';
const CARD_URL = `${ORIGIN}/characters/${ID}`;
const SETTINGS_URL = `${ORIGIN}/hampter/api-settings`;
const AVATAR_URL = 'https://ella.janitorai.com/bot-avatars/portrait.png?width=1200';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
const PUBLIC_META = { name: 'Test character', showdefinition: true, personality: 'Public definition.', avatar: 'portrait.png' };
const CAPTURE = { messages: [{ role: 'system', content: '<Test Persona>Private definition.</Test Persona>' }] };

beforeEach((t) => {
    t.mock.method(chromium, 'launchPersistentContext', () => assert.fail('Tests must not open a saved browser profile'));
    t.mock.method(https, 'request', () => assert.fail('Tests must not make live HTTPS requests'));
});

function json(body, status = 200) {
    return { status, body: JSON.stringify(body) };
}

function mockBridge(t) {
    const state = {
        original: { selected_proxy_config_id: 'original', source: 'openai', generation_settings: { context_length: 8192, temperature: 0.7 } },
        presets: [{ id: 'original', client_id: 'original-client' }],
        meta: { name: 'Test character', showdefinition: false },
        signedIn: true,
        profile: { id: 'test-account' },
        requests: [],
        launches: [],
        contexts: [],
        events: [],
        warnings: [],
        response: { json: async () => CAPTURE, text: async () => JSON.stringify(CAPTURE) },
    };
    state.settings = structuredClone(state.original);
    t.mock.method(console, 'warn', (message) => state.warnings.push(message));

    async function request(target, init) {
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        state.requests.push({ target, method, body, profileId: state.profile?.id, cache: init.cache });
        const overridden = await state.request?.({ target, method, body });
        if (overridden !== undefined) {
            return overridden;
        }
        if (target.endsWith('/profiles/mine')) {
            return json(state.signedIn ? state.profile : null, state.signedIn ? 200 : 401);
        }
        if (target.includes('/hampter/characters/')) {
            return json(state.meta);
        }
        if (target === SETTINGS_URL) {
            if (method === 'PATCH') {
                Object.assign(state.settings, body);
            }
            return json({ settings: state.settings, proxy_configs: state.presets });
        }
        if (target === `${SETTINGS_URL}/proxy-configs`) {
            state.presets.push({ ...body, id: 'temporary' });
            return json({});
        }
        if (target.startsWith(`${SETTINGS_URL}/proxy-configs/`)) {
            assert.equal(method, 'DELETE');
            const id = target.split('/').at(-1);
            assert.notEqual(String(state.settings.selected_proxy_config_id), id, 'never delete the selected preset');
            state.presets = state.presets.filter((preset) => String(preset.id) !== id);
            return json({});
        }
        if (target === `${ORIGIN}/hampter/chats` && method === 'POST') {
            return json({ id: 'test-chat' });
        }
        if (target === `${ORIGIN}/hampter/chats/test-chat` && method === 'DELETE') {
            return json({});
        }
        assert.fail(`Unexpected mock request: ${method} ${target}`);
    }

    state.browser = createJannyBrowser({
        profileDir: '/tmp/opencode/janny-mock-profile-never-created',
        launchContext: async (directory) => {
            state.launches.push(directory);
            state.launchStarted?.resolve();
            await state.launchWait;
            if (state.launchError) {
                throw state.launchError;
            }
            const closed = Promise.withResolvers();
            closed.promise.catch(() => {});
            const context = new EventEmitter();
            let url = 'about:blank';
            const locator = {
                last() { return this; },
                count: async () => 1,
                isVisible: async () => true,
                isEnabled: async () => true,
                async click() {
                    if (state.sendError) {
                        throw state.sendError;
                    }
                },
                getAttribute: async () => null,
                fill: async () => {},
            };
            const page = {
                url: () => url,
                context: () => context,
                locator: () => locator,
                async goto(target) {
                    if (target === ORIGIN && state.navigationError) {
                        throw state.navigationError;
                    }
                    url = target;
                },
                async close() { closed.reject(new Error('page closed')); },
                evaluate(fn, arg) {
                    const overridden = state.evaluate?.(fn, arg, page);
                    let pending;
                    if (overridden !== undefined) {
                        pending = overridden;
                    } else if (arg?.target) {
                        pending = request(arg.target, arg.request);
                    } else if (arg?.base64) {
                        pending = state.transcodeError ? Promise.reject(state.transcodeError) : PNG.toString('base64');
                    } else {
                        pending = typeof arg === 'string' ? null : 'Mock Chromium';
                    }
                    return Promise.race([Promise.resolve(pending), closed.promise]);
                },
                waitForResponse(predicate, options) {
                    assert.equal(options.timeout, 120000);
                    assert.equal(predicate({ url: () => `${ORIGIN}/generateAlpha`, request: () => ({ method: () => 'POST' }) }), true);
                    return Promise.race([state.responseWait ?? Promise.resolve(state.response), closed.promise]);
                },
                request: { get() { assert.fail('buffered Playwright avatar requests must not be used'); } },
            };
            Object.assign(context, {
                pages: () => [page],
                async cookies(target) {
                    state.events.push(['cookies', target]);
                    return [{ name: 'avatar-session', value: 'test-only' }];
                },
                async setOffline(value) { state.events.push(['offline', value]); },
                async setStorageState(value) {
                    state.events.push(['storage', value]);
                    if (state.clearError) {
                        throw state.clearError;
                    }
                    assert.deepEqual(value, { cookies: [], origins: [{ origin: ORIGIN, localStorage: [] }] });
                    state.signedIn = false;
                },
                async close() {
                    state.events.push(['close']);
                    state.closeStarted?.resolve();
                    await state.closeWait;
                    closed.reject(new Error('context closed'));
                    context.emit('close');
                },
            });
            state.contexts.push(context);
            return context;
        },
        fetchAvatar: (url, options) => {
            assert.equal(options.redirect, 'manual');
            assert.equal(options.size, 20 * 1024 * 1024);
            assert.equal(options.headers.cookie, 'avatar-session=test-only');
            return state.fetchAvatar(url, options);
        },
    });
    t.after(() => state.browser.close());
    return state;
}

test('a failed send handles the later response-wait rejection and still restores settings', async (t) => {
    const state = mockBridge(t);
    const wait = Promise.withResolvers();
    state.responseWait = wait.promise;
    state.sendError = new Error('input disappeared');
    await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_private_capture_failed' });
    assert.deepEqual(state.settings, state.original);
    assert.deepEqual(state.presets.map(({ id }) => id), ['original']);
    wait.reject(new Error('late response timeout'));
    await nextTurn(); // node:test also fails on any unhandled rejection.
    assert.equal((await state.browser.status()).restorePending, false);
});

for (const phase of ['headers', 'body']) {
    test(`in-page ${phase} timeout aborts the request and releases the next operation`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const state = mockBridge(t);
        const entered = Promise.withResolvers();
        let signal;
        state.evaluate = (fn, arg) => {
            if (!arg?.target.includes('/hampter/characters/')) {
                return undefined;
            }
            return vm.runInNewContext(`(${fn.toString()})`, {
                document: { cookie: '' }, localStorage: { length: 0 },
                AbortController, setTimeout, clearTimeout,
                fetch: async (_url, init) => {
                    signal = init.signal;
                    const pending = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
                    entered.resolve();
                    return phase === 'headers' ? pending : { status: 200, text: () => pending };
                },
            })(arg);
        };
        const failed = assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_browser_request_failed', status: 502 });
        await entered.promise;
        const next = state.browser.status();
        t.mock.timers.tick(30000);
        await failed;
        assert.equal(signal.aborted, true);
        assert.deepEqual(await next, { ready: true, loggedIn: true, restorePending: false });
    });
}

test('the server-side deadline also releases a frozen page evaluation', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    const entered = Promise.withResolvers();
    state.evaluate = (_fn, arg) => {
        if (arg?.target.includes('/hampter/characters/')) {
            entered.resolve();
            return new Promise(() => {});
        }
        return undefined;
    };
    const failed = assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_browser_request_failed' });
    await entered.promise;
    t.mock.timers.tick(31000);
    await failed;
});

test('the captured response body has a deadline and still restores settings', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    const entered = Promise.withResolvers();
    const body = Promise.withResolvers();
    state.response.json = () => { entered.resolve(); return body.promise; };
    const failed = assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_browser_request_failed' });
    await entered.promise;
    t.mock.timers.tick(30000);
    await failed;
    assert.deepEqual(state.settings, state.original);
    body.reject(new Error('late body failure'));
    await nextTurn();
});

for (const failure of ['http', 'transport', 'ignored patch', 'partial patch', 'verification', 'delete']) {
    test(`a restore ${failure} failure is reported and can be retried through status`, async (t) => {
        const state = mockBridge(t);
        let restoring = false;
        state.request = ({ target, method, body }) => {
            if (target === SETTINGS_URL && method === 'PATCH' && body.selected_proxy_config_id === 'original') {
                restoring = true;
                if (failure === 'http') {
                    return json({}, 503);
                }
                if (failure === 'transport') {
                    throw new Error('connection lost');
                }
                if (failure === 'ignored patch' || failure === 'partial patch') {
                    if (failure === 'partial patch') {
                        state.settings.selected_proxy_config_id = 'original';
                    }
                    return json({});
                }
            }
            if (restoring && failure === 'verification' && target === SETTINGS_URL && method === 'GET') {
                return json({});
            }
            if (failure === 'delete' && target.endsWith('/proxy-configs/temporary')) {
                return json({}, 503);
            }
            return undefined;
        };
        await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed', status: 502 });
        assert.equal(state.presets.some(({ id }) => id === 'temporary'), true);
        const pending = await state.browser.status();
        assert.deepEqual(pending, { ready: true, loggedIn: true, restorePending: true, code: 'janny_restore_failed' });
        assert.equal(JSON.stringify(pending).includes('selected_proxy'), false);
        state.request = undefined;
        assert.deepEqual(await state.browser.status(), { ready: true, loggedIn: true, restorePending: false });
        assert.deepEqual(state.settings, state.original);
        assert.deepEqual(state.presets.map(({ id }) => id), ['original']);
        const result = await state.browser.fetchCard(CARD_URL);
        assert.deepEqual(Object.keys(result).sort(), ['avatarPng', 'card', 'id']);
        assert.equal(result.card.data.description, 'Private definition.');
    });
}

test('capture setup failures retain recovery even when the remote mutation lost its reply', async (t) => {
    for (const lost of ['create', 'select']) {
        await t.test(lost, async (t) => {
            const state = mockBridge(t);
            state.request = ({ target, method, body }) => {
                if (lost === 'create' && target.endsWith('/proxy-configs') && method === 'POST') {
                    state.presets.push({ ...body, id: 'temporary' });
                    throw new Error('created but reply lost');
                }
                if (lost === 'select' && target === SETTINGS_URL && body?.selected_proxy_config_id === 'temporary') {
                    state.settings.selected_proxy_config_id = 'temporary';
                    throw new Error('selected but reply lost');
                }
                if (target === SETTINGS_URL && method === 'PATCH' && body.selected_proxy_config_id === 'original') {
                    return json({}, 500);
                }
                return undefined;
            };
            await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
            assert.equal(state.presets.length, 2);
            state.request = undefined;
            await state.contexts[0].close();
            assert.deepEqual(await state.browser.status(), { ready: false, loggedIn: false, restorePending: true, code: 'janny_restore_failed' });
            assert.equal((await state.browser.login()).restorePending, false);
            assert.deepEqual(state.settings, state.original);
            assert.equal(state.presets.length, 1);
        });
    }
});

for (const action of ['status', 'login', 'logout', 'fetchCard', 'close']) {
    for (const identity of ['different', 'missing', 'unavailable']) {
        test(`${action} refuses recovery when profile identity is ${identity}, without account writes`, async (t) => {
            const state = mockBridge(t);
            state.request = ({ method, body }) => method === 'PATCH' && body?.selected_proxy_config_id === 'original' ? json({}, 500) : undefined;
            await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
            const accountA = { settings: state.settings, presets: state.presets };
            state.profile = identity === 'missing' ? {} : { id: 'other-account' };
            state.settings = { selected_proxy_config_id: 'other', source: 'other', generation_settings: { context_length: 4096 } };
            state.presets = [{ id: 'other', client_id: 'other-client' }];
            const accountB = structuredClone({ settings: state.settings, presets: state.presets });
            state.request = identity === 'unavailable' ? ({ target }) => {
                if (target.endsWith('/profiles/mine')) {
                    throw new Error('profile request failed');
                }
                return undefined;
            } : undefined;
            const start = state.requests.length;
            if (action === 'status' || action === 'login') {
                const status = await state.browser[action]();
                assert.equal(status.restorePending, true);
                assert.equal(status.code, 'janny_restore_failed');
                assert.equal(Object.hasOwn(status, 'profileId'), false);
            } else if (action === 'close') {
                await state.browser.close();
                assert.ok(state.warnings.some((message) => message.includes('janny_restore_failed')));
            } else {
                await assert.rejects(state.browser[action](CARD_URL), { code: 'janny_restore_failed', status: 502 });
            }
            assert.equal(state.requests.slice(start).some(({ method }) => method !== 'GET'), false);
            assert.equal(state.events.some(([event]) => event === 'storage'), false);
            assert.deepEqual({ settings: state.settings, presets: state.presets }, accountB);
            if (action !== 'close') {
                // A's original snapshot survives every refused B action.
                state.profile = { id: 'test-account' };
                Object.assign(state, accountA);
                state.request = undefined;
                assert.equal((await state.browser.status()).restorePending, false);
                assert.deepEqual(state.settings, state.original);
                assert.deepEqual(state.presets.map(({ id }) => id), ['original']);
                assert.ok(state.requests.some(({ target, method }) => target.endsWith('/chats/test-chat') && method === 'DELETE'));
            }
        });
    }
}

test('capture refuses missing or invalid originating profile IDs before any mutation', async (t) => {
    for (const profile of [null, {}, { id: null }, { id: '' }, { id: ' ' }, { id: 1 }, { id: {} }]) {
        const state = mockBridge(t);
        state.profile = profile;
        await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
        assert.equal(state.requests.some(({ method }) => method !== 'GET'), false);
        assert.equal((await state.browser.status()).restorePending, false);
    }
});

test('an account switch while reading original settings cannot mislabel the recovery snapshot', async (t) => {
    const state = mockBridge(t);
    state.request = ({ target, method }) => {
        if (target === SETTINGS_URL && method === 'GET') {
            state.profile = { id: 'other-account' };
        }
        return undefined;
    };
    await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
    assert.equal(state.requests.some(({ method }) => method !== 'GET'), false);
    assert.equal((await state.browser.status()).restorePending, false);
});

test('every capture and cleanup write is preceded by an uncached profile check', async (t) => {
    const state = mockBridge(t);
    await state.browser.fetchCard(CARD_URL);
    for (const [index, request] of state.requests.entries()) {
        if (request.method !== 'GET') {
            assert.equal(state.requests[index - 1].target, `${ORIGIN}/hampter/profiles/mine`);
            assert.equal(state.requests[index - 1].cache, 'no-store');
        }
    }
});

for (const phase of ['capture response', 'restore verification', 'preset deletion', 'chat deletion']) {
    test(`switching accounts after ${phase} blocks further cleanup and retains recovery`, async (t) => {
        const state = mockBridge(t);
        let accountA;
        const switchAccount = () => {
            accountA = { settings: state.settings, presets: state.presets };
            state.profile = { id: 'other-account' };
            state.settings = { selected_proxy_config_id: 'other', source: 'other' };
            state.presets = [{ id: 'other' }];
        };
        if (phase === 'capture response') {
            state.response.json = async () => { switchAccount(); return CAPTURE; };
        } else {
            let restoring = false;
            state.request = ({ target, method, body }) => {
                if (target === SETTINGS_URL && method === 'PATCH' && body.selected_proxy_config_id === 'original') {
                    restoring = true;
                }
                if (phase === 'restore verification' && restoring && target === SETTINGS_URL && method === 'GET') {
                    const restored = json({ settings: state.settings, proxy_configs: state.presets });
                    switchAccount();
                    return restored;
                }
                if (phase === 'preset deletion' && target.endsWith('/proxy-configs/temporary') && method === 'DELETE') {
                    state.presets = state.presets.filter(({ id }) => id !== 'temporary');
                    switchAccount();
                    return json({});
                }
                if (phase === 'chat deletion' && target.endsWith('/chats/test-chat') && method === 'DELETE') {
                    switchAccount();
                    return json({});
                }
                return undefined;
            };
        }
        await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
        assert.equal(state.requests.some(({ profileId, method }) => profileId === 'other-account' && method !== 'GET'), false);
        assert.equal((await state.browser.status()).restorePending, true);
        state.profile = { id: 'test-account' };
        Object.assign(state, accountA);
        state.request = undefined;
        assert.equal((await state.browser.status()).restorePending, false);
        assert.deepEqual(state.settings, state.original);
        assert.deepEqual(state.presets.map(({ id }) => id), ['original']);
        assert.ok(state.requests.some(({ target, method }) => target.endsWith('/chats/test-chat') && method === 'DELETE'));
    });
}

test('null settings are restored and absent optional settings are not changed', async (t) => {
    for (const original of [
        { selected_proxy_config_id: null, source: null, generation_settings: null },
        { selected_proxy_config_id: null },
    ]) {
        const state = mockBridge(t);
        state.settings = structuredClone(original);
        await state.browser.fetchCard(CARD_URL);
        assert.deepEqual(state.settings, original);
    }
});

test('missing or malformed original settings fail before any account mutation', async (t) => {
    for (const settings of [{}, { selected_proxy_config_id: {} }, { selected_proxy_config_id: null, source: {} },
        { selected_proxy_config_id: null, generation_settings: 'not an object' }]) {
        const state = mockBridge(t);
        state.settings = settings;
        await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_private_capture_failed' });
        assert.equal(state.requests.some(({ method }) => method !== 'GET'), false);
    }
});

test('logout opens and clears the saved session even after its window was closed', async (t) => {
    for (const alreadyOpened of [false, true]) {
        const state = mockBridge(t);
        if (alreadyOpened) {
            await state.browser.login();
            await state.contexts[0].close();
        }
        assert.deepEqual(await state.browser.logout(), { ready: false, loggedIn: false, restorePending: false });
        assert.equal(state.launches.length, alreadyOpened ? 2 : 1);
        assert.ok(state.launches.every((directory) => directory === '/tmp/opencode/janny-mock-profile-never-created'));
        assert.equal(state.signedIn, false);
        assert.equal((await state.browser.login()).loggedIn, false);
    }
});

test('logout reports launch or storage-clear failures instead of claiming success', async (t) => {
    const state = mockBridge(t);
    state.launchError = new JannyBrowserError('janny_browser_unavailable', 503);
    await assert.rejects(state.browser.logout(), { code: 'janny_browser_unavailable' });
    state.launchError = null;
    state.clearError = new Error('storage unavailable');
    await assert.rejects(state.browser.logout(), { code: 'janny_browser_request_failed', status: 502 });
    assert.equal(state.signedIn, true);
    assert.equal(state.events.filter(([event]) => event === 'close').length, 1);
});

test('logout preserves credentials until pending settings have been restored', async (t) => {
    const state = mockBridge(t);
    state.request = ({ method, body }) => method === 'PATCH' && body?.selected_proxy_config_id === 'original' ? json({}, 500) : undefined;
    await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
    await assert.rejects(state.browser.logout(), { code: 'janny_restore_failed' });
    assert.equal(state.events.some(([event]) => event === 'storage'), false);
    assert.equal(state.signedIn, true);
    state.request = undefined;
    await state.browser.logout();
    assert.deepEqual(state.settings, state.original);
    assert.equal(state.signedIn, false);
});

test('logout navigation failures keep recovery pending and report the restore error', async (t) => {
    const state = mockBridge(t);
    state.request = ({ method, body }) => method === 'PATCH' && body?.selected_proxy_config_id === 'original' ? json({}, 500) : undefined;
    await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
    await state.contexts[0].close();
    state.request = undefined;
    state.navigationError = new Error('navigation failed');
    await assert.rejects(state.browser.logout(), { code: 'janny_restore_failed', status: 502 });
    assert.equal(state.signedIn, true);
    assert.equal(state.events.some(([event]) => event === 'storage'), false);
    state.navigationError = null;
    assert.equal((await state.browser.status()).restorePending, false);
});

test('shutdown bypasses a stalled operation and rejects queued work without reopening', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    const entered = Promise.withResolvers();
    state.evaluate = (_fn, arg) => {
        if (arg?.target.includes('/hampter/characters/')) {
            entered.resolve();
            return new Promise(() => {});
        }
        return undefined;
    };
    const failed = assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_browser_request_failed' });
    await entered.promise;
    const queued = assert.rejects(state.browser.login(), { code: 'janny_browser_unavailable' });
    const closing = state.browser.close();
    t.mock.timers.tick(5000);
    await closing;
    await failed;
    await queued;
    await state.browser.close();
    await assert.rejects(state.browser.login(), { code: 'janny_browser_unavailable' });
    assert.equal(state.launches.length, 1);
    assert.equal(state.events.filter(([event]) => event === 'close').length, 1);
});

test('shutdown is bounded even when the context close does not settle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    await state.browser.login();
    const wait = Promise.withResolvers();
    state.closeWait = wait.promise;
    state.closeStarted = Promise.withResolvers();
    const closing = state.browser.close();
    await state.closeStarted.promise;
    t.mock.timers.tick(5000);
    await closing;
    wait.resolve();
});

test('a launch completing after shutdown closes its context instead of retaining it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    const wait = Promise.withResolvers();
    state.launchWait = wait.promise;
    state.launchStarted = Promise.withResolvers();
    const login = assert.rejects(state.browser.login(), { code: 'janny_browser_unavailable' });
    await state.launchStarted.promise;
    const closing = state.browser.close();
    t.mock.timers.tick(5000);
    await closing;
    wait.resolve();
    await login;
    assert.equal(state.events.filter(([event]) => event === 'close').length, 1);
});

test('shutdown retries pending restoration before closing the context', async (t) => {
    const state = mockBridge(t);
    state.request = ({ method, body }) => method === 'PATCH' && body?.selected_proxy_config_id === 'original' ? json({}, 500) : undefined;
    await assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
    state.request = undefined;
    await state.browser.close();
    assert.deepEqual(state.settings, state.original);
    assert.deepEqual(state.presets.map(({ id }) => id), ['original']);
    assert.equal(state.warnings.length, 0);
});

test('shutdown during a stalled restore leaves the active preset intact and reports failure', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    const entered = Promise.withResolvers();
    state.evaluate = (_fn, arg) => {
        if (arg?.target === SETTINGS_URL && arg.request.method === 'PATCH'
            && JSON.parse(arg.request.body).selected_proxy_config_id === 'original') {
            entered.resolve();
            return new Promise(() => {});
        }
        return undefined;
    };
    const failed = assert.rejects(state.browser.fetchCard(CARD_URL), { code: 'janny_restore_failed' });
    await entered.promise;
    const closing = state.browser.close();
    t.mock.timers.tick(5000);
    await closing;
    await failed;
    assert.equal(state.settings.selected_proxy_config_id, 'temporary');
    assert.equal(state.presets.length, 2);
    assert.ok(state.warnings.some((message) => message.includes('janny_restore_failed')));
});

test('avatar redirects stay on allowed paths and release every response stream', async (t) => {
    const state = mockBridge(t);
    state.meta = PUBLIC_META;
    const responses = [];
    const urls = [];
    state.fetchAvatar = async (url, options) => {
        urls.push(url);
        const response = new Response(Readable.from([PNG]), {
            size: options.size,
            status: urls.length === 1 ? 302 : 200,
            headers: urls.length === 1 ? { location: '/chats/portrait.png' } : {},
        });
        responses.push(response);
        return response;
    };
    const result = await state.browser.fetchCard(CARD_URL);
    assert.deepEqual(urls, [AVATAR_URL, 'https://ella.janitorai.com/chats/portrait.png']);
    assert.ok(responses.every((response) => response.body.destroyed));
    assert.deepEqual(result.avatarPng, PNG);
    assert.equal(validateCardBytes(embedCardInPng(result.avatarPng, result.card), 'png').inside.name, PUBLIC_META.name);
});

test('off-host, insecure and off-path avatar redirects are rejected before another request', async (t) => {
    for (const location of ['https://127.0.0.1/bot-avatars/a.png', 'http://ella.janitorai.com/bot-avatars/a.png', '/other/a.png']) {
        const state = mockBridge(t);
        state.meta = PUBLIC_META;
        let calls = 0;
        const response = new Response(new Readable({ read() {} }), { status: 302, headers: { location } });
        state.fetchAvatar = async (url) => { assert.equal(url, AVATAR_URL); calls += 1; return response; };
        assert.equal((await state.browser.fetchCard(CARD_URL)).avatarPng, null);
        assert.equal(calls, 1);
        assert.equal(response.body.destroyed, true);
    }
});

test('avatar redirect loops stop after three hops and destroy all four responses', async (t) => {
    const state = mockBridge(t);
    state.meta = PUBLIC_META;
    const responses = [];
    state.fetchAvatar = async () => {
        const response = new Response(new Readable({ read() {} }), { status: 307, headers: { location: '/bot-avatars/loop.png' } });
        responses.push(response);
        return response;
    };
    assert.equal((await state.browser.fetchCard(CARD_URL)).avatarPng, null);
    assert.equal(responses.length, 4);
    assert.ok(responses.every((response) => response.body.destroyed));
});

test('avatar size limits stop reading before a complete oversized download', async (t) => {
    for (const declared of [true, false]) {
        const state = mockBridge(t);
        state.meta = PUBLIC_META;
        let chunks = 0;
        const stream = Readable.from((async function* () {
            for (let index = 0; index < 100; index += 1) {
                chunks += 1;
                yield Buffer.alloc(1024 * 1024);
            }
        })());
        state.fetchAvatar = async (_url, options) => new Response(stream, {
            size: options.size,
            headers: declared ? { 'content-length': String(100 * 1024 * 1024) } : {},
        });
        assert.equal((await state.browser.fetchCard(CARD_URL)).avatarPng, null);
        assert.equal(stream.destroyed, true);
        assert.ok(chunks < 100, 'stop the stream rather than check its size after downloading');
        if (declared) {
            assert.equal(chunks, 0);
        }
    }
});

for (const failure of ['http', 'body', 'decode']) {
    test(`avatar ${failure} failures release the response and preserve the JSON card fallback`, async (t) => {
        const state = mockBridge(t);
        state.meta = PUBLIC_META;
        const stream = failure === 'body'
            ? Readable.from((async function* () { yield PNG; throw new Error('body failed'); })())
            : Readable.from([PNG]);
        state.fetchAvatar = async (_url, options) => new Response(stream, { size: options.size, status: failure === 'http' ? 503 : 200 });
        if (failure === 'decode') {
            state.transcodeError = new Error('invalid picture');
        }
        const result = await state.browser.fetchCard(CARD_URL);
        assert.equal(result.avatarPng, null);
        assert.equal(result.card.data.description, PUBLIC_META.personality);
        assert.equal(stream.destroyed, true);
    });
}

test('an avatar body timeout aborts and destroys its stream', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    state.meta = PUBLIC_META;
    const entered = Promise.withResolvers();
    const stream = new Readable({ read() { entered.resolve(); } });
    let signal;
    state.fetchAvatar = async (_url, options) => {
        signal = options.signal;
        signal.addEventListener('abort', () => stream.destroy(new Error('aborted')), { once: true });
        return new Response(stream, { size: options.size });
    };
    const imported = state.browser.fetchCard(CARD_URL);
    await entered.promise;
    t.mock.timers.tick(30000);
    assert.equal((await imported).avatarPng, null);
    assert.equal(signal.aborted, true);
    assert.equal(stream.destroyed, true);
});

test('closing the browser aborts an avatar request still waiting for headers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = mockBridge(t);
    state.meta = PUBLIC_META;
    const entered = Promise.withResolvers();
    let signal;
    state.fetchAvatar = (_url, options) => {
        signal = options.signal;
        entered.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const imported = state.browser.fetchCard(CARD_URL);
    await entered.promise;
    const closing = state.browser.close();
    t.mock.timers.tick(5000);
    await closing;
    assert.equal((await imported).avatarPng, null);
    assert.equal(signal.aborted, true);
    assert.equal(state.contexts[0].listenerCount('close'), 1, 'remove the avatar abort listener');
});

test('PNG conversion works on an in-memory strict-CSP page without data fetches or live requests', async (t) => {
    if (!existsSync(chromium.executablePath())) {
        t.skip('Playwright Chromium is not installed; mock lifecycle tests still run');
        return;
    }
    const chromiumBrowser = await chromium.launch({ headless: true });
    t.after(() => chromiumBrowser.close());
    const context = await chromiumBrowser.newContext({ serviceWorkers: 'block' });
    const unexpected = [];
    await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url === `${ORIGIN}/hampter/characters/${ID}`) {
            await route.fulfill({ json: PUBLIC_META });
        } else if (url === CARD_URL) {
            await route.fulfill({
                contentType: 'text/html',
                headers: { 'content-security-policy': "default-src 'none'; connect-src 'self'" },
                body: '<!doctype html><title>Local avatar check</title>',
            });
        } else {
            unexpected.push(url);
            await route.abort();
        }
    });
    const browser = createJannyBrowser({
        launchContext: async () => context,
        fetchAvatar: async (url, options) => {
            assert.equal(url, AVATAR_URL);
            return new Response(Readable.from([PNG]), { size: options.size });
        },
    });
    t.after(() => browser.close());
    const imported = await browser.fetchCard(CARD_URL);
    assert.ok(Buffer.isBuffer(imported.avatarPng));
    assert.equal(validateCardBytes(embedCardInPng(imported.avatarPng, imported.card), 'png').inside.name, PUBLIC_META.name);
    assert.equal(await context.pages()[0].evaluate(() => fetch('data:text/plain,blocked').then(() => false, () => true)), true);
    assert.deepEqual(unexpected, []);

    await context.pages()[0].evaluate(() => {
        localStorage.setItem('test-auth', 'fake-session');
        sessionStorage.setItem('test-auth', 'fake-session');
    });
    await context.addCookies([{ name: 'test-auth', value: 'fake-session', url: ORIGIN }]);
    const closeContext = context.close.bind(context);
    t.mock.method(context, 'close', async () => {
        const saved = await context.storageState({ indexedDB: true });
        assert.deepEqual(saved.cookies, []);
        assert.ok(saved.origins.every((origin) => origin.localStorage.length === 0 && !origin.indexedDB?.length));
        await closeContext();
    });
    assert.deepEqual(await browser.logout(), { ready: false, loggedIn: false, restorePending: false });
    assert.deepEqual(unexpected, []);
});
