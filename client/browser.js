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
import { getSettings, updateSettings, isSourceEnabled, rememberQuery } from './settings.js';
import { createResultCache } from './cache.js';
import { showDetail } from './detail.js';
import {
    availabilityCopy,
    directRoutingNotice,
    emptyResultMessage,
    formatCount,
    formatResultCount,
    searchErrorMessage,
    sortLabel,
    unreachableReason,
} from './copy.js';
import { buildFilters } from './filters.js';
import { PROTOCOL_VERSION, VERSION, MAX_FANOUT } from '../shared/schema.js';

/**
 * The value of the synthetic "All sources" entry in the picker.
 *
 * Not a source id: no adapter answers to it, and the server is never sent it.
 * A merged search sends the real ids in `sources`.
 */
const ALL_SOURCES = '__all__';

/** How long to wait after the last keystroke before searching. */
const TYPEAHEAD_DELAY_MS = 500;

/** Shorter than this and a search matches most of the catalogue anyway. */
const MIN_TYPEAHEAD_LENGTH = 3;

/**
 * Builds the pseudo-source that stands for a merged search.
 *
 * Its capabilities are the INTERSECTION of the sources behind it, not the union.
 * A sort or a filter that only some of them honour would quietly apply to part
 * of the list, which is exactly the kind of silent half-filtering the per-source
 * controls exist to avoid.
 */
