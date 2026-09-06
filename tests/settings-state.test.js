import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as settings from '../client/settings.js';
import { getSaucepanAccount, loginSaucepanAccount } from '../client/account.js';
import { invalidateAvailability } from '../client/api.js';
import { SETTINGS_KEY } from '../client/constants.js';
import { FILTER_LIMITS, PROTOCOL_VERSION, VERSION } from '../shared/schema.js';
import { SOURCES } from '../server/registry.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const entry = (extra = {}) => ({ name: 'Elves', query: 'elf', source: 'botbooru', ...extra });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

function host(t, raw = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div></body>', { url: 'https://local.test/' });
    const previous = Object.fromEntries(['document', 'window', 'requestAnimationFrame', 'fetch', 'SillyTavern']
        .map((key) => [key, globalThis[key]]));
    const extensionSettings = { [SETTINGS_KEY]: raw };
    const observers = new Set();
    const NativeObserver = dom.window.MutationObserver;
    let saves = 0;
    let callbacks = 0;
    dom.window.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super((...args) => { callbacks++; callback(...args); });
        }
        observe(...args) {
            super.observe(...args);
            observers.add(this);
        }
        disconnect() {
            super.disconnect();
            observers.delete(this);
        }
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        SillyTavern: {
            getContext: () => ({
                extensionSettings,
                saveSettingsDebounced() { saves++; },
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            }),
        },
        fetch: async (url, options = {}) => {
            const path = String(url);
            if (path.endsWith('/healthz')) {
                return jsonResponse({ protocol: PROTOCOL_VERSION, version: VERSION, sources: Object.values(SOURCES) });
            }
            if (path.endsWith('/account/status')) {
                return jsonResponse({ source: JSON.parse(options.body).source, loggedIn: false });
            }
            if (path.endsWith('/janny/status')) {
                return jsonResponse({ ready: false, loggedIn: false });
            }
            throw new Error(`Unexpected request: ${url}`);
        },
    });
    invalidateAvailability();
    t.after(async () => {
        try {
            dom.window.document.body.replaceChildren();
            await tick();
            await tick();
            assert.equal(observers.size, 0, 'detached controls must disconnect every observer');
        } finally {
            invalidateAvailability();
            Object.assign(globalThis, previous);
            dom.window.close();
        }
    });
    return { dom, extensionSettings, observers, get saves() { return saves; }, get callbacks() { return callbacks; } };
}

test('settings reads repair private records once and leave clean reads write-free', (t) => {
    const state = host(t, {
        _v: 3, queryHistory: ['private history'], namedSearches: [entry()],
    });
    for (let index = 0; index < 10; index++) {
        const value = settings.getSettings();
        assert.deepEqual(value.queryHistory, []);
        assert.deepEqual(value.namedSearches, []);
        assert.equal(value.saveNamedSearches, false);
    }
    assert.equal(state.saves, 1);
    assert.deepEqual(state.extensionSettings[SETTINGS_KEY].queryHistory, []);
    assert.deepEqual(state.extensionSettings[SETTINGS_KEY].namedSearches, []);

    state.extensionSettings[SETTINGS_KEY] = { saveQueryHistory: false, queryHistory: [], saveNamedSearches: false, namedSearches: [] };
    settings.getSettings();
    settings.getSettings();
    assert.equal(state.saves, 1, 'disabled, empty history must not schedule saves on reads');

    settings.updateSettings({ queryHistory: ['discard'], namedSearches: [entry()] });
    assert.equal(state.saves, 2, 'an update must schedule only one save, including a purge');
    assert.deepEqual(settings.getSettings().queryHistory, []);
    assert.deepEqual(settings.getSettings().namedSearches, []);
    assert.equal(state.saves, 2);
});

