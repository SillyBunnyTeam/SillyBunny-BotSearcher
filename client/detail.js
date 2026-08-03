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
import {
    additionalImportContents,
    detailErrorMessage,
    importErrorMessage,
    insideRows,
    sourceStatLine,
} from './copy.js';

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

    // The detail pane replaces the grid, so focus has to follow it or the user
    // is left tabbing through a hidden view.
    back.focus();

    const loading = el('div', 'sbbs-state', 'Loading card details...');
    container.append(loading);

    let card;
    try {
        card = await post('/detail', { source: source.id, id: summary.id });
    } catch (error) {
        setText(loading, detailErrorMessage(error, source.label));
        const retry = el('button', 'menu_button', 'Try again');
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
                // A real button, so revealing works by keyboard too.
                const reveal = el('button', 'sbbs-reveal', 'Show sensitive image');
                reveal.type = 'button';
                reveal.addEventListener('click', () => {
                    figure.classList.remove('sbbs-blurred');
                    reveal.remove();
                }, { once: true });
                figure.append(reveal);
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
    const stats = sourceStatLine(source.id, card.stats);
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

    // ---- source-reported card contents ----
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
 * Summarizes reported metadata, never raw lorebook or script contents.
 */
function insidePanel(inside) {
    if (!inside || typeof inside !== 'object') {
        return null;
    }

    const rows = insideRows(inside);

    const panel = el('details', 'sbbs-inside');
    panel.open = inside.lorebookEntries > 0
        || inside.hasSystemPrompt
        || inside.hasPostHistoryInstructions
        || inside.hasDepthPrompt
        || inside.regexScripts > 0;

    const summary = document.createElement('summary');
    setText(summary, 'Card contents');
    panel.append(summary);

    if (rows.length === 0) {
        panel.append(el('p', 'sbbs-inside-empty', 'No additional details reported by this source.'));
        return panel;
    }

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
    setText(button, 'Import card');

    const status = el('span', 'sbbs-import-status');
    status.setAttribute('role', 'status');

    button.addEventListener('click', async () => {
        // The button is the lock: one import at a time.
        button.disabled = true;
        setText(button, 'Importing...');
        setText(status, '');

        try {
            // Native sources go through SillyBunny's own importer; the rest
            // need the server to fetch and validate the bytes first.
            const added = card.nativeImport === true
                ? await importCard(card, source.clientHosts)
                : await importCardBytes(card, source);

            setText(button, 'Imported');

            const open = el('button', 'menu_button sbbs-open-character', 'Open character');
            open.type = 'button';
            open.addEventListener('click', () => openCharacter(added.avatar));
            bar.append(open);

            toastr.success(added.name || card.name || 'Character', 'Imported');

            // The bytes are the only honest source for this. If the card turned
            // out to carry something the listing never mentioned, say so.
            const surprise = additionalImportContents(added.inside, card.inside);
            if (surprise) {
                toastr.info(surprise, 'Additional contents found', { timeOut: 12000 });
            }
        } catch (error) {
            button.disabled = false;
            setText(button, 'Try import again');
            setText(status, importErrorMessage(error));
            toastr.error(importErrorMessage(error), 'Import failed');
        }
    });

    bar.append(button, status);
    bar.append(el('p', 'sbbs-trust-note', 'Cards come from third-party sites. Review the description and card contents before starting a chat.'));
    return bar;
}
