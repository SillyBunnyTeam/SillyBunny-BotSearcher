import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright';
import { PROTOCOL_VERSION, VERSION } from '../shared/schema.js';
import { invalidateAvailability } from '../client/api.js';
import { openBrowser } from '../client/browser.js';
import { getSettings, updateSettings } from '../client/settings.js';
import { getBotbooruAccount, loginBotbooruAccount, logoutBotbooruAccount } from '../client/account.js';

const template = fs.readFileSync(new URL('../templates/browser.html', import.meta.url), 'utf8');
const sources = [
    { id: 'botbooru', label: 'BotBooru', tier: 0, clientHosts: ['botbooru.com'], capabilities: {
        search: true, detail: false, urlImport: true, sfwToggle: true, hideAiToggle: true,
        sorts: ['latest', 'downloads'], filters: [{ key: 'tags', type: 'tags', label: 'Tags' }],
    } },
    { id: 'chub', label: 'Chub', tier: 1, clientHosts: ['chub.ai'], capabilities: {
        search: true, detail: false, sfwToggle: true, sorts: ['default', 'trending'],
        filters: [{ key: 'tags', type: 'tags', label: 'Tags' }, { key: 'minTokens', type: 'number', label: 'Minimum tokens' }],
    } },
];
const card = (source, id, extra = {}) => ({ source, id, name: id, stats: {}, contentRating: 'sfw', ...extra });
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) {
            return;
        }
        await tick();
    }
    assert.fail('Workflow did not settle');
}

async function browser(t, { settings = {}, search, route, healthSources = sources } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
    const globals = {
        document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback) => setTimeout(callback, 0), CSS: { escape: String },
        toastr: { error() {}, success() {}, info() {} },
    };
    const previous = Object.fromEntries([...Object.keys(globals), 'fetch', 'SillyTavern'].map((key) => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    const calls = [];
    const searches = [];
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).split('/').at(-1);
        const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;
        calls.push({ path, body, options });
        if (path === 'healthz') {
            return reply({ protocol: PROTOCOL_VERSION, version: VERSION, sources: healthSources });
        }
        if (path === 'search') {
            searches.push(body);
            return search ? search(body, searches.length, options)
                : reply({ items: [card(body.source ?? 'chub', body.query || 'catalogue')], nextCursor: 'next' });
        }
        const custom = await route?.(path, body, options);
        if (custom) {
            return custom;
        }
        if (['login', 'logout', 'status'].includes(path)) {
            return reply({ loggedIn: path === 'login', username: path === 'login' ? 'alice' : '', nsfwEnabled: path === 'login' });
        }
        if (path === 'retry') {
            return reply({ ok: true });
        }
        if (path === 'card' || path === 'url-card') {
            return reply({ error: 'card_invalid' }, 400);
        }
        throw new Error(`Unexpected request: ${path}`);
    };
    const extensionSettings = { SillyBunnyBotSearcher: { imageMode: 'off', ...settings } };
    let popup;
    class Popup {
        constructor(html, _type, _title, options) {
            this.options = options;
            this.content = document.createElement('div');
            this.content.innerHTML = html;
            this.dlg = document.createElement('dialog');
            this.dlg.append(this.content);
            document.body.append(this.dlg);
            popup = this;
        }
        show() {
            return new Promise((resolve) => {
                this.resolve = resolve;
            });
        }
        complete() {
            this.options.onClose();
            this.dlg.remove();
            this.resolve();
        }
    }
    globalThis.SillyTavern = { getContext: () => ({
        extensionSettings, saveSettingsDebounced() {}, characters: [], getCharacters: async () => {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        renderExtensionTemplateAsync: async () => template,
        Popup, POPUP_TYPE: { DISPLAY: 'display' }, POPUP_RESULT: { CANCELLED: 'cancelled' },
    }) };
    await logoutBotbooruAccount();
    invalidateAvailability();
    let opened = openBrowser();
    t.after(async () => {
        popup?.complete();
        await opened;
        invalidateAvailability();
        Object.assign(globalThis, previous);
        dom.window.close();
    });
    await waitFor(() => popup && searches.length > 0);
    const $ = (selector) => popup.content.querySelector(selector);
    const event = (node, type) => node.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
    const submit = (query) => {
        $('#sbbs_query').value = query;
        event($('#sbbs_search_form'), 'submit');
    };
    return {
        $, event, submit, searches, calls, dom, extensionSettings,
        get popup() {
            return popup;
        },
        async reopen() {
            popup.complete();
            await opened;
            popup = null;
            opened = openBrowser();
            await waitFor(() => popup && $('.sbbs-card'));
        },
    };
}

