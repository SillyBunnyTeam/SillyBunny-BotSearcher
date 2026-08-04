import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    SORT_LABELS,
    additionalImportContents,
    accountErrorMessage,
    availabilityCopy,
    compareReleaseVersions,
    detailErrorMessage,
    formatCount,
    formatNumber,
    formatResultCount,
    importErrorMessage,
    insideRows,
    searchErrorMessage,
    unreachableReason,
    directRoutingNotice,
    sortLabel,
    sourceStatLine,
    serverPluginUpdateErrorMessage,
} from '../client/copy.js';
import { SOURCES } from '../server/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every advertised sort has an intentional display label', () => {
    for (const source of Object.values(SOURCES)) {
        for (const sort of source.capabilities.sorts) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(SORT_LABELS, sort),
                true,
                `${source.id} sort ${sort} needs a display label`,
            );
            assert.doesNotMatch(sortLabel(sort), /_|[a-z][A-Z]/, `${sort} leaked an API name`);
        }
    }

    assert.equal(sortLabel('approved_at'), 'Recently approved');
    assert.equal(sortLabel('chatCount'), 'Most chats');
    assert.equal(sortLabel('createdAt'), 'Newest');
    assert.equal(sortLabel('relevant'), 'Most relevant');
    assert.equal(sortLabel('tokens_asc'), 'Fewest tokens');
});

test('counts are localized and pluralized', () => {
    const one = new Intl.NumberFormat().format(1);
    const two = new Intl.NumberFormat().format(2);
    const ten = new Intl.NumberFormat().format(10);
    const large = new Intl.NumberFormat().format(12345);

    assert.equal(formatNumber(12345), large);
    assert.equal(formatCount(1, 'token'), `${one} token`);
    assert.equal(formatCount(12345, 'token'), `${large} tokens`);
    assert.equal(formatCount(2, 'entry', 'entries'), `${two} entries`);
    assert.equal(formatResultCount(1, null), `${one} result shown`);
    assert.equal(formatResultCount(1, 10), `${one} of ${ten} results`);
    assert.equal(formatResultCount(1, 1), `${one} of ${one} result`);
});

test('detail statistics use each source field meaning', () => {
    const stats = { tokens: 1, views: 2, downloads: 3, favorites: 4 };

    assert.equal(sourceStatLine('botbooru', stats), [
        formatCount(1, 'token'),
        formatCount(3, 'download'),
        formatCount(2, 'view'),
        formatCount(4, 'fork'),
    ].join(', '));
    assert.equal(sourceStatLine('chub', stats), [
        formatCount(1, 'token'),
        formatCount(2, 'chat'),
        formatCount(3, 'star'),
        formatCount(4, 'favorite'),
    ].join(', '));
    assert.equal(sourceStatLine('pygmalion', stats), [
        formatCount(1, 'token'),
        formatCount(2, 'view'),
        formatCount(3, 'star'),
        formatCount(4, 'chat'),
    ].join(', '));
    assert.equal(sourceStatLine('wyvern', stats), [
        formatCount(1, 'token'),
        formatCount(4, 'like'),
    ].join(', '));
    assert.equal(sourceStatLine('charactertavern', stats), [
        formatCount(1, 'token'),
        formatCount(2, 'message'),
        formatCount(3, 'download'),
        formatCount(4, 'like'),
    ].join(', '));
    assert.equal(sourceStatLine('jannyai', stats), formatCount(1, 'token'));
    assert.equal(sourceStatLine('quillgen', stats), '');
});

test('card contents distinguish unreported values and include regex scripts', () => {
    assert.deepEqual(insideRows({
        lorebookEntries: null,
        alternateGreetings: null,
        hasSystemPrompt: false,
        hasPostHistoryInstructions: false,
        hasDepthPrompt: false,
        regexScripts: null,
        embeddedAssets: null,
        originSite: null,
        specVersion: null,
    }), [
        { label: 'Lorebook', value: 'Not reported' },
        { label: 'Alternate greetings', value: 'Not reported' },
        { label: 'Regex scripts', value: 'Not reported' },
        { label: 'Embedded assets', value: 'Not reported' },
    ]);

    const rows = insideRows({
        lorebookEntries: 1,
        alternateGreetings: 2,
        hasSystemPrompt: true,
        hasPostHistoryInstructions: true,
        hasDepthPrompt: true,
        regexScripts: 3,
        embeddedAssets: 4,
        originSite: 'Example',
        specVersion: 'chara_card_v2',
    });
    assert.deepEqual(rows.find((row) => row.label === 'Lorebook'), { label: 'Lorebook', value: formatCount(1, 'entry', 'entries') });
    assert.deepEqual(rows.find((row) => row.label === 'Regex scripts'), { label: 'Regex scripts', value: formatCount(3, 'script') });
    assert.deepEqual(rows.find((row) => row.label === 'System prompt'), { label: 'System prompt', value: 'Included' });
});

