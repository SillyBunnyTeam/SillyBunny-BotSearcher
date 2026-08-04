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
import {
    AVAILABILITY,
    UPDATE_CAPABILITY,
    getAvailability,
    getServerPluginUpdateCapabilities,
    invalidateAvailability,
    post,
    postRouted,
    thumbSrc,
    updateServerPlugin,
} from './api.js';
import { el, setText, setImgSafe } from './render.js';
import { getSettings, updateSettings, isSourceEnabled, rememberQuery } from './settings.js';
import { createResultCache } from './cache.js';
import { showDetail } from './detail.js';
import {
    availabilityCopy,
    compareReleaseVersions,
    directRoutingNotice,
    emptyResultMessage,
    formatCount,
    formatResultCount,
    searchErrorMessage,
    sortLabel,
    sourceStatLine,
    serverPluginUpdateErrorMessage,
    unreachableReason,
} from './copy.js';
import { buildFilters } from './filters.js';
import { createVocabularyLoader } from './vocabulary.js';
import {
    getBotbooruAccount,
    noteBotbooruAccountError,
    subscribeBotbooruAccount,
} from './account.js';
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
 * Most capabilities are the intersection of the sources behind it. SFW is the
 * exception: when any member can enforce it, send the value and state plainly
 * that sources without a reliable filter remain outside that guarantee. Omitting
 * it would turn BotBooru into an authenticated non-SFW search while the checkbox
 * still looked enabled.
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
            sfwToggle: members.some((entry) => entry.capabilities?.sfwToggle === true),
            sfwComplete: members.every((entry) => entry.capabilities?.sfwToggle === true),
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
    let reopenAfterClose = false;
    const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: !connected,
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
        dispose = wireInstallPanel(popup, availability, () => {
            reopenAfterClose = true;
        });
    }

    await closed;
    if (reopenAfterClose) {
        setTimeout(() => {
            openBrowser().catch((error) => console.error(`[${LOG_TAG}]`, error));
        }, 0);
    }
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
        filterActions: root.querySelector('.sbbs-filter-actions'),
        count: root.querySelector('#sbbs_count'),
        state: root.querySelector('#sbbs_state'),
        partial: root.querySelector('#sbbs_partial'),
        reload: root.querySelector('#sbbs_reload'),
        queryHistory: root.querySelector('#sbbs_query_history'),
        body: root.querySelector('.sbbs-body'),
        grid: root.querySelector('#sbbs_grid'),
        more: root.querySelector('#sbbs_more'),
        detail: root.querySelector('#sbbs_detail'),
    };

    const settings = getSettings();
    const sources = Array.isArray(health?.sources) ? health.sources : [];
    const searchable = sources.filter((source) => source?.capabilities?.search);
    // Every enabled source stays in the picker, including one the server
    // currently has in cooldown. Selecting it explains why and offers a reload,
    // which is more useful than the source not being there to select.
    const usable = searchable.filter((source) => isSourceEnabled(source, settings.enabledSources));

    if (usable.length === 0) {
        dom.bar.hidden = true;
        setText(dom.state, searchable.length === 0
            ? 'The server did not report any searchable sources.'
            : 'No sources are enabled. Enable one in Extensions > BotSearcher > Sources.');
        return () => {};
    }

    /** Card element -> record and immutable source snapshot. */
    const records = new Map();

    const initialSource = settings.defaultSource === ALL_SOURCES && usable.length > 1
        ? mergedSourceEntry(usable)
        : (usable.find((entry) => entry.id === settings.defaultSource) ?? usable[0]);
    const state = {
        source: initialSource,
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
        /** Sources successfully fetched directly during this dialog only. */
        directSources: new Set(),
        /** Per-source filter panel handle; null when the source declares none. */
        filters: null,
        /** Answers to questions already asked, so toggling a control is free. */
        cache: createResultCache(),
        /** Pending as-you-type search. */
        typingTimer: null,
        /** Tag names are fetched once per source for this dialog only. */
        vocabulary: createVocabularyLoader(),
        /** Public status only. The bearer remains in the server process. */
        account: getBotbooruAccount(),
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
        // A source the server has in cooldown is still selectable, so say which
        // one it is rather than letting it look identical to a working one.
        setText(option, source.state === 'down'
            ? `${source.label ?? source.id} (unavailable)`
            : (source.label ?? source.id));
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
        updateContentControlNote();
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
        // Invalidate immediately, not after the debounce: a fetch implementation
        // can ignore abort, and its completed old response must never render for
        // the text now visible in the box.
        state.searchController?.abort();
        state.requestGeneration++;
        state.loading = false;
        dom.body?.setAttribute('aria-busy', 'false');
        dom.more.disabled = false;
        const value = dom.query.value.trim();
        // Below this a search is mostly noise, but clearing the box back to the
        // catalogue view is a real intent.
        if (value !== '' && value.length < MIN_TYPEAHEAD_LENGTH) {
            state.nextCursor = null;
            state.items = [];
            state.itemKeys.clear();
            records.clear();
            dom.grid.replaceChildren();
            dom.more.hidden = true;
            setText(dom.count, '');
            setText(dom.state, 'Keep typing to search.');
            return;
        }
        state.typingTimer = setTimeout(() => void runSearch({ append: false }), TYPEAHEAD_DELAY_MS);
    });
    dom.more.addEventListener('click', () => void runSearch({ append: true }));

    const unsubscribeAccount = subscribeBotbooruAccount((account) => {
        const previousRevision = state.account.revision;
        state.account = account;
        updateContentControlNote();
        if (account.revision === previousRevision) {
            return;
        }
        // A protected response can have been cached while another source is now
        // selected. Clear on every account revision, not only while BotBooru is
        // visible, so it cannot cross a logout or replacement login.
        state.cache.clear();
        if (!selectionUsesBotbooru()) {
            return;
        }
        if (account.error && mergedSources().length > 0) {
            removeMergedBotbooruResults(account);
            return;
        }
        resetForAccountChange(account);
    });

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
        updateContentControlNote();

        dom.hideAiControl.hidden = state.source.capabilities?.hideAiToggle !== true;

        // Filters are per source and are not carried across a source change:
        // "tags" on one site does not mean the same thing on another, and a
        // silently-kept filter would explain a suddenly empty grid badly.
        const declared = state.source.capabilities?.filters ?? [];
        state.filters = declared.length > 0
            ? buildFilters(dom.filterFields, declared, onFilterChange)
            : null;
        void loadVocabulary(state.source, state.filters);
        // The panel itself always stays reachable: it also holds the content
        // controls, which apply to every source. Only the per-source fields go,
        // and "Clear filters" with them, since it would have nothing to clear.
        if (declared.length === 0) {
            dom.filterFields.replaceChildren();
        }
        dom.filterActions.hidden = declared.length === 0;
        updateFilterBadge();
    }

    async function loadVocabulary(source, filters) {
        if (!filters || source.capabilities?.tagVocabulary !== true) {
            return;
        }
        const tags = await state.vocabulary.load(source);
        // A slow response for the previous source must not populate the newly
        // rebuilt controls, even if both sources happen to use tag filters.
        if (!state.disposed && state.source === source && state.filters === filters) {
            filters.setVocabulary(tags);
        }
    }

    /** The real sources behind the current selection, or [] when it is one source. */
    function mergedSources() {
        return Array.isArray(state.source.merged) ? state.source.merged : [];
    }

    function selectionUsesBotbooru() {
        return state.source.id === 'botbooru'
            || mergedSources().some((source) => source.id === 'botbooru');
    }

    function updateContentControlNote() {
        const canFilter = state.source.capabilities?.sfwToggle === true;
        const notes = [];
        if (!canFilter) {
            notes.push(mergedSources().length > 0
                ? 'Some of these sources do not provide a reliable SFW filter.'
                : `${state.source.label} does not provide a reliable SFW filter.`);
        } else if (dom.sfw.checked && mergedSources().length > 0
            && state.source.capabilities?.sfwComplete !== true) {
            notes.push('SFW only is enforced where a source provides a reliable filter; other sources may still include sensitive content.');
        }
        if (selectionUsesBotbooru() && !dom.sfw.checked) {
            if (!state.account.loggedIn) {
                notes.push('BotBooru requires a login under Extensions > BotSearcher for non-SFW results.');
            } else if (!state.account.nsfwEnabled) {
                notes.push('Enable NSFW for the BotBooru account under Extensions > BotSearcher.');
            } else if (state.account.nsflEnabled && state.account.nsflActive === true) {
                notes.push('NSFL is active for the BotBooru account, so non-SFW searches may include NSFL content.');
            } else if (state.account.nsflEnabled && state.account.nsflActive === null) {
                notes.push('BotBooru did not report whether NSFL is currently active, so non-SFW searches may include it.');
            }
        }
        const note = notes.join(' ');
        setText(dom.sfwNote, note);
        if (note === '') {
            dom.sfw.removeAttribute('aria-describedby');
        } else {
            dom.sfw.setAttribute('aria-describedby', 'sbbs_sfw_note');
        }
    }

    function resetForAccountChange(account) {
        const wasDetail = dom.root.dataset.view === 'detail';
        clearTimeout(state.typingTimer);
        state.searchController?.abort();
        state.detailController?.abort();
        state.searchController = null;
        state.detailController = null;
        state.requestGeneration++;
        state.loading = false;
        state.nextCursor = null;
        state.items = [];
        state.itemKeys.clear();
        state.cache.clear();
        records.clear();
        dom.body?.setAttribute('aria-busy', 'false');
        dom.grid.replaceChildren();
        dom.detail.replaceChildren();
        dom.root.dataset.view = 'grid';
        dom.more.hidden = true;
        dom.more.disabled = false;
        dom.partial.hidden = true;
        dom.partial.replaceChildren();
        setText(dom.count, '');

        if (!account.error && (!account.loggedIn || !account.nsfwEnabled) && !dom.sfw.checked) {
            // This is deliberately dialog-local. The saved default still reflects
            // what the user chose and can resume after a future login.
            dom.sfw.checked = true;
            updateContentControlNote();
        }

        if (account.error) {
            setText(dom.state, searchErrorMessage({ code: account.error }, 'BotBooru'));
            if (wasDetail && dom.query.isConnected) {
                dom.query.focus();
            }
            return;
        }
        void runSearch({ append: false });
    }

    /** Keeps valid merged results while removing cards tied to an expired account. */
    function removeMergedBotbooruResults(account) {
        const wasDetail = dom.root.dataset.view === 'detail';
        state.detailController?.abort();
        state.detailController = null;
        dom.detail.replaceChildren();
        dom.root.dataset.view = 'grid';

        for (const [open, record] of records) {
            if (record.source.id === 'botbooru') {
                open.closest('li')?.remove();
                records.delete(open);
            }
        }
        state.items = state.items.filter((item) => item?.source !== 'botbooru');
        state.itemKeys = new Set(state.items.map((item) => `${item.source}:${item.id}`));
        dom.more.hidden = state.nextCursor === null;
        dom.more.disabled = false;

        if (!account.error && (!account.loggedIn || !account.nsfwEnabled) && !dom.sfw.checked) {
            dom.sfw.checked = true;
            updateContentControlNote();
        }
        setText(dom.count, formatResultCount(state.items.length, null));
        if (wasDetail && dom.query.isConnected) {
            dom.query.focus();
        }
    }

    /** Resolves a result's own source, which in a merged search is not the selection. */
    function sourceOf(item) {
        const candidates = mergedSources();
        const allowed = candidates.length > 0 ? candidates : [state.source];
        return allowed.find((entry) => entry.id === item?.source) ?? null;
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
        hideSourceFailure();
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
        const requestFilters = {
            ...filters,
            hideAi: source.capabilities?.hideAiToggle === true && dom.hideAi.checked,
        };
        if (source.capabilities?.sfwToggle === true) {
            requestFilters.sfwOnly = dom.sfw.checked;
        }
        const body = {
            query,
            limit: getSettings().resultsPerPage,
            cursor,
            filters: requestFilters,
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
                onDirect: (reason) => useDirectRouting(source, reason),
            });

            if (state.disposed || generation !== state.requestGeneration) {
                return;
            }

            const partial = Array.isArray(result.partial) ? result.partial : [];
            if (!cached && partial.length === 0) {
                state.cache.set(body, result);
            }

            clearSkeletons();

            const items = Array.isArray(result.items) ? result.items : [];
            const fresh = items.filter((item) => {
                const itemSource = sourceOf(item);
                // Keyed by the item's OWN source, which in a merged search is
                // not the selection.
                if (!itemSource || typeof item?.id !== 'string' || item.id === '') {
                    return false;
                }
                const key = `${itemSource.id}:${item.id}`;
                if (state.itemKeys.has(key)) {
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
            showPartialFailures(partial);

            setText(dom.count, formatResultCount(state.items.length, result.total));
            dom.more.hidden = state.nextCursor === null;
        } catch (error) {
            if (error?.name === 'AbortError' || generation !== state.requestGeneration || state.disposed) {
                return;
            }
            clearSkeletons();

            // The server is in cooldown for this source, so re-searching would
            // be answered without it trying. Offer the reload that clears it.
            if (error?.code === 'source_down') {
                showSourceFailure(source, source.reason);
                return;
            }

            if (source.id === 'botbooru' && noteBotbooruAccountError(error)) {
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
            if (entry?.source === 'botbooru') {
                noteBotbooruAccountError({ code: entry?.error });
            }
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
     * announced in a toast that disappears. The user can dismiss the disclosure
     * after reading it without changing the routing decision.
     */
    function noteDirectRouting(source, reason) {
        if (state.directNoted.has(source.id)) {
            return;
        }
        state.directNoted.add(source.id);

        const notice = el('div', 'sbbs-direct-notice');
        const message = el('span', 'sbbs-direct-notice-text');
        setText(message, directRoutingNotice(source.label, reason));
        message.setAttribute('role', 'status');

        const dismiss = document.createElement('button');
        dismiss.className = 'sbbs-direct-notice-dismiss';
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', 'Dismiss direct routing notice');
        dismiss.title = 'Dismiss direct routing notice';

        const icon = el('i', 'fa-solid fa-xmark');
        icon.setAttribute('aria-hidden', 'true');
        dismiss.append(icon);
        dismiss.addEventListener('click', () => {
            // Keep directNoted intact: closing the disclosure does not turn off
            // the route or make the same notice reappear during this dialog.
            notice.remove();
        });

        notice.append(message, dismiss);
        dom.state.after(notice);
    }

    function useDirectRouting(source, reason) {
        state.directSources.add(source.id);
        noteDirectRouting(source, reason);
    }

    /**
     * Reports a source that could not be reached, and offers to try it again.
     *
     * The source stays selected and stays in the picker. It used to be removed,
     * which meant a site having a bad minute disappeared from the list and the
     * dialog silently switched to a different one — so the results on screen
     * were from somewhere the user had not chosen, and getting back needed a
     * button that appeared somewhere else.
     *
     * The server-side cooldown is the reason a plain re-search would not help:
     * while a source is in cooldown the server answers immediately without
     * trying. Reload clears that first, then searches again.
     */
    function showSourceFailure(dead, reason) {
        dom.grid.replaceChildren();
        records.clear();
        state.items = [];
        state.itemKeys.clear();
        state.nextCursor = null;
        dom.more.hidden = true;
        setText(dom.count, '');
        setText(dom.state, `${unreachableReason(dead.label, reason)} It is still in the list.`);

        // Rebuilt each time rather than accumulating one per failed attempt.
        dom.reload.replaceChildren();
        dom.reload.hidden = false;

        const reload = el('button', 'menu_button sbbs-reload-source');
        reload.type = 'button';
        setText(reload, `Reload ${dead.label}`);
        reload.addEventListener('click', async () => {
            reload.disabled = true;
            setText(reload, `Reloading ${dead.label}...`);
            try {
                await post('/retry', { source: dead.id });
                invalidateAvailability();
            } catch {
                // The cooldown could not be cleared, but the search below still
                // reports what happened, so there is nothing extra to say here.
            }
            if (state.disposed) {
                return;
            }
            dom.reload.hidden = true;
            dom.reload.replaceChildren();
            void runSearch({ append: false });
        });

        dom.reload.append(reload);
    }

    /** Clears the reload prompt once a search is under way again. */
    function hideSourceFailure() {
        if (!dom.reload.hidden) {
            dom.reload.hidden = true;
            dom.reload.replaceChildren();
        }
    }

    function appendCards(items, selection) {
        const settingsNow = getSettings();
        const merged = mergedSources().length > 0;
        for (const item of items) {
            // In a merged search each card belongs to its own source: that is
            // what supplies its image hosts, its filters and its importer.
            const source = merged ? sourceOf(item) : selection;
            if (!source) {
                continue;
            }
            const { card, open, tags } = buildCard(
                item,
                source,
                settingsNow,
                merged,
                state.directSources.has(source.id),
            );
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
                    onDirect: (reason) => useDirectRouting(record.source, reason),
                    isSourceDirect: (sourceId) => state.directSources.has(sourceId),
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
        state.vocabulary.clear();
        unsubscribeAccount();
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
 * @param {boolean} sourceDirect whether this dialog fetched the source directly
 * @returns {{ card: HTMLElement, open: HTMLButtonElement, tags: {button: HTMLElement, tag: string}[] }}
 */
function buildCard(item, source, settings, showSource = false, sourceDirect = false) {
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

    const src = thumbSrc(item, source, 'grid', settings.imageMode, sourceDirect);
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

    // Source, popularity and content rating share the card's last line. On a
    // wide screen CSS lifts the rating and the source chip back onto the
    // thumbnail; in the narrow list layout the thumbnail is far too small to
    // carry either legibly, and the content rating has to stay readable.
    const footer = el('div', 'sbbs-card-footer');

    // Which site a result came from only matters when they are mixed together.
    if (showSource) {
        footer.append(el('span', 'sbbs-card-source', source.label ?? item.source ?? ''));
    }

    const popularity = popularityOf(item, source.id);
    if (popularity !== '') {
        footer.append(el('div', 'sbbs-card-stats', popularity));
    }

    footer.append(el('span', `sbbs-rating sbbs-rating-${rating.value}`, rating.label));
    meta.append(footer);

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

    const tags = buildCardTags(item, source, card, !showSource);
    return { card, open, tags };
}

/** Up to four tags, as filter buttons where the source supports tag filtering. */
function buildCardTags(item, source, card, allowFilter) {
    const list = Array.isArray(item.tags)
        ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 4)
        : [];
    if (list.length === 0) {
        return [];
    }

    const canFilter = allowFilter && (source.capabilities?.filters ?? []).some((filter) => filter.key === 'tags');
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
function popularityOf(item, sourceId) {
    return sourceStatLine(sourceId, item?.stats);
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
 * @param {() => void} requestReopen
 */
function wireInstallPanel(popup, availability, requestReopen) {
    const root = popup.content;
    const instructions = root.querySelector('.sbbs-install-instructions');
    const manualUpdate = root.querySelector('.sbbs-update-instructions');
    const guidance = root.querySelector('.sbbs-install-guidance');
    const update = root.querySelector('#sbbs_update_plugin');
    const recheck = root.querySelector('#sbbs_recheck');
    const status = root.querySelector('.sbbs-install-update-status');
    const capabilityController = new AbortController();
    let closed = false;

    for (const tag of root.querySelectorAll('.sbbs-release-tag')) {
        setText(tag, `v${VERSION}`);
    }

    const render = (capabilityStatus = '') => {
        const copy = availabilityCopy(
            availability.status,
            availability.health,
            PROTOCOL_VERSION,
            VERSION,
            capabilityStatus,
        );
        setText(root.querySelector('.sbbs-install-title'), copy.title);
        setText(root.querySelector('.sbbs-install-lead'), copy.lead);
        instructions.hidden = !copy.showInstall;
        manualUpdate.hidden = !copy.showManualUpdate;
        update.hidden = !copy.showUpdate;
        setText(guidance, copy.guidance);
        guidance.hidden = copy.guidance === '';
    };
    render();

    const serverIsOlder = compareReleaseVersions(availability.health?.version, VERSION) === -1;
    if (availability.status === AVAILABILITY.PROTOCOL_MISMATCH && serverIsOlder) {
        getServerPluginUpdateCapabilities({ signal: capabilityController.signal }).then((capability) => {
            if (closed) {
                return;
            }
            const toolingMissing = capability.capabilities
                && (capability.capabilities.tooling?.git === false || capability.capabilities.tooling?.npm === false);
            const effectiveStatus = toolingMissing ? UPDATE_CAPABILITY.UNAVAILABLE : capability.status;
            render(effectiveStatus);
            const messages = {
                [UPDATE_CAPABILITY.FORBIDDEN]: 'Automatic updates require a SillyBunny administrator. Stop SillyBunny completely before using the manual commands below.',
                [UPDATE_CAPABILITY.DISABLED]: 'Server plugins are disabled in config.yaml. Enable them, then stop SillyBunny completely before using the manual commands.',
                [UPDATE_CAPABILITY.LEGACY]: 'This legacy SillyBunny host has no automatic updater. Stop it completely before using the manual commands below.',
                [UPDATE_CAPABILITY.UNSUPPORTED]: 'This host updater does not provide the required exact-release and safe-restart guarantees. Manual replacement is not offered.',
                [UPDATE_CAPABILITY.UNAVAILABLE]: toolingMissing
                    ? 'Automatic and manual updates require both Git and npm on the SillyBunny host.'
                    : 'Automatic updating is unavailable on this host. Check the SillyBunny logs before updating manually.',
            };
            if (messages[effectiveStatus]) {
                setText(status, messages[effectiveStatus]);
                status.hidden = false;
            }
        }).catch((error) => {
            if (closed) {
                return;
            }
            if (error?.name !== 'AbortError') {
                console.debug(`[${LOG_TAG}] update capability check failed:`, error);
                render(UPDATE_CAPABILITY.UNAVAILABLE);
                setText(status, 'Automatic updating could not be verified. Check the SillyBunny logs before updating manually.');
                status.hidden = false;
            }
        });
    }

    update?.addEventListener('click', async () => {
        if (closed) {
            return;
        }
        update.disabled = true;
        recheck.disabled = true;
        status.hidden = false;
        try {
            const phases = {
                staging: `Installing server plugin v${VERSION}...`,
                restarting: 'Release installed. Waiting for SillyBunny to restart...',
                verifying: 'SillyBunny is back. Verifying the server plugin...',
                complete: `Server plugin v${VERSION} is ready.`,
            };
            await updateServerPlugin({
                onPhase: (phase) => {
                    if (!closed) {
                        setText(status, phases[phase] ?? 'Updating server plugin...');
                    }
                },
            });
            if (closed) {
                return;
            }
            requestReopen();
            popup.complete(context().POPUP_RESULT.CANCELLED);
        } catch (error) {
            if (closed || error?.name === 'AbortError') {
                return;
            }
            setText(status, serverPluginUpdateErrorMessage(error));
            manualUpdate.hidden = true;
            update.disabled = false;
            recheck.disabled = false;
        }
    });

    recheck?.addEventListener('click', () => {
        invalidateAvailability();
        requestReopen();
        popup.complete(context().POPUP_RESULT.CANCELLED);
    });

    return () => {
        closed = true;
        capabilityController.abort();
    };
}