test('URL intent guards every control path and exposes the correct submit action', async (t) => {
    const b = await browser(t);
    await waitFor(() => b.$('.sbbs-card'));
    b.$('#sbbs_select_toggle').click();
    b.$('.sbbs-card-open').click();
    b.$('#sbbs_query').value = 'https://botbooru.com/cards/a';
    b.event(b.$('#sbbs_query'), 'input');
    assert.equal(b.$('#sbbs_go').getAttribute('aria-label'), 'Review card URL');
    assert.equal(b.$('#sbbs_query').getAttribute('enterkeyhint'), 'go');
    assert.equal(b.$('#sbbs_more').hidden, true);
    assert.equal(b.$('.sbbs-root').dataset.selecting, 'false');
    assert.equal(b.$('.sbbs-card'), null);
    for (const id of ['#sbbs_sfw', '#sbbs_hide_ai', '#sbbs_sort']) {
        b.event(b.$(id), 'change');
    }
    b.$('#sbbs_filter_tags').value = 'Elf';
    b.event(b.$('#sbbs_filter_tags'), 'blur');
    b.$('#sbbs_filters_clear').click();
    b.$('#sbbs_source').value = 'chub';
    b.event(b.$('#sbbs_source'), 'change');
    b.$('#sbbs_refresh').click();
    assert.equal(b.searches.length, 1);
    assert.equal(b.$('.sbbs-root').dataset.view, 'grid', 'controls must not import');
    updateSettings({ skipReview: true });
    assert.equal(b.$('#sbbs_go').getAttribute('aria-label'), 'Import card URL');
    b.submit('https://unknown.example/card');
    assert.equal(b.$('#sbbs_go').disabled, true);
    assert.equal(b.searches.length, 1);
    b.submit('ordinary search');
    await waitFor(() => b.searches.length === 2);
    assert.equal(b.$('#sbbs_go').getAttribute('aria-label'), 'Search');
    assert.equal(b.$('#sbbs_go').disabled, false);
    assert.equal(b.$('#sbbs_inspect_file').closest('#sbbs_filters'), null);
    assert.equal(b.$('#sbbs_sfw').closest('#sbbs_filters'), null);
    assert.equal(b.$('#sbbs_filters_clear').textContent, 'Clear source filters');
});

test('typing clears pagination and selection immediately and ignores an abort-resistant reply', async (t) => {
    let late;
    const b = await browser(t, { search: (_body, n) => n === 2 ? new Promise((resolve) => {
        late = resolve;
    })
        : reply({ items: [card('botbooru', 'old')], nextCursor: 'old-page' }) });
    await waitFor(() => b.$('.sbbs-card'));
    b.$('#sbbs_select_toggle').click();
    b.$('.sbbs-card-open').click();
    b.$('#sbbs_more').click();
    await waitFor(() => late);
    b.$('#sbbs_query').value = 'new query';
    b.event(b.$('#sbbs_query'), 'input');
    assert.equal(b.$('#sbbs_more').hidden, true);
    assert.equal(b.$('#sbbs_import_selected').disabled, true);
    assert.equal(b.$('.sbbs-card'), null);
    assert.equal(b.$('#sbbs_count').textContent, '');
    late(reply({ items: [card('botbooru', 'late')], nextCursor: 'stale' }));
    await tick();
    assert.equal(b.$('.sbbs-card'), null);
    b.$('#sbbs_more').click();
    assert.equal(b.searches.length, 2);
    b.$('#sbbs_query').value = 'x';
    b.event(b.$('#sbbs_query'), 'input');
    assert.equal(b.$('#sbbs_state').textContent, 'Keep typing to search.');
});

