/**
 * Extension settings.
 *
 * Everything is re-clamped on read with the same discipline the server uses on
 * requests, so a hand-edited settings.json cannot inject an unknown source id or
 * an absurd page size. No secret is ever stored here; this extension needs no
 * credentials for any source, and deliberately does not implement the API-key
 * features some sites offer.
 *
 * The panel is built with createElement rather than from a template, so that
 * client/ contains no HTML parsing of any kind. The only HTML this extension
 * turns into DOM is a static template handed to Popup, which does the insertion
 * itself.
 */

import { SETTINGS_KEY, DOM_IDS, EXTENSION_NAME } from './constants.js';
import { IMAGE_MODES } from '../shared/schema.js';
import { el, setText } from './render.js';
import { getAvailability } from './api.js';

const PAGE_SIZES = [12, 24, 48];

const AVAILABLE_IMAGE_MODES = IMAGE_MODES;

const IMAGE_MODE_LABELS = {
    proxy: 'Through SillyBunny server (image host sees the server IP)',
    direct: 'Direct from card site (image host sees the browser connection)',
    off: 'No thumbnails',
};

/** Sources above this tier are opt-in: they work, but are narrow or unreliable. */
export const DEFAULT_MAX_TIER = 2;

const DEFAULTS = Object.freeze({
    /** null means "whatever is tier <= DEFAULT_MAX_TIER"; an array is an explicit choice. */
    enabledSources: null,
    defaultSource: 'botbooru',
    sfwOnlyDefault: true,
    hideAiDefault: false,
    blurNsfw: true,
    // Avoid direct browser connections to image hosts by default.
    imageMode: 'proxy',
    resultsPerPage: 24,
    sortBySource: Object.freeze({}),
    showTrustPanel: true,
    /**
     * Allow requests for a source to move to this browser when the server is
     * blocked from reaching it. On by default because the alternative is the
     * source silently disappearing, which is what it used to do; the switch is
     * always announced in the browse dialog when it happens.
     */
    allowDirectRequests: true,
    /** Most recent first. Search terms only — never a card name or a filter. */
    queryHistory: Object.freeze([]),
    _v: 3,
});

/** Enough to be useful as a dropdown, few enough to stay scannable. */
export const MAX_QUERY_HISTORY = 20;

/** Search terms are user text, so they are capped like any other stored string. */
const MAX_QUERY_LENGTH = 128;

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * Reads settings, repairing anything out of range, so no caller has to re-check.
 */
export function getSettings() {
    const store = context().extensionSettings;
    const raw = store && typeof store === 'object' && Object.prototype.hasOwnProperty.call(store, SETTINGS_KEY)
        ? store[SETTINGS_KEY]
        : null;
    const source = raw && typeof raw === 'object' ? raw : {};
    const read = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);

    const enabled = read('enabledSources');
    const rawSorts = read('sortBySource');
    const sortBySource = Object.create(null);
    if (rawSorts && typeof rawSorts === 'object' && !Array.isArray(rawSorts)) {
        for (const [sourceId, sort] of Object.entries(rawSorts)) {
            if (/^[a-z0-9-]{1,64}$/.test(sourceId) && typeof sort === 'string') {
                sortBySource[sourceId] = sort.slice(0, 32);
            }
        }
    } else if (typeof read('sortDefault') === 'string') {
        // v1 stored one global sort. Preserve it for the source it belonged to.
        const sourceId = typeof read('defaultSource') === 'string'
            ? read('defaultSource').slice(0, 64)
            : DEFAULTS.defaultSource;
        if (/^[a-z0-9-]{1,64}$/.test(sourceId)) {
            sortBySource[sourceId] = read('sortDefault').slice(0, 32);
        }
    }

    return {
        enabledSources: Array.isArray(enabled)
            ? enabled.filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id))
            : null,
        defaultSource: typeof read('defaultSource') === 'string' ? read('defaultSource').slice(0, 64) : DEFAULTS.defaultSource,
        sfwOnlyDefault: read('sfwOnlyDefault') !== false,
        hideAiDefault: read('hideAiDefault') === true,
        blurNsfw: read('blurNsfw') !== false,
        imageMode: AVAILABLE_IMAGE_MODES.includes(read('imageMode')) ? read('imageMode') : DEFAULTS.imageMode,
        resultsPerPage: PAGE_SIZES.includes(read('resultsPerPage')) ? read('resultsPerPage') : DEFAULTS.resultsPerPage,
        sortBySource: { ...sortBySource },
        showTrustPanel: read('showTrustPanel') !== false,
        allowDirectRequests: read('allowDirectRequests') !== false,
        queryHistory: Array.isArray(read('queryHistory'))
            ? read('queryHistory')
                .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
                .map((entry) => entry.slice(0, MAX_QUERY_LENGTH))
                .slice(0, MAX_QUERY_HISTORY)
            : [],
        _v: DEFAULTS._v,
    };
}

