/**
 * The intake screen: what a card actually contains, before it joins the collection.
 *
 * Everything shown here is derived from the card's own bytes, not from what the
 * listing claimed — that distinction is the point of the screen, and the two are
 * shown side by side when they disagree.
 *
 * The same rule as the rest of the extension applies to every value: it was
 * written by a stranger, so it is written to the DOM through setText() and
 * never as markup. Counts and flags are reported; lorebook text, script bodies
 * and macro arguments are the card's content and are not reproduced. The card's
 * own text does reach this screen — the token cost has to be measured with the
 * host tokenizer, which needs the text — but it is counted and discarded, never
 * rendered.
 *
 * Structural validation is not a safety verdict, and the screen says so rather
 * than implying that a card with an empty findings list is safe to run.
 */

import { el, setLinkSafe, setText } from './render.js';
import {
    cleanBytes,
    commitPreparedCardImport,
    fetchUrlCard,
    fetchNativeCardBytes,
    importCard,
    inspectBytes,
    openCharacter,
    prepareCardImport,
    readLocalCardFile,
} from './importer.js';
import { jannyBrowserControl, saucepanAccountControl } from './settings.js';
import {
    additionalImportContents,
    cleanKeeps,
    cleanPlan,
    duplicateMessage,
    importErrorMessage,
    intakeErrorMessage,
    intakeIdentity,
    intakeSections,
    tokenFootprint,
} from './copy.js';

/** Fields compared against an installed copy, in the order they are listed. */
const COMPARED_FIELDS = Object.freeze([
    ['description', 'description', 'description'],
    ['personality', 'personality', 'personality'],
    ['scenario', 'scenario', 'scenario'],
    ['firstMessage', 'first_mes', 'first message'],
    ['messageExample', 'mes_example', 'example messages'],
    ['systemPrompt', 'system_prompt', 'system prompt'],
    ['postHistoryInstructions', 'post_history_instructions', 'post-history instructions'],
]);

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {HTMLElement} container the #sbbs_intake node
 * @param {{ card?: any, source?: any, file?: File }} request where the card is coming from
 * @param {() => void} onBack
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function showIntake(container, request, onBack, { signal } = {}) {
    container.replaceChildren();

    const header = el('div', 'sbbs-detail-header');
    const back = el('button', 'menu_button sbbs-back');
    back.type = 'button';
    const backIcon = el('i', 'fa-solid fa-arrow-left');
    backIcon.setAttribute('aria-hidden', 'true');
    back.append(backIcon, el('span', undefined, 'Back'));
    back.addEventListener('click', onBack);
    header.append(back);
    // Named after the button that opens it, so the transition explains itself.
    container.append(header, el('h2', 'sbbs-intake-title', 'Review and import'));

    const status = el('div', 'sbbs-state', 'Fetching the card...');
    status.setAttribute('role', 'status');
    container.append(status);
    back.focus();

    let prepared;
    try {
        prepared = await loadBytes(request, signal);
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
            return;
        }
        showNotInspected(container, status, request, error, onBack, signal);
        return;
    }

    if (signal?.aborted) {
        return;
    }

    setText(status, 'Inspecting the card...');

    let report;
    try {
        report = await inspectBytes(prepared.file, { signal });
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
            return;
        }
        showNotInspected(container, status, request, error, onBack, signal);
        return;
    }

    if (signal?.aborted) {
        return;
    }

    status.remove();
    const inside = report?.inside ?? {};
    const body = el('div', 'sbbs-intake-body');

    // ---- identity ----
    const name = inside.name || request.card?.name || prepared.file.name;
    body.append(el('h3', 'sbbs-intake-name', name));

    const identity = intakeIdentity(inside);
    if (identity) {
        body.append(el('div', 'sbbs-intake-identity', identity));
    }

    const origin = originLine(request, inside);
    if (origin.length > 0) {
        const list = el('dl', 'sbbs-intake-origin');
        for (const row of origin) {
            list.append(el('dt', undefined, row.label), el('dd', undefined, row.value));
        }
        body.append(list);
    }

    // ---- already installed? ----
    const found = await findInstalled(inside);
    if (signal?.aborted) {
        return;
    }
    const match = found?.unknown === true ? null : found;
    const duplicate = el('p', found ? 'sbbs-intake-duplicate sbbs-intake-warn' : 'sbbs-intake-duplicate');
    setText(duplicate, duplicateMessage(found));
    body.append(duplicate);

    // ---- what the listing did not mention ----
    // The gap between the two is worth stating on its own. A card carrying a
    // system prompt the listing never advertised is a different proposition from
    // one that said so up front, and the full report below does not make that
    // difference obvious on its own.
    const undisclosed = additionalImportContents(inside, request.card?.inside);
    if (undisclosed) {
        body.append(el('p', 'sbbs-intake-undisclosed', undisclosed));
    }

    // ---- what this card costs ----
    const footprint = el('p', 'sbbs-intake-tokens', 'Measuring token cost...');
    const footprintRows = el('dl', 'sbbs-intake-list');
    body.append(el('h4', 'sbbs-intake-section', 'Token cost'), footprint, footprintRows);
    void countTokens(inside).then((counts) => {
        if (signal?.aborted) {
            return;
        }
        const { headline, rows } = tokenFootprint(counts);
        setText(footprint, headline);
        for (const entry of rows) {
            footprintRows.append(el('dt', undefined, entry.label), el('dd', undefined, entry.value));
        }
    });

    // ---- the report ----
    const sections = intakeSections(inside);
    if (sections.length === 0) {
        body.append(el('p', 'sbbs-intake-empty', 'No lorebook, scripts, prompts or external references were found in these bytes.'));
    }
    for (const section of sections) {
        body.append(el('h4', 'sbbs-intake-section', section.title));
        const list = el('dl', 'sbbs-intake-list');
        for (const row of section.rows) {
            const term = el('dt', row.tone ? `sbbs-intake-${row.tone}` : undefined, row.label);
            list.append(term, el('dd', undefined, row.value));
        }
        body.append(list);
    }

    body.append(el(
        'p',
        'sbbs-trust-note',
        'This describes the bytes that would be imported. It does not establish that the card\'s instructions are safe or appropriate.',
    ));

    container.append(body);
    container.append(actionBar(prepared, inside, match, onBack));
}

