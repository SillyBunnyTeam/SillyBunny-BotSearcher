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
import { postRouted, thumbSrc } from './api.js';
import { getSettings } from './settings.js';
import { commitPreparedCardImport, importCard, openCharacter, prepareCardImport } from './importer.js';
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
 * @param {{ id: string, label: string, clientHosts: string[], nativeImport?: boolean, capabilities?: any }} source
 * @param {() => void} onBack
 * @param {{ signal?: AbortSignal, onTag?: (tag: string) => void, onDirect?: (reason: string) => void, isSourceDirect?: (sourceId: string) => boolean }} [options]
 */
export async function showDetail(container, summary, source, onBack, options = {}) {
    const { signal, onTag, onDirect, isSourceDirect } = options;
    container.replaceChildren();

    const settings = getSettings();

    const header = el('div', 'sbbs-detail-header');
    const back = el('button', 'menu_button sbbs-back');
    back.type = 'button';
    const backIcon = el('i', 'fa-solid fa-arrow-left');
    backIcon.setAttribute('aria-hidden', 'true');
    back.append(backIcon, el('span', undefined, 'Back'));
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
        card = await postRouted('/detail', { source: source.id, id: summary.id }, source, {
            signal,
            allowDirect: settings.allowDirectRequests,
            onDirect,
        });
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
            return;
        }
        setText(loading, detailErrorMessage(error, source.label));
        const retry = el('button', 'menu_button', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', () => void showDetail(container, summary, source, onBack, options));
        container.append(retry);
        return;
    }

    if (signal?.aborted) {
        return;
    }

    if (!isExpectedDetail(card, summary, source)) {
        setText(loading, 'BotSearcher rejected a mismatched card response. Try searching again.');
        return;
    }

    loading.remove();

    const body = el('div', 'sbbs-detail-body');

    // ---- preview ----
    const previewSrc = thumbSrc(card, source, 'detail', settings.imageMode, isSourceDirect?.(source.id) === true);
    if (previewSrc) {
        const figure = el('div', 'sbbs-detail-image');
        const img = document.createElement('img');
        img.alt = '';
        if (setImgSafe(img, previewSrc, source.clientHosts)) {
            const rating = ratingOf(card);
            if (rating.value !== 'sfw' && settings.blurNsfw) {
                figure.classList.add('sbbs-blurred');
                // A real button, so revealing works by keyboard too.
                const reveal = el('button', 'sbbs-reveal', `Show ${rating.reveal} image`);
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
    const rating = ratingOf(card);
    meta.append(el('span', `sbbs-chip sbbs-rating-${rating.value}`, rating.label));
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
        // Clickable only where the source declares a tag filter, and only when
        // the caller gave us somewhere to send the click. Elsewhere they stay
        // plain text rather than looking interactive and doing nothing.
        const canFilter = typeof onTag === 'function'
            && (source.capabilities?.filters ?? []).some((filter) => filter.key === 'tags');

        const tagRow = el('div', 'sbbs-tags');
        for (const tag of card.tags.slice(0, 24)) {
            if (!canFilter) {
                tagRow.append(el('span', 'sbbs-tag', tag));
                continue;
            }
            const button = el('button', 'sbbs-tag sbbs-tag-button', tag);
            button.type = 'button';
            button.setAttribute('aria-label', `Search ${source.label} for tag ${tag}`);
            button.addEventListener('click', () => onTag(tag));
            tagRow.append(button);
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

function isExpectedDetail(card, summary, source) {
    return card
        && typeof card === 'object'
        && card.source === source.id
        && typeof card.id === 'string'
        && card.id === summary.id;
}

function ratingOf(card) {
    if (card?.contentRating === 'sfw') {
        return { value: 'sfw', label: 'SFW', reveal: 'SFW' };
    }
    if (card?.contentRating === 'sensitive') {
        return { value: 'sensitive', label: 'Sensitive content', reveal: 'sensitive' };
    }
    return { value: 'unknown', label: 'Content rating not reported', reveal: 'unrated' };
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
    const inspection = el('div', 'sbbs-import-inspection');
    let prepared = null;

    button.addEventListener('click', async () => {
        const native = source.nativeImport === true;
        button.disabled = true;
        setText(status, '');

        try {
            if (!native && !prepared) {
                setText(button, 'Inspecting...');
                prepared = await prepareCardImport(card, source);
                inspection.replaceChildren();
                const verified = insidePanel(prepared.inside);
                if (verified) {
                    verified.open = true;
                    inspection.append(verified);
                }
                const surprise = additionalImportContents(prepared.inside, card.inside);
                setText(
                    status,
                    surprise
                        ? `${surprise} Review the verified contents, then click again to import.`
                        : 'Card bytes were validated. Review the verified contents, then click again to import.',
                );
                button.disabled = false;
                setText(button, 'Import inspected card');
                return;
            }

            setText(button, 'Importing...');
            const added = native
                ? await importCard(card, source)
                : await commitPreparedCardImport(prepared);

            setText(button, 'Imported');

            const open = el('button', 'menu_button sbbs-open-character', 'Open character');
            open.type = 'button';
            open.addEventListener('click', () => openCharacter(added.avatar));
            bar.append(open);

            toastr.success('Character imported.', 'Imported');
        } catch (error) {
            button.disabled = false;
            setText(button, prepared ? 'Import inspected card' : 'Try import again');
            setText(status, importErrorMessage(error));
            toastr.error(importErrorMessage(error), 'Import failed');
        }
    });

    bar.append(button, status, inspection);
    bar.append(el('p', 'sbbs-trust-note', 'Cards come from third-party sites. Review the description and card contents before starting a chat.'));
    return bar;
}