test('named searches need a separate opt-in and opting out purges the stored records', (t) => {
    const state = host(t);
    assert.equal(settings.saveNamedSearch(entry()), false);
    assert.equal(state.saves, 0);
    settings.updateSettings({ saveQueryHistory: true });
    settings.rememberQuery('history term');
    assert.equal(settings.saveNamedSearch(entry()), false, 'history opt-in is not named-search consent');

    settings.updateSettings({ saveNamedSearches: true });
    assert.equal(settings.saveNamedSearch(entry()), true);
    settings.updateSettings({ saveQueryHistory: false });
    assert.equal(settings.getSettings().namedSearches.length, 1);
    assert.deepEqual(settings.getSettings().queryHistory, []);
    settings.updateSettings({ saveNamedSearches: false });
    assert.deepEqual(state.extensionSettings[SETTINGS_KEY].namedSearches, []);
    settings.updateSettings({ saveNamedSearches: true });
    assert.deepEqual(settings.getSettings().namedSearches, [], 'turning consent back on cannot restore purged entries');
});

test('named searches keep only bounded query choices, never card data or credentials', (t) => {
    const state = host(t, { saveNamedSearches: true });
    const filters = Object.assign(Object.create({ franchise: 'inherited text' }), {
        tags: ['Elf', 'Elf', 'x'.repeat(100), 'https://private.test/tag', { text: 'nested' }, ...Array(20).fill('forest')],
        excludeTags: ['modern'], writer: 'w'.repeat(100), character: 'https://private.test/character',
        minTokens: -99, maxTokens: 2_000_000, uploadedAfter: '2024-02-29', uploadedBefore: '2024-02-30', ocOnly: true,
        creator: 'wrong source', token: 'filter-secret', description: 'private card text',
    });
    const raw = entry({
        name: 'n'.repeat(100), query: 'q'.repeat(300), filters, sort: 'latest',
        sorts: { chub: 'trending', botbooru: 'not-a-sort', token: 'credential', __all__: 'latest' },
        sfwOnly: false, hideAi: true,
        token: 'top-level-secret', importUrl: 'https://private.test/import', first_mes: 'private greeting',
        promptText: { description: 'private prompt' },
    });
    assert.equal(settings.saveNamedSearch(raw), true);
    const saved = settings.getSettings().namedSearches[0];
    assert.deepEqual(Object.keys(saved).sort(), ['name', 'query', 'source', 'filters', 'sort', 'sorts', 'sfwOnly', 'hideAi'].sort());
    assert.equal(saved.name.length, settings.MAX_NAMED_SEARCH_NAME);
    assert.equal(saved.query.length, 128);
    assert.deepEqual(saved.filters, {
        tags: ['Elf', 'x'.repeat(FILTER_LIMITS.tagLength), 'forest'], excludeTags: ['modern'],
        writer: 'w'.repeat(FILTER_LIMITS.textLength), minTokens: 0, maxTokens: FILTER_LIMITS.numberMax,
        uploadedAfter: '2024-02-29', ocOnly: true,
    });
    assert.deepEqual(saved.sorts, { chub: 'trending' });
    assert.equal(saved.sfwOnly, false);
    assert.equal(saved.hideAi, true);
    assert.doesNotMatch(JSON.stringify(state.extensionSettings), /private|secret|credential|https|inherited|wrong source/);
    raw.filters.writer = 'changed after saving';
    saved.filters.tags.push('changed after reading');
    assert.equal(settings.getSettings().namedSearches[0].filters.writer.length, FILTER_LIMITS.textLength);
    assert.equal(settings.getSettings().namedSearches[0].filters.tags.includes('changed after reading'), false);
});

test('URL queries and names are rejected before truncation and unsafe persisted data is purged', (t) => {
    const state = host(t, { saveNamedSearches: true });
    for (const text of [
        'https://private.test/card', 'look at HTTPS://private.test/card', '//private.test/card',
        'www.private.test/card', 'https:private.test/card', 'data:text/plain,secret', 'javascript:alert(1)', 'Bearer credential',
        `${'x'.repeat(300)} https://private.test/card`,
    ]) {
        assert.equal(settings.saveNamedSearch(entry({ query: text })), false, text);
        assert.equal(settings.saveNamedSearch(entry({ name: text })), false, text);
    }
    for (const bad of [null, [], entry({ name: '' }), entry({ query: {} }), entry({ source: '__proto__' }),
        entry({ source: 'unknown-source' }), entry({ source: 'a'.repeat(65) }), Object.create(entry())]) {
        assert.equal(settings.saveNamedSearch(bad), false);
    }
    assert.equal(state.saves, 0);

    state.extensionSettings[SETTINGS_KEY].namedSearches = [
        entry({ query: 'https://private.test/card' }),
        entry({ name: 'Allowed', filters: { writer: 'https://private.test/author', tags: ['elf'], minTokens: NaN }, token: 'secret' }),
    ];
    const normalized = settings.getSettings().namedSearches;
    assert.equal(normalized.length, 1);
    assert.deepEqual(normalized[0].filters, { tags: ['elf'] });
    assert.equal(state.saves, 1);
    assert.doesNotMatch(JSON.stringify(state.extensionSettings), /https|private|secret/);
    settings.getSettings();
    assert.equal(state.saves, 1);
});