test('shortlist survives searches independently of import selection but not closing the dialog', async (t) => {
    const b = await browser(t, { settings: { defaultSource: 'chub' } });
    await waitFor(() => b.$('.sbbs-card'));
    b.$('.sbbs-shortlist-toggle').click();
    b.$('#sbbs_select_toggle').click();
    b.$('.sbbs-card-open').click();
    b.submit('another');
    await waitFor(() => b.$('.sbbs-card-name')?.textContent === 'another');
    assert.equal(b.$('#sbbs_shortlist_count').textContent, 'Shortlist (1)');
    assert.match(b.$('#sbbs_shortlist_items').textContent, /catalogue/);
    assert.equal(b.$('.sbbs-root').dataset.selecting, 'false');
    b.$('.sbbs-shortlist-toggle').click();
    b.$('#sbbs_shortlist_import').click();
    assert.equal(b.$('.sbbs-root').dataset.view, 'intake');
    assert.equal(b.calls.filter((call) => call.path === 'card').length, 0);
    assert.match(b.$('.sbbs-intake-title').textContent, /Import 2 cards/);
    b.$('.sbbs-intake .sbbs-back').click();
    assert.equal(b.$('#sbbs_shortlist_count').textContent, 'Shortlist (2)');
    assert.doesNotMatch(JSON.stringify(b.extensionSettings), /catalogue|another/);
    await b.reopen();
    assert.equal(b.$('#sbbs_shortlist_count').textContent, 'Shortlist (0)');
});

test('named searches require separate consent and restore the approved shape', async (t) => {
    const b = await browser(t, { settings: { defaultSource: 'chub', saveQueryHistory: true } });
    await waitFor(() => b.$('.sbbs-card'));
    assert.equal(b.$('#sbbs_named_controls').hidden, true);
    assert.equal(b.$('#sbbs_named_consent').checked, false);
    b.$('#sbbs_named_consent').checked = true;
    b.event(b.$('#sbbs_named_consent'), 'change');
    b.$('#sbbs_named_name').value = 'Elves';
    b.$('#sbbs_query').value = 'forest';
    b.$('#sbbs_filter_tags').value = 'Elf, Magic';
    b.$('#sbbs_filter_minTokens').value = '1000';
    b.$('#sbbs_sort').value = 'trending';
    b.$('#sbbs_sfw').checked = false;
    b.$('#sbbs_hide_ai').checked = true;
    b.$('#sbbs_named_save').click();
    assert.deepEqual(getSettings().namedSearches, [{
        name: 'Elves', query: 'forest', source: 'chub', filters: { tags: ['Elf', 'Magic'], minTokens: 1000 },
        sort: 'trending', sorts: {}, sfwOnly: false, hideAi: true,
    }]);
    b.$('#sbbs_source').value = 'botbooru';
    b.event(b.$('#sbbs_source'), 'change');
    b.$('#sbbs_named_load').click();
    await waitFor(() => b.searches.at(-1)?.source === 'chub' && b.searches.at(-1)?.filters.minTokens === 1000);
    assert.equal(b.$('#sbbs_query').value, 'forest');
    assert.equal(b.$('#sbbs_sort').value, 'trending');
    assert.deepEqual(b.searches.at(-1).filters.tags, ['Elf', 'Magic']);
    assert.equal(b.searches.at(-1).filters.sfwOnly, false);
    assert.equal(b.$('#sbbs_hide_ai').checked, true);
    assert.equal(document.activeElement, b.$('#sbbs_query'));
    updateSettings({ enabledSources: ['botbooru'] });
    const beforeDisabledLoad = b.searches.length;
    b.$('#sbbs_named_load').click();
    assert.equal(b.searches.length, beforeDisabledLoad);
    assert.match(b.$('#sbbs_named_status').textContent, /Enable this search source/);
    updateSettings({ enabledSources: null });
    b.$('#sbbs_named_name').value = 'No URL';
    b.$('#sbbs_query').value = 'https://botbooru.com/cards/a';
    b.$('#sbbs_named_save').click();
    assert.equal(getSettings().namedSearches.length, 1);
    b.$('#sbbs_named_remove').click();
    assert.deepEqual(getSettings().namedSearches, []);
    b.$('#sbbs_query').value = 'forest';
    b.$('#sbbs_named_save').click();
    updateSettings({ saveNamedSearches: false });
    assert.equal(b.$('#sbbs_named_list').options.length, 0);
    assert.equal(b.$('#sbbs_named_name').value, '');
    assert.equal(b.$('#sbbs_named_controls').hidden, true);
    assert.equal(getSettings().saveQueryHistory, true);
    assert.deepEqual(getSettings().namedSearches, []);
});

