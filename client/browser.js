/**
 * The browse dialog.
 *
 * One Popup holds both views, switched by `data-view` on `.sbbs-root`; there is
 * no second popup and no history stack. Popup supplies the focus trap, the
 * backdrop and Esc handling.
 *
 * Grid cards are built with createElement and setText. The link between a card
 * element and its record is a Map, not a data-* attribute, so no untrusted
 * string is ever serialized into the DOM and parsed back out.
 */

import { EXTENSION_PATH, LOG_TAG } from './constants.js';
import { AVAILABILITY, getAvailability, invalidateAvailability, post } from './api.js';
import { el, setText, setImgSafe } from './render.js';
import { getSettings, updateSettings } from './settings.js';
import { showDetail } from './detail.js';

let openPopup = null;

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {{ query?: string }} [options]
 */
export async function openBrowser(options = {}) {
    if (openPopup) {
        return;
    }

    const ctx = context();
    const availability = await getAvailability();
    const connected = availability.status === AVAILABILITY.OK;

    const templateName = connected ? 'templates/browser' : 'templates/plugin-missing';
    let html;
    try {
        html = await ctx.renderExtensionTemplateAsync(EXTENSION_PATH, templateName);
    } catch (error) {
        console.error(`[${LOG_TAG}] failed to render ${templateName}:`, error);
        toastr.error('Could not open the browser.', 'BotSearcher');
        return;
    }

    // Popup assigns a string body itself (public/scripts/popup.js:529), which is
    // how this extension stays free of HTML parsing in its own code.
    const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: false,
        okButton: false,
        cancelButton: 'Close',
        onClose: () => {
            openPopup = null;
        },
    });

    openPopup = popup;
    const closed = popup.show();

    if (connected) {
        wireBrowser(popup, availability.health, options);
    } else {
        wireInstallPanel(popup, availability.status);
    }

    await closed;
}

/**
 * @param {any} popup
 * @param {any} health
 * @param {{ query?: string }} options
 */
function wireBrowser(popup, health, options) {
    const root = popup.content;
    const dom = {
        root: root.querySelector('.sbbs-root'),
        bar: root.querySelector('.sbbs-bar'),
        source: root.querySelector('#sbbs_source'),
        query: root.querySelector('#sbbs_query'),
        go: root.querySelector('#sbbs_go'),
        sort: root.querySelector('#sbbs_sort'),
        sfw: root.querySelector('#sbbs_sfw'),
        count: root.querySelector('#sbbs_count'),
        state: root.querySelector('#sbbs_state'),
        grid: root.querySelector('#sbbs_grid'),
        more: root.querySelector('#sbbs_more'),
        detail: root.querySelector('#sbbs_detail'),
    };

    const settings = getSettings();
    const sources = Array.isArray(health?.sources) ? health.sources : [];
    const usable = sources.filter((source) => source && source.state !== 'down' && source.capabilities?.search);

    if (usable.length === 0) {
        dom.bar.hidden = true;
        setText(dom.state, 'No sources are available yet.');
        return;
    }

    /** Card element -> record. Keeps untrusted strings out of the DOM entirely. */
    const records = new Map();

    const state = {
        source: usable.find((entry) => entry.id === settings.defaultSource) ?? usable[0],
        offset: 0,
        loading: false,
        items: [],
    };

    for (const source of usable) {
        const option = document.createElement('option');
        option.value = source.id;
        setText(option, source.label ?? source.id);
        dom.source.append(option);
    }
    dom.source.value = state.source.id;

    dom.sfw.checked = settings.sfwOnlyDefault;
    applySourceCapabilities();

    if (typeof options.query === 'string' && options.query !== '') {
        dom.query.value = options.query;
    }

    setText(dom.state, `Search ${state.source.label}, or press Enter to see the latest.`);

    // ---- events ----

    dom.source.addEventListener('change', () => {
        const next = usable.find((entry) => entry.id === dom.source.value);
        if (!next) {
            return;
        }
        state.source = next;
        applySourceCapabilities();
        updateSettings({ defaultSource: next.id });
        runSearch({ append: false });
    });

    dom.sort.addEventListener('change', () => runSearch({ append: false }));
    dom.sfw.addEventListener('change', () => {
        updateSettings({ sfwOnlyDefault: dom.sfw.checked });
        runSearch({ append: false });
    });

    dom.go.addEventListener('click', () => runSearch({ append: false }));
    dom.query.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            runSearch({ append: false });
        }
    });
    dom.more.addEventListener('click', () => runSearch({ append: true }));

    if (typeof options.query === 'string' && options.query !== '') {
        runSearch({ append: false });
    }

    /** Rebuilds sort options and the SFW toggle for the active source. */
    function applySourceCapabilities() {
        const sorts = state.source.capabilities?.sorts ?? [];
        dom.sort.replaceChildren();
        for (const sort of sorts) {
            const option = document.createElement('option');
            option.value = sort;
            setText(option, sort.charAt(0).toUpperCase() + sort.slice(1));
            dom.sort.append(option);
        }
        if (sorts.includes(settings.sortDefault)) {
            dom.sort.value = settings.sortDefault;
        }
        dom.sort.hidden = sorts.length === 0;

        // Never imply filtering that the source cannot actually do.
        const canFilter = state.source.capabilities?.sfwToggle === true;
        dom.sfw.disabled = !canFilter;
        dom.sfw.closest('.sbbs-sfw').title = canFilter ? '' : `${state.source.label} has no SFW filter`;
    }

    async function runSearch({ append }) {
        if (state.loading) {
            return;
        }
        state.loading = true;

        if (!append) {
            state.offset = 0;
            state.items = [];
            records.clear();
            dom.grid.replaceChildren();
            showSkeletons();
        }
        dom.more.hidden = true;

        try {
            const result = await post('/search', {
                source: state.source.id,
                query: dom.query.value.trim(),
                sort: dom.sort.value,
                limit: settings.resultsPerPage,
                offset: state.offset,
                filters: { sfwOnly: dom.sfw.checked },
            });

            clearSkeletons();

            const items = Array.isArray(result.items) ? result.items : [];
            state.items.push(...items);
            state.offset += items.length;

            appendCards(items);

            if (state.items.length === 0) {
                const term = dom.query.value.trim();
                setText(dom.state, term
                    ? `No results for “${term}” on ${state.source.label}.`
                    : `No results on ${state.source.label}.`);
            } else {
                setText(dom.state, '');
            }

            setText(dom.count, result.total !== null && result.total !== undefined
                ? `${state.items.length} of ${result.total}`
                : `${state.items.length} shown`);

            dom.more.hidden = result.hasMore !== true || items.length === 0;
        } catch (error) {
            clearSkeletons();
            setText(dom.state, describeError(error, state.source.label));
            setText(dom.count, '');
        } finally {
            state.loading = false;
        }
    }

    function appendCards(items) {
        const settingsNow = getSettings();
        for (const item of items) {
            const card = buildCard(item, state.source, settingsNow);
            records.set(card, item);
            card.addEventListener('click', () => {
                dom.root.dataset.view = 'detail';
                showDetail(dom.detail, records.get(card), state.source, () => {
                    dom.root.dataset.view = 'grid';
                    dom.detail.replaceChildren();
                });
            });
            const li = document.createElement('li');
            li.append(card);
            dom.grid.append(li);
        }
    }

    function showSkeletons() {
        for (let i = 0; i < 12; i++) {
            const li = document.createElement('li');
            li.className = 'sbbs-skeleton';
            li.append(el('div', 'sbbs-card-img'));
            dom.grid.append(li);
        }
    }

    function clearSkeletons() {
        for (const node of [...dom.grid.querySelectorAll('.sbbs-skeleton')]) {
            node.remove();
        }
    }
}

