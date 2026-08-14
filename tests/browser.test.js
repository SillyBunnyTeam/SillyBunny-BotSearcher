import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { PROTOCOL_VERSION, VERSION } from '../shared/schema.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'templates/browser.html'), 'utf8');
const INSTALL_TEMPLATE = fs.readFileSync(path.join(ROOT, 'templates/plugin-missing.html'), 'utf8');

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) {
            return;
        }
        await tick();
    }
    assert.fail(message);
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function card(source, id, name, extra = {}) {
    return {
        source,
        id,
        name,
        creator: '',
        contentRating: 'unknown',
        stats: {},
        thumbUrl: null,
        thumbRef: null,
        ...extra,
    };
}

test('v1 settings migrate their sort to the saved source', async () => {
    const settingsStore = {
        SillyBunnyBotSearcher: {
            _v: 1,
            defaultSource: 'chub',
            sortDefault: 'trending',
        },
    };
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: settingsStore }) };

    const { getSettings } = await import('../client/settings.js?settings-migration');
    const settings = getSettings();

    assert.equal(settings._v, 4);
    assert.deepEqual(settings.sortBySource, { chub: 'trending' });
    assert.equal(settings.hideAiDefault, false);
    // Browser-direct routing exposes the browser network address, so upgrades
    // require an explicit opt-in rather than silently enabling it.
    assert.equal(settings.allowDirectRequests, false);
});

test('search history keeps what was searched for, newest first and without repeats', async () => {
    const settingsStore = {};
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: settingsStore, saveSettingsDebounced() {} }),
    };

    const { getSettings, rememberQuery, clearQueryHistory, MAX_QUERY_HISTORY } =
        await import('../client/settings.js?query-history');

    // Search history is intentionally off unless the user opts in.
    assert.deepEqual(getSettings().queryHistory, []);
    const settings = globalThis.SillyTavern.getContext().extensionSettings;
    settings.SillyBunnyBotSearcher = { saveQueryHistory: true };

    rememberQuery('elf');
    rememberQuery('orc');
    assert.deepEqual(getSettings().queryHistory, ['orc', 'elf'], 'newest first');

    // Searching something again moves it up rather than duplicating it, and the
    // spelling the user just typed is the one kept.
    rememberQuery('ELF');
    assert.deepEqual(getSettings().queryHistory, ['ELF', 'orc']);

    // The catalogue view runs with an empty query on every open; it is not a search.
    rememberQuery('');
    rememberQuery('   ');
    assert.deepEqual(getSettings().queryHistory, ['ELF', 'orc']);

    for (let i = 0; i < MAX_QUERY_HISTORY + 10; i++) {
        rememberQuery(`term-${i}`);
    }
    assert.equal(getSettings().queryHistory.length, MAX_QUERY_HISTORY, 'the list stays bounded');

    clearQueryHistory();
    assert.deepEqual(getSettings().queryHistory, []);
});

test('legacy search history is erased when the new opt-in is disabled', async () => {
    let saves = 0;
    const settingsStore = {
        SillyBunnyBotSearcher: { _v: 3, queryHistory: ['sensitive search'] },
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: settingsStore,
            saveSettingsDebounced() { saves++; },
        }),
    };

    const { getSettings } = await import('../client/settings.js?query-history-migration');
    assert.deepEqual(getSettings().queryHistory, []);
    assert.deepEqual(settingsStore.SillyBunnyBotSearcher.queryHistory, []);
    assert.equal(settingsStore.SillyBunnyBotSearcher.saveQueryHistory, false);
    assert.equal(saves, 1);
});

test('a corrupt stored history is repaired rather than trusted', async () => {
    const settingsStore = {
        SillyBunnyBotSearcher: { saveQueryHistory: true, queryHistory: ['ok', 42, null, '', { evil: true }, 'x'.repeat(500)] },
    };
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: settingsStore, saveSettingsDebounced() {} }),
    };

    const { getSettings } = await import('../client/settings.js?query-history-repair');
    const history = getSettings().queryHistory;

    assert.deepEqual(history.slice(0, 1), ['ok']);
    assert.equal(history.length, 2, 'non-strings are dropped');
    assert.equal(history[1].length, 128, 'and an oversized entry is capped');
});