test('named searches replace names case-insensitively, cap at 20 without eviction, and survive reload', async (t) => {
    const state = host(t, { saveNamedSearches: true });
    for (let index = 0; index < settings.MAX_NAMED_SEARCHES; index++) {
        assert.equal(settings.saveNamedSearch(entry({ name: `Search ${index}` })), true);
    }
    assert.equal(settings.saveNamedSearch(entry({ name: 'One too many' })), false);
    assert.equal(settings.saveNamedSearch(entry({ name: ' SEARCH 0 ', query: '', source: '__all__', sorts: { chub: 'trending' } })), true);
    assert.equal(settings.getSettings().namedSearches.length, 20);
    assert.equal(settings.getSettings().namedSearches[0].name, 'SEARCH 0');
    assert.equal(settings.removeNamedSearch(' search 1 '), true);
    assert.equal(settings.removeNamedSearch('search 1'), false);

    const before = settings.getSettings().namedSearches;
    state.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(state.extensionSettings[SETTINGS_KEY]));
    const reloaded = await import('../client/settings.js?named-search-reload');
    const saves = state.saves;
    assert.deepEqual(reloaded.getSettings().namedSearches, before);
    assert.equal(state.saves, saves, 'valid persisted data does not need another write on reload');
});

test('named-search filter and sort allowlists cover current source declarations', (t) => {
    host(t, { saveNamedSearches: true });
    const values = { tags: ['elf'], text: 'example', number: 42, date: '2024-02-29', boolean: true };
    for (const source of Object.values(SOURCES)) {
        const filters = Object.fromEntries((source.capabilities.filters ?? []).map((spec) => [spec.key, values[spec.type]]));
        for (const sort of source.capabilities.sorts) {
            assert.equal(settings.saveNamedSearch(entry({ name: source.id, source: source.id, filters, sort, sorts: { [source.id]: sort } })), true);
            const saved = settings.getSettings().namedSearches[0];
            assert.equal(saved.sort, sort, `${source.id} sort must remain usable`);
            assert.deepEqual(saved.sorts, { [source.id]: sort });
            assert.deepEqual(saved.filters, filters, `${source.id} filters must remain usable`);
        }
    }
});