test('named merged searches restore each source sort without saving account or cursor data', async (t) => {
    const b = await browser(t, { settings: {
        defaultSource: '__all__', saveNamedSearches: true, sortBySource: { chub: 'trending', botbooru: 'downloads' },
    } });
    await waitFor(() => b.$('.sbbs-card'));
    b.$('#sbbs_named_name').value = 'Across sites';
    b.$('#sbbs_named_save').click();
    assert.deepEqual(getSettings().namedSearches[0].sorts, { botbooru: 'downloads', chub: 'trending' });
    updateSettings({ sortBySource: { botbooru: 'latest', chub: 'default' } });
    b.$('#sbbs_named_load').click();
    b.$('#sbbs_refresh').click();
    await waitFor(() => b.searches.length === 2);
    assert.deepEqual(b.searches.at(-1).sorts, { botbooru: 'downloads', chub: 'trending' });
    assert.equal(b.searches.at(-1).cursor, null);
    assert.deepEqual(Object.keys(getSettings().namedSearches[0]).sort(),
        ['name', 'query', 'source', 'filters', 'sort', 'sorts', 'sfwOnly', 'hideAi'].sort());
});

test('Refresh bypasses cached pages and starts at the first page', async (t) => {
    const b = await browser(t, { search: (body, n) => reply({ items: [card(body.source, `result-${n}`)], nextCursor: `page-${n}` }) });
    await waitFor(() => b.$('.sbbs-card'));
    b.submit('');
    assert.equal(b.searches.length, 1, 'ordinary repeat uses cache');
    b.$('#sbbs_more').click();
    await waitFor(() => b.searches.length === 2 && b.$('#sbbs_grid').children.length === 2);
    b.$('#sbbs_refresh').click();
    await waitFor(() => b.$('.sbbs-card-name')?.textContent === 'result-3');
    assert.equal(b.searches[2].cursor, null);
    assert.equal(b.$('#sbbs_grid').children.length, 1);
});

test('failed-source retry retains healthy cards and partitions opaque pagination cursors', async (t) => {
    const b = await browser(t, { settings: { defaultSource: '__all__' }, search: (_body, n) => {
        const pages = [
            { items: [card('botbooru', 'healthy')], nextCursor: 'merged-1', partial: [{ source: 'chub', error: 'timeout' }] },
            { items: [card('chub', 'recovered')], nextCursor: 'chub-2' },
            { items: [card('botbooru', 'healthy-2')], nextCursor: 'healthy-3' },
            { items: [card('chub', 'recovered-2')], nextCursor: null },
        ];
        return reply(pages[n - 1]);
    } });
    await waitFor(() => b.$('.sbbs-retry-source:not(:disabled)'));
    const healthy = b.$('.sbbs-card-open');
    b.$('.sbbs-retry-source').click();
    await waitFor(() => b.$('#sbbs_recovered .sbbs-retry-source:not(:disabled)'));
    assert.equal(b.$('.sbbs-card-open'), healthy);
    assert.deepEqual(b.searches[1].sources, ['chub']);
    assert.equal(b.searches[1].cursor, 'merged-1');
    assert.deepEqual(b.calls.filter((call) => call.path === 'retry').map((call) => call.body), [{ source: 'chub' }]);
    updateSettings({ resultsPerPage: 12, sortBySource: { botbooru: 'downloads' } });
    b.$('#sbbs_more').click();
    await waitFor(() => b.$('#sbbs_grid').children.length === 3);
    assert.deepEqual(b.searches[2].sources, ['botbooru']);
    assert.equal(b.searches[2].cursor, 'merged-1', 'healthy paging was not advanced by the retry');
    assert.equal(b.searches[2].limit, 24, 'continuation keeps its original page size');
    assert.equal(b.searches[2].sorts.botbooru, 'latest', 'continuation keeps its original sort');
    b.$('#sbbs_recovered .sbbs-retry-source').click();
    await waitFor(() => b.$('#sbbs_grid').children.length === 4);
    assert.equal(b.searches[3].cursor, 'chub-2');
    assert.deepEqual(b.searches[3].sources, ['chub']);
    assert.equal(b.$('#sbbs_recovered').hidden, true);
});