test('a source without detail support opens its listing without a detail request', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="detail"></div></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });

    let requests = 0;
    globalThis.fetch = async () => {
        requests += 1;
        throw new Error('summary-only detail must not fetch');
    };
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: {}, saveSettingsDebounced() {} }),
    };

    try {
        const { showDetail } = await import('../client/detail.js?summary-only-detail');
        const summary = card('jannyai', '311a6844-61d6-4468-aa98-91ecc7fbae86', 'elf trucker', {
            tagline: 'A cropped listing description.',
            contentRating: 'sfw',
            stats: { tokens: 2727 },
            tags: ['Elf', 'OC'],
            pageUrl: 'https://jannyai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-elf-trucker',
            importUrl: 'https://janitorai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-elf-trucker',
            nativeImport: true,
        });
        const source = {
            id: 'jannyai',
            label: 'JannyAI',
            clientHosts: ['jannyai.com', 'janitorai.com', 'image.jannyai.com'],
            nativeImport: true,
            capabilities: { detail: false },
        };

        await showDetail(dom.window.document.getElementById('detail'), summary, source, () => {});

        assert.equal(requests, 0);
        assert.match(dom.window.document.querySelector('.sbbs-detail-name').textContent, /elf trucker/);
        assert.equal(dom.window.document.querySelector('.sbbs-description').textContent, summary.tagline);
        assert.equal(dom.window.document.querySelector('.sbbs-chip-link').href, summary.pageUrl);
        assert.ok(dom.window.document.querySelector('.sbbs-import'), 'native import action must remain available');
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('a setting note sits beside its label, not inside it', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
    };

    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
    });
    globalThis.fetch = async () => jsonResponse({ protocol: PROTOCOL_VERSION, version: VERSION, sources: [] });
    const settingsStore = {};
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: settingsStore, saveSettingsDebounced() {} }),
    };

    try {
        const { mountSettings } = await import('../client/settings.js?settings-panel');
        await mountSettings();

        const input = dom.window.document.getElementById('sbbs_set_direct');
        assert.ok(input, 'the direct-requests setting must be mounted');

        const note = dom.window.document.getElementById('sbbs_set_direct_note');
        assert.ok(note, 'a setting that changes where requests come from needs its consequence written down');

        // SillyBunny's .checkbox_label is a flex row with no flex-wrap, so a
        // full-width child inside it takes the whole row and squeezes the label
        // text to one character per line. The note must be a sibling.
        const label = input.closest('.checkbox_label');
        assert.ok(label, 'the checkbox still needs its label');
        assert.equal(label.contains(note), false, 'the note must not live inside .checkbox_label');
        assert.equal(note.parentElement, label.parentElement, 'it belongs beside the label');

        // Still announced with the control it explains.
        assert.equal(input.getAttribute('aria-describedby'), note.id);
    } finally {
        // api.js caches /healthz for a minute, and that cache is shared across
        // the query-suffixed module copies these tests use. Leaving this test's
        // empty source list in it would starve whichever test ran next.
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('BotBooru account settings clear passwords and expose account-wide content state', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
    });

    const calls = [];
    let loginAttempts = 0;
    const signedOut = {
        source: 'botbooru', loggedIn: false, username: null,
        nsfwEnabled: false, nsflEnabled: false, nsflActive: null,
    };
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [{
                    id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'],
                    capabilities: {
                        search: true, sorts: ['latest'], sfwToggle: true, detail: true,
                        accountLogin: true, nsfwRequiresAccount: true,
                    },
                }],
            });
        }
        if (path.endsWith('/capabilities')) {
            return jsonResponse({ error: 'Forbidden' }, 403);
        }
        if (path.includes('/account/')) {
            const body = JSON.parse(options.body);
            calls.push({ path, body, options });
            if (path.endsWith('/account/status') || path.endsWith('/account/logout')) {
                return jsonResponse(signedOut);
            }
            if (path.endsWith('/account/login')) {
                loginAttempts += 1;
                if (loginAttempts === 1) {
                    return jsonResponse({ error: 'botbooru_invalid_credentials' }, 401);
                }
                return jsonResponse({
                    source: 'botbooru', loggedIn: true, username: 'alice',
                    nsfwEnabled: false, nsflEnabled: true, nsflActive: true,
                });
            }
            if (path.endsWith('/account/nsfw')) {
                return jsonResponse({
                    source: 'botbooru', loggedIn: true, username: 'alice',
                    nsfwEnabled: body.enabled, nsflEnabled: true, nsflActive: true,
                });
            }
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const extensionSettings = {};
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { mountSettings } = await import('../client/settings.js?botbooru-account-settings');
        await mountSettings();
        await waitFor(
            () => /Not logged in/.test(dom.window.document.querySelector('.sbbs-account-status')?.textContent ?? ''),
            'account status did not load',
        );

        const username = dom.window.document.getElementById('sbbs_botbooru_username');
        const password = dom.window.document.getElementById('sbbs_botbooru_password');
        const form = dom.window.document.querySelector('.sbbs-account-login');
        assert.equal(username.autocomplete, 'username');
        assert.equal(password.autocomplete, 'current-password');
        assert.equal(dom.window.document.querySelector(`label[for="${username.id}"]`)?.textContent, 'Username');
        assert.equal(dom.window.document.querySelector(`label[for="${password.id}"]`)?.textContent, 'Password');

        username.value = 'Alice';
        password.value = 'wrong secret';
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(() => password.value === '' && /did not accept/.test(dom.window.document.body.textContent), 'failed login did not settle');

        password.value = ' exact p&+ss ';
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await waitFor(() => password.value === '' && /Logged in as alice/.test(dom.window.document.body.textContent), 'login did not settle');
        assert.match(dom.window.document.body.textContent, /changes the BotBooru account preference on every device/);
        assert.match(dom.window.document.body.textContent, /Non-SFW searches may include NSFL content/);
        assert.match(dom.window.document.body.textContent, /does not revoke the token upstream/);

        const loginCalls = calls.filter((call) => call.path.endsWith('/account/login'));
        assert.equal(loginCalls[0].body.password, 'wrong secret');
        assert.equal(loginCalls[1].body.password, ' exact p&+ss ');
        assert.ok(loginCalls.every((call) => call.options.credentials === 'same-origin'));
        assert.doesNotMatch(JSON.stringify(extensionSettings), /Alice|wrong secret|exact p&\+ss|token/i);

        const nsfw = dom.window.document.getElementById('sbbs_botbooru_nsfw');
        nsfw.checked = true;
        nsfw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => calls.some((call) => call.path.endsWith('/account/nsfw')) && nsfw.checked, 'NSFW setting did not update');
        assert.deepEqual(calls.find((call) => call.path.endsWith('/account/nsfw')).body, {
            source: 'botbooru', enabled: true,
        });

        dom.window.document.querySelector('.sbbs-account-signed-in > .menu_button').click();
        await waitFor(() => /Not logged in/.test(dom.window.document.body.textContent), 'logout did not settle');
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('settings offer an exact-release update when a compatible server is older', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
    });
    globalThis.fetch = async (url) => {
        if (String(url).endsWith('/healthz')) {
            return jsonResponse({ protocol: PROTOCOL_VERSION, version: '0.2.0', sources: [] });
        }
        if (String(url).endsWith('/capabilities')) {
            return jsonResponse({
                apiVersion: 1,
                exactGitRelease: true,
                existingPluginsOnly: true,
                installsDependencies: true,
                dependencyPolicy: 'npm-ci-production-ignore-scripts',
                safeRestart: true,
                serverPluginsEnabled: true,
                available: true,
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };
    const settingsStore = {};
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: settingsStore, saveSettingsDebounced() {} }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { mountSettings } = await import('../client/settings.js?settings-plugin-update');
        await mountSettings();

        const root = dom.window.document.getElementById('sbbs_settings');
        const update = root.querySelector('.sbbs-setting-plugin .menu_button');
        await waitFor(() => update.hidden === false, 'settings update action did not appear');
        assert.equal(update.type, 'button');
        assert.match(root.querySelector('.sbbs-setting-plugin').textContent, new RegExp(`Server v0\\.2\\.0 is older than frontend v${VERSION.replace(/\./g, '\\.')}`));
        assert.equal(root.contains(update), true);
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('an older incompatible server offers the host updater without bypassing a safety refusal', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        toastr: { error() {}, info() {}, success() {} },
    });

    let applyBody = null;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/healthz')) {
            return jsonResponse({ protocol: 3, version: '0.2.0', sources: [] });
        }
        if (String(url).endsWith('/capabilities')) {
            return jsonResponse({
                apiVersion: 1,
                exactGitRelease: true,
                existingPluginsOnly: true,
                installsDependencies: true,
                dependencyPolicy: 'npm-ci-production-ignore-scripts',
                safeRestart: true,
                serverPluginsEnabled: true,
                available: true,
            });
        }
        if (String(url).endsWith('/apply-release')) {
            applyBody = JSON.parse(options.body);
            return jsonResponse({
                error: 'Symlinked plugins cannot be updated automatically.',
                code: 'managed_externally',
            }, 409);
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popups = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popups.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
            renderExtensionTemplateAsync: async () => INSTALL_TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { openBrowser } = await import('../client/browser.js?server-plugin-update-panel');
        const opened = openBrowser();
        await waitFor(() => popups.length === 1, 'plugin recovery popup did not open');
        const popup = popups[0];
        assert.equal(popup.options.allowVerticalScrolling, true, 'recovery instructions must remain scrollable');
        const update = popup.content.querySelector('#sbbs_update_plugin');
        await waitFor(() => update.hidden === false, 'automatic update action did not appear');

        assert.equal(popup.content.querySelector('.sbbs-update-instructions').hidden, true);
        update.click();
        await waitFor(
            () => /externally managed/.test(popup.content.querySelector('.sbbs-install-update-status').textContent),
            'host update failure was not explained',
        );

        assert.deepEqual(applyBody, {
            directoryName: 'SillyBunny-BotSearcher',
            targetVersion: VERSION,
        });
        assert.equal(update.disabled, false, 'the action should be retryable after failure');
        assert.equal(popup.content.querySelector('.sbbs-update-instructions').hidden, true);

        popup.complete();
        await opened;
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('closing the recovery popup does not abort an in-progress server update', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        toastr: { error() {}, info() {}, success() {} },
    });

    let healthCalls = 0;
    let resolveApply;
    let applySignal;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/healthz')) {
            healthCalls++;
            return healthCalls === 1
                ? jsonResponse({ protocol: 3, version: '0.2.0', sources: [] })
                : jsonResponse({ protocol: PROTOCOL_VERSION, version: VERSION, sources: [] });
        }
        if (String(url).endsWith('/capabilities')) {
            return jsonResponse({
                apiVersion: 1,
                exactGitRelease: true,
                existingPluginsOnly: true,
                installsDependencies: true,
                dependencyPolicy: 'npm-ci-production-ignore-scripts',
                safeRestart: true,
                serverPluginsEnabled: true,
                available: true,
            });
        }
        if (String(url).endsWith('/apply-release')) {
            applySignal = options.signal;
            return new Promise((resolve, reject) => {
                resolveApply = () => resolve(jsonResponse({
                    ok: true,
                    action: 'updated',
                    restarting: true,
                    serverBootId: 'old-boot',
                }, 202));
                options.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
        if (String(url).endsWith('/version')) {
            return jsonResponse({ serverBootId: 'new-boot' });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popups = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popups.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
            renderExtensionTemplateAsync: async () => INSTALL_TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { openBrowser } = await import('../client/browser.js?update-survives-popup-close');
        const opened = openBrowser();
        await waitFor(() => popups.length === 1, 'plugin recovery popup did not open');
        const popup = popups[0];
        const update = popup.content.querySelector('#sbbs_update_plugin');
        await waitFor(() => update.hidden === false, 'automatic update action did not appear');

        update.click();
        await waitFor(() => typeof resolveApply === 'function', 'update request did not start');
        popup.complete();
        await opened;

        assert.ok(applySignal instanceof AbortSignal, 'the state-changing request needs its own finite lifetime');
        assert.equal(applySignal.aborted, false, 'popup lifetime must not abort the state-changing request');
        resolveApply();
        await waitFor(() => healthCalls === 2, 'the detached update did not finish verification');
        assert.equal(popups.length, 1, 'closing the popup must not reopen it after the update');
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('an enabled URL-only source keeps the search box as its URL entry', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
    });

    const urlCards = [];
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [
                    { id: 'botbooru', label: 'Botbooru', tier: 0, capabilities: { search: true } },
                    { id: 'jannyai', label: 'JannyAI', tier: 2, clientHosts: ['jannyai.com', 'janitorai.com'], capabilities: { search: true, browserImport: true } },
                    { id: 'saucepan', label: 'Saucepan.ai', tier: 2, clientHosts: ['saucepan.ai'], capabilities: { search: false, accountLogin: true, urlImport: true } },
                ],
            });
        }
        if (path.endsWith('/url-card')) {
            urlCards.push(JSON.parse(options.body));
            return jsonResponse({ error: 'saucepan_login_required' }, 401);
        }
        if (path.endsWith('/account/status')) {
            return jsonResponse({ loggedIn: false });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popups = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popups.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    const extensionSettings = {
        SillyBunnyBotSearcher: { enabledSources: ['saucepan'] },
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            renderExtensionTemplateAsync: async () => TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { openBrowser } = await import('../client/browser.js?saucepan-url-only');
        const opened = openBrowser();
        await waitFor(() => popups.length === 1, 'URL-only browser popup did not open');

        const popup = popups[0];
        const source = popup.content.querySelector('#sbbs_source');
        const query = popup.content.querySelector('#sbbs_query');
        const state = popup.content.querySelector('#sbbs_state');
        const form = popup.content.querySelector('#sbbs_search_form');
        const rows = [...popup.content.querySelectorAll('.sbbs-bar-row')];
        assert.equal(rows.find((row) => row.contains(query)).hidden, false, 'the query row stays for URL entry');
        assert.equal(rows.find((row) => !row.contains(query)).hidden, true, 'catalogue controls stay hidden');
        assert.equal(query.getAttribute('placeholder'), 'Paste a card URL (Saucepan.ai)');
        assert.deepEqual([...source.options].map((option) => option.value), [], 'Saucepan must not enter the catalogue picker');
        assert.match(state.textContent, /No searchable source is enabled\. Paste a card URL from Saucepan\.ai/);
        assert.doesNotMatch(state.textContent, /No sources are enabled/);

        // A URL from a source the user switched off says how to turn it on.
        query.value = 'https://jannyai.com/characters/0b7a1a71-4c62-4de1-a44c-6f06a4ffe421_character-a';
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        assert.match(state.textContent, /Enable JannyAI under Extensions > BotSearcher > Sources/);

        // A Saucepan URL goes to /url-card and opens the intake review; the
        // login it needs is offered on that screen rather than in a pointer to
        // the settings drawer.
        query.value = 'https://saucepan.ai/companion/abcdef1234';
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        assert.equal(popup.content.querySelector('.sbbs-root').dataset.view, 'intake');
        await waitFor(() => /This Saucepan\.ai card requires a login/.test(popup.content.textContent), 'login-required intake error did not render');
        assert.deepEqual(urlCards, [{ source: 'saucepan', url: 'https://saucepan.ai/companion/abcdef1234' }]);
        assert.ok(popup.content.querySelector('#sbbs_intake_saucepan_account_heading'), 'the login form is embedded on the error screen');
        assert.match(popup.content.textContent, /Try again/);
        await waitFor(() => /Not logged in\. Saucepan\.ai card URLs require an account token\./.test(popup.content.textContent), 'embedded account status did not settle');

        popup.complete();
        await opened;
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('a pasted Saucepan URL opens the intake review instead of a search', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        CSS: globalThis.CSS,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        CSS: { escape: (value) => String(value) },
        toastr: { error() {}, info() {}, success() {} },
    });

    const searches = [];
    const urlCards = [];
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [
                    { id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'], capabilities: { search: true, sorts: ['latest'], sfwToggle: true, detail: true } },
                    { id: 'saucepan', label: 'Saucepan.ai', tier: 2, state: 'up', clientHosts: ['saucepan.ai'], capabilities: { search: false, accountLogin: true, urlImport: true } },
                ],
            });
        }
        if (path.endsWith('/search')) {
            searches.push(JSON.parse(options.body));
            return jsonResponse({ items: [], nextCursor: null, total: 0 });
        }
        if (path.endsWith('/url-card')) {
            urlCards.push(JSON.parse(options.body));
            return jsonResponse({ error: 'saucepan_login_required' }, 401);
        }
        if (path.endsWith('/account/status')) {
            return jsonResponse({ loggedIn: false });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popups = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popups.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    const extensionSettings = {
        SillyBunnyBotSearcher: { enabledSources: ['botbooru', 'saucepan'], defaultSource: 'botbooru' },
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            renderExtensionTemplateAsync: async () => TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { openBrowser } = await import('../client/browser.js?saucepan-omnibox');
        const opened = openBrowser();
        await waitFor(() => popups.length === 1 && searches.length === 1, 'mixed-source browser did not settle');

        const popup = popups[0];
        const query = popup.content.querySelector('#sbbs_query');
        const form = popup.content.querySelector('#sbbs_search_form');
        const state = popup.content.querySelector('#sbbs_state');

        assert.equal(query.getAttribute('placeholder'), 'Search cards, or paste a card URL');
        assert.equal(query.getAttribute('aria-label'), 'Search character cards or paste a card URL');
        assert.deepEqual(searches[0], {
            query: '',
            limit: 24,
            cursor: null,
            filters: { sfwOnly: true, hideAi: false },
            source: 'botbooru',
            sort: 'latest',
        });

        // Typing the URL announces the import instead of scheduling a search.
        query.value = 'https://saucepan.ai/companion/abc123def456';
        query.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.match(state.textContent, /Press Enter to review this Saucepan\.ai card before importing\./);

        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        assert.equal(popup.content.querySelector('.sbbs-root').dataset.view, 'intake');
        await waitFor(() => /This Saucepan\.ai card requires a login/.test(popup.content.textContent), 'intake error did not render');
        assert.deepEqual(urlCards, [{ source: 'saucepan', url: 'https://saucepan.ai/companion/abc123def456' }]);
        assert.equal(searches.length, 1, 'the URL was imported, not searched');
        await waitFor(() => /Not logged in\. Saucepan\.ai card URLs require an account token\./.test(popup.content.textContent), 'embedded login status did not settle');

        popup.complete();
        await opened;
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('Saucepan settings explain URL-only use and keep unavailable status separate', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings"></div></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
    });

    globalThis.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [{
                    id: 'saucepan', label: 'Saucepan.ai', tier: 3, state: 'down',
                    capabilities: { search: false, accountLogin: true, urlImport: true },
                }],
            });
        }
        if (path.endsWith('/account/status')) {
            return jsonResponse({ source: 'saucepan', loggedIn: false });
        }
        if (path.endsWith('/capabilities')) {
            return jsonResponse({}, 403);
        }
        throw new Error(`unexpected request: ${url}`);
    };

    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {},
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { mountSettings } = await import('../client/settings.js?saucepan-settings-guidance');
        await mountSettings();
        await waitFor(() => /Not logged in/.test(dom.window.document.querySelector('#sbbs_saucepan_account_heading')?.parentElement?.textContent ?? ''), 'Saucepan account status did not load');

        const row = dom.window.document.querySelector('.sbbs-source-row');
        const status = dom.window.document.querySelector('#sbbs_saucepan_account_heading').parentElement.querySelector('.sbbs-account-status');
        assert.match(row.textContent, /URL import only, no catalog search/);
        assert.doesNotMatch(row.textContent, /limited public catalog/);
        assert.match(row.textContent, /unavailable/);
        assert.match(dom.window.document.body.textContent, /Saucepan\.ai has no catalog search\. Paste a companion URL into BotSearcher's search box/);
        assert.doesNotMatch(status.textContent, /no catalog search/);
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('a direct-routing notice can be dismissed without disabling the route', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        CSS: globalThis.CSS,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };

    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        CSS: { escape: (value) => String(value) },
        toastr: { error() {}, info() {}, success() {} },
    });

    const DIRECT_URL = 'https://gateway.chub.ai/api/search';
    let directRequests = 0;
    let ingests = 0;
    globalThis.fetch = async (url) => {
        const requestPath = String(url);
        if (requestPath.endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [{
                    id: 'chub',
                    label: 'Chub',
                    tier: 1,
                    state: 'up',
                    clientHosts: ['chub.ai'],
                    directHosts: ['gateway.chub.ai'],
                    capabilities: { search: true, sorts: ['default'], sfwToggle: true, detail: true },
                }],
            });
        }
        if (requestPath === DIRECT_URL) {
            directRequests += 1;
            return jsonResponse({ data: { nodes: [] } });
        }
        if (requestPath.endsWith('/search')) {
            return jsonResponse({ mode: 'direct', kind: 'search', url: DIRECT_URL, reason: 'forbidden' });
        }
        if (requestPath.endsWith('/ingest')) {
            ingests += 1;
            return jsonResponse({
                total: 1,
                nextCursor: null,
                items: [card('chub', 'author/direct', 'Direct result')],
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popupInstances = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popupInstances.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    const extensionSettings = {
        SillyBunnyBotSearcher: { defaultSource: 'chub', allowDirectRequests: true },
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            renderExtensionTemplateAsync: async () => TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const { openBrowser } = await import('../client/browser.js?dismiss-direct-routing-notice');
        const opened = openBrowser();
        await waitFor(
            () => popupInstances.length === 1 && popupInstances[0].content.querySelector('.sbbs-direct-notice'),
            'direct-routing notice did not render',
        );
        const popup = popupInstances[0];
        const notice = popup.content.querySelector('.sbbs-direct-notice');
        const dismiss = notice.querySelector('.sbbs-direct-notice-dismiss');

        assert.match(notice.textContent, /sees your browser's address rather than the server's/);
        assert.equal(dismiss.type, 'button');
        assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss direct routing notice');
        assert.match(popup.content.textContent, /Direct result/, 'the direct result must still render');

        dismiss.click();
        assert.equal(popup.content.querySelector('.sbbs-direct-notice'), null, 'dismissal hides the notice');

        // A distinct search repeats the direct route, but the acknowledged
        // source must not recreate the dismissed notice during this dialog.
        popup.content.querySelector('#sbbs_query').value = 'second search';
        popup.content.querySelector('#sbbs_search_form').dispatchEvent(new dom.window.Event('submit', {
            bubbles: true,
            cancelable: true,
        }));
        await waitFor(
            () => directRequests === 2 && ingests === 2,
            'the second direct route did not finish',
        );
        assert.equal(popup.content.querySelector('.sbbs-direct-notice'), null, 'the dismissed notice must stay hidden');
        assert.match(popup.content.textContent, /Direct result/, 'dismissal must not disable direct routing');

        popup.complete();
        await opened;
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('a source that fails stays in the picker and offers a reload', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        CSS: globalThis.CSS,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };

    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        CSS: { escape: (value) => String(value) },
        toastr: { error() {}, info() {}, success() {} },
    });

    const searches = [];
    const retries = [];
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [
                    // Reported down before the dialog even opens. It must still
                    // be offered, not quietly missing from the list.
                    { id: 'chub', label: 'Chub', tier: 1, state: 'down', reason: 'forbidden', clientHosts: ['chub.ai'], capabilities: { search: true, sorts: ['default'], sfwToggle: true, detail: true } },
                    { id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'], capabilities: { search: true, sorts: ['latest'], sfwToggle: true, detail: true } },
                ],
            });
        }
        if (String(url).endsWith('/retry')) {
            retries.push(JSON.parse(options.body));
            return jsonResponse({ ok: true, state: 'unknown' });
        }
        if (String(url).endsWith('/search')) {
            return new Promise((resolve, reject) => {
                searches.push({ body: JSON.parse(options.body), resolve, reject });
                options.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popupInstances = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popupInstances.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    const extensionSettings = { SillyBunnyBotSearcher: { defaultSource: 'chub' } };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            renderExtensionTemplateAsync: async () => TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { openBrowser } = await import('../client/browser.js?source-reload');
        const opened = openBrowser();
        await waitFor(() => popupInstances.length === 1 && searches.length === 1, 'initial search did not start');
        const popup = popupInstances[0];
        const picker = popup.content.querySelector('#sbbs_source');

        // A source already in cooldown is still selectable, and says so.
        const options = [...picker.options].map((option) => option.textContent);
        assert.ok(options.includes('Chub (unavailable)'), `Chub must remain selectable, got ${options.join(' / ')}`);
        assert.equal(picker.value, 'chub', 'and stays the saved default rather than being switched away from');

        searches[0].resolve(jsonResponse({ error: 'source_down' }, 503));

        await waitFor(
            () => popup.content.querySelector('#sbbs_reload')?.hidden === false,
            'a failed source must offer a reload',
        );

        // The whole point: it is still there, still selected.
        assert.equal(picker.value, 'chub', 'the failed source must stay selected');
        assert.equal([...picker.options].some((option) => option.value === 'chub'), true, 'and stay in the list');
        assert.match(popup.content.querySelector('#sbbs_state').textContent, /Chub refused the request/);
        assert.match(popup.content.querySelector('#sbbs_state').textContent, /still in the list/);

        // Reload clears the server-side cooldown first, or the next search would
        // be answered from it without the source being tried at all.
        const reload = popup.content.querySelector('.sbbs-reload-source');
        assert.match(reload.textContent, /Reload Chub/);
        reload.click();

        await waitFor(() => searches.length === 2, 'reload did not search again');
        assert.deepEqual(retries, [{ source: 'chub' }], 'the cooldown must be cleared before retrying');
        assert.equal(searches[1].body.source, 'chub', 'and it retries the same source');
        assert.equal(popup.content.querySelector('#sbbs_reload').hidden, true, 'the prompt clears while retrying');

        searches[1].resolve(jsonResponse({
            total: 1,
            nextCursor: null,
            items: [card('chub', 'author/one', 'Back again')],
        }));
        await waitFor(() => /Back again/.test(popup.content.textContent), 'the recovered source did not render');

        popup.complete();
        await opened;
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('BotBooru account changes clear protected results and rerun safely', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        CSS: globalThis.CSS,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };

    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        CSS: { escape: (value) => String(value) },
        toastr: { error() {}, info() {}, success() {} },
    });

    const searches = [];
    const details = [];
    globalThis.fetch = async (url, options = {}) => {
        const requestPath = String(url);
        if (requestPath.endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [
                    {
                        id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'],
                        capabilities: {
                            search: true, sorts: ['latest'], sfwToggle: true, detail: true,
                            accountLogin: true, nsfwRequiresAccount: true,
                        },
                    },
                    {
                        id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'],
                        capabilities: { search: true, sorts: ['default'], sfwToggle: true, detail: true },
                    },
                ],
            });
        }
        if (requestPath.endsWith('/account/login')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: true, username: 'alice',
                nsfwEnabled: true, nsflEnabled: false, nsflActive: null,
            });
        }
        if (requestPath.endsWith('/account/logout')) {
            return jsonResponse({
                source: 'botbooru', loggedIn: false, username: null,
                nsfwEnabled: false, nsflEnabled: false, nsflActive: null,
            });
        }
        if (requestPath.endsWith('/detail')) {
            return new Promise((resolve, reject) => {
                const call = { body: JSON.parse(options.body), resolve };
                details.push(call);
                options.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
        if (requestPath.endsWith('/search')) {
            return new Promise((resolve, reject) => {
                const call = { body: JSON.parse(options.body), resolve, aborted: false };
                searches.push(call);
                options.signal?.addEventListener('abort', () => {
                    call.aborted = true;
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popupInstances = [];
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popupInstances.push(this);
        }

        show() {
            return new Promise((resolve) => { this.resolveClosed = resolve; });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    const extensionSettings = {
        SillyBunnyBotSearcher: {
            _v: 4,
            defaultSource: 'botbooru',
            sfwOnlyDefault: false,
        },
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            renderExtensionTemplateAsync: async () => TEMPLATE,
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        const account = await import('../client/account.js');
        await account.loginBotbooruAccount('Alice', 'first secret');

        const { openBrowser } = await import('../client/browser.js?account-lifecycle');
        const opened = openBrowser();
        await waitFor(() => popupInstances.length === 1 && searches.length === 1, 'protected search did not start');
        const popup = popupInstances[0];
        assert.equal(searches[0].body.filters.sfwOnly, false);

        searches[0].resolve(jsonResponse({
            total: 1,
            nextCursor: 'protected-next',
            items: [card('botbooru', 'private-1', 'Protected result', {
                accountRef: 'signed-result-ref',
                contentRating: 'sensitive',
            })],
        }));
        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 1, 'protected result did not render');

        popup.content.querySelector('.sbbs-card-open').click();
        await waitFor(() => details.length === 1, 'protected detail request did not start');
        assert.deepEqual(details[0].body, {
            source: 'botbooru',
            id: 'private-1',
            accountRef: 'signed-result-ref',
        });
        details[0].resolve(jsonResponse(card('botbooru', 'private-1', 'Protected detail', {
            contentRating: 'sensitive',
        })));
        await waitFor(() => /Protected detail/.test(popup.content.textContent), 'protected detail did not render');
        popup.content.querySelector('.sbbs-back').click();

        const source = popup.content.querySelector('#sbbs_source');
        source.value = 'chub';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => searches.length === 2, 'Chub search did not start');
        searches[1].resolve(jsonResponse({
            total: 1,
            nextCursor: null,
            items: [card('chub', 'author/public', 'Public result')],
        }));
        await waitFor(() => /Public result/.test(popup.content.textContent), 'Chub result did not render');

        // A replacement login rotates the server session even if the visible
        // account fields are unchanged. It must clear protected cache entries
        // even while another source is selected, without refreshing that source.
        await account.loginBotbooruAccount('Alice', 'replacement secret');
        await tick();
        assert.equal(searches.length, 2, 'an unrelated selected source must not refresh');

        source.value = 'botbooru';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => searches.length === 3, 'returning to BotBooru reused protected cache');
        assert.deepEqual(searches[2].body, searches[0].body, 'the cache test must repeat the same request');
        searches[2].resolve(jsonResponse({
            total: 1,
            nextCursor: 'protected-next',
            items: [card('botbooru', 'private-2', 'Replacement-session result', { contentRating: 'sensitive' })],
        }));
        await waitFor(() => /Replacement-session result/.test(popup.content.textContent), 'replacement session did not render');

        popup.content.querySelector('#sbbs_more').click();
        await waitFor(() => searches.length === 4, 'protected append did not start');
        assert.equal(searches[3].body.cursor, 'protected-next');

        await account.logoutBotbooruAccount();
        await waitFor(() => searches.length === 5, 'logout did not start a safe refresh');
        assert.equal(searches[3].aborted, true, 'logout must abort the protected request');
        assert.equal(popup.content.querySelectorAll('.sbbs-card').length, 0, 'logout must remove protected cards immediately');
        assert.equal(popup.content.querySelector('#sbbs_sfw').checked, true, 'the open dialog must fail back to SFW');
        assert.equal(
            extensionSettings.SillyBunnyBotSearcher.sfwOnlyDefault,
            false,
            'the dialog fallback must not overwrite the saved preference',
        );
        assert.equal(searches[4].body.filters.sfwOnly, true);
        assert.equal(searches[4].body.cursor, null);

        searches[4].resolve(jsonResponse({ total: 0, nextCursor: null, items: [] }));
        await waitFor(() => /No cards are currently listed on Botbooru/.test(popup.content.textContent), 'safe refresh did not settle');
        popup.complete();
        await opened;
    } finally {
        const { invalidateAvailability } = await import('../client/api.js');
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('the browser is single-flight, ignores stale searches, deduplicates, and preserves append results on retry', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        CSS: globalThis.CSS,
        fetch: globalThis.fetch,
        toastr: globalThis.toastr,
        SillyTavern: globalThis.SillyTavern,
    };

    Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback) => setTimeout(callback, 0),
        CSS: { escape: (value) => String(value) },
        toastr: { error() {}, info() {}, success() {} },
    });

    const searches = [];
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/healthz')) {
            return jsonResponse({
                protocol: PROTOCOL_VERSION,
                version: VERSION,
                sources: [
                    { id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'], capabilities: { search: true, sorts: ['latest'], sfwToggle: true, hideAiToggle: true, detail: true } },
                    { id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'], capabilities: { search: true, sorts: ['default'], sfwToggle: true, hideAiToggle: false, detail: true, filters: [{ key: 'tags', type: 'tags', label: 'Tags' }] } },
                    { id: 'openchar', label: 'Openchar', tier: 1, state: 'up', clientHosts: ['openchar.example'], capabilities: { search: true, sorts: ['default'], detail: true } },
                ],
            });
        }
        if (String(url).endsWith('/search')) {
            return new Promise((resolve, reject) => {
                const call = { body: JSON.parse(options.body), resolve, reject, aborted: false };
                searches.push(call);
                options.signal?.addEventListener('abort', () => {
                    call.aborted = true;
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        }
        throw new Error(`unexpected request: ${url}`);
    };

    const popupInstances = [];
    let renders = 0;
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popupInstances.push(this);
        }

        show() {
            return new Promise((resolve) => {
                this.resolveClosed = resolve;
            });
        }

        complete() {
            this.options.onClose?.();
            this.dlg.remove();
            this.resolveClosed?.();
        }
    }

    const extensionSettings = {};
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            renderExtensionTemplateAsync: async () => {
                renders++;
                return TEMPLATE;
            },
            Popup,
            POPUP_TYPE: { DISPLAY: 'display' },
            POPUP_RESULT: { CANCELLED: 'cancelled' },
        }),
    };

    try {
        const { openBrowser } = await import('../client/browser.js?browser-behavior');
        const firstOpen = openBrowser();
        const secondOpen = openBrowser();
        assert.equal(firstOpen, secondOpen, 'rapid opens must share one popup operation');

        await waitFor(() => popupInstances.length === 1 && searches.length === 1, 'initial catalogue search did not start');
        assert.equal(renders, 1);
        assert.equal(searches[0].body.source, 'botbooru');
        assert.equal(searches[0].body.cursor, null);

        const popup = popupInstances[0];
        const source = popup.content.querySelector('#sbbs_source');
        source.value = 'chub';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

        await waitFor(() => searches.length === 2, 'source-switch search did not start');
        assert.equal(searches[0].aborted, true, 'source switch must abort the stale request');
        searches[1].resolve(jsonResponse({
            total: 2,
            nextCursor: 'cursor-1',
            items: [
                card('chub', 'author/one', 'Fresh', {
                    tagline: 'A short summary from the source',
                    tags: ['Elf', 'Romance'],
                    stats: { downloads: 1200, favorites: 34 },
                }),
                card('chub', 'author/one', 'Duplicate'),
            ],
        }));

        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 1, 'fresh result did not render');
        assert.match(popup.content.textContent, /Fresh/);
        assert.doesNotMatch(popup.content.textContent, /Duplicate/);

        // ---- what a card shows ----
        // tagline, tags and stats all arrived in the summary already; before
        // this they were fetched and then dropped on the floor.
        assert.match(popup.content.textContent, /A short summary from the source/);
        assert.match(popup.content.textContent, /1,200 stars/);
        assert.match(popup.content.textContent, /34 favorites/);

        const cardTags = [...popup.content.querySelectorAll('.sbbs-card-tag')];
        assert.deepEqual(cardTags.map((tag) => tag.textContent), ['Elf', 'Romance']);
        // Chub declares a tag filter, so its tags are actionable.
        assert.ok(cardTags.every((tag) => tag.tagName === 'BUTTON'), 'tags must be buttons where filtering is possible');
        assert.equal(cardTags[0].getAttribute('aria-label'), 'Filter by tag Elf');

        // The card's own action is a single button, not the whole card, so the
        // tag buttons are reachable rather than nested inside it.
        const open = popup.content.querySelector('.sbbs-card-open');
        assert.ok(open, 'the card needs one primary action');
        assert.equal(open.querySelector('button'), null, 'a button inside a button is not keyboard-reachable');

        const more = popup.content.querySelector('#sbbs_more');
        more.click();
        await waitFor(() => searches.length === 3, 'append search did not start');
        searches[2].resolve(jsonResponse({ error: 'source_busy' }, 429));

        await waitFor(() => more.textContent === 'Retry loading more', 'append retry state did not appear');
        assert.equal(popup.content.querySelectorAll('.sbbs-card').length, 1, 'append failure must preserve existing cards');

        more.click();
        await waitFor(() => searches.length === 4, 'append retry did not start');
        searches[3].resolve(jsonResponse({
            total: 2,
            nextCursor: null,
            items: [card('chub', 'author/one', 'Duplicate again'), card('chub', 'author/two', 'Second')],
        }));

        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 2, 'append retry did not render');
        assert.match(popup.content.textContent, /Second/);

        // ---- filters ----
        // Botbooru declared none, Chub declares tags. The control follows the
        // source, so switching sources must have revealed it.
        const filtersToggle = popup.content.querySelector('#sbbs_filters_toggle');
        assert.equal(filtersToggle.hidden, false, 'a source that declares filters must offer them');

        filtersToggle.click();
        assert.equal(popup.content.querySelector('#sbbs_filters').hidden, false);

        const tagInput = popup.content.querySelector('#sbbs_filter_tags');
        tagInput.value = 'Elf';
        tagInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        await waitFor(() => searches.length === 5, 'committing a tag did not re-run the search');
        assert.deepEqual(searches[4].body.filters.tags, ['Elf'], 'the tag must reach the request');
        // Still sent alongside, not replaced by, the filters the source declared.
        assert.equal(searches[4].body.filters.sfwOnly, true);
        assert.equal(searches[4].body.cursor, null, 'a filter change starts a new result set');
        assert.equal(popup.content.querySelector('#sbbs_filters_badge').textContent, '1');

        searches[4].resolve(jsonResponse({
            total: 1,
            nextCursor: null,
            items: [card('chub', 'author/three', 'Tagged', { tags: ['Vampire'] })],
        }));
        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 1, 'filtered result did not render');

        // ---- clicking a tag on a card filters by it ----
        popup.content.querySelector('.sbbs-card-tag-button').click();
        await waitFor(() => searches.length === 6, 'clicking a tag did not re-run the search');
        assert.deepEqual(searches[5].body.filters.tags, ['Elf', 'Vampire'], 'a clicked tag adds to the filter');
        assert.equal(popup.content.querySelector('#sbbs_filters').hidden, false, 'the panel must open so the change is visible');

        searches[5].resolve(jsonResponse({ total: 0, nextCursor: null, items: [] }));
        await waitFor(
            () => /No cards on Chub match these filters/.test(popup.content.textContent),
            'an empty filtered result must say the filters are why',
        );

        // ---- searching every source at once ----
        source.value = '__all__';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => searches.length === 7, 'the merged search did not start');

        const merged = searches[6].body;
        assert.deepEqual(merged.sources, ['botbooru', 'chub', 'openchar'], 'a merged search names its sources');
        assert.equal(merged.source, undefined, 'and does not also name a single one');
        // No shared sort vocabulary, so each source keeps its own.
        assert.deepEqual(Object.keys(merged.sorts).sort(), ['botbooru', 'chub', 'openchar']);
        assert.equal(popup.content.querySelector('#sbbs_sort').hidden, true, 'one sort control cannot drive both');
        assert.equal(merged.filters.sfwOnly, true, 'BotBooru must stay SFW when another source lacks that filter');
        assert.match(
            popup.content.querySelector('#sbbs_sfw_note').textContent,
            /enforced where a source provides a reliable filter/,
        );
        // Chub filters tags and Botbooru does not; offering the control would
        // filter half the list silently. The panel itself stays reachable
        // because it also holds SFW only, which applies to every source.
        assert.equal(popup.content.querySelector('#sbbs_filters_toggle').hidden, false);
        assert.equal(
            popup.content.querySelector('#sbbs_filter_fields').children.length,
            0,
            'a filter only some sources honour must not be offered',
        );
        assert.equal(
            popup.content.querySelector('.sbbs-filter-actions').hidden,
            true,
            'and "Clear filters" goes with them, having nothing to clear',
        );
        assert.equal(popup.content.querySelector('#sbbs_sfw').isConnected, true);

        searches[6].resolve(jsonResponse({
            total: 3,
            nextCursor: 'healthy-source-next',
            items: [
                card('botbooru', 'b1', 'From Botbooru'),
                card('chub', 'author/c1', 'From Chub'),
            ],
            partial: [
                { source: 'chub', error: 'timeout' },
                { source: 'botbooru', error: 'botbooru_session_expired' },
            ],
        }));

        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 1, 'merged account failure did not settle');
        // The expired account removes only BotBooru's cards; valid results from
        // other sources stay visible and the retained account state is updated.
        assert.deepEqual(
            [...popup.content.querySelectorAll('.sbbs-card-source')].map((node) => node.textContent),
            ['Chub'],
        );
        assert.doesNotMatch(popup.content.textContent, /From Botbooru/);
        assert.match(popup.content.textContent, /From Chub/);
        // A source that did not answer is named, not silently dropped.
        assert.match(popup.content.querySelector('#sbbs_partial').textContent, /Chub did not respond in time/);
        assert.match(popup.content.querySelector('#sbbs_partial').textContent, /login expired/);
        const account = await import('../client/account.js');
        assert.equal(account.getBotbooruAccount().error, 'botbooru_session_expired');
        assert.equal(
            popup.content.querySelector('#sbbs_more').hidden,
            false,
            'a BotBooru account failure must not discard healthy-source pagination',
        );

        // The account revision clears every dialog cache entry, including Chub's,
        // because a protected page could have been cached before changing source.
        const beforeReturn = searches.length;
        source.value = 'chub';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => searches.length === beforeReturn + 1, 'account change did not clear the unrelated cache');
        searches.at(-1).resolve(jsonResponse({
            total: 1,
            nextCursor: null,
            items: [card('chub', 'author/one', 'Fresh after account change')],
        }));
        await waitFor(() => /Fresh after account change/.test(popup.content.textContent), 'fresh Chub result did not render');

        // Partial merged results are deliberately not cached: a source can
        // recover before the user returns to the same query.
        source.value = '__all__';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => searches.length === beforeReturn + 2, 'partial merged result must be refreshed');
        searches.at(-1).resolve(jsonResponse({
            total: 2,
            nextCursor: null,
            items: [
                card('botbooru', 'b1', 'From Botbooru'),
                card('chub', 'author/c1', 'From Chub'),
            ],
        }));
        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 2, 'the refreshed merged search did not render');
        assert.equal(searches.length, beforeReturn + 2, 'the recovered source must be retried');
        assert.match(popup.content.textContent, /From Botbooru/);

        // With account state stable again, the newly fetched Chub page is safe
        // to reuse for the same request.
        const beforeCachedReturn = searches.length;
        source.value = 'chub';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(() => /Fresh after account change/.test(popup.content.textContent), 'stable cache was not reused');
        assert.equal(searches.length, beforeCachedReturn, 'a stable repeated search must not hit the network');

        // ---- typing does not fire a request per keystroke ----
        const queryBox = popup.content.querySelector('#sbbs_query');
        const beforeTyping = searches.length;
        for (const value of ['e', 'el', 'elf', 'elfn']) {
            queryBox.value = value;
            queryBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
        await tick();
        assert.equal(searches.length, beforeTyping, 'typing must be debounced, not sent per keystroke');

        popup.complete();
        await firstOpen;
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});
