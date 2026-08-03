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
import { AVAILABILITY, getAvailability, invalidateAvailability, post, thumbSrc } from './api.js';
import { el, setText, setImgSafe } from './render.js';
import { getSettings, updateSettings, isSourceEnabled } from './settings.js';
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
    const usable = sources.filter((source) => source
        && source.state !== 'down'
        && source.capabilities?.search
        && isSourceEnabled(source, settings.enabledSources));

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
        /** A search requested while one was in flight, honoured when it lands. */
        rerun: null,
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
            setText(option, sortLabel(sort));
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
        // Dropping a request while one is in flight loses it silently: type a
        // query during the initial load, press Enter, and nothing happens. Note
        // the intent instead and honour it when the current one finishes.
        if (state.loading) {
            state.rerun = append ? state.rerun : { append: false };
            return;
        }
        state.loading = true;
        state.rerun = null;

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
            setText(dom.count, '');

            if (error?.code === 'source_down') {
                retireSource(state.source);
                return;
            }

            setText(dom.state, describeError(error, state.source.label));
        } finally {
            state.loading = false;

            const queued = state.rerun;
            if (queued) {
                state.rerun = null;
                runSearch(queued);
            }
        }
    }

    /**
     * A source that has gone away is removed from the picker rather than left
     * to spin. The Retry clears its server-side cooldown, so a site that comes
     * back does not require a restart.
     */
    function retireSource(dead) {
        const index = usable.findIndex((entry) => entry.id === dead.id);
        if (index >= 0) {
            usable.splice(index, 1);
        }
        dom.source.querySelector(`option[value="${CSS.escape(dead.id)}"]`)?.remove();

        toastr.info(`${dead.label} isn’t responding — hidden for now.`, 'BotSearcher');

        dom.grid.replaceChildren();
        records.clear();
        state.items = [];

        if (usable.length === 0) {
            dom.bar.hidden = true;
            setText(dom.state, 'No sources are available right now.');
        } else {
            state.source = usable[0];
            dom.source.value = state.source.id;
            applySourceCapabilities();
            setText(dom.state, `Switched to ${state.source.label}.`);
        }

        const retry = el('button', 'menu_button sbbs-retry-source', `Retry ${dead.label}`);
        retry.type = 'button';
        retry.addEventListener('click', async () => {
            retry.disabled = true;
            try {
                await post('/retry', { source: dead.id });
                invalidateAvailability();
                toastr.success(`${dead.label} will be tried again.`, 'BotSearcher');
                restoreSource(dead, retry);
            } catch {
                retry.disabled = false;
                toastr.error(`${dead.label} is still unavailable.`, 'BotSearcher');
            }
        });
        dom.state.after(retry);
    }

    function restoreSource(revived, retryButton) {
        retryButton.remove();
        if (usable.some((entry) => entry.id === revived.id)) {
            return;
        }
        usable.push(revived);
        const option = document.createElement('option');
        option.value = revived.id;
        setText(option, revived.label ?? revived.id);
        dom.source.append(option);
        dom.bar.hidden = false;
        dom.source.value = revived.id;
        state.source = revived;
        applySourceCapabilities();
        runSearch({ append: false });
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
                    // Return focus where it was, so keyboard and screen-reader
                    // users are not dropped back at the top of the dialog.
                    card.focus();
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
 * @param {{ label: string, clientHosts: string[] }} source
 * @param {ReturnType<typeof getSettings>} settings
 */
function buildCard(item, source, settings) {
    const card = el('button', 'sbbs-card');
    card.type = 'button';

    const figure = el('div', 'sbbs-card-img');
    // Always present, revealed if no image arrives. A source may have no
    // thumbnail, or one too large for the proxy's cap. Decorative: the card's
    // accessible name already carries the character name.
    const initial = el('span', 'sbbs-card-initial', initialOf(item.name));
    initial.setAttribute('aria-hidden', 'true');
    figure.append(initial);

    const src = thumbSrc(item, source, 'grid', settings.imageMode);
    if (src) {
        const img = document.createElement('img');
        img.alt = '';
        if (setImgSafe(img, src, source.clientHosts)) {
            if (item.nsfw && settings.blurNsfw) {
                figure.classList.add('sbbs-blurred');
            }
            img.addEventListener('error', () => img.remove(), { once: true });
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

    // One accessible name covering both lines, plus the adult flag, so a screen
    // reader announces something useful instead of "button, Bertha, 606 tokens".
    const parts = [item.name || 'Untitled'];
    if (item.creator) {
        parts.push(`by ${item.creator}`);
    }
    if (item.nsfw) {
        parts.push('adult');
    }
    card.setAttribute('aria-label', parts.join(', '));

    return card;
}

/**
 * Sort values are whatever each API calls them — "approved_at",
 * "trending_downloads", "n_tokens". Show something readable without
 * maintaining a translation table per source.
 */
const SORT_WORDS = { n: 'number of', asc: 'ascending', desc: 'descending' };

function sortLabel(sort) {
    const words = String(sort).split(/[_\s]+/).filter(Boolean);
    const text = words.map((word) => SORT_WORDS[word] ?? word).join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** First character of a name, for the no-image tile. */
function initialOf(name) {
    const text = typeof name === 'string' ? name.trim() : '';
    return text === '' ? '?' : [...text][0].toUpperCase();
}

function describeError(error, sourceLabel) {
    switch (error?.code) {
        case 'timeout':
            return `${sourceLabel} did not respond in time. Try again.`;
        case 'rate_limited':
            return 'Too many searches — wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy — try again shortly.`;
        case 'source_down':
            return `${sourceLabel} isn’t responding.`;
        case 'http_error':
            return `${sourceLabel} returned an error.`;
        case 'too_large':
            return `${sourceLabel} sent more data than expected.`;
        case 'bad_json':
        case 'unsafe_json':
            return `${sourceLabel} sent a response this version can’t read. It may have changed its API.`;
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
