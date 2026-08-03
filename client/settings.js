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
import { IMAGE_MODES, REPOSITORY_URL, VERSION } from '../shared/schema.js';
import { el, setText } from './render.js';
import {
    AVAILABILITY,
    UPDATE_CAPABILITY,
    getAvailability,
    getServerPluginUpdateCapabilities,
    updateServerPlugin,
} from './api.js';
import { compareReleaseVersions, serverPluginUpdateErrorMessage } from './copy.js';

const PAGE_SIZES = [12, 24, 48];

const MAX_ENABLED_SOURCES = 64;
const MAX_SORTS = 64;
const MAX_SOURCE_OPTIONS = 64;

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
    /** Browser-direct fallback changes who sees the user's network address. */
    allowDirectRequests: false,
    /** Search terms can be sensitive, so persistence is an explicit opt-in. */
    saveQueryHistory: false,
    /** Most recent first. Search terms only — never a card name or a filter. */
    queryHistory: Object.freeze([]),
    _v: 4,
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
    const ctx = context();
    const store = ctx.extensionSettings;
    const raw = store && typeof store === 'object' && Object.prototype.hasOwnProperty.call(store, SETTINGS_KEY)
        ? store[SETTINGS_KEY]
        : null;
    let source = raw && typeof raw === 'object' ? raw : {};
    const read = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);

    // Versions before opt-in history stored terms automatically. Remove those
    // terms as soon as the upgraded extension reads the profile, rather than
    // merely hiding them behind the new default.
    if (read('saveQueryHistory') !== true && Object.prototype.hasOwnProperty.call(source, 'queryHistory')) {
        source = { ...source, saveQueryHistory: false, queryHistory: [], _v: DEFAULTS._v };
        store[SETTINGS_KEY] = source;
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }

    const enabled = read('enabledSources');
    const rawSorts = read('sortBySource');
    const sortBySource = Object.create(null);
    if (rawSorts && typeof rawSorts === 'object' && !Array.isArray(rawSorts)) {
        let visited = 0;
        for (const sourceId in rawSorts) {
            if (!Object.prototype.hasOwnProperty.call(rawSorts, sourceId)) {
                continue;
            }
            if (visited++ >= MAX_SORTS) {
                break;
            }
            const sort = rawSorts[sourceId];
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
        enabledSources: normalizeSourceIds(enabled),
        defaultSource: typeof read('defaultSource') === 'string' ? read('defaultSource').slice(0, 64) : DEFAULTS.defaultSource,
        sfwOnlyDefault: read('sfwOnlyDefault') !== false,
        hideAiDefault: read('hideAiDefault') === true,
        blurNsfw: read('blurNsfw') !== false,
        imageMode: AVAILABLE_IMAGE_MODES.includes(read('imageMode')) ? read('imageMode') : DEFAULTS.imageMode,
        resultsPerPage: PAGE_SIZES.includes(read('resultsPerPage')) ? read('resultsPerPage') : DEFAULTS.resultsPerPage,
        sortBySource: { ...sortBySource },
        showTrustPanel: read('showTrustPanel') !== false,
        allowDirectRequests: read('allowDirectRequests') === true,
        saveQueryHistory: read('saveQueryHistory') === true,
        queryHistory: read('saveQueryHistory') === true && Array.isArray(read('queryHistory'))
            ? read('queryHistory').slice(0, MAX_QUERY_HISTORY)
                .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
                .map((entry) => entry.slice(0, MAX_QUERY_LENGTH))
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
    if (!getSettings().saveQueryHistory) {
        return;
    }
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
    const normalized = getSettings();
    ctx.extensionSettings[SETTINGS_KEY] = normalized;
    ctx.saveSettingsDebounced();
    return normalized;
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
            'Some sites refuse connections from servers but not from home connections. With this on, the site sees your browser’s address rather than the server’s. With it off, such a source stays in the list but cannot return results.',
        ),
        checkbox(
            'sbbs_set_history',
            'Save search history in SillyBunny profile settings',
            settings.saveQueryHistory,
            (v) => updateSettings({ saveQueryHistory: v, ...(v ? {} : { queryHistory: [] }) }),
            'Search terms can be sensitive. With this off, terms are not retained after the current dialog.',
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
        const availability = await getAvailability();
        const { health } = availability;
        const sources = Array.isArray(health?.sources) ? health.sources : [];
        if (sources.length > 0) {
            content.prepend(sourceList(sources));
        }
        content.prepend(serverPluginControl(availability));
    } catch {
        // Plugin not installed yet; the rest of the panel still works.
    }
}