/**
 * Gets the card's bytes, by whichever route this source allows.
 *
 * A native source is downloaded by SillyBunny's own importer route, so the
 * bytes described here are the bytes that would be imported.
 */
async function loadBytes(request, signal) {
    if (request.file) {
        return readLocalCardFile(request.file);
    }
    const bridged = request.source?.capabilities?.browserImport === true;
    const native = request.source?.nativeImport === true;
    if (typeof request.url === 'string') {
        return native && bridged
            ? nativeThenBridge({ importUrl: request.url }, request.source, signal)
            : fetchUrlCard(request.url, request.source, { signal });
    }
    if (bridged && typeof request.card?.importUrl === 'string') {
        return native
            ? nativeThenBridge(request.card, request.source, signal)
            : fetchUrlCard(request.card.importUrl, request.source, { signal });
    }
    if (native) {
        return fetchNativeCardBytes(request.card, request.source, { signal });
    }
    return prepareCardImport(request.card, request.source, { signal });
}

/**
 * The zero-setup native downloader first, the browser bridge as the fallback
 * for hosts Cloudflare blocks and for private cards.
 *
 * The bridge needs Playwright and a login on the server, so leading with it
 * made a fresh install's first JannyAI import fail with setup instructions
 * while the route that needs no setup sat unused. Login is the one bridge
 * failure the user can act on from this screen; for every other bridge state
 * the native error's guidance is the useful one, so that is the error kept.
 */
async function nativeThenBridge(card, source, signal) {
    try {
        return await fetchNativeCardBytes(card, source, { signal });
    } catch (nativeError) {
        if (nativeError?.name === 'AbortError' || signal?.aborted) {
            throw nativeError;
        }
        try {
            return await fetchUrlCard(card.importUrl, source, { signal });
        } catch (bridgeError) {
            if (bridgeError?.name === 'AbortError' || bridgeError?.message === 'janny_login_required') {
                throw bridgeError;
            }
            if (bridgeError?.message === 'janny_browser_unavailable') {
                // Lets the recovery text suggest setting the bridge up.
                nativeError.bridgeUnavailable = true;
            }
            throw nativeError;
        }
    }
}

