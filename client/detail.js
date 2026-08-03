/**
 * The detail pane.
 *
 * Every value here came off a card site, so every value is written with
 * setText() or passed through the URL allow-check. The description is rendered
 * as pre-wrapped plain text: turning a stranger's markdown into HTML would mean
 * relying on a sanitizer for correctness, which is a bypass surface, for no
 * benefit in a "pick a card" flow.
 */

import { el, setText, setImgSafe, setLinkSafe } from './render.js';
import { post, thumbSrc } from './api.js';
import { getSettings } from './settings.js';
import { importCard, importCardBytes, openCharacter } from './importer.js';

/**
 * @param {HTMLElement} container the #sbbs_detail node
 * @param {any} summary the card as it appeared in the grid
 * @param {{ id: string, label: string, clientHosts: string[] }} source
 * @param {() => void} onBack
 */
export async function showDetail(container, summary, source, onBack) {
    container.replaceChildren();

    const settings = getSettings();

    const header = el('div', 'sbbs-detail-header');
    const back = el('button', 'menu_button sbbs-back');
    back.type = 'button';
    back.append(el('i', 'fa-solid fa-arrow-left'), el('span', undefined, 'Back'));
    back.addEventListener('click', onBack);
    header.append(back);
    container.append(header);

    const loading = el('div', 'sbbs-state', 'Loading…');
    container.append(loading);

    let card;
    try {
        card = await post('/detail', { source: source.id, id: summary.id });
    } catch (error) {
        setText(loading, describeError(error, source.label));
        const retry = el('button', 'menu_button', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => showDetail(container, summary, source, onBack));
        container.append(retry);
        return;
    }

    loading.remove();

    const body = el('div', 'sbbs-detail-body');

    // ---- preview ----
    const previewSrc = thumbSrc(card, source, 'detail', settings.imageMode);
    if (previewSrc) {
        const figure = el('div', 'sbbs-detail-image');
        const img = document.createElement('img');
        img.alt = '';
        if (setImgSafe(img, previewSrc, source.clientHosts)) {
            if (card.nsfw && settings.blurNsfw) {
                figure.classList.add('sbbs-blurred');
                figure.title = 'Click to reveal';
                figure.addEventListener('click', () => figure.classList.remove('sbbs-blurred'), { once: true });
            }
            figure.append(img);
            body.append(figure);
        }
    }

    const main = el('div', 'sbbs-detail-main');

    // ---- identity ----
    main.append(el('h2', 'sbbs-detail-name', card.name || 'Untitled'));

    const meta = el('div', 'sbbs-detail-meta');
    if (card.creator) {
        meta.append(el('span', 'sbbs-chip', `by ${card.creator}`));
    }
    if (card.pageUrl) {
        const link = document.createElement('a');
        link.className = 'sbbs-chip sbbs-chip-link';
        setText(link, `View on ${source.label}`);
        if (setLinkSafe(link, card.pageUrl, source.clientHosts)) {
            meta.append(link);
        }
    }
    if (meta.childElementCount > 0) {
        main.append(meta);
    }

    // ---- stats ----
    const stats = statLine(card.stats);
    if (stats) {
        main.append(el('div', 'sbbs-detail-stats', stats));
    }

    // ---- tags ----
    if (Array.isArray(card.tags) && card.tags.length > 0) {
        const tagRow = el('div', 'sbbs-tags');
        for (const tag of card.tags.slice(0, 24)) {
            tagRow.append(el('span', 'sbbs-tag', tag));
        }
        main.append(tagRow);
    }

    // ---- what's inside ----
    if (settings.showTrustPanel) {
        const panel = insidePanel(card.inside);
        if (panel) {
            main.append(panel);
        }
    }

    // ---- description ----
    if (card.description) {
        main.append(el('h3', 'sbbs-detail-subhead', 'Description'));
        main.append(el('div', 'sbbs-description', card.description));
    }
    if (card.firstMessage) {
        main.append(el('h3', 'sbbs-detail-subhead', 'First message'));
        main.append(el('div', 'sbbs-description', card.firstMessage));
    }
    if (card.creatorNotes) {
        main.append(el('h3', 'sbbs-detail-subhead', "Creator's notes"));
        main.append(el('div', 'sbbs-description', card.creatorNotes));
    }

    body.append(main);
    container.append(body);

    // ---- actions ----
    container.append(actionBar(card, source));
}

/**
 * The trust panel. Counts only — never the lorebook contents, which would be
 * more untrusted text with nothing to gain.
 */