/**
 * Records a search term, most recent first, without duplicates.
 *
 * Only called for a search the user actually submitted, so the catalogue view
 * that runs on open never lands here and the list stays a record of what they
 * asked for rather than of what the dialog did.
 *
 * @param {string} query
 */
export function rememberQuery(query) {
    const trimmed = typeof query === 'string' ? query.trim().slice(0, MAX_QUERY_LENGTH) : '';
    if (trimmed === '') {
        return;
    }

    const previous = getSettings().queryHistory;
    // Case-insensitive dedupe, but the newest spelling is what gets kept.
    const rest = previous.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase());
    updateSettings({ queryHistory: [trimmed, ...rest].slice(0, MAX_QUERY_HISTORY) });
}

export function clearQueryHistory() {
    updateSettings({ queryHistory: [] });
}

/**
 * Whether a source should appear in the picker.
 *
 * With no explicit choice saved, tier decides: tiers 0-2 are sources with a
 * real catalogue and a stable API, tier 3 is everything narrow or fragile
 * enough that it should be asked for rather than assumed.
 *
 * @param {{ id: string, tier: number }} source
 * @param {string[] | null} enabledSources
 */
export function isSourceEnabled(source, enabledSources) {
    if (Array.isArray(enabledSources)) {
        return enabledSources.includes(source.id);
    }
    return typeof source.tier === 'number' && source.tier <= DEFAULT_MAX_TIER;
}

/**
 * @param {Partial<ReturnType<typeof getSettings>>} patch
 */
export function updateSettings(patch) {
    const ctx = context();
    ctx.extensionSettings[SETTINGS_KEY] = { ...getSettings(), ...patch };
    ctx.saveSettingsDebounced();
    return getSettings();
}

/**
 * Mounts the settings drawer.
 *
 * Both the unique id and data-extension-name matter: SillyBunny watches
 * #extensions_settings with a MutationObserver and silently removes any block
 * whose dedupe key collides with an existing one
 * (public/scripts/extensions.js:890-963).
 */
export async function mountSettings() {
    if (document.getElementById(DOM_IDS.settingsRoot)) {
        return;
    }

    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }

    const container = el('div', 'extension_container');
    container.id = DOM_IDS.settingsRoot;
    container.dataset.extensionName = EXTENSION_NAME;

    const drawer = el('div', 'inline-drawer');
    const header = el('button', 'inline-drawer-toggle inline-drawer-header sbbs-settings-toggle');
    header.type = 'button';
    header.setAttribute('aria-expanded', 'false');
    header.setAttribute('aria-controls', 'sbbs_settings_content');
    header.append(el('b', undefined, 'BotSearcher'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));

    const content = el('div', 'inline-drawer-content sbbs-settings');
    content.id = 'sbbs_settings_content';
    const settings = getSettings();

    content.append(
        checkbox('sbbs_set_sfw', 'Request SFW results by default', settings.sfwOnlyDefault, (v) => updateSettings({ sfwOnlyDefault: v })),
        checkbox('sbbs_set_hide_ai', 'Hide AI-generated cards when the source supports it', settings.hideAiDefault, (v) => updateSettings({ hideAiDefault: v })),
        checkbox('sbbs_set_blur', 'Blur sensitive and unrated thumbnails until revealed', settings.blurNsfw, (v) => updateSettings({ blurNsfw: v })),
        checkbox('sbbs_set_trust', 'Show the Card contents panel', settings.showTrustPanel, (v) => updateSettings({ showTrustPanel: v })),
        checkbox(
            'sbbs_set_direct',
            'Request a source from this browser when the server cannot reach it',
            settings.allowDirectRequests,
            (v) => updateSettings({ allowDirectRequests: v }),
            'Some sites refuse connections from servers but not from home connections. With this off, such a source is removed from the list instead. With it on, the site sees your browser’s address rather than the server’s.',
        ),
        select(
            'sbbs_set_images',
            'Thumbnails',
            AVAILABLE_IMAGE_MODES.map((mode) => ({ value: mode, label: IMAGE_MODE_LABELS[mode] ?? mode })),
            settings.imageMode,
            (v) => updateSettings({ imageMode: v }),
        ),
        select(
            'sbbs_set_perpage',
            'Results per page',
            PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) })),
            String(settings.resultsPerPage),
            (v) => updateSettings({ resultsPerPage: Number(v) }),
        ),
        historyControl(),
    );

    drawer.append(header, content);
    container.append(drawer);
    host.append(container);

    const syncExpanded = () => header.setAttribute('aria-expanded', String(content.getClientRects().length > 0));
    header.addEventListener('click', () => requestAnimationFrame(syncExpanded));
    requestAnimationFrame(syncExpanded);

    // Source list comes from the server, so it stays correct as adapters are
    // added. Appended after mounting so a missing plugin does not block the
    // rest of the panel.
    try {
        const { health } = await getAvailability();
        const sources = Array.isArray(health?.sources) ? health.sources : [];
        if (sources.length > 0) {
            content.prepend(sourceList(sources));
        }
    } catch {
        // Plugin not installed yet; the rest of the panel still works.
    }
}

