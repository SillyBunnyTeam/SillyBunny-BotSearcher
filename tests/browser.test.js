import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'templates/browser.html'), 'utf8');

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

    assert.equal(settings._v, 3);
    assert.deepEqual(settings.sortBySource, { chub: 'trending' });
    assert.equal(settings.hideAiDefault, false);
    // Settings saved before direct routing existed still get it, so a source the
    // server cannot reach keeps working after an upgrade without being touched.
    assert.equal(settings.allowDirectRequests, true);
});

test('search history keeps what was searched for, newest first and without repeats', async () => {
    const settingsStore = {};
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: settingsStore, saveSettingsDebounced() {} }),
    };

    const { getSettings, rememberQuery, clearQueryHistory, MAX_QUERY_HISTORY } =
        await import('../client/settings.js?query-history');

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

test('a corrupt stored history is repaired rather than trusted', async () => {
    const settingsStore = {
        SillyBunnyBotSearcher: { queryHistory: ['ok', 42, null, '', { evil: true }, 'x'.repeat(500)] },
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
    globalThis.fetch = async () => jsonResponse({ protocol: 3, version: '0.2.0', sources: [] });
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
                protocol: 3,
                version: '0.2.0',
                sources: [
                    { id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'], capabilities: { search: true, sorts: ['latest'], sfwToggle: true, hideAiToggle: true, detail: true } },
                    { id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'], capabilities: { search: true, sorts: ['default'], sfwToggle: true, hideAiToggle: false, detail: true, filters: [{ key: 'tags', type: 'tags', label: 'Tags' }] } },
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
        assert.match(popup.content.textContent, /1,200 downloads/);
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
        assert.deepEqual(merged.sources, ['botbooru', 'chub'], 'a merged search names its sources');
        assert.equal(merged.source, undefined, 'and does not also name a single one');
        // No shared sort vocabulary, so each source keeps its own.
        assert.deepEqual(Object.keys(merged.sorts).sort(), ['botbooru', 'chub']);
        assert.equal(popup.content.querySelector('#sbbs_sort').hidden, true, 'one sort control cannot drive both');
        // Chub filters tags and Botbooru does not; offering the control would
        // filter half the list silently.
        assert.equal(popup.content.querySelector('#sbbs_filters_toggle').hidden, true);

        searches[6].resolve(jsonResponse({
            total: 3,
            nextCursor: null,
            items: [
                card('botbooru', 'b1', 'From Botbooru'),
                card('chub', 'author/c1', 'From Chub'),
            ],
            partial: [{ source: 'chub', error: 'timeout' }],
        }));

        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 2, 'merged results did not render');
        // Which site each result came from only matters once they are mixed.
        assert.deepEqual(
            [...popup.content.querySelectorAll('.sbbs-card-source')].map((node) => node.textContent),
            ['Botbooru', 'Chub'],
        );
        // A source that did not answer is named, not silently dropped.
        assert.match(popup.content.querySelector('#sbbs_partial').textContent, /Chub did not respond in time/);

        // ---- asking the same question twice ----
        // Switching source rebuilds the filter panel, so this is the same
        // unfiltered Chub search that ran earlier — and must be answered from
        // the cache rather than the network.
        const beforeReturn = searches.length;
        source.value = 'chub';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(
            () => popup.content.textContent.includes('Fresh'),
            'switching back did not restore the earlier Chub results',
        );
        assert.equal(searches.length, beforeReturn, 'a repeated search must not hit the network again');

        // And back to All, which was answered a moment ago too.
        source.value = '__all__';
        source.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await waitFor(
            () => popup.content.querySelectorAll('.sbbs-card').length === 2,
            'the repeated merged search did not render',
        );
        assert.equal(searches.length, beforeReturn, 'still no network request');
        assert.match(popup.content.textContent, /From Botbooru/);

        // ---- typing does not fire a request per keystroke ----
        const queryBox = popup.content.querySelector('#sbbs_query');
        for (const value of ['e', 'el', 'elf', 'elfn']) {
            queryBox.value = value;
            queryBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
        await tick();
        assert.equal(searches.length, beforeReturn, 'typing must be debounced, not sent per keystroke');

        popup.complete();
        await firstOpen;
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});