test('a cooldown on a later page retains cards and retries the same cursor', async (t) => {
    const b = await browser(t, { settings: { defaultSource: 'chub' }, search: (_body, n) => n === 2
        ? reply({ error: 'source_down' }, 503)
        : reply({ items: [card('chub', `page-${n}`)], nextCursor: n === 1 ? 'second-page' : null }) });
    await waitFor(() => b.$('.sbbs-card'));
    const first = b.$('.sbbs-card-open');
    b.$('#sbbs_more').click();
    await waitFor(() => b.$('.sbbs-reload-source'));
    assert.equal(b.$('.sbbs-card-open'), first);
    b.$('.sbbs-reload-source').click();
    await waitFor(() => b.$('#sbbs_grid').children.length === 2);
    assert.equal(b.searches[2].cursor, 'second-page');
    assert.equal(b.$('.sbbs-card-open'), first);
});

test('a retry response and cooldown reset cannot restart an obsolete search', async (t) => {
    let releaseRetry;
    let releaseSearch;
    const b = await browser(t, { settings: { defaultSource: '__all__' },
        route: (path) => path === 'retry' ? new Promise((resolve) => {
            releaseRetry = resolve;
        }) : null,
        search: (body, n) => {
            if (body.sources?.length === 1) {
                return new Promise((resolve) => {
                    releaseSearch = resolve;
                });
            }
            return reply({ items: [card('botbooru', `healthy-${n}`)], nextCursor: 'merged', partial: [{ source: 'chub', error: 'timeout' }] });
        },
    });
    await waitFor(() => b.$('.sbbs-retry-source:not(:disabled)'));
    b.$('.sbbs-retry-source').click();
    await waitFor(() => releaseRetry);
    b.submit('different');
    releaseRetry(reply({ ok: true }));
    await waitFor(() => b.$('.sbbs-retry-source:not(:disabled)'));
    assert.equal(b.searches.length, 2);
    b.$('.sbbs-retry-source').click();
    await tick();
    releaseRetry(reply({ ok: true }));
    await waitFor(() => releaseSearch);
    b.submit('third');
    releaseSearch(reply({ items: [card('chub', 'stale-recovery')], nextCursor: 'wrong' }));
    await waitFor(() => b.$('.sbbs-card-name')?.textContent === 'healthy-4');
    assert.doesNotMatch(b.$('#sbbs_grid').textContent, /stale-recovery/);
});

test('account revisions strip late merged BotBooru results and errors while retaining healthy replies', async (t) => {
    let finish;
    const b = await browser(t, { settings: { defaultSource: '__all__' }, search: (_body, n) => n === 2
        ? new Promise((resolve) => {
            finish = resolve;
        })
        : reply({ items: [card('botbooru', 'protected'), card('chub', 'public')], nextCursor: 'merged' }) });
    await waitFor(() => b.$('#sbbs_grid').children.length === 2);
    b.$('.sbbs-shortlist-toggle').click();
    b.$('#sbbs_more').click();
    await waitFor(() => finish);
    await loginBotbooruAccount('alice', 'secret');
    const revision = getBotbooruAccount().revision;
    assert.doesNotMatch(b.$('#sbbs_grid').textContent, /protected/);
    assert.match(b.$('#sbbs_grid').textContent, /public/);
    assert.equal(b.$('#sbbs_shortlist_count').textContent, 'Shortlist (0)');
    finish(reply({ items: [card('botbooru', 'stale-secret'), card('chub', 'late-public')], nextCursor: 'healthy-next',
        partial: [{ source: 'botbooru', error: 'botbooru_session_expired' }] }));
    await waitFor(() => /late-public/.test(b.$('#sbbs_grid').textContent));
    assert.doesNotMatch(b.$('#sbbs_grid').textContent, /stale-secret/);
    assert.equal(getBotbooruAccount().revision, revision);
    assert.equal(getBotbooruAccount().loggedIn, true);
    assert.equal(b.$('#sbbs_more').hidden, false);
    assert.match(b.$('#sbbs_partial').textContent, /account changed/);
});