/**
 * @param {any} item
 * @param {{ label: string, allowedHosts: string[] }} source
 * @param {ReturnType<typeof getSettings>} settings
 */
function buildCard(item, source, settings) {
    const card = el('button', 'sbbs-card');
    card.type = 'button';

    const figure = el('div', 'sbbs-card-img');
    if (settings.imageMode !== 'off' && item.thumbUrl) {
        const img = document.createElement('img');
        img.alt = '';
        if (setImgSafe(img, item.thumbUrl, source.allowedHosts)) {
            if (item.nsfw && settings.blurNsfw) {
                figure.classList.add('sbbs-blurred');
            }
            figure.append(img);
        }
    }

    const meta = el('div', 'sbbs-card-meta');
    meta.append(el('div', 'sbbs-card-name', item.name || 'Untitled'));

    const sub = [];
    if (item.stats?.tokens) {
        sub.push(`${item.stats.tokens} tokens`);
    }
    if (item.creator) {
        sub.push(item.creator);
    }
    meta.append(el('div', 'sbbs-card-sub', sub.join(' · ')));

    card.append(figure, meta);
    card.title = item.name || '';
    return card;
}

function describeError(error, sourceLabel) {
    switch (error?.code) {
        case 'timeout':
            return `${sourceLabel} did not respond in time. Try again.`;
        case 'rate_limited':
            return 'Too many searches — wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy — try again shortly.`;
        case 'http_error':
            return `${sourceLabel} returned an error.`;
        default:
            return `Could not reach ${sourceLabel}.`;
    }
}

/**
 * @param {any} popup
 * @param {string} status
 */
function wireInstallPanel(popup, status) {
    const root = popup.content;

    if (status === AVAILABILITY.PROTOCOL_MISMATCH) {
        setText(root.querySelector('.sbbs-install-title'), 'The two halves are out of sync');
    }

    root.querySelector('#sbbs_recheck')?.addEventListener('click', () => {
        invalidateAvailability();
        popup.complete(context().POPUP_RESULT.CANCELLED);
        setTimeout(() => {
            openBrowser().catch((error) => console.error(`[${LOG_TAG}]`, error));
        }, 250);
    });
}