function mergedSourceEntry(usable) {
    const members = usable.slice(0, MAX_FANOUT);
    return {
        id: ALL_SOURCES,
        label: 'All sources',
        merged: members,
        clientHosts: [...new Set(members.flatMap((entry) => entry.clientHosts ?? []))],
        capabilities: {
            search: true,
            paging: 'cursor',
            sorts: [],
            sfwToggle: members.every((entry) => entry.capabilities?.sfwToggle === true),
            hideAiToggle: false,
            detail: true,
            filters: [],
        },
    };
}

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
        filtersToggle: root.querySelector('#sbbs_filters_toggle'),
        filtersBadge: root.querySelector('#sbbs_filters_badge'),
        filters: root.querySelector('#sbbs_filters'),
        filterFields: root.querySelector('#sbbs_filter_fields'),
        filtersClear: root.querySelector('#sbbs_filters_clear'),
        count: root.querySelector('#sbbs_count'),
        state: root.querySelector('#sbbs_state'),
        partial: root.querySelector('#sbbs_partial'),
        queryHistory: root.querySelector('#sbbs_query_history'),
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
        /** Per-source filter panel handle; null when the source declares none. */
        filters: null,
        /** Answers to questions already asked, so toggling a control is free. */
        cache: createResultCache(),
        /** Pending as-you-type search. */
        typingTimer: null,
    };

    // "All sources" is a synthetic entry, not a source. It is only worth
    // offering when there is more than one thing to merge.
    if (usable.length > 1) {
        const option = document.createElement('option');
        option.value = ALL_SOURCES;
        setText(option, `All sources (${Math.min(usable.length, MAX_FANOUT)})`);
        dom.source.append(option);
    }
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
        const next = dom.source.value === ALL_SOURCES
            ? mergedSourceEntry(usable)
            : usable.find((entry) => entry.id === dom.source.value);
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

    dom.filtersToggle.addEventListener('click', () => {
        const open = dom.filters.hidden;
        dom.filters.hidden = !open;
        dom.filtersToggle.setAttribute('aria-expanded', String(open));
    });
    dom.filtersClear.addEventListener('click', () => {
        if (state.filters?.count() === 0) {
            return;
        }
        state.filters?.clear();
        updateFilterBadge();
        void runSearch({ append: false });
    });

    dom.form.addEventListener('submit', (event) => {
        event.preventDefault();
        clearTimeout(state.typingTimer);
        rememberQuery(dom.query.value);
        refreshQueryHistory();
        void runSearch({ append: false });
    });

    /**
     * Searches while typing, but slowly.
     *
     * Long enough that an ordinary phrase is one request rather than a dozen —
     * the per-user budget is 30 searches a minute and a card site should not be
     * asked a question per keystroke — and short enough that the grid follows
     * along. Submitting still works and skips the wait.
     */
    dom.query.addEventListener('input', () => {
        clearTimeout(state.typingTimer);
        const value = dom.query.value.trim();
        // Below this a search is mostly noise, but clearing the box back to the
        // catalogue view is a real intent.
        if (value !== '' && value.length < MIN_TYPEAHEAD_LENGTH) {
            return;
        }
        state.typingTimer = setTimeout(() => void runSearch({ append: false }), TYPEAHEAD_DELAY_MS);
    });
    dom.more.addEventListener('click', () => void runSearch({ append: true }));

    refreshQueryHistory();

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
        // Hidden for a merged search too: the sources share no sort vocabulary,
        // so one control could not set the same thing on all of them. Each keeps
        // the sort it was last given on its own.
        dom.sort.hidden = sorts.length <= 1;

        // Never imply filtering that the source cannot actually do.
        const canFilter = state.source.capabilities?.sfwToggle === true;
        dom.sfw.disabled = !canFilter;
        setText(dom.sfwNote, canFilter ? '' : mergedSources().length > 0
            ? 'Some of these sources do not provide a reliable SFW filter.'
            : `${state.source.label} does not provide a reliable SFW filter.`);
        if (canFilter) {
            dom.sfw.removeAttribute('aria-describedby');
        } else {
            dom.sfw.setAttribute('aria-describedby', 'sbbs_sfw_note');
        }

        dom.hideAiControl.hidden = state.source.capabilities?.hideAiToggle !== true;

        // Filters are per source and are not carried across a source change:
        // "tags" on one site does not mean the same thing on another, and a
        // silently-kept filter would explain a suddenly empty grid badly.
        const declared = state.source.capabilities?.filters ?? [];
        state.filters = declared.length > 0
            ? buildFilters(dom.filterFields, declared, onFilterChange)
            : null;
        dom.filtersToggle.hidden = declared.length === 0;
        if (declared.length === 0) {
            dom.filters.hidden = true;
            dom.filtersToggle.setAttribute('aria-expanded', 'false');
            dom.filterFields.replaceChildren();
        }
        updateFilterBadge();
    }

    /** The real sources behind the current selection, or [] when it is one source. */
    function mergedSources() {
        return Array.isArray(state.source.merged) ? state.source.merged : [];
    }

    /** Resolves a result's own source, which in a merged search is not the selection. */
    function sourceOf(item) {
        return usable.find((entry) => entry.id === item?.source) ?? state.source;
    }

    function onFilterChange() {
        updateFilterBadge();
        void runSearch({ append: false });
    }

    /** Shows how many filters are active, so a collapsed panel is not a trap. */
    function updateFilterBadge() {
        const active = state.filters?.count() ?? 0;
        dom.filtersBadge.hidden = active === 0;
        setText(dom.filtersBadge, String(active));
        dom.filtersClear.disabled = active === 0;
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
        // Read once and reuse for the request and the empty-result message, so
        // the two cannot disagree about what was asked for.
        const filters = state.filters?.read() ?? {};

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

        const members = mergedSources();
        const body = {
            query,
            limit: getSettings().resultsPerPage,
            cursor,
            filters: {
                sfwOnly: dom.sfw.checked,
                hideAi: source.capabilities?.hideAiToggle === true && dom.hideAi.checked,
                ...filters,
            },
        };

        if (members.length > 0) {
            body.sources = members.map((entry) => entry.id);
            // Each source keeps its own saved sort; there is no vocabulary they
            // share, so there is nothing sensible for one control to set.
            const saved = getSettings().sortBySource;
            body.sorts = Object.fromEntries(members.map((entry) => [
                entry.id,
                saved[entry.id] ?? entry.capabilities?.sorts?.[0],
            ]));
        } else {
            body.source = source.id;
            body.sort = sort;
        }

        try {
            // A control that was just toggled asks a question already answered.
            const cached = state.cache.get(body);
            const result = cached ?? await postRouted('/search', body, source, {
                signal: controller.signal,
                // A merged search has no single source to reroute, and the
                // per-source failures it reports are handled below instead.
                allowDirect: members.length === 0 && getSettings().allowDirectRequests,
                onDirect: (reason) => noteDirectRouting(source, reason),
            });

            if (state.disposed || generation !== state.requestGeneration) {
                return;
            }

            if (!cached) {
                state.cache.set(body, result);
            }

            clearSkeletons();

            const items = Array.isArray(result.items) ? result.items : [];
            const fresh = items.filter((item) => {
                // Keyed by the item's OWN source, which in a merged search is
                // not the selection.
                const key = `${item?.source ?? source.id}:${String(item?.id ?? '')}`;
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
                setText(dom.state, emptyResultMessage(source.label, query, Object.keys(filters).length));
            } else {
                setText(dom.state, '');
            }

            // Which sources in a merged search did not answer. Stated rather
            // than hidden: a short list of results has a reason, and silently
            // dropping a site would look like it simply had nothing.
            showPartialFailures(Array.isArray(result.partial) ? result.partial : []);

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

    /** Refills the previous-searches dropdown attached to the query box. */
    function refreshQueryHistory() {
        dom.queryHistory.replaceChildren();
        for (const entry of getSettings().queryHistory) {
            const option = document.createElement('option');
            // A datalist option's VALUE is what gets inserted, and setting it as
            // an attribute rather than as text keeps it out of the markup path.
            option.value = entry;
            dom.queryHistory.append(option);
        }
    }

    /** Names the sources a merged search could not reach, or clears the notice. */
    function showPartialFailures(partial) {
        dom.partial.replaceChildren();
        if (partial.length === 0) {
            dom.partial.hidden = true;
            return;
        }

        dom.partial.hidden = false;
        for (const entry of partial) {
            const label = usable.find((item) => item.id === entry?.source)?.label ?? entry?.source;
            setText(
                dom.partial.appendChild(el('div', 'sbbs-partial-line')),
                searchErrorMessage({ code: entry?.error }, label),
            );
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

    function appendCards(items, selection) {
        const settingsNow = getSettings();
        const merged = mergedSources().length > 0;
        for (const item of items) {
            // In a merged search each card belongs to its own source: that is
            // what supplies its image hosts, its filters and its importer.
            const source = merged ? sourceOf(item) : selection;
            const { card, open, tags } = buildCard(item, source, settingsNow, merged);
            records.set(open, { item, source });

            // Clicking a tag narrows the search instead of opening the card.
            // Only offered when the source declares a tag filter, so it never
            // looks like it should work and then does nothing.
            for (const { button, tag } of tags) {
                button.addEventListener('click', () => {
                    if (state.filters?.set('tags', tag)) {
                        dom.filters.hidden = false;
                        dom.filtersToggle.setAttribute('aria-expanded', 'true');
                        onFilterChange();
                    }
                });
            }

            open.addEventListener('click', () => {
                const record = records.get(open);
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
                    if (open.isConnected) {
                        open.focus();
                    }
                }, {
                    signal: detailController.signal,
                    // Filtering from the detail pane only makes sense back in
                    // the grid, so it returns there rather than leaving the user
                    // on a card while the results behind it change.
                    onTag: (tag) => {
                        if (!state.filters?.set('tags', tag)) {
                            return;
                        }
                        detailController.abort();
                        state.detailController = null;
                        dom.root.dataset.view = 'grid';
                        dom.detail.replaceChildren();
                        dom.filters.hidden = false;
                        dom.filtersToggle.setAttribute('aria-expanded', 'true');
                        onFilterChange();
                    },
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
        clearTimeout(state.typingTimer);
        state.searchController?.abort();
        state.detailController?.abort();
        // Cached pages hold listing text from adult catalogues. They live as long
        // as the dialog and no longer.
        state.cache.clear();
    };
}

/**
 * Builds one result card.
 *
 * The card is a container rather than a single button because the tags inside
 * it are their own buttons, and a button inside a button is neither valid nor
 * reachable by keyboard. `open` is the primary action and carries the card's
 * accessible name; the tags are siblings of it.
 *
 * @param {any} item
 * @param {{ label: string, clientHosts: string[], capabilities?: any }} source
 * @param {ReturnType<typeof getSettings>} settings
 * @param {boolean} showSource whether results came from more than one site
 * @returns {{ card: HTMLElement, open: HTMLButtonElement, tags: {button: HTMLElement, tag: string}[] }}
 */
function buildCard(item, source, settings, showSource = false) {
    const card = el('div', 'sbbs-card');

    const open = el('button', 'sbbs-card-open');
    open.type = 'button';

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

    // Which site a result came from only matters when they are mixed together.
    if (showSource) {
        figure.append(el('span', 'sbbs-card-source', source.label ?? item.source ?? ''));
    }

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

    // The source's own one-line summary. Already fetched and normalized, and the
    // single most useful thing for telling two similarly-named cards apart.
    if (typeof item.tagline === 'string' && item.tagline.trim() !== '') {
        meta.append(el('div', 'sbbs-card-tagline', item.tagline.trim()));
    }

    const popularity = popularityOf(item);
    if (popularity !== '') {
        meta.append(el('div', 'sbbs-card-stats', popularity));
    }

    open.append(figure, meta);
    open.title = item.name || '';

    // One accessible name covers the whole card, so the tagline and stats are
    // not read out twice.
    const parts = [item.name || 'Untitled'];
    if (item.creator) {
        parts.push(`by ${item.creator}`);
    }
    if (showSource && source.label) {
        parts.push(`on ${source.label}`);
    }
    parts.push(rating.accessible);
    open.setAttribute('aria-label', parts.join(', '));

    card.append(open);

    const tags = buildCardTags(item, source, card);
    return { card, open, tags };
}

/** Up to four tags, as filter buttons where the source supports tag filtering. */
function buildCardTags(item, source, card) {
    const list = Array.isArray(item.tags)
        ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 4)
        : [];
    if (list.length === 0) {
        return [];
    }

    const canFilter = (source.capabilities?.filters ?? []).some((filter) => filter.key === 'tags');
    const row = el('div', 'sbbs-card-tags');
    const handles = [];

    for (const tag of list) {
        if (!canFilter) {
            // Still worth showing; just not clickable, because on this source
            // clicking could not do anything.
            row.append(el('span', 'sbbs-card-tag', tag));
            continue;
        }
        const button = el('button', 'sbbs-card-tag sbbs-card-tag-button', tag);
        button.type = 'button';
        button.setAttribute('aria-label', `Filter by tag ${tag}`);
        row.append(button);
        handles.push({ button, tag });
    }

    card.append(row);
    return handles;
}

/**
 * The popularity figures a source reported, and only those.
 *
 * Sources count different things under the same names — Chub's "downloads" is
 * its star count — so each is labelled rather than shown as a bare number, and
 * a figure the source did not report is omitted rather than shown as zero.
 */
function popularityOf(item) {
    const stats = item?.stats;
    const parts = [];
    if (stats?.downloads) {
        parts.push(formatCount(stats.downloads, 'download'));
    }
    if (stats?.favorites) {
        parts.push(formatCount(stats.favorites, 'favorite'));
    }
    if (stats?.views) {
        parts.push(formatCount(stats.views, 'chat'));
    }
    return parts.slice(0, 2).join(' · ');
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