function insidePanel(inside) {
    if (!inside || typeof inside !== 'object') {
        return null;
    }

    const rows = [];
    const add = (label, value) => rows.push({ label, value });

    if (inside.lorebookEntries === null) {
        add('Lorebook', 'present (size unknown)');
    } else if (inside.lorebookEntries > 0) {
        add('Lorebook', `${inside.lorebookEntries} entr${inside.lorebookEntries === 1 ? 'y' : 'ies'}`);
    }
    if (inside.alternateGreetings > 0) {
        add('Alternate greetings', String(inside.alternateGreetings));
    }
    if (inside.hasSystemPrompt) {
        add('System prompt', 'overrides yours');
    }
    if (inside.hasPostHistoryInstructions) {
        add('Post-history instructions', 'yes');
    }
    if (inside.hasDepthPrompt) {
        add('Depth prompt', 'yes');
    }
    if (inside.embeddedAssets > 0) {
        add('Extra images', String(inside.embeddedAssets));
    }
    if (inside.originSite) {
        add('Originally from', inside.originSite);
    }
    if (inside.specVersion) {
        add('Card format', inside.specVersion);
    }

    const panel = el('details', 'sbbs-inside');
    panel.open = rows.length > 0 && (inside.lorebookEntries > 0 || inside.hasSystemPrompt);

    const summary = document.createElement('summary');
    setText(summary, rows.length === 0 ? 'What’s inside this card: nothing unusual' : 'What’s inside this card');
    panel.append(summary);

    const list = el('dl', 'sbbs-inside-list');
    for (const row of rows) {
        list.append(el('dt', undefined, row.label), el('dd', undefined, row.value));
    }
    panel.append(list);

    return panel;
}

function actionBar(card, source) {
    const bar = el('div', 'sbbs-detail-actions');

    const button = el('button', 'menu_button sbbs-import');
    button.type = 'button';
    setText(button, 'Import');

    const status = el('span', 'sbbs-import-status');
    status.setAttribute('role', 'status');

    button.addEventListener('click', async () => {
        // The button is the lock: one import at a time.
        button.disabled = true;
        setText(button, 'Importing…');
        setText(status, '');

        try {
            // Native sources go through SillyBunny's own importer; the rest
            // need the server to fetch and validate the bytes first.
            const added = card.nativeImport === true
                ? await importCard(card, source.clientHosts)
                : await importCardBytes(card, source);

            setText(button, 'Imported');

            const open = el('button', 'menu_button sbbs-open-character', 'Go to character');
            open.type = 'button';
            open.addEventListener('click', () => openCharacter(added.avatar));
            bar.append(open);

            toastr.success(added.name || card.name || 'Character', 'Imported');

            // The bytes are the only honest source for this. If the card turned
            // out to carry something the listing never mentioned, say so.
            const surprise = describeSurprise(added.inside, card.inside);
            if (surprise) {
                toastr.info(surprise, 'What this card brought with it', { timeOut: 12000 });
            }
        } catch (error) {
            button.disabled = false;
            setText(button, 'Import failed — retry');
            setText(status, describeImportError(error));
            toastr.error(describeImportError(error), 'Import failed');
        }
    });

    bar.append(button, status);
    bar.append(el('p', 'sbbs-trust-note', 'Cards come from third-party sites. Review the description before starting a chat.'));
    return bar;
}

function statLine(stats) {
    if (!stats || typeof stats !== 'object') {
        return '';
    }
    const parts = [];
    if (stats.tokens !== null && stats.tokens !== undefined) {
        parts.push(`${stats.tokens} tokens`);
    }
    if (stats.downloads !== null && stats.downloads !== undefined) {
        parts.push(`${stats.downloads} downloads`);
    }
    if (stats.views !== null && stats.views !== undefined) {
        parts.push(`${stats.views} views`);
    }
    return parts.join(' · ');
}

function describeError(error, sourceLabel) {
    switch (error?.code) {
        case 'timeout':
            return `${sourceLabel} did not respond in time.`;
        case 'rate_limited':
            return 'Too many requests — wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy — try again shortly.`;
        default:
            return `Could not load this card from ${sourceLabel}.`;
    }
}

/**
 * Compares what the card actually contained against what the listing claimed.
 * Only the difference is worth interrupting for — repeating what the detail
 * view already showed is noise.
 */
function describeSurprise(actual, claimed) {
    if (!actual || typeof actual !== 'object') {
        return '';
    }

    const notes = [];
    const wasClaimed = (key) => claimed && typeof claimed === 'object' && claimed[key];

    if (actual.lorebookEntries > 0 && !wasClaimed('lorebookEntries')) {
        notes.push(`a lorebook with ${actual.lorebookEntries} entr${actual.lorebookEntries === 1 ? 'y' : 'ies'}`);
    }
    if (actual.hasSystemPrompt && !wasClaimed('hasSystemPrompt')) {
        notes.push('a system prompt that overrides yours');
    }
    if (actual.hasPostHistoryInstructions && !wasClaimed('hasPostHistoryInstructions')) {
        notes.push('post-history instructions');
    }
    if (actual.externalImages > 0) {
        notes.push(`${actual.externalImages} image${actual.externalImages === 1 ? '' : 's'} loaded from other sites`);
    }

    return notes.length === 0 ? '' : `This card also includes ${joinList(notes)}.`;
}

function joinList(items) {
    if (items.length === 1) {
        return items[0];
    }
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describeImportError(error) {
    switch (error?.message) {
        case 'import_url_rejected':
            return 'That download link was rejected as unsafe.';
        case 'import_unsupported':
            return 'This source cannot be imported yet.';
        case 'import_failed':
            return 'The card did not arrive. It may have been removed.';
        case 'card_invalid':
            return 'That download was not a usable character card.';
        case 'png_malformed':
        case 'not_a_png':
            return 'That download was damaged or incomplete.';
        case 'too_large':
            return 'That card is larger than this extension will download.';
        case 'use_native_import':
            return 'This source should import directly — please report this.';
        case 'rate_limited':
            return 'Too many downloads — wait a moment and try again.';
        default:
            return 'Something went wrong during import.';
    }
}