test('mounted preferences, sources and clear actions stay current and release their listeners', async (t) => {
    const state = host(t);
    await settings.mountSettings();
    await tick();
    const root = document.getElementById('sbbs_settings');
    const content = document.getElementById('sbbs_settings_content');
    assert.equal(content.firstElementChild.textContent, 'Preferences');
    assert.equal(content.lastElementChild.classList.contains('sbbs-setting-plugin'), true);
    const sections = [...content.children];
    assert.ok(sections.indexOf(content.querySelector('.sbbs-setting-sources')) < sections.indexOf(content.querySelector('details')));
    assert.equal(content.querySelectorAll('details').length, 3);
    assert.ok([...content.querySelectorAll('details')].every((detail) => !detail.open && detail.querySelector('summary')));

    const changed = {
        sfwOnlyDefault: false, hideAiDefault: true, blurNsfw: false, showTrustPanel: false,
        skipReview: true, allowDirectRequests: true, imageMode: 'off', resultsPerPage: 48,
        saveQueryHistory: true, saveNamedSearches: true, enabledSources: ['chub'],
    };
    settings.updateSettings(changed);
    for (const [id, key] of [
        ['sfw', 'sfwOnlyDefault'], ['hide_ai', 'hideAiDefault'], ['blur', 'blurNsfw'], ['trust', 'showTrustPanel'],
        ['skip_review', 'skipReview'], ['direct', 'allowDirectRequests'], ['history', 'saveQueryHistory'], ['named_searches', 'saveNamedSearches'],
    ]) {
        assert.equal(document.getElementById(`sbbs_set_${id}`).checked, changed[key], id);
    }
    assert.equal(document.getElementById('sbbs_set_images').value, 'off');
    assert.equal(document.getElementById('sbbs_set_perpage').value, '48');
    assert.equal(content.querySelector('[data-source-id="botbooru"]').checked, false);
    assert.equal(content.querySelector('[data-source-id="chub"]').checked, true);
    settings.rememberQuery('elf');
    settings.saveNamedSearch(entry());
    const clearHistory = document.getElementById('sbbs_clear_history');
    const clearNamed = document.getElementById('sbbs_clear_named_searches');
    assert.equal(clearHistory.disabled, false);
    assert.equal(clearNamed.disabled, false);
    assert.match(clearHistory.textContent, /\(1\)/);
    assert.match(clearNamed.textContent, /\(1\)/);
    clearHistory.click();
    assert.equal(clearHistory.disabled, true);
    assert.equal(clearNamed.disabled, false);
    clearNamed.click();
    assert.equal(clearNamed.disabled, true);
    assert.deepEqual(settings.getSettings().namedSearches, []);

    // The host can replace profile values without calling the extension setter.
    Object.assign(state.extensionSettings[SETTINGS_KEY], { sfwOnlyDefault: true, imageMode: 'direct', enabledSources: ['botbooru'] });
    root.querySelector('.sbbs-settings-toggle').click();
    await tick();
    const sfw = document.getElementById('sbbs_set_sfw');
    assert.equal(sfw.checked, true);
    assert.equal(document.getElementById('sbbs_set_images').value, 'direct');
    assert.equal(content.querySelector('[data-source-id="botbooru"]').checked, true);
    assert.equal(content.querySelector('[data-source-id="chub"]').checked, false);
    const saves = state.saves;
    content.append(document.createElement('span'));
    await tick();
    assert.equal(state.saves, saves, 'DOM changes must never trigger a settings save');
    assert.ok(state.callbacks < 100, 'rendering must not create an observer callback cycle');

    root.remove();
    await tick();
    assert.equal(state.observers.size, 0);
    settings.updateSettings({ sfwOnlyDefault: false });
    assert.equal(sfw.checked, true, 'a detached drawer must no longer receive settings updates');
});

test('BotBooru recovery controls have unique ids, shared state, and detached secret cleanup', async (t) => {
    const state = host(t);
    globalThis.fetch = async (url) => jsonResponse(String(url).endsWith('/account/login')
        ? { loggedIn: true, username: 'alice', nsfwEnabled: true }
        : { loggedIn: false });
    const first = settings.botbooruAccountControl();
    const second = settings.botbooruAccountControl('sbbs_inline_botbooru');
    document.body.append(first, second);
    await tick();
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const label of document.querySelectorAll('label[for]')) {
        assert.ok(document.getElementById(label.htmlFor));
    }
    document.getElementById('sbbs_inline_botbooru_username').value = 'alice';
    const password = document.getElementById('sbbs_inline_botbooru_password');
    password.value = 'private password';
    second.querySelector('form').dispatchEvent(new state.dom.window.Event('submit', { cancelable: true }));
    await tick();
    assert.equal(password.value, '');
    for (const control of [first, second]) {
        assert.match(control.querySelector('.sbbs-account-status').textContent, /Logged in as alice/);
        assert.equal(control.querySelector('.sbbs-account-signed-in').hidden, false);
    }
    password.value = 'unsent password';
    second.remove();
    await tick();
    assert.equal(password.value, '');
    assert.equal(state.observers.size, 1);
    assert.doesNotMatch(JSON.stringify(state.extensionSettings), /password|alice/);
});

