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

function card(source, id, name) {
    return {
        source,
        id,
        name,
        creator: '',
        contentRating: 'unknown',
        stats: {},
        thumbUrl: null,
        thumbRef: null,
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
                protocol: 2,
                version: '0.2.0',
                sources: [
                    { id: 'botbooru', label: 'Botbooru', tier: 0, state: 'up', clientHosts: ['botbooru.com'], capabilities: { search: true, sorts: ['latest'], sfwToggle: true, hideAiToggle: true, detail: true } },
                    { id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'], capabilities: { search: true, sorts: ['default'], sfwToggle: true, hideAiToggle: false, detail: true } },
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
            items: [card('chub', 'author/one', 'Fresh'), card('chub', 'author/one', 'Duplicate')],
        }));

        await waitFor(() => popup.content.querySelectorAll('.sbbs-card').length === 1, 'fresh result did not render');
        assert.match(popup.content.textContent, /Fresh/);
        assert.doesNotMatch(popup.content.textContent, /Duplicate/);

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

        popup.complete();
        await firstOpen;
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});
