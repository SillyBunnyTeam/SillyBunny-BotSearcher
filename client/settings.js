/**
 * Extension settings.
 *
 * Everything is re-clamped on read with the same discipline the server uses on
 * requests, so a hand-edited settings.json cannot inject an unknown source id or
 * an absurd page size. No secret is ever stored here — this extension needs no
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

const PAGE_SIZES = [12, 24, 48];

const AVAILABLE_IMAGE_MODES = IMAGE_MODES;

const IMAGE_MODE_LABELS = {
    proxy: 'Through your own server (the card site never sees your IP address)',
    direct: 'Straight from the card site (faster, but the site sees your IP address)',
    off: 'No thumbnails (lowest data use)',
};

const DEFAULTS = Object.freeze({
    defaultSource: 'botbooru',
    sfwOnlyDefault: true,
    blurNsfw: true,
    // Private by default. 'direct' is offered, but opting out of privacy should
    // be a choice the user makes, not the one they get by not choosing.
    imageMode: 'proxy',
    resultsPerPage: 24,
    sortDefault: 'latest',
    showTrustPanel: true,
    _v: 1,
});

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

    return {
        defaultSource: typeof read('defaultSource') === 'string' ? read('defaultSource').slice(0, 64) : DEFAULTS.defaultSource,
        sfwOnlyDefault: read('sfwOnlyDefault') !== false,
        blurNsfw: read('blurNsfw') !== false,
        imageMode: AVAILABLE_IMAGE_MODES.includes(read('imageMode')) ? read('imageMode') : DEFAULTS.imageMode,
        resultsPerPage: PAGE_SIZES.includes(read('resultsPerPage')) ? read('resultsPerPage') : DEFAULTS.resultsPerPage,
        sortDefault: typeof read('sortDefault') === 'string' ? read('sortDefault').slice(0, 32) : DEFAULTS.sortDefault,
        showTrustPanel: read('showTrustPanel') !== false,
        _v: DEFAULTS._v,
    };
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
export function mountSettings() {
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
    const header = el('div', 'inline-drawer-toggle inline-drawer-header');
    header.append(el('b', undefined, 'BotSearcher'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));

    const content = el('div', 'inline-drawer-content sbbs-settings');
    const settings = getSettings();

    content.append(
        checkbox('sbbs_set_sfw', 'SFW only by default', settings.sfwOnlyDefault, (v) => updateSettings({ sfwOnlyDefault: v })),
        checkbox('sbbs_set_blur', 'Blur adult thumbnails until clicked', settings.blurNsfw, (v) => updateSettings({ blurNsfw: v })),
        checkbox('sbbs_set_trust', 'Show the "What’s inside this card" panel', settings.showTrustPanel, (v) => updateSettings({ showTrustPanel: v })),
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
    );

    drawer.append(header, content);
    container.append(drawer);
    host.append(container);
}

function checkbox(id, label, checked, onChange) {
    const wrapper = el('label', 'checkbox_label sbbs-setting');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked === true;
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, el('span', undefined, label));
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
