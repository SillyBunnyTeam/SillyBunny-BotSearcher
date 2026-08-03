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
        ['downloads', 'like'],
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
    if (inside.hasSystemPrompt) {
        add('System prompt', 'Included');
    }
    if (inside.hasPostHistoryInstructions) {
        add('Post-history instructions', 'Included');
    }
    if (inside.hasDepthPrompt) {
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
    if (inside.originSite) {
        add('Reported origin', inside.originSite);
    }
    if (inside.specVersion) {
        add('Card format', inside.specVersion);
    }

    return rows;
}

export function searchErrorMessage(error, sourceLabel) {
    switch (error?.code) {
        case 'timeout':
            return `${sourceLabel} did not respond in time. Try again.`;
        case 'rate_limited':
            return 'Too many searches. Wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy. Try again shortly.`;
        case 'source_down':
            return `${sourceLabel} is not responding.`;
        case 'http_error':
            return `${sourceLabel} returned an error.`;
        case 'too_large':
            return `${sourceLabel} sent more data than BotSearcher accepts.`;
        case 'bad_json':
        case 'unsafe_json':
            return `${sourceLabel} sent a response this version cannot read. The source API may have changed.`;
        default:
            return `Could not connect to ${sourceLabel}.`;
    }
}

export function detailErrorMessage(error, sourceLabel) {
    switch (error?.code) {
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

export function availabilityCopy(status, health, frontendProtocol, frontendVersion) {
    if (status === 'missing') {
        return {
            title: 'Server plugin not found',
            lead: 'The frontend extension is installed, but BotSearcher could not find its server plugin. Both components are required for search.',
            guidance: '',
            showInstall: true,
        };
    }

    if (status === 'protocol-mismatch') {
        const protocols = `Frontend protocol: ${frontendProtocol}. Server protocol: ${health?.protocol ?? 'not reported'}.`;
        const versions = health?.version
            ? ` Frontend version: ${frontendVersion}. Server version: ${health.version}.`
            : ` Frontend version: ${frontendVersion}.`;
        return {
            title: 'Frontend and server are incompatible',
            lead: 'The BotSearcher frontend and server plugin use different protocol versions.',
            guidance: `${protocols}${versions} Update both components from the same release, restart SillyBunny, then check again.`,
            showInstall: false,
        };
    }

    return {
        title: 'Server plugin unavailable',
        lead: 'BotSearcher could not connect to its server plugin.',
        guidance: 'Restart SillyBunny. If the problem continues, check the server logs for BotSearcher errors.',
        showInstall: false,
    };
}