/**
 * When the card could not be fetched or read.
 *
 * A native card can still be imported the way it always was, so the offer stays
 * — clearly labelled as skipping the inspection rather than passing it. A
 * login failure gets the matching login control inline: sending the user out
 * of this modal to the settings drawer would throw away the URL, the results
 * and their place in the task.
 */
function showNotInspected(container, status, request, error, onBack, signal) {
    setText(status, intakeErrorMessage(error, request.source?.id));

    const actions = el('div', 'sbbs-detail-actions');
    const recovery = nativeRecovery(request, error);
    if (recovery) {
        actions.append(recovery);
    }

    const code = error?.message ?? error?.code;
    if (request.source?.id === 'saucepan' && ['saucepan_login_required', 'saucepan_session_expired'].includes(code)) {
        actions.append(saucepanAccountControl('sbbs_intake_saucepan'));
    }
    if (request.source?.id === 'jannyai' && code === 'janny_login_required') {
        actions.append(jannyBrowserControl('sbbs_intake_janny'));
    }
    if (request.source?.nativeImport === true && request.card) {
        actions.append(el(
            'p',
            'sbbs-intake-warn',
            'This card was not inspected. Importing now adds it to your collection without a report of its contents.',
        ));

        const anyway = el('button', 'menu_button sbbs-import', 'Import without inspecting');
        anyway.type = 'button';
        const result = el('span', 'sbbs-import-status');
        result.setAttribute('role', 'status');
        anyway.addEventListener('click', async () => {
            anyway.disabled = true;
            setText(anyway, 'Importing...');
            try {
                const added = await importCard(request.card, request.source);
                setText(anyway, 'Imported');
                actions.append(openButton(added));
                toastr.success('Character imported.');
            } catch (importError) {
                anyway.disabled = false;
                setText(anyway, 'Try import again');
                setText(result, importErrorMessage(importError));
                toastr.error(importErrorMessage(importError), 'Import failed');
            }
        });
        actions.append(anyway, result);
    }

    // Worth offering for every failure: transient ones pass on a retry, and a
    // login fixed just above needs one to take effect.
    const tryAgain = el('button', 'menu_button', 'Try again');
    tryAgain.type = 'button';
    tryAgain.addEventListener('click', () => void showIntake(container, request, onBack, { signal }));
    actions.append(tryAgain);

    const retry = el('button', 'menu_button', 'Back');
    retry.type = 'button';
    retry.addEventListener('click', onBack);
    actions.append(retry);
    container.append(actions);
}

function nativeRecovery(request, error) {
    if ((error?.message ?? error?.code) !== 'native_download_failed'
        || request.source?.id !== 'jannyai') {
        return null;
    }

    const recovery = el('div', 'sbbs-intake-recovery');
    const instructions = el(
        'p',
        undefined,
        'Download the card from JannyAI, then return to the browse dialog and choose “Inspect a card file” in Filters.',
    );
    const pageUrl = request.card?.pageUrl;
    if (typeof pageUrl === 'string' && pageUrl !== '') {
        const link = document.createElement('a');
        setText(link, 'Open JannyAI page');
        if (setLinkSafe(link, pageUrl, request.source.clientHosts)) {
            instructions.append(document.createTextNode(' '), link);
        }
    }
    recovery.append(instructions);
    if (error?.bridgeUnavailable === true) {
        recovery.append(el(
            'p',
            undefined,
            'Setting up JannyAI browser import under Extensions > BotSearcher lets the server fetch cards Cloudflare blocks.',
        ));
    }
    return recovery;
}

/** Where the card came from, and who the bytes say made it. */
function originLine(request, inside) {
    const rows = [];
    if (request.source?.label) {
        rows.push({ label: 'Source', value: request.source.label });
    }
    if (request.file) {
        rows.push({ label: 'Source', value: `Local file (${request.file.name})` });
    }
    if (typeof request.card?.pageUrl === 'string' && request.card.pageUrl !== '') {
        rows.push({ label: 'Original address', value: request.card.pageUrl });
    }
    if (typeof request.url === 'string' && request.url !== '') {
        rows.push({ label: 'Original address', value: request.url });
    }
    if (inside.creator) {
        // The listing's creator and the card's own can disagree; both are shown
        // rather than picking one and calling it the creator.
        const reported = request.card?.creator;
        rows.push({
            label: 'Creator in the card',
            value: reported && reported !== inside.creator
                ? `${inside.creator} (the listing says ${reported})`
                : inside.creator,
        });
    }
    if (inside.characterVersion) {
        rows.push({ label: 'Card version', value: inside.characterVersion });
    }
    return rows;
}