/**
 * Checkbox per source. Ticking any one switches from "tier default" to an
 * explicit list, so a new adapter never silently turns itself on for someone
 * who has already curated their sources.
 */
function sourceList(sources) {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-sources');
    wrapper.append(el('label', undefined, 'Sources'));

    const settings = getSettings();

    for (const source of sources) {
        const enabled = isSourceEnabled(source, settings.enabledSources);
        const row = el('label', 'checkbox_label sbbs-source-row');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = enabled;
        input.dataset.sourceId = source.id;

        input.addEventListener('change', () => {
            const chosen = [...wrapper.querySelectorAll('input[type=checkbox]')]
                .filter((box) => box.checked)
                .map((box) => box.dataset.sourceId);
            updateSettings({ enabledSources: chosen });
        });

        row.append(input, el('span', undefined, source.label ?? source.id));

        if (source.tier > DEFAULT_MAX_TIER) {
            row.append(el('small', 'sbbs-source-note', 'limited public catalog'));
        }
        if (source.state === 'down') {
            row.append(el('small', 'sbbs-source-note', 'unavailable'));
        }

        wrapper.append(row);
    }

    return wrapper;
}

/**
 * Search history, with a way to get rid of it.
 *
 * Search terms are kept so the query box can offer them again. They are also a
 * record of what someone looked for on adult catalogues, sitting in a settings
 * file, so clearing them has to be one visible click rather than an edit.
 */
function historyControl() {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-select');
    const count = getSettings().queryHistory.length;

    const caption = el('label', undefined, 'Search history');
    wrapper.append(caption);

    const button = el('button', 'menu_button');
    button.type = 'button';
    button.disabled = count === 0;
    setText(button, count === 0 ? 'No saved searches' : `Clear ${count} saved ${count === 1 ? 'search' : 'searches'}`);
    button.addEventListener('click', () => {
        clearQueryHistory();
        button.disabled = true;
        setText(button, 'No saved searches');
    });

    wrapper.append(button);
    wrapper.append(el(
        'span',
        'sbbs-setting-note',
        'Terms you searched for are saved on this device so the search box can suggest them again. Card names are not saved.',
    ));
    return wrapper;
}

function checkbox(id, label, checked, onChange, note) {
    const control = el('label', 'checkbox_label sbbs-setting');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked === true;
    input.addEventListener('change', () => onChange(input.checked));
    control.append(input, el('span', undefined, label));

    if (!note) {
        return control;
    }

    // A setting that changes where a request comes from needs the consequence
    // written down next to it, not left to the label.
    //
    // The note goes OUTSIDE the label. SillyBunny's .checkbox_label is a flex
    // row with no flex-wrap (public/style.css:5160), so a full-width child
    // inside it cannot wrap onto its own line — it takes the width and squeezes
    // the label text down to one character per line instead.
    const hint = el('span', 'sbbs-setting-note', note);
    hint.id = `${id}_note`;
    input.setAttribute('aria-describedby', hint.id);

    control.classList.remove('sbbs-setting');
    const wrapper = el('div', 'sbbs-setting sbbs-setting-noted');
    wrapper.append(control, hint);
    return wrapper;
}

function select(id, label, options, value, onChange) {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-select');
    const caption = el('label', undefined, label);
    caption.htmlFor = id;

    const input = document.createElement('select');
    input.id = id;
    input.className = 'text_pole';

    for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        setText(node, option.label);
        input.append(node);
    }

    input.value = value;
    input.addEventListener('change', () => onChange(input.value));

    wrapper.append(caption, input);
    return wrapper;
}