test('inline BotBooru login recovery and committing intake survive account revisions', async (t) => {
    const b = await browser(t, { route: (path) => path === 'card'
        ? reply({ error: 'botbooru_login_required' }, 401) : null });
    await waitFor(() => b.$('.sbbs-card'));
    b.$('.sbbs-card-open').click();
    b.$('.sbbs-detail .sbbs-import').click();
    await waitFor(() => b.$('.sbbs-intake-account-recovery[data-source="botbooru"]'));
    const recovery = b.$('.sbbs-intake-account-recovery');
    await loginBotbooruAccount('alice', 'secret');
    assert.equal(b.$('.sbbs-root').dataset.view, 'intake');
    assert.equal(b.$('.sbbs-intake-account-recovery'), recovery);
    recovery.remove();
    b.$('#sbbs_intake').dataset.committing = 'true';
    const contents = b.$('#sbbs_intake').firstChild;
    await logoutBotbooruAccount();
    assert.equal(b.$('.sbbs-root').dataset.view, 'intake');
    assert.equal(b.$('#sbbs_intake').firstChild, contents);
    b.$('#sbbs_inspect_file').click();
    assert.equal(b.$('#sbbs_intake').firstChild, contents);
});

test('review returns focus to detail and tag searches focus the surviving filter input', async (t) => {
    const b = await browser(t, { settings: { defaultSource: 'chub' }, search: () => reply({
        items: [card('chub', 'tagged', { tags: ['Elf'], tagline: 'A listing summary', stats: { tokens: 1234 } })], nextCursor: null,
    }) });
    await waitFor(() => b.$('.sbbs-card'));
    const open = b.$('.sbbs-card-open');
    const described = open.getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id).textContent);
    assert.match(described.join(' '), /1,234 tokens/);
    assert.match(described.join(' '), /A listing summary/);
    open.click();
    const review = b.$('.sbbs-detail .sbbs-import');
    review.focus();
    review.click();
    await waitFor(() => /could not|invalid|not/i.test(b.$('#sbbs_intake').textContent));
    b.$('.sbbs-intake .sbbs-back').click();
    assert.equal(document.activeElement, review);
    b.$('.sbbs-detail .sbbs-tag-button').click();
    assert.equal(b.$('.sbbs-root').dataset.view, 'grid');
    assert.equal(document.activeElement, b.$('#sbbs_filter_tags'));
    await waitFor(() => b.$('.sbbs-card'));
    b.$('#sbbs_filters_clear').click();
    await waitFor(() => b.$('.sbbs-card'));
    b.$('.sbbs-card-tag-button').click();
    assert.equal(document.activeElement, b.$('#sbbs_filter_tags'));
});

test('merged result and detail tags stay plain text rather than inert buttons', async (t) => {
    const b = await browser(t, { settings: { defaultSource: '__all__' }, search: () => reply({
        items: [card('chub', 'tagged', { tags: ['Elf'] })], nextCursor: null,
    }) });
    await waitFor(() => b.$('.sbbs-card'));
    assert.equal(b.$('.sbbs-card-tag-button'), null);
    b.$('.sbbs-card-open').click();
    assert.equal(b.$('.sbbs-tag-button'), null);
    assert.equal(b.$('.sbbs-tags .sbbs-tag').tagName, 'SPAN');
});

