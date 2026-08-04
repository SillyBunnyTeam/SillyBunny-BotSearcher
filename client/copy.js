/**
 * Pure display formatting shared by the browser and detail views.
 * Machine values stay unchanged; only their user-facing labels live here.
 */

const NUMBER_FORMAT = new Intl.NumberFormat();

export const SORT_LABELS = Object.freeze({
    latest: 'Latest',
    curated: 'Curated',
    downloads: 'Most downloaded',
    favorites: 'Most favorited',
    views: 'Most viewed',
    random: 'Random',
    default: 'Source default',
    download_count: 'Most downloaded',
    star_count: 'Most starred',
    n_favorites: 'Most favorited',
    rating: 'Highest rated',
    trending: 'Trending',
    trending_downloads: 'Trending downloads',
    created_at: 'Newest',
    last_activity_at: 'Recently active',
    newcomer: 'Newcomers',
    n_tokens: 'Most tokens',
    name: 'Name',
    approved_at: 'Recently approved',
    stars: 'Most starred',
    chatCount: 'Most chats',
    createdAt: 'Newest',
    updatedAt: 'Recently updated',
    token_count: 'Most tokens',
    display_name: 'Name',
    recommended: 'Recommended',
    download: 'Most downloaded',
    newest: 'Newest',
});

const STAT_FIELDS = Object.freeze({
    botbooru: Object.freeze([
        ['tokens', 'token'],
        ['downloads', 'download'],
        ['views', 'view'],
        ['favorites', 'fork'],
    ]),
    chub: Object.freeze([
        ['tokens', 'token'],
        ['views', 'chat'],
        ['downloads', 'star'],
        ['favorites', 'favorite'],
    ]),
    pygmalion: Object.freeze([
        ['tokens', 'token'],
        ['views', 'view'],
        ['downloads', 'star'],
        ['favorites', 'chat'],
    ]),
    wyvern: Object.freeze([
        ['tokens', 'token'],
        ['favorites', 'like'],
    ]),
    charactertavern: Object.freeze([
        ['tokens', 'token'],
        ['views', 'message'],
        ['downloads', 'download'],
        ['favorites', 'like'],
    ]),
});

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatNumber(value) {
    const number = finiteNumber(value);
    return number === null ? '' : NUMBER_FORMAT.format(number);
}

export function formatCount(value, singular, plural = `${singular}s`) {
    const number = finiteNumber(value);
    if (number === null) {
        return '';
    }
    return `${formatNumber(number)} ${number === 1 ? singular : plural}`;
}

export function formatResultCount(shown, total) {
    const shownCount = finiteNumber(shown) ?? 0;
    const totalCount = finiteNumber(total);
    if (totalCount !== null) {
        const resultWord = totalCount === 1 ? 'result' : 'results';
        return `${formatNumber(shownCount)} of ${formatNumber(totalCount)} ${resultWord}`;
    }
    const resultWord = shownCount === 1 ? 'result' : 'results';
    return `${formatNumber(shownCount)} ${resultWord} shown`;
}