function serverPluginControl(availability) {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-plugin');
    wrapper.append(el('label', undefined, 'Server plugin'));

    const status = el('span', 'sbbs-setting-note');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    wrapper.append(status);

    const serverVersion = typeof availability.health?.version === 'string'
        ? availability.health.version
        : null;
    const comparison = compareReleaseVersions(serverVersion, VERSION);
    const isMounted = () => wrapper.isConnected;

    if (availability.status === AVAILABILITY.MISSING) {
        setText(status, `Not installed. Open BotSearcher for the v${VERSION} installation commands.`);
        return wrapper;
    }
    if (availability.status === AVAILABILITY.ERROR) {
        setText(status, 'Unavailable. Restart SillyBunny and check its server-plugin logs.');
        return wrapper;
    }
    if (!serverVersion) {
        setText(status, `Frontend v${VERSION}; the server did not report a release version.`);
        return wrapper;
    }
    if (comparison === 1) {
        setText(status, `Server v${serverVersion} is newer than frontend v${VERSION}. Update the frontend; server downgrades are blocked.`);
        return wrapper;
    }
    if (comparison === 0 && availability.status === AVAILABILITY.OK) {
        setText(status, `Server plugin v${serverVersion} matches this frontend.`);
        return wrapper;
    }
    if (comparison === 0) {
        setText(status, `Both components report v${VERSION}, but their protocols differ. Reinstall both from the same release tag.`);
        return wrapper;
    }
    if (comparison !== -1) {
        setText(status, `Frontend v${VERSION}; unrecognized server version ${serverVersion}.`);
        return wrapper;
    }

    setText(status, `Server v${serverVersion} is older than frontend v${VERSION}. Checking automatic update support...`);
    const actions = el('div', 'sbbs-plugin-update-actions');
    const update = el('button', 'menu_button', 'Update server plugin and restart');
    update.type = 'button';
    update.hidden = true;
    const commands = el('pre', 'sbbs-install-code sbbs-plugin-update-commands');
    const code = el('code');
    setText(code, manualUpdateCommands());
    commands.append(code);
    commands.hidden = true;
    actions.append(update);
    wrapper.append(actions, commands);

    getServerPluginUpdateCapabilities().then((capability) => {
        if (!isMounted()) {
            return;
        }
        if (capability.status === UPDATE_CAPABILITY.AVAILABLE) {
            setText(status, `Server v${serverVersion} is older than frontend v${VERSION}.`);
            update.hidden = false;
            return;
        }

        const messages = {
            [UPDATE_CAPABILITY.FORBIDDEN]: 'Sign in as a SillyBunny administrator, or stop SillyBunny completely and use Git Bash to run these commands:',
            [UPDATE_CAPABILITY.DISABLED]: 'Enable server plugins in config.yaml, stop SillyBunny completely, then use Git Bash to run these commands:',
            [UPDATE_CAPABILITY.LEGACY]: 'This legacy SillyBunny host has no automatic updater. Stop it completely, then use Git Bash to run these commands:',
        };
        const toolingMissing = capability.capabilities
            && (capability.capabilities.tooling?.git === false || capability.capabilities.tooling?.npm === false);
        if (toolingMissing) {
            setText(status, 'Automatic and manual updates require both Git and npm on the SillyBunny host.');
            commands.hidden = true;
            return;
        }
        if (messages[capability.status]) {
            setText(status, messages[capability.status]);
            commands.hidden = false;
            return;
        }
        if (capability.status === UPDATE_CAPABILITY.UNSUPPORTED) {
            setText(status, 'This host exposes an updater but does not provide the required exact-release and safe-restart guarantees. Manual replacement is not offered.');
            commands.hidden = true;
            return;
        }
        setText(status, 'Automatic updating is unavailable. Check the SillyBunny logs before updating manually.');
        commands.hidden = true;
    }).catch((error) => {
        if (!isMounted()) {
            return;
        }
        console.debug('[BotSearcher] update capability check failed:', error);
        setText(status, 'Automatic updating could not be verified. Check the SillyBunny logs before updating manually.');
        commands.hidden = true;
    });

    update.addEventListener('click', async () => {
        update.disabled = true;
        try {
            const phases = {
                staging: `Installing server plugin v${VERSION}...`,
                restarting: 'Waiting for SillyBunny to restart...',
                verifying: 'Verifying the restarted server plugin...',
                complete: `Server plugin v${VERSION} is ready.`,
            };
            await updateServerPlugin({
                onPhase: (phase) => {
                    if (isMounted()) {
                        setText(status, phases[phase] ?? 'Updating server plugin...');
                    }
                },
            });
            if (!isMounted()) {
                return;
            }
            update.hidden = true;
            commands.hidden = true;
        } catch (error) {
            if (!isMounted()) {
                return;
            }
            setText(status, serverPluginUpdateErrorMessage(error));
            commands.hidden = true;
            update.disabled = false;
        }
    });

    return wrapper;
}