test('browser controls and shortlist remain usable at desktop and narrow mobile sizes', {
    skip: !fs.existsSync(chromium.executablePath()), timeout: 30_000,
}, async (t) => {
    const instance = await chromium.launch({ headless: true });
    t.after(() => instance.close());
    const page = await instance.newPage();
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, 'https://browser.test', 'no live source requests');
        if (url.pathname === '/') {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    * { box-sizing: border-box; }
                    body { margin: 0; font: 16px/1.5 system-ui; }
                    .popup { display: flex; flex-direction: column; position: fixed; inset: 0; margin: auto;
                        height: 90vh; max-width: 90vw; padding: 20px; }
                    .popup-content, .popup-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
                    button, input, select { font: inherit; }
                    .menu_button { display: flex; width: min-content; padding: 6px 16px; white-space: nowrap;
                        min-width: 38px; min-height: 38px; }
                    .text_pole { width: 100%; min-height: 36px; }
                    .checkbox_label { display: flex; align-items: center; gap: 8px; }
                </style><link rel="stylesheet" href="/style.css"></head><body></body></html>` });
        }
        if (/^\/(client|shared)\/[a-z0-9-]+\.js$/.test(url.pathname) || url.pathname === '/style.css') {
            return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
                body: fs.readFileSync(new URL(`..${url.pathname}`, import.meta.url), 'utf8') });
        }
        if (url.pathname.endsWith('/healthz')) {
            return route.fulfill({ json: { protocol: PROTOCOL_VERSION, version: VERSION, sources } });
        }
        if (url.pathname.endsWith('/search')) {
            return route.fulfill({ json: { items: [card('chub', 'A long shortlist card name '.repeat(10))], nextCursor: null } });
        }
        assert.fail(`Unexpected browser request: ${url.pathname}`);
    });
    await page.goto('https://browser.test', { waitUntil: 'networkidle' });
    await page.evaluate(async (html) => {
        const extensionSettings = { SillyBunnyBotSearcher: { defaultSource: 'chub', imageMode: 'off' } };
        class Popup {
            constructor(template, _type, _title, options) {
                this.options = options;
                this.dlg = document.createElement('dialog');
                this.dlg.className = 'popup';
                const wrapper = document.createElement('div');
                wrapper.className = 'popup-body';
                this.content = document.createElement('div');
                this.content.className = 'popup-content';
                this.content.innerHTML = template;
                wrapper.append(this.content);
                this.dlg.append(wrapper);
                document.body.append(this.dlg);
            }
            show() { this.dlg.showModal(); return new Promise(() => {}); }
        }
        globalThis.SillyTavern = { getContext: () => ({
            extensionSettings, saveSettingsDebounced() {}, Popup,
            POPUP_TYPE: { DISPLAY: 'display' }, POPUP_RESULT: { CANCELLED: 'cancelled' },
            renderExtensionTemplateAsync: async () => html,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        }) };
        void (await import('/client/browser.js')).openBrowser();
    }, template);
    await page.locator('.sbbs-card-open').waitFor();
    for (const [width, height] of [[1440, 900], [360, 640], [320, 400]]) {
        await page.setViewportSize({ width, height });
        for (const selector of ['#sbbs_select_toggle', '.sbbs-shortlist-toggle', '#sbbs_refresh']) {
            const label = await page.locator(selector).first().evaluate((button) => {
                const range = document.createRange();
                range.selectNodeContents(button.querySelector('span') ?? button);
                return { text: button.textContent, lines: new Set([...range.getClientRects()]
                    .filter((rect) => rect.height && rect.width).map((rect) => Math.round(rect.top))).size };
            });
            assert.equal(label.lines, 1, `${width}px: ${label.text} stays on one line`);
        }
        await page.locator('#sbbs_named_searches > summary').click();
        await page.locator('#sbbs_named_consent').check();
        await page.locator('#sbbs_named_name').fill('Mobile search');
        await page.locator('#sbbs_named_save').click();
        await page.locator('#sbbs_named_load').click();
        assert.equal(await page.locator('#sbbs_query').evaluate((node) => node === document.activeElement), true);
        await page.locator('#sbbs_named_searches > summary').click();
        await page.locator('.sbbs-shortlist-toggle').click();
        await page.locator('#sbbs_shortlist > summary').click();
        const overflow = await page.locator('.sbbs-root').evaluate((root) => [root, ...root.querySelectorAll(
            '.sbbs-bar, .sbbs-named-controls, .sbbs-shortlist-item, .sbbs-card',
        )].filter((node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.className));
        assert.deepEqual(overflow, [], `${width}x${height}: no horizontal clipping`);
        await page.locator('#sbbs_shortlist_import').click();
        await page.locator('.sbbs-bulk-start').waitFor();
        await page.locator('.sbbs-bulk .sbbs-back').click();
        await page.locator('#sbbs_shortlist_clear').click();
        await page.locator('#sbbs_shortlist > summary').click();
    }
    assert.deepEqual(errors, []);
});