test('downloaded card notices report contents not disclosed by the source', () => {
    const actual = {
        lorebookEntries: 2,
        alternateGreetings: 1,
        hasSystemPrompt: true,
        hasPostHistoryInstructions: true,
        hasDepthPrompt: true,
        regexScripts: 1,
        embeddedAssets: 1,
        externalImages: 2,
    };
    const reported = {
        lorebookEntries: 0,
        alternateGreetings: 0,
        hasSystemPrompt: false,
        hasPostHistoryInstructions: false,
        hasDepthPrompt: false,
        regexScripts: 0,
        embeddedAssets: 0,
    };

    const message = additionalImportContents(actual, reported);
    for (const text of [
        formatCount(2, 'lorebook entry', 'lorebook entries'),
        formatCount(1, 'alternate greeting'),
        'a system prompt',
        'post-history instructions',
        'a depth prompt',
        formatCount(1, 'regex script'),
        formatCount(1, 'embedded asset'),
        formatCount(2, 'external URL reference'),
    ]) {
        assert.match(message, new RegExp(text));
    }
    assert.equal(
        additionalImportContents(actual, actual),
        `The imported card also contains ${formatCount(2, 'external URL reference')}.`,
    );
});

test('availability states give different recovery instructions', () => {
    const missing = availabilityCopy('missing', null, 1, '0.1.0');
    const unavailable = availabilityCopy('error', null, 1, '0.1.0');
    const mismatch = availabilityCopy('protocol-mismatch', { protocol: 2, version: '0.1.0' }, 1, '0.1.0');

    assert.equal(missing.title, 'Server plugin not found');
    assert.equal(missing.showInstall, true);
    assert.equal(missing.showUpdate, false);
    assert.equal(unavailable.title, 'Server plugin unavailable');
    assert.equal(unavailable.showInstall, false);
    assert.match(unavailable.guidance, /server logs/);
    assert.equal(mismatch.title, 'Frontend and server are incompatible');
    assert.equal(mismatch.showInstall, false);
    assert.match(mismatch.guidance, /Frontend protocol: 1\. Server protocol: 2\./);
    assert.match(mismatch.guidance, /Frontend version: 0\.1\.0\. Server version: 0\.1\.0\./);
    assert.equal(mismatch.showManualUpdate, false);
    assert.equal(mismatch.showUpdate, false);
});

test('only an older server is offered the matching release update', () => {
    const older = availabilityCopy('protocol-mismatch', { protocol: 3, version: '0.2.0' }, 4, '0.3.0', 'available');
    const newer = availabilityCopy('protocol-mismatch', { protocol: 5, version: '0.4.0' }, 4, '0.3.0', 'available');

    assert.equal(compareReleaseVersions('0.2.9', '0.3.0'), -1);
    assert.equal(compareReleaseVersions('0.3.0', '0.3.0'), 0);
    assert.equal(compareReleaseVersions('1.0.0', '0.3.0'), 1);
    assert.equal(compareReleaseVersions('latest', '0.3.0'), null);
    assert.equal(older.showUpdate, true);
    assert.equal(older.showManualUpdate, false);
    assert.match(older.guidance, /Update the server plugin to v0\.3\.0/);
    assert.equal(newer.showUpdate, false);
    assert.equal(newer.showManualUpdate, false);
    assert.match(newer.guidance, /server is newer/i);
    assert.match(newer.guidance, /downgrade is not offered/i);
});