function manualUpdateCommands() {
    return [
        'set -eu',
        'PLUGIN=plugins/SillyBunny-BotSearcher',
        `REPO=${REPOSITORY_URL}`,
        `RELEASE=v${VERSION}`,
        'test ! -L "$PLUGIN"',
        'PLUGIN_ROOT="$(cd "$PLUGIN" && pwd -P)"',
        'GIT_ROOT="$(git -C "$PLUGIN_ROOT" rev-parse --show-toplevel)"',
        'GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"',
        'test "$GIT_ROOT" = "$PLUGIN_ROOT"',
        'REMOTE="$(git -C "$PLUGIN_ROOT" remote get-url origin)"',
        'REPO_NO_SUFFIX="${REPO%.git}"',
        'test "$REMOTE" = "$REPO" || test "$REMOTE" = "$REPO_NO_SUFFIX"',
        'STATUS="$(git -C "$PLUGIN_ROOT" status --porcelain --untracked-files=no)"',
        'test -z "$STATUS"',
        'CURRENT="$(node -e \'process.stdout.write(require(process.argv[1] + "/package.json").version)\' "$PLUGIN_ROOT")"',
        manualVersionGuardCommand(),
        'OLD_COMMIT="$(git -C "$PLUGIN_ROOT" rev-parse HEAD)"',
        'rollback() { git -C "$PLUGIN_ROOT" checkout --detach "$OLD_COMMIT"; npm --prefix "$PLUGIN_ROOT" ci --omit=dev --ignore-scripts --no-audit --no-fund; }',
        'trap rollback ERR',
        'git -C "$PLUGIN_ROOT" fetch --depth 1 "$REPO" "refs/tags/$RELEASE"',
        'git -C "$PLUGIN_ROOT" checkout --detach FETCH_HEAD',
        'TARGET="$(node -e \'process.stdout.write(require(process.argv[1] + "/package.json").version)\' "$PLUGIN_ROOT")"',
        'test "$TARGET" = "${RELEASE#v}"',
        'npm --prefix "$PLUGIN_ROOT" ci --omit=dev --ignore-scripts --no-audit --no-fund',
        'trap - ERR',
    ].join('\n');
}

function manualVersionGuardCommand() {
    const script = [
        'const parse=value=>/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/.test(value)?value.split(".").map(Number):null;',
        'const [current,target]=process.argv.slice(1).map(parse);',
        'let order=0;',
        'if(current&&target){for(let i=0;i<3&&!order;i++)order=Math.sign(current[i]-target[i]);}',
        'if(!current||!target||order>=0){console.error("Installed version is not a stable older release; refusing replacement.");process.exit(1);}',
    ].join('');
    return `node -e '${script}' "$CURRENT" "\${RELEASE#v}"`;
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

    for (const source of sources.slice(0, MAX_SOURCE_OPTIONS)) {
        if (!source || typeof source !== 'object' || !/^[a-z0-9-]{1,64}$/.test(source.id)) {
            continue;
        }
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
        'Saved terms are stored in your SillyBunny profile settings and may be included in server backups. Card names are not saved.',
    ));
    return wrapper;
}

function normalizeSourceIds(value) {
    if (!Array.isArray(value)) {
        return null;
    }

    const seen = new Set();
    const ids = [];
    for (const id of value.slice(0, MAX_ENABLED_SOURCES)) {
        if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids;
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