export function sortLabel(sort) {
    if (Object.prototype.hasOwnProperty.call(SORT_LABELS, sort)) {
        return SORT_LABELS[sort];
    }

    const text = String(sort ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();
    return text === '' ? 'Sort option' : text.charAt(0).toUpperCase() + text.slice(1);
}

export function sourceStatLine(sourceId, stats) {
    if (!stats || typeof stats !== 'object') {
        return '';
    }

    const fields = STAT_FIELDS[sourceId] ?? [];
    return fields
        .map(([key, label]) => formatCount(stats[key], label))
        .filter(Boolean)
        .join(', ');
}

export function insideRows(inside) {
    if (!inside || typeof inside !== 'object') {
        return [];
    }

    const rows = [];
    const add = (label, value) => rows.push({ label, value });

    if (inside.lorebookEntries === null) {
        add('Lorebook', 'Not reported');
    } else if (inside.lorebookEntries > 0) {
        add('Lorebook', formatCount(inside.lorebookEntries, 'entry', 'entries'));
    }
    if (inside.alternateGreetings === null) {
        add('Alternate greetings', 'Not reported');
    } else if (inside.alternateGreetings > 0) {
        add('Alternate greetings', formatCount(inside.alternateGreetings, 'greeting'));
    }
    if (inside.hasSystemPrompt === null) {
        add('System prompt', 'Not reported');
    } else if (inside.hasSystemPrompt) {
        add('System prompt', 'Included');
    }
    if (inside.hasPostHistoryInstructions === null) {
        add('Post-history instructions', 'Not reported');
    } else if (inside.hasPostHistoryInstructions) {
        add('Post-history instructions', 'Included');
    }
    if (inside.hasDepthPrompt === null) {
        add('Depth prompt', 'Not reported');
    } else if (inside.hasDepthPrompt) {
        add('Depth prompt', 'Included');
    }
    if (inside.regexScripts === null) {
        add('Regex scripts', 'Not reported');
    } else if (inside.regexScripts > 0) {
        add('Regex scripts', formatCount(inside.regexScripts, 'script'));
    }
    if (inside.embeddedAssets === null) {
        add('Embedded assets', 'Not reported');
    } else if (inside.embeddedAssets > 0) {
        add('Embedded assets', formatCount(inside.embeddedAssets, 'asset'));
    }
    if (inside.externalImages > 0) {
        add('External URL references', formatCount(inside.externalImages, 'reference'));
    }
    if (inside.originSite) {
        add('Reported origin', inside.originSite);
    }
    if (inside.specVersion) {
        add('Card format', inside.specVersion);
    }

    return rows;
}

/**
 * What an empty grid means, which depends on what was actually asked for.
 *
 * "Try a broader search" is unhelpful advice when the query is empty and it is
 * the filters doing the narrowing, so the sentence names whichever one applies.
 *
 * @param {string} sourceLabel
 * @param {string} query
 * @param {number} activeFilters
 */
export function emptyResultMessage(sourceLabel, query, activeFilters = 0) {
    if (query && activeFilters > 0) {
        return `No results for "${query}" on ${sourceLabel} with these filters. Try removing a filter or broadening the search.`;
    }
    if (activeFilters > 0) {
        return `No cards on ${sourceLabel} match these filters. Try removing one.`;
    }
    if (query) {
        return `No results for "${query}" on ${sourceLabel}. Try a broader search.`;
    }
    return `No cards are currently listed on ${sourceLabel}.`;
}

/**
 * Why a source could not be reached, in the words that fit what happened.
 *
 * "Not responding" is wrong for a refusal: the site answered, and it said no.
 * The two lead to different next actions, so they get different sentences.
 *
 * @param {string} sourceLabel
 * @param {string | null | undefined} reason a `classify()` kind from the server
 */
export function unreachableReason(sourceLabel, reason) {
    switch (reason) {
        case 'forbidden':
            return `${sourceLabel} refused the request from your SillyBunny server.`;
        case 'dns':
            return `${sourceLabel} could not be found from your SillyBunny server.`;
        case 'not_found':
            return `${sourceLabel} no longer offers the endpoint BotSearcher uses.`;
        default:
            return `${sourceLabel} is not responding.`;
    }
}

/**
 * Shown when requests for a source move from the server to this browser. States
 * the consequence rather than only the mechanism, because the consequence is the
 * part the user is being asked to accept.
 */
export function directRoutingNotice(sourceLabel, reason) {
    return `${unreachableReason(sourceLabel, reason)} BotSearcher is now requesting ${sourceLabel} from this browser instead, so ${sourceLabel} sees your browser's address rather than the server's. You can turn this off in Extensions > BotSearcher.`;
}

export function searchErrorMessage(error, sourceLabel) {
    switch (error?.code) {
        case 'botbooru_login_required':
            return 'Log in to BotBooru under Extensions > BotSearcher to search non-SFW results.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in again under Extensions > BotSearcher.';
        case 'botbooru_nsfw_disabled':
            return 'Enable NSFW for the BotBooru account under Extensions > BotSearcher, or search SFW only.';
        case 'botbooru_auth_unavailable':
            return 'BotBooru account access is unavailable. Try again shortly.';
        case 'account_profile_required':
            return 'Select a SillyBunny profile before using a BotBooru account.';
        case 'botbooru_account_changed':
            return 'The BotBooru account changed during this request. Try again.';
        case 'timeout':
            return `${sourceLabel} did not respond in time. Try again.`;
        case 'rate_limited':
            return 'Too many searches. Wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy. Try again shortly.`;
        case 'source_down':
            return `${sourceLabel} is not responding.`;
        case 'direct_blocked':
            return `${sourceLabel} refused the request from your SillyBunny server and from this browser.`;
        case 'bad_direct_url':
            return `BotSearcher will not request ${sourceLabel} from an unexpected address.`;
        case 'direct_unsupported':
            return `${sourceLabel} cannot be requested from this browser.`;
        case 'http_error':
            return `${sourceLabel} returned an error.`;
        case 'too_large':
            return `${sourceLabel} sent more data than BotSearcher accepts.`;
        case 'bad_cursor':
            return `The ${sourceLabel} result page expired. Start a new search to continue.`;
        case 'bad_json':
        case 'unsafe_json':
            return `${sourceLabel} sent a response this version cannot read. The source API may have changed.`;
        default:
            return `Could not connect to ${sourceLabel}.`;
    }
}

export function detailErrorMessage(error, sourceLabel) {
    switch (error?.code) {
        case 'botbooru_login_required':
            return 'Log in to BotBooru under Extensions > BotSearcher to load this card.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in again under Extensions > BotSearcher.';
        case 'botbooru_auth_unavailable':
            return 'BotBooru account access is unavailable. Try again shortly.';
        case 'botbooru_nsfw_disabled':
            return 'NSFW is disabled for this BotBooru account. Search again in SFW mode.';
        case 'botbooru_account_changed':
            return 'The BotBooru account changed after this result loaded. Search again.';
        case 'timeout':
            return `${sourceLabel} did not respond in time.`;
        case 'rate_limited':
            return 'Too many requests. Wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy. Try again shortly.`;
        default:
            return `Could not load this card from ${sourceLabel}.`;
    }
}

export function accountErrorMessage(error) {
    switch (error?.code) {
        case 'botbooru_invalid_credentials':
            return 'BotBooru did not accept that username and password.';
        case 'botbooru_login_required':
            return 'Log in to BotBooru first.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in again.';
        case 'botbooru_nsfw_disabled':
            return 'NSFW is disabled for this BotBooru account.';
        case 'botbooru_auth_unavailable':
            return 'BotBooru account access is unavailable. Try again shortly.';
        case 'account_profile_required':
            return 'Select a SillyBunny profile before logging in to BotBooru.';
        case 'botbooru_account_changed':
            return 'The BotBooru account changed during this request. Try again.';
        case 'bad_account_request':
            return 'Enter a valid BotBooru username and password.';
        case 'rate_limited':
            return 'Too many login attempts. Wait before trying again.';
        default:
            return 'Could not update the BotBooru account. Try again.';
    }
}

export function importErrorMessage(error) {
    switch (error?.message) {
        case 'import_url_rejected':
            return 'BotSearcher rejected the download link.';
        case 'import_unsupported':
            return 'This source does not support imports.';
        case 'import_failed':
            return 'The card could not be imported. It may have been removed.';
        case 'card_invalid':
            return 'The download is not a supported character card.';
        case 'png_malformed':
        case 'not_a_png':
            return 'The downloaded card is damaged or incomplete.';
        case 'too_large':
            return 'The card is larger than BotSearcher allows.';
        case 'use_native_import':
            return 'This card must use SillyBunny\'s built-in importer. Report this BotSearcher error.';
        case 'rate_limited':
            return 'Too many downloads. Wait a moment and try again.';
        default:
            return 'The card could not be imported.';
    }
}

function list(items) {
    if (items.length === 1) {
        return items[0];
    }
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function additionalImportContents(actual, reported) {
    if (!actual || typeof actual !== 'object') {
        return '';
    }

    const notes = [];
    const reportedCount = (key) => {
        const value = reported && typeof reported === 'object' ? reported[key] : null;
        return finiteNumber(value) ?? 0;
    };
    const reportedFlag = (key) => reported && typeof reported === 'object' && reported[key] === true;

    if (actual.lorebookEntries > reportedCount('lorebookEntries')) {
        notes.push(formatCount(actual.lorebookEntries, 'lorebook entry', 'lorebook entries'));
    }
    if (actual.alternateGreetings > reportedCount('alternateGreetings')) {
        notes.push(formatCount(actual.alternateGreetings, 'alternate greeting'));
    }
    if (actual.hasSystemPrompt && !reportedFlag('hasSystemPrompt')) {
        notes.push('a system prompt');
    }
    if (actual.hasPostHistoryInstructions && !reportedFlag('hasPostHistoryInstructions')) {
        notes.push('post-history instructions');
    }
    if (actual.hasDepthPrompt && !reportedFlag('hasDepthPrompt')) {
        notes.push('a depth prompt');
    }
    if (actual.regexScripts > reportedCount('regexScripts')) {
        notes.push(formatCount(actual.regexScripts, 'regex script'));
    }
    if (actual.embeddedAssets > reportedCount('embeddedAssets')) {
        notes.push(formatCount(actual.embeddedAssets, 'embedded asset'));
    }
    if (actual.externalImages > 0) {
        notes.push(formatCount(actual.externalImages, 'external URL reference'));
    }

    return notes.length === 0 ? '' : `The imported card also contains ${list(notes)}.`;
}

/** Compares stable X.Y.Z releases, or returns null for an unknown format. */
export function compareReleaseVersions(left, right) {
    const parse = (value) => {
        const match = String(value ?? '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
        return match ? match.slice(1).map((part) => Number.parseInt(part, 10)) : null;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) {
        return null;
    }
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {
            return a[index] < b[index] ? -1 : 1;
        }
    }
    return 0;
}

export function availabilityCopy(status, health, frontendProtocol, frontendVersion, capabilityStatus = '') {
    if (status === 'missing') {
        return {
            title: 'Server plugin not found',
            lead: 'The frontend extension is installed, but BotSearcher could not find its server plugin. Both components are required for search.',
            guidance: '',
            showInstall: true,
            showManualUpdate: false,
            showUpdate: false,
        };
    }

    if (status === 'protocol-mismatch') {
        const protocols = `Frontend protocol: ${frontendProtocol}. Server protocol: ${health?.protocol ?? 'not reported'}.`;
        const versions = health?.version
            ? ` Frontend version: ${frontendVersion}. Server version: ${health.version}.`
            : ` Frontend version: ${frontendVersion}.`;
        const comparison = compareReleaseVersions(health?.version, frontendVersion);
        let recovery = ' Reinstall both components from the same release, restart SillyBunny, then check again.';
        if (comparison === -1) {
            recovery = ` Update the server plugin to v${frontendVersion}, then let SillyBunny restart.`;
        } else if (comparison === 1) {
            recovery = ` The server is newer; update the frontend extension to v${health.version}. A server downgrade is not offered.`;
        } else if (comparison === null) {
            recovery = ' The server version cannot be ordered safely. Verify both deployments manually; no server replacement is offered.';
        }
        const manualFallback = ['forbidden', 'disabled', 'legacy'].includes(capabilityStatus);
        return {
            title: 'Frontend and server are incompatible',
            lead: 'The BotSearcher frontend and server plugin use different protocol versions.',
            guidance: `${protocols}${versions}${recovery}`,
            showInstall: false,
            showManualUpdate: comparison === -1 && manualFallback,
            showUpdate: comparison === -1 && capabilityStatus === 'available',
        };
    }

    return {
        title: 'Server plugin unavailable',
        lead: 'BotSearcher could not connect to its server plugin.',
        guidance: 'Restart SillyBunny. If the problem continues, check the server logs for BotSearcher errors.',
        showInstall: false,
        showManualUpdate: false,
        showUpdate: false,
    };
}

export function serverPluginUpdateErrorMessage(error) {
    const messages = {
        managed_externally: 'This server plugin is externally managed. Use its owner or deployment process; automatic replacement is blocked.',
        dirty_checkout: 'The server-plugin checkout has tracked local changes. Commit or discard them before updating.',
        wrong_remote: 'The server-plugin Git remote does not match its declared repository.',
        update_busy: 'Another server-plugin update is already running. Try again after it finishes.',
        downgrade_blocked: 'SillyBunny refused to downgrade the server plugin.',
        server_plugins_disabled: 'Server plugins are disabled in config.yaml.',
        tooling_unavailable: 'SillyBunny needs Git and npm to install this server-plugin release.',
        safe_restart_unavailable: 'This SillyBunny process cannot perform a supervised plugin restart.',
        staging_timeout: 'Server-plugin staging did not finish before the safety timeout. Check the server logs before retrying.',
        restart_marker_missing: 'SillyBunny did not provide the boot marker required to verify a safe restart.',
        restart_timeout: 'SillyBunny did not return before the restart timeout. Check the server logs.',
        plugin_verification_failed: 'SillyBunny restarted, but the matching server-plugin release did not become available. Check the update logs.',
    };
    if (typeof error?.code === 'string' && messages[error.code]) {
        return messages[error.code];
    }
    if (error?.status === 403) {
        return 'Only a SillyBunny administrator can update server plugins.';
    }
    return 'The server plugin could not be updated. Check the server logs before retrying.';
}