test('manual update fallback is limited to known upgrades on legacy hosts', () => {
    const older = availabilityCopy('protocol-mismatch', { protocol: 3, version: '0.2.0' }, 4, '0.3.0', 'legacy');
    const unsafeUpdater = availabilityCopy('protocol-mismatch', { protocol: 3, version: '0.2.0' }, 4, '0.3.0', 'unsupported');
    const missingTools = availabilityCopy('protocol-mismatch', { protocol: 3, version: '0.2.0' }, 4, '0.3.0', 'unavailable');
    const unknown = availabilityCopy('protocol-mismatch', { protocol: 5, version: '0.4.0-beta.1' }, 4, '0.3.0', 'unsupported');

    assert.equal(older.showManualUpdate, true);
    assert.equal(older.showUpdate, false);
    assert.equal(unsafeUpdater.showManualUpdate, false);
    assert.equal(missingTools.showManualUpdate, false);
    assert.equal(unknown.showManualUpdate, false);
    assert.equal(unknown.showUpdate, false);
    assert.match(unknown.guidance, /cannot be ordered safely/);
});

test('server-plugin update errors give an actionable recovery', () => {
    assert.match(serverPluginUpdateErrorMessage({ code: 'managed_externally' }), /externally managed/);
    assert.match(serverPluginUpdateErrorMessage({ code: 'dirty_checkout' }), /tracked local changes/);
    assert.match(serverPluginUpdateErrorMessage({ code: 'restart_timeout' }), /restart timeout/);
    assert.match(serverPluginUpdateErrorMessage({ status: 403 }), /administrator/);
    assert.doesNotMatch(serverPluginUpdateErrorMessage({ code: 'wrong_remote' }), /manual commands/i);
});

test('an unreachable source is described by what actually happened', () => {
    // A refusal and a timeout are different events with different next actions.
    // Collapsing both into "not responding" was wrong for the case that turned
    // out to be the common one: a site that answers, and says no.
    assert.equal(unreachableReason('Chub', 'forbidden'), 'Chub refused the request from your SillyBunny server.');
    assert.equal(unreachableReason('Chub', 'dns'), 'Chub could not be found from your SillyBunny server.');
    assert.equal(unreachableReason('Chub', 'not_found'), 'Chub no longer offers the endpoint BotSearcher uses.');
    assert.equal(unreachableReason('Chub', 'transient'), 'Chub is not responding.');
    assert.equal(unreachableReason('Chub', null), 'Chub is not responding.');
});

test('the direct-routing notice states the consequence, not just the mechanism', () => {
    const notice = directRoutingNotice('Chub', 'forbidden');

    assert.match(notice, /refused the request from your SillyBunny server/);
    // The part the user is actually being asked to accept.
    assert.match(notice, /sees your browser's address rather than the server's/);
    // And where to undo it.
    assert.match(notice, /Extensions > BotSearcher/);
});

test('search and detail errors use direct recovery copy', () => {
    const searchCases = {
        timeout: 'Botbooru did not respond in time. Try again.',
        rate_limited: 'Too many searches. Wait a moment and try again.',
        source_busy: 'Botbooru is busy. Try again shortly.',
        source_down: 'Botbooru is not responding.',
        http_error: 'Botbooru returned an error.',
        too_large: 'Botbooru sent more data than BotSearcher accepts.',
        bad_json: 'Botbooru sent a response this version cannot read. The source API may have changed.',
        unsafe_json: 'Botbooru sent a response this version cannot read. The source API may have changed.',
    };
    for (const [code, expected] of Object.entries(searchCases)) {
        assert.equal(searchErrorMessage({ code }, 'Botbooru'), expected);
    }
    assert.equal(searchErrorMessage({ code: 'unknown' }, 'Botbooru'), 'Could not connect to Botbooru.');

    // Both routes failed, so say both. "Not responding" would be wrong twice
    // over: the site answered, and the browser was tried as well.
    assert.equal(
        searchErrorMessage({ code: 'direct_blocked' }, 'Chub'),
        'Chub refused the request from your SillyBunny server and from this browser.',
    );

    assert.equal(detailErrorMessage({ code: 'timeout' }, 'Chub'), 'Chub did not respond in time.');
    assert.equal(detailErrorMessage({ code: 'rate_limited' }, 'Chub'), 'Too many requests. Wait a moment and try again.');
    assert.equal(detailErrorMessage({ code: 'source_busy' }, 'Chub'), 'Chub is busy. Try again shortly.');
    assert.equal(detailErrorMessage({}, 'Chub'), 'Could not load this card from Chub.');
});