/**
 * Finds an installed character with the same name and lists what differs.
 *
 * Name matching is deliberate rather than clever: the avatar filename is the
 * host's identity for a character and says nothing about which card it came
 * from, and there is no hash of the installed file to compare against.
 *
 * The list is refreshed first. `getContext().characters` is empty until the app
 * has fetched it, so reading it as-is reports "not in your collection" for a
 * card that plainly is — a false all-clear, which is the one answer this screen
 * must never give by accident. If the refresh fails, that is reported as not
 * knowing rather than as not finding.
 *
 * @returns {Promise<{name: string, avatar: string, differences: string[]} | {unknown: true} | null>}
 */
async function findInstalled(inside) {
    const wanted = String(inside.name ?? '').trim().toLowerCase();
    if (wanted === '') {
        return null;
    }

    const ctx = context();
    try {
        await ctx.getCharacters();
    } catch {
        return { unknown: true };
    }

    const characters = ctx.characters;
    if (!Array.isArray(characters)) {
        return { unknown: true };
    }

    const installed = characters.find((entry) => String(entry?.name ?? '').trim().toLowerCase() === wanted);
    if (!installed) {
        return null;
    }

    return {
        name: installed.name,
        avatar: installed.avatar,
        differences: differencesFrom(installed, inside),
    };
}

function differencesFrom(installed, inside) {
    const differences = [];
    const data = installed.data ?? {};
    const read = (key) => {
        const fromData = data[key];
        const value = typeof fromData === 'string' ? fromData : installed[key];
        return typeof value === 'string' ? value : '';
    };

    if (inside.promptText?.truncated !== true) {
        const fields = inside.promptText?.fields ?? {};
        for (const [reportKey, hostKey, label] of COMPARED_FIELDS) {
            if ((fields[reportKey] ?? '') !== read(hostKey)) {
                differences.push(label);
            }
        }
    }

    const entries = Array.isArray(data.character_book?.entries) ? data.character_book.entries.length : 0;
    if (typeof inside.lorebookEntries === 'number' && inside.lorebookEntries !== entries) {
        differences.push('lorebook');
    }

    const greetings = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.length : 0;
    if (typeof inside.alternateGreetings === 'number' && inside.alternateGreetings !== greetings) {
        differences.push('set of alternate greetings');
    }

    return differences;
}

/**
 * Which card fields land in which bucket.
 *
 * Grouped by when the text is in context rather than by field, because that is
 * the question the screen answers. The first group is there for every request;
 * the greeting is there once, as the opening message; the examples are dropped
 * again as soon as the chat grows past them.
 */
const TOKEN_BUCKETS = Object.freeze([
    ['always', ['description', 'personality', 'scenario', 'systemPrompt', 'postHistoryInstructions']],
    ['greeting', ['firstMessage']],
    ['examples', ['messageExample']],
]);

/**
 * Measures the card with SillyBunny's own tokenizer, so the numbers match what
 * the rest of the app would report.
 *
 * The text measured here is never rendered; only these counts are.
 */
