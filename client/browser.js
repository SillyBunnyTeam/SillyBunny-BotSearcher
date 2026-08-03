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
import { AVAILABILITY, getAvailability, invalidateAvailability, post, postRouted, thumbSrc } from './api.js';
import { el, setText, setImgSafe } from './render.js';
import { getSettings, updateSettings, isSourceEnabled } from './settings.js';
import { showDetail } from './detail.js';
import {
    availabilityCopy,
    directRoutingNotice,
    formatCount,
    formatResultCount,
    searchErrorMessage,
    sortLabel,
    unreachableReason,
} from './copy.js';
import { PROTOCOL_VERSION, VERSION } from '../shared/schema.js';

let openingPromise = null;

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {{ query?: string }} [options]
 */
export function openBrowser(options = {}) {
    if (openingPromise) {
        return openingPromise;
    }
    openingPromise = openBrowserOnce(options).finally(() => {
        openingPromise = null;
    });
    return openingPromise;
}

async function openBrowserOnce(options) {

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
    let dispose = () => {};
    const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: false,
        okButton: false,
        cancelButton: 'Close',
        onClose: () => {
            dispose();
        },
    });
    popup.dlg.setAttribute('aria-label', 'Find cards online');

    const closed = popup.show();

    if (connected) {
        dispose = wireBrowser(popup, availability.health, options);
    } else {
        wireInstallPanel(popup, availability);
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
        form: root.querySelector('#sbbs_search_form'),
        bar: root.querySelector('.sbbs-bar'),
        source: root.querySelector('#sbbs_source'),
        query: root.querySelector('#sbbs_query'),
        go: root.querySelector('#sbbs_go'),
        sort: root.querySelector('#sbbs_sort'),
        sfw: root.querySelector('#sbbs_sfw'),
        sfwNote: root.querySelector('#sbbs_sfw_note'),
        hideAiControl: root.querySelector('#sbbs_hide_ai_control'),
        hideAi: root.querySelector('#sbbs_hide_ai'),
        count: root.querySelector('#sbbs_count'),
        state: root.querySelector('#sbbs_state'),
        body: root.querySelector('.sbbs-body'),
        grid: root.querySelector('#sbbs_grid'),
        more: root.querySelector('#sbbs_more'),
        detail: root.querySelector('#sbbs_detail'),
    };

    const settings = getSettings();
    const sources = Array.isArray(health?.sources) ? health.sources : [];
    const searchable = sources.filter((source) => source?.capabilities?.search);
    const enabled = searchable.filter((source) => isSourceEnabled(source, settings.enabledSources));
    const usable = enabled.filter((source) => source.state !== 'down');

    if (usable.length === 0) {
        dom.bar.hidden = true;
        if (searchable.length === 0) {
            setText(dom.state, 'The server did not report any searchable sources.');
        } else if (enabled.length === 0) {
            setText(dom.state, 'No sources are enabled. Enable one in Extensions > BotSearcher > Sources.');
        } else {
            setText(dom.state, 'Enabled sources are unavailable right now.');
        }
        return () => {};
    }

    /** Card element -> record and immutable source snapshot. */
    const records = new Map();

    const state = {
        source: usable.find((entry) => entry.id === settings.defaultSource) ?? usable[0],
        nextCursor: null,
        loading: false,
        requestGeneration: 0,
        searchController: null,
        detailController: null,
        disposed: false,
        items: [],
        itemKeys: new Set(),
        /** Sources already told the user they are being fetched by the browser. */
        directNoted: new Set(),
    };

    for (const source of usable) {
        const option = document.createElement('option');
        option.value = source.id;
        setText(option, source.label ?? source.id);
        dom.source.append(option);
    }
    dom.source.value = state.source.id;

    dom.sfw.checked = settings.sfwOnlyDefault;
    dom.hideAi.checked = settings.hideAiDefault;
    applySourceCapabilities();

    if (typeof options.query === 'string' && options.query !== '') {
        dom.query.value = options.query.slice(0, 128);
    }

    // ---- events ----

    dom.source.addEventListener('change', () => {
        const next = usable.find((entry) => entry.id === dom.source.value);
        if (!next) {
            return;
        }
        state.source = next;
        state.detailController?.abort();
        applySourceCapabilities();
        updateSettings({ defaultSource: next.id });
        void runSearch({ append: false });
    });

    dom.sort.addEventListener('change', () => {
        const latest = getSettings();
        updateSettings({ sortBySource: { ...latest.sortBySource, [state.source.id]: dom.sort.value } });
        void runSearch({ append: false });
    });
    dom.sfw.addEventListener('change', () => {
        updateSettings({ sfwOnlyDefault: dom.sfw.checked });
        void runSearch({ append: false });
    });
    dom.hideAi.addEventListener('change', () => {
        updateSettings({ hideAiDefault: dom.hideAi.checked });
        void runSearch({ append: false });
    });

    dom.form.addEventListener('submit', (event) => {
        event.preventDefault();
        void runSearch({ append: false });
    });
    dom.more.addEventListener('click', () => void runSearch({ append: true }));

    // Browsing is useful without a query. Start immediately, then leave the
    // search field focused so the user can replace the catalogue view.
    void runSearch({ append: false });
    requestAnimationFrame(() => dom.query.focus());

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
        const savedSort = getSettings().sortBySource[state.source.id];
        if (sorts.includes(savedSort)) {
            dom.sort.value = savedSort;
        }
        dom.sort.hidden = sorts.length <= 1;

        // Never imply filtering that the source cannot actually do.
        const canFilter = state.source.capabilities?.sfwToggle === true;
        dom.sfw.disabled = !canFilter;
        setText(dom.sfwNote, canFilter ? '' : `${state.source.label} does not provide a reliable SFW filter.`);
        if (canFilter) {
            dom.sfw.removeAttribute('aria-describedby');
        } else {
            dom.sfw.setAttribute('aria-describedby', 'sbbs_sfw_note');
        }

        dom.hideAiControl.hidden = state.source.capabilities?.hideAiToggle !== true;
    }

    async function runSearch({ append }) {
        if (state.disposed || (append && (state.loading || !state.nextCursor))) {
            return;
        }

        state.searchController?.abort();
        const controller = new AbortController();
        state.searchController = controller;
        const generation = ++state.requestGeneration;
        const source = state.source;
        const query = dom.query.value.trim();
        const sort = dom.sort.value;
        const cursor = append ? state.nextCursor : null;

        state.loading = true;
        dom.body?.setAttribute('aria-busy', 'true');
        dom.more.disabled = true;
        setText(dom.more, 'Load more');
        setText(dom.state, append ? `Loading more from ${source.label}...` : `Searching ${source.label}...`);

        if (!append) {
            state.nextCursor = null;
            state.items = [];
            state.itemKeys.clear();
            records.clear();
            dom.grid.replaceChildren();
            showSkeletons();
        }
        dom.more.hidden = true;

        try {
            const result = await postRouted('/search', {
                source: source.id,
                query,
                sort,
                limit: getSettings().resultsPerPage,
                cursor,
                filters: {
                    sfwOnly: dom.sfw.checked,
                    hideAi: source.capabilities?.hideAiToggle === true && dom.hideAi.checked,
                },
            }, source, {
                signal: controller.signal,
                allowDirect: getSettings().allowDirectRequests,
                onDirect: (reason) => noteDirectRouting(source, reason),
            });

            if (state.disposed || generation !== state.requestGeneration) {
                return;
            }

            clearSkeletons();

            const items = Array.isArray(result.items) ? result.items : [];
            const fresh = items.filter((item) => {
                const key = `${source.id}:${String(item?.id ?? '')}`;
                if (!item?.id || state.itemKeys.has(key)) {
                    return false;
                }
                state.itemKeys.add(key);
                return true;
            });
            state.items.push(...fresh);
            state.nextCursor = typeof result.nextCursor === 'string' && result.nextCursor !== ''
                ? result.nextCursor
                : null;

            appendCards(fresh, source);

            if (state.items.length === 0) {
                setText(dom.state, query
                    ? `No results for "${query}" on ${source.label}. Try a broader search.`
                    : `No cards are currently listed on ${source.label}.`);
            } else {
                setText(dom.state, '');
            }

            setText(dom.count, formatResultCount(state.items.length, result.total));
            dom.more.hidden = state.nextCursor === null;
        } catch (error) {
            if (error?.name === 'AbortError' || generation !== state.requestGeneration || state.disposed) {
                return;
            }
            clearSkeletons();

            if (error?.code === 'source_down') {
                retireSource(source, source.reason);
                return;
            }

            setText(dom.state, searchErrorMessage(error, source.label));
            if (append && state.items.length > 0) {
                setText(dom.more, 'Retry loading more');
                dom.more.hidden = false;
            } else {
                setText(dom.count, '');
            }
        } finally {
            if (generation === state.requestGeneration) {
                state.loading = false;
                dom.body?.setAttribute('aria-busy', 'false');
                dom.more.disabled = false;
            }
        }
    }

    /**
     * Says, once per source per session, that its requests are now coming from
     * this browser rather than from the SillyBunny server.
     *
     * This is a routing change the user did not ask for, made because the
     * alternative is the source not working at all. It changes which address the
     * card site sees, so it is stated plainly and left on screen rather than
     * announced in a toast that disappears.
     */
    function noteDirectRouting(source, reason) {
        if (state.directNoted.has(source.id)) {
            return;
        }
        state.directNoted.add(source.id);

        const notice = el('div', 'sbbs-direct-notice');
        setText(notice, directRoutingNotice(source.label, reason));
        notice.setAttribute('role', 'status');
        dom.state.after(notice);
    }

    /**
     * A source that has gone away is removed from the picker rather than left
     * to spin. The Retry clears its server-side cooldown, so a site that comes
     * back does not require a restart.
     *
     * A source the browser can still reach is never retired here — /search hands
     * back a direct plan instead of `source_down`, so this is only reached when
     * there is genuinely no path left.
     */
    function retireSource(dead, reason) {
        const index = usable.findIndex((entry) => entry.id === dead.id);
        if (index >= 0) {
            usable.splice(index, 1);
        }
        dom.source.querySelector(`option[value="${CSS.escape(dead.id)}"]`)?.remove();

        toastr.info(
            `${unreachableReason(dead.label, reason)} It has been removed from this list.`,
            'BotSearcher',
        );

        dom.grid.replaceChildren();
        records.clear();
        state.items = [];
        state.itemKeys.clear();
        state.nextCursor = null;

        if (usable.length === 0) {
            dom.bar.hidden = true;
            setText(dom.state, 'No sources are available right now.');
        } else {
            state.source = usable[0];
            dom.source.value = state.source.id;
            applySourceCapabilities();
            setText(dom.state, `Switched to ${state.source.label}.`);
            void runSearch({ append: false });
        }

        const retry = el('button', 'menu_button sbbs-retry-source', `Retry ${dead.label}`);
        retry.type = 'button';
        retry.addEventListener('click', async () => {
            retry.disabled = true;
            try {
                await post('/retry', { source: dead.id });
                invalidateAvailability();
                toastr.success(`Trying ${dead.label} again.`, 'BotSearcher');
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
        void runSearch({ append: false });
    }

    function appendCards(items, source) {
        const settingsNow = getSettings();
        for (const item of items) {
            const card = buildCard(item, source, settingsNow);
            records.set(card, { item, source });
            card.addEventListener('click', () => {
                const record = records.get(card);
                if (!record) {
                    return;
                }
                state.detailController?.abort();
                const detailController = new AbortController();
                state.detailController = detailController;
                dom.root.dataset.view = 'detail';
                void showDetail(dom.detail, record.item, record.source, () => {
                    detailController.abort();
                    state.detailController = null;
                    dom.root.dataset.view = 'grid';
                    dom.detail.replaceChildren();
                    // Return focus where it was, so keyboard and screen-reader
                    // users are not dropped back at the top of the dialog.
                    if (card.isConnected) {
                        card.focus();
                    }
                }, { signal: detailController.signal });
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
            li.setAttribute('aria-hidden', 'true');
            const shape = el('div', 'sbbs-card-img');
            shape.setAttribute('aria-hidden', 'true');
            li.append(shape);
            dom.grid.append(li);
        }
    }

    function clearSkeletons() {
        for (const node of [...dom.grid.querySelectorAll('.sbbs-skeleton')]) {
            node.remove();
        }
    }

    return () => {
        state.disposed = true;
        state.requestGeneration++;
        state.searchController?.abort();
        state.detailController?.abort();
    };
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

    const rating = ratingOf(item);
    const badge = el('span', `sbbs-rating sbbs-rating-${rating.value}`, rating.label);
    figure.append(badge);

    const src = thumbSrc(item, source, 'grid', settings.imageMode);
    if (src) {
        const img = document.createElement('img');
        img.alt = '';
        if (setImgSafe(img, src, source.clientHosts)) {
            if (rating.value !== 'sfw' && settings.blurNsfw) {
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
        sub.push(formatCount(item.stats.tokens, 'token'));
    }
    if (item.creator) {
        sub.push(item.creator);
    }
    meta.append(el('div', 'sbbs-card-sub', sub.join(' · ')));

    card.append(figure, meta);
    card.title = item.name || '';

    // One accessible name covers both lines and the content flag.
    const parts = [item.name || 'Untitled'];
    if (item.creator) {
        parts.push(`by ${item.creator}`);
    }
    parts.push(rating.accessible);
    card.setAttribute('aria-label', parts.join(', '));

    return card;
}

function ratingOf(item) {
    if (item?.contentRating === 'sfw') {
        return { value: 'sfw', label: 'SFW', accessible: 'rated SFW' };
    }
    if (item?.contentRating === 'sensitive') {
        return { value: 'sensitive', label: 'Sensitive', accessible: 'sensitive content' };
    }
    return { value: 'unknown', label: 'Unrated', accessible: 'content rating not reported' };
}

/** First character of a name, for the no-image tile. */
function initialOf(name) {
    const text = typeof name === 'string' ? name.trim() : '';
    return text === '' ? '?' : [...text][0].toUpperCase();
}

/**
 * @param {any} popup
 * @param {{ status: string, health: any }} availability
 */
function wireInstallPanel(popup, availability) {
    const root = popup.content;
    const copy = availabilityCopy(
        availability.status,
        availability.health,
        PROTOCOL_VERSION,
        VERSION,
    );
    const instructions = root.querySelector('.sbbs-install-instructions');
    const guidance = root.querySelector('.sbbs-install-guidance');

    setText(root.querySelector('.sbbs-install-title'), copy.title);
    setText(root.querySelector('.sbbs-install-lead'), copy.lead);
    instructions.hidden = !copy.showInstall;
    setText(guidance, copy.guidance);
    guidance.hidden = copy.guidance === '';

    root.querySelector('#sbbs_recheck')?.addEventListener('click', () => {
        invalidateAvailability();
        popup.complete(context().POPUP_RESULT.CANCELLED);
        setTimeout(() => {
            openBrowser().catch((error) => console.error(`[${LOG_TAG}]`, error));
        }, 250);
    });
}