test('BotBooru account errors point to the setting that resolves them', () => {
    assert.match(searchErrorMessage({ code: 'botbooru_login_required' }, 'Botbooru'), /Extensions > BotSearcher/);
    assert.match(searchErrorMessage({ code: 'botbooru_session_expired' }, 'Botbooru'), /expired/);
    assert.match(searchErrorMessage({ code: 'botbooru_nsfw_disabled' }, 'Botbooru'), /Enable NSFW/);
    assert.match(detailErrorMessage({ code: 'botbooru_login_required' }, 'Botbooru'), /Extensions > BotSearcher/);
    assert.match(detailErrorMessage({ code: 'botbooru_account_changed' }, 'Botbooru'), /Search again/);
    assert.match(accountErrorMessage({ code: 'botbooru_invalid_credentials' }), /username and password/);
    assert.match(accountErrorMessage({ code: 'rate_limited' }), /Too many login attempts/);
    assert.doesNotMatch(accountErrorMessage({ message: 'upstream secret detail' }), /secret detail/);
});

test('import errors explain the failure without claiming certainty', () => {
    const cases = {
        import_url_rejected: 'BotSearcher rejected the download link.',
        import_unsupported: 'This source does not support imports.',
        import_failed: 'The card could not be imported. It may have been removed.',
        card_invalid: 'The download is not a supported character card.',
        png_malformed: 'The downloaded card is damaged or incomplete.',
        not_a_png: 'The downloaded card is damaged or incomplete.',
        too_large: 'The card is larger than BotSearcher allows.',
        use_native_import: "This card must use SillyBunny's built-in importer. Report this BotSearcher error.",
        rate_limited: 'Too many downloads. Wait a moment and try again.',
    };
    for (const [message, expected] of Object.entries(cases)) {
        assert.equal(importErrorMessage(new Error(message)), expected);
    }
    assert.equal(importErrorMessage(new Error('unknown')), 'The card could not be imported.');
});

test('browser template gives the search field a durable name and matching limit', () => {
    const browser = fs.readFileSync(path.join(ROOT, 'templates/browser.html'), 'utf8');
    const install = fs.readFileSync(path.join(ROOT, 'templates/plugin-missing.html'), 'utf8');
    const browserScript = fs.readFileSync(path.join(ROOT, 'client/browser.js'), 'utf8');

    assert.match(browser, /id="sbbs_query"[^>]*aria-label="Search character cards"/);
    assert.match(browser, /id="sbbs_query"[^>]*maxlength="128"/);
    assert.match(browser, /id="sbbs_sfw_note"[^>]*aria-live="polite"/);
    assert.match(browser, /aria-label="Card details"/);
    assert.match(browserScript, /popup\.dlg\.setAttribute\('aria-label', 'Find cards online'\)/);
    assert.match(install, />Check again<\/button>/);
    assert.match(install, /class="sbbs-install-guidance" hidden/);
    assert.match(install, /id="sbbs_update_plugin"[^>]*hidden>Update server plugin and restart<\/button>/);
    assert.match(install, /class="sbbs-install-update-status" role="status" aria-live="polite" hidden/);
    assert.match(install, /RELEASE=<span class="sbbs-release-tag">v0\.3\.0<\/span>/);
    assert.match(install, /git clone --branch "\$RELEASE" --depth 1/);
    assert.match(install, /npm --prefix plugins\/SillyBunny-BotSearcher ci --omit=dev --ignore-scripts --no-audit --no-fund/);
    assert.match(install, /set -eu/);
    assert.match(install, /GIT_ROOT="\$\(git -C "\$PLUGIN_ROOT" rev-parse --show-toplevel\)"/);
    assert.match(install, /test "\$GIT_ROOT" = "\$PLUGIN_ROOT"/);
    assert.match(install, /REMOTE="\$\(git -C "\$PLUGIN_ROOT" remote get-url origin\)"/);
    assert.match(install, /REPO_NO_SUFFIX="\$\{REPO%\.git\}"/);
    assert.match(install, /STATUS="\$\(git -C "\$PLUGIN_ROOT" status --porcelain --untracked-files=no\)"/);
    assert.match(install, /trap rollback ERR/);
    assert.match(install, /including on Windows/);
});