async function countTokens(inside) {
    const ctx = context();
    if (inside.promptText?.truncated !== false || typeof ctx.getTokenCountAsync !== 'function') {
        return { measured: false };
    }

    const fields = inside.promptText.fields ?? {};
    const count = async (text) => (text === '' ? 0 : ctx.getTokenCountAsync(text));
    const book = inside.promptText.lorebook;
    const measurableBook = book && book.truncated === false ? book : null;

    try {
        // The buckets are independent, so they are counted together rather than
        // one after another — five round trips to the tokenizer in sequence is a
        // visible pause on a slow one.
        const totals = await Promise.all([
            ...TOKEN_BUCKETS.map(([, keys]) => count(keys.map(key => fields[key] ?? '').filter(Boolean).join('\n'))),
            count(measurableBook?.always ?? ''),
            count(measurableBook?.conditional ?? ''),
        ]);
        if (!totals.every(Number.isFinite)) {
            return { measured: false };
        }

        const counts = { measured: true, lorebook: null };
        TOKEN_BUCKETS.forEach(([bucket], index) => {
            counts[bucket] = totals[index];
        });

        if (book) {
            counts.lorebook = measurableBook
                ? {
                    measured: true,
                    always: totals[TOKEN_BUCKETS.length],
                    conditional: totals[TOKEN_BUCKETS.length + 1],
                    alwaysEntries: book.alwaysEntries ?? 0,
                    conditionalEntries: book.conditionalEntries ?? 0,
                }
                : { measured: false };
        }

        return counts;
    } catch {
        // A tokenizer that is still loading is not worth failing the screen for.
        return { measured: false };
    }
}

function openButton(added) {
    const open = el('button', 'menu_button sbbs-open-character', 'Open character');
    open.type = 'button';
    open.addEventListener('click', () => openCharacter(added.avatar));
    return open;
}

/**
 * Exact or clean, plus replace when the card is already installed.
 *
 * Clean import states what it will drop from THIS card and what it will keep,
 * because a fixed profile is only honest if it is itemised at the point of use.
 */
function actionBar(prepared, inside, match, onBack) {
    const bar = el('div', 'sbbs-detail-actions');
    const status = el('span', 'sbbs-import-status');
    status.setAttribute('role', 'status');

    const removals = cleanPlan(inside);
    const keeps = cleanKeeps(inside);

    const exact = el('button', 'menu_button sbbs-import', 'Import exactly');
    exact.type = 'button';

    const clean = el('button', 'menu_button sbbs-import-clean', 'Clean import');
    clean.type = 'button';
    clean.disabled = removals.length === 0;

    // `label.control` is read-only in the DOM, so the input is held separately
    // rather than hung off the label.
    let replaceLabel = null;
    let replaceInput = null;
    if (match) {
        replaceLabel = document.createElement('label');
        replaceLabel.className = 'checkbox_label sbbs-intake-replace';
        replaceInput = document.createElement('input');
        replaceInput.type = 'checkbox';
        replaceLabel.append(replaceInput, el('span', undefined, `Replace the installed "${match.name}" instead of adding a copy`));
    }

    const run = async (button, transform) => {
        for (const control of [exact, clean]) {
            control.disabled = true;
        }
        const original = button.textContent;
        setText(status, '');
        setText(button, 'Importing...');

        try {
            const bytes = await transform();
            const added = await commitPreparedCardImport(bytes, {
                replaceAvatar: replaceInput?.checked ? match.avatar : undefined,
            });
            setText(button, 'Imported');
            bar.append(openButton(added));
            toastr.success('Character imported.');
        } catch (error) {
            exact.disabled = false;
            clean.disabled = removals.length === 0;
            setText(button, original);
            setText(status, importErrorMessage(error));
            toastr.error(importErrorMessage(error), 'Import failed');
        }
    };

    exact.addEventListener('click', () => void run(exact, () => prepared));
    clean.addEventListener('click', () => void run(clean, () => cleanBytes(prepared)));

    // The explanation of what Clean import will do sits ABOVE the two look-alike
    // buttons, so the choice is informed before it is offered rather than after.
    const explanation = el('div', 'sbbs-intake-clean-note');
    if (removals.length === 0) {
        explanation.append(el('p', undefined, 'Clean import has nothing to remove from this card.'));
    } else {
        explanation.append(el('p', undefined, `Clean import removes ${removals.join(', ')}.`));
        if (keeps.length > 0) {
            explanation.append(el('p', undefined, `It keeps ${keeps.join(', ')}.`));
        }
    }
    bar.append(explanation);

    bar.append(exact, clean);
    if (replaceLabel) {
        bar.append(replaceLabel);
    }
    bar.append(status);

    // Returning to the grid has to stay reachable from the bottom of a long report.
    const backAgain = el('button', 'menu_button sbbs-intake-back', 'Back');
    backAgain.type = 'button';
    backAgain.addEventListener('click', onBack);
    bar.append(backAgain);

    return bar;
}