test('Saucepan drawer and inline recovery share state despite late status replies', async (t) => {
    const state = host(t);
    const statuses = [];
    globalThis.fetch = async (url) => {
        if (String(url).endsWith('/account/status')) {
            return new Promise((resolve) => statuses.push(resolve));
        }
        return jsonResponse({ loggedIn: !String(url).endsWith('/account/logout'), token: 'not-retained' });
    };
    const first = settings.saucepanAccountControl();
    const second = settings.saucepanAccountControl('sbbs_inline_saucepan');
    document.body.append(first, second);
    const token = document.getElementById('sbbs_inline_saucepan_token');
    token.value = 'private-token';
    [...second.querySelectorAll('button')].find((button) => button.textContent === 'Use token').click();
    await tick();
    for (const resolve of statuses) {
        resolve(jsonResponse({ loggedIn: false }));
    }
    await tick();
    assert.equal(token.value, '');
    assert.equal(getSaucepanAccount().loggedIn, true);
    for (const control of [first, second]) {
        assert.match(control.querySelector('.sbbs-account-status').textContent, /ready for URL imports/);
    }
    [...first.querySelectorAll('button')].find((button) => button.textContent === 'Log out').click();
    await tick();
    assert.match(second.querySelector('.sbbs-account-status').textContent, /Not logged in/);
    const password = document.getElementById('sbbs_inline_saucepan_password');
    password.value = 'unsent password';
    token.value = 'unsent token';
    second.remove();
    await tick();
    assert.equal(password.value, '');
    assert.equal(token.value, '');
    await loginSaucepanAccount('handle', 'password');
    assert.match(first.querySelector('.sbbs-account-status').textContent, /ready for URL imports/);
    assert.match(second.querySelector('.sbbs-account-status').textContent, /Not logged in/, 'detached subscriptions must be removed');
    assert.doesNotMatch(JSON.stringify(state.extensionSettings), /private|password|token|handle/);
});

test('Janny keeps response codes and operation failures without extra status requests', async (t) => {
    host(t);
    const calls = [];
    let result = { ready: true, loggedIn: false, code: 'janny_browser_request_failed' };
    let statusCode = 200;
    globalThis.fetch = async (url) => {
        calls.push(String(url).split('/').at(-1));
        return jsonResponse(result, statusCode);
    };
    const control = settings.jannyBrowserControl();
    document.body.append(control);
    const status = control.querySelector('.sbbs-account-status');
    const [login, refresh, logout] = control.querySelectorAll('button');
    await tick();
    assert.match(status.textContent, /request failed.*refresh status/);
    assert.deepEqual(calls, ['status']);
    result = { ready: true, loggedIn: true };
    login.click();
    assert.match(status.textContent, /Opening/);
    await tick();
    assert.match(status.textContent, /session is ready/);
    assert.equal(logout.disabled, false);
    assert.deepEqual(calls, ['status', 'login']);

    for (const [code, expected] of [
        ['timeout', /timed out.*refresh status/],
        ['janny_restore_failed', /settings could not be restored.*before importing again/],
    ]) {
        statusCode = 502;
        result = { error: code };
        logout.click();
        await tick();
        assert.match(status.textContent, expected);
        assert.equal(refresh.disabled, false);
        assert.equal(logout.disabled, false, 'a failed logout must not pretend to clear the session');
    }
    assert.deepEqual(calls, ['status', 'login', 'logout', 'logout']);
    statusCode = 200;
    result = { ready: true, loggedIn: false };
    logout.click();
    await tick();
    assert.match(status.textContent, /Not logged in/);
    assert.equal(logout.disabled, true);
    assert.equal(calls.length, 5);
});

test('Janny admin-only refusals disable actions and leave recovery visible', async (t) => {
    host(t);
    for (const statusCode of [200, 403]) {
        let requests = 0;
        globalThis.fetch = async () => {
            requests++;
            return jsonResponse(statusCode === 200 ? { code: 'janny_admin_required' } : { error: 'janny_admin_required' }, statusCode);
        };
        const control = settings.jannyBrowserControl(`sbbs_janny_${statusCode}`);
        document.body.append(control);
        await tick();
        assert.match(control.querySelector('.sbbs-account-status').textContent, /Only a SillyBunny administrator/);
        for (const button of control.querySelectorAll('button')) {
            assert.equal(button.disabled, true);
            button.click();
        }
        await tick();
        assert.equal(requests, 1);
        control.remove();
    }
});
