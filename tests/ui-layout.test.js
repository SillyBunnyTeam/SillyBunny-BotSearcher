import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';

const ROOT = new URL('../', import.meta.url);
const ORIGIN = 'https://sbbs-layout.test';
const HOST_ORIGIN = 'https://sillybunny-host.test';
const VIEWPORTS = [[1440, 900], [1280, 480], [360, 640], [320, 568], [360, 400], [320, 320],
    [1440, 900, 2], [360, 640, 2], [320, 568, 2]];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');
const SOURCE = { id: 'chub', label: 'Chub', clientHosts: ['cards.test'], capabilities: { filters: [{ key: 'tags' }] } };
const CARD = {
    source: 'chub', id: 'layout-card', name: 'Mara, the station archivist', creator: 'Sample author',
    tagline: 'An archivist cataloguing the last arrivals at a remote station.',
    description: 'Source listing prose stays visible as plain text. '.repeat(100),
    firstMessage: 'Source first message.', creatorNotes: 'Source creator notes.',
    contentRating: 'sensitive', thumbRef: 'local-preview', pageUrl: 'https://cards.test/card',
    tags: Array.from({ length: 30 }, (_, i) => `archive-tag-${i + 1}`),
    inside: { lorebookEntries: 12, hasSystemPrompt: true },
};
const PRIVATE_TEXT = 'INTAKE_PRIVATE_PROMPT_MUST_NOT_RENDER';
const REPORT = { kind: 'png', inside: {
    name: CARD.name, scan: { complete: true, reasons: [] },
    lorebookEntries: 12, regexScripts: 2, hasSystemPrompt: true, hasDepthPrompt: true,
    alternateGreetings: 4, byteSize: 4096, sha256: 'a'.repeat(64),
    externalUrls: { count: 2, hosts: ['verylonghost'.repeat(12) + '.test'] },
    promptText: { truncated: false, fields: { description: PRIVATE_TEXT, systemPrompt: PRIVATE_TEXT },
        lorebook: { truncated: false, always: PRIVATE_TEXT, conditional: PRIVATE_TEXT, alwaysEntries: 1, conditionalEntries: 11 } },
} };

// A disposable host shell, not a saved profile or a connection to SillyBunny.
// Only host sizing/control defaults are approximated; product CSS and modules are real.
const HOST_CSS = `
    * { box-sizing: border-box; }
    body { margin: 0; font: var(--mainFontSize)/1.5 system-ui, sans-serif; background: #24212b; color: #e6e0eb; }
    :root { --fontScale: 1; --mainFontSize: calc(var(--fontScale) * 15px); --sheldWidth: 50vw;
        --sb-shell-surface: #302c38; --sb-muted-fg: #bcb4c8; --sb-accent: #c1a1df;
        --sb-focus-ring: #dfbcfa; --sb-shell-border: #71667e; --sb-radius-sm: 6px; }
    .popup { display: flex; flex-direction: column; width: min(500px, calc(100dvw - 2em));
        max-height: calc(100dvh - 2em); max-width: calc(100dvw - 2em); min-height: fit-content;
        padding: 12px 20px; border: 1px solid #71667e; overflow: visible; text-align: center;
        border-radius: 1.65rem; background: var(--sb-shell-surface); color: inherit; }
    .large_dialogue_popup { height: 90dvh !important; max-width: 90dvw !important; }
    .wide_dialogue_popup { min-width: var(--sheldWidth); }
    .popup .popup-body { display: flex; flex-direction: column; overflow: hidden;
        width: min(100%, 100vw); height: 100%; max-height: 95dvh; padding: 1px; }
    .popup .popup-content { margin-top: 10px; padding: 0 8px; overflow: hidden; flex-grow: 1; }
    .popup.left_aligned_dialogue_popup .popup-content { text-align: start; }
    @media screen and (max-width: 1000px) { .popup .popup-content { overflow-y: auto; } }
    .popup-controls { margin-top: 8px; display: flex; flex-wrap: wrap; justify-content: center;
        max-width: 100%; padding: 6px; align-self: center; gap: 12px; }
    .popup .popup-button-close { position: absolute; top: -6px; right: -6px; width: 24px;
        height: 24px; font-size: 20px; padding: 2px 3px 3px 2px; }
    .popup-button-close::before { content: 'X'; }
    button, input, select { font: inherit; color: inherit; }
    .menu_button { display: flex; align-items: center; justify-content: center; gap: 6px;
        width: min-content; white-space: nowrap; padding: 6px 16px; margin: 0;
        min-width: 38px; min-height: 38px; line-height: 1.2; font-size: calc(var(--mainFontSize) * .86);
        border: 1px solid #71667e; border-radius: 6px; background: #42394d; cursor: pointer; }
    .popup-controls .menu_button { width: unset; margin: 0; max-width: 100%; flex-grow: 1; white-space: normal; }
    .text_pole { width: 100%; min-height: 36px; padding: 5px; margin: 5px 0;
        background: #24212b; border: 1px solid #71667e; border-radius: 6px; }
    .checkbox_label { display: flex; align-items: center; gap: 8px; }
    input[type=checkbox], input[type=radio] { flex: none; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #dfbcfa; outline-offset: -2px; }
    button:disabled { opacity: .5; }
    a { color: #d6b5ee; }
`;

test('isolated browser layouts, live detail states, keyboard focus and intake privacy', {
    skip: !existsSync(chromium.executablePath()) && 'Playwright Chromium is not installed', timeout: 120_000,
}, async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const hostPublic = process.env.SILLYBUNNY_PUBLIC && await realpath(process.env.SILLYBUNNY_PUBLIC);
    const screenshots = await mkdtemp(join(tmpdir(), `sbbs-ui-layout-${hostPublic ? 'actualhost-' : ''}`));
    t.diagnostic(`Fresh screenshots: ${screenshots}`);
    let hostStyles = `<style>${HOST_CSS}</style>`;
    if (hostPublic) {
        // jsdom only parses markup here: no host scripts, resources or private user CSS.
        const host = new JSDOM(await readFile(join(hostPublic, 'index.html'), 'utf8'), { url: `${HOST_ORIGIN}/` });
        hostStyles = [...host.window.document.head.querySelectorAll('style, link[rel="stylesheet"], link[data-sb-deferred-style]')]
            .map((node) => {
                if (node.tagName === 'STYLE') { return node.outerHTML; }
                const url = new URL(node.href);
                if (url.pathname.endsWith('/user.css')) { return ''; }
                assert.equal(url.origin, HOST_ORIGIN, 'host styles must be local static files');
                const link = host.window.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = url.href;
                link.media = node.getAttribute('data-sb-media') ?? node.getAttribute('media') ?? 'all';
                return link.outerHTML;
            }).join('\n');
        host.window.close();
        assert.ok(hostStyles.includes(`${HOST_ORIGIN}/style.css`), 'actual host base stylesheet is included');
    }
    const template = await readFile(new URL('templates/browser.html', ROOT), 'utf8');
    const requests = [];
    const unexpected = [];
    const errors = [];
    const labelFailures = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let detailResponse = CARD;
    let detailStatus = 200;
    let detailGate;
    let collection = [{ name: CARD.name, avatar: `${'long-installed-filename-'.repeat(12)}.png`, data: {} }];
    let report = structuredClone(REPORT);
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.pathname);
        if (hostPublic && url.origin === HOST_ORIGIN) {
            // CSS background images are deliberately excluded; only styles and fonts are loaded.
            if (route.request().resourceType() === 'image') { return route.abort(); }
            const pathname = decodeURIComponent(url.pathname);
            const type = { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }[extname(pathname)];
            if (type && !pathname.endsWith('/user.css') && ['stylesheet', 'font'].includes(route.request().resourceType())) {
                const file = await realpath(resolve(hostPublic, `.${pathname}`));
                const local = relative(hostPublic, file);
                assert.ok(local && local !== '..' && !local.startsWith(`..${sep}`), 'static assets stay inside the public directory');
                return route.fulfill({ contentType: type, headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: await readFile(file) });
            }
        }
        if (url.origin !== ORIGIN) {
            unexpected.push(url.href);
            return route.abort();
        }
        if (url.pathname === '/') {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                ${hostStyles}<link rel="stylesheet" href="/style.css"></head><body class="no-blur">
                <dialog class="popup large_dialogue_popup wide_dialogue_popup left_aligned_dialogue_popup">
                <div class="popup-body"><div class="popup-content">${template}</div>
                <div class="popup-controls"><div class="popup-button-cancel menu_button result-control" role="button" tabindex="0">Close</div></div></div>
                <div class="popup-button-close right_menu_button fa-solid fa-circle-xmark" role="button" tabindex="0" aria-label="Close popup"></div>
                </dialog></body></html>` });
        }
        if (/^\/(client|shared)\/[a-z0-9-]+\.js$/.test(url.pathname) || url.pathname === '/style.css') {
            return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
                body: await readFile(new URL(url.pathname.slice(1), ROOT), 'utf8') });
        }
        if (url.pathname.endsWith('/detail')) {
            await detailGate;
            return route.fulfill({ status: detailStatus, json: detailResponse });
        }
        if (url.pathname.endsWith('/thumb')) {
            return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="390"><rect width="260" height="390" fill="#665777"/><circle cx="130" cy="125" r="55" fill="#b5a2c7"/><path d="M35 365V275Q130 185 225 275V365Z" fill="#b5a2c7"/></svg>' });
        }
        if (url.pathname === '/api/characters/all') {
            return route.fulfill({ json: collection });
        }
        if (url.pathname.startsWith('/characters/') || url.pathname.endsWith('/card')) {
            return route.fulfill({ contentType: 'image/png', body: PNG });
        }
        if (url.pathname.endsWith('/inspect')) {
            return route.fulfill({ json: report });
        }
        unexpected.push(url.href);
        return route.abort();
    });
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
        document.querySelector('dialog').showModal();
        await document.fonts.ready;
    });
    await page.evaluate(async ({ card, source }) => {
        const settings = {};
        globalThis.SillyTavern = { getContext: () => ({
            extensionSettings: settings, saveSettingsDebounced() {},
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            getTokenCountAsync: async (text) => text.length,
        }) };
        globalThis.toastr = { error() {} };
        window.ui = { ...await import('/client/detail.js'), ...await import('/client/filters.js'),
            ...await import('/client/intake.js'), card, source };
        document.querySelector('#sbbs_source').append(new Option('Chub', 'chub'));
        document.querySelector('#sbbs_sort').append(new Option('Most downloaded', 'downloads'));
    }, { card: CARD, source: SOURCE });

    async function openDetail(source = SOURCE) {
        await page.evaluate((source) => {
            document.querySelector('.sbbs-root').dataset.view = 'detail';
            void window.ui.showDetail(document.querySelector('#sbbs_detail'), window.ui.card, source, () => {}, {
                onTag: (tag) => { window.selectedTag = tag; },
            });
        }, source);
    }
    async function capture(name) {
        await page.screenshot({ path: join(screenshots, `${name}.png`) });
        // A min-content button can fit its parent while breaking every word.
        // Measure rendered words after scrolling each control into reach, then restore the view.
        const failures = await page.evaluate(() => {
            const failures = [];
            const scrolls = [...document.querySelectorAll('.popup, .popup *')]
                .map((node) => [node, node.scrollLeft, node.scrollTop]);
            for (const button of document.querySelectorAll('.sbbs-root .menu_button')) {
                if (!button.checkVisibility({ visibilityProperty: true })) { continue; }
                button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                const box = button.getBoundingClientRect();
                const style = getComputedStyle(button);
                let left = Math.max(0, box.left + button.clientLeft);
                let right = Math.min(innerWidth, box.left + button.clientLeft + button.clientWidth);
                let top = Math.max(0, box.top + button.clientTop);
                let bottom = Math.min(innerHeight, box.top + button.clientTop + button.clientHeight);
                for (let parent = button.parentElement; parent; parent = parent.parentElement) {
                    const css = getComputedStyle(parent);
                    const rect = parent.getBoundingClientRect();
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
                        left = Math.max(left, rect.left + parent.clientLeft);
                        right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
                    }
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
                        top = Math.max(top, rect.top + parent.clientTop);
                        bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
                    }
                }
                const broken = [];
                let clipped = false;
                let words = 0;
                const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const text = walker.currentNode;
                    if (!text.parentElement.checkVisibility({ visibilityProperty: true })) { continue; }
                    for (const match of text.textContent.matchAll(/\S+/g)) {
                        words++;
                        const range = document.createRange();
                        range.setStart(text, match.index);
                        range.setEnd(text, match.index + match[0].length);
                        const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
                        const lines = new Set(rects.map((rect) => Math.round(rect.top))).size;
                        if (lines > 1) { broken.push(`${match[0]}: ${lines} lines`); }
                        if (!rects.length || rects.some((rect) => rect.left < left - 1 || rect.right > right + 1
                            || rect.top < top - 1 || rect.bottom > bottom + 1)) { clipped = true; }
                    }
                }
                if (words && (broken.length || clipped)) { failures.push({
                    button: button.id || button.className, label: button.innerText.trim(),
                    width: Number(box.width.toFixed(1)), height: Number(box.height.toFixed(1)), font: style.fontSize,
                    broken, clipped,
                }); }
            }
            for (const [node, left, top] of scrolls) { node.scrollTo({ left, top, behavior: 'instant' }); }
            return [...new Set(failures.map((failure) => JSON.stringify(failure)))].map((failure) => JSON.parse(failure));
        });
        if (failures.length) { labelFailures.push({ screenshot: name, failures }); }
    }
    async function fit() {
        const overflow = await page.evaluate(() => [...document.querySelectorAll(
            '.sbbs-root, .sbbs-bar, .sbbs-bar-row, .sbbs-detail-body, .sbbs-detail-actions, .sbbs-intake-body, .sbbs-bulk-list, .sbbs-intake-choice',
        )].filter((node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1)
            .map((node) => `${node.className}: ${node.scrollWidth} > ${node.clientWidth}`));
        assert.deepEqual(overflow, [], 'no horizontal clipping or overflow');
    }
    async function tabTo(selector) {
        for (let i = 0; i < 100; i++) {
            if (await page.locator(selector).first().evaluate((node) => node === document.activeElement)) {
                const visible = await page.locator(selector).first().evaluate((node) => {
                    const rect = node.getBoundingClientRect();
                    let top = 0;
                    let bottom = window.innerHeight;
                    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                        if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
                            const box = parent.getBoundingClientRect();
                            top = Math.max(top, box.top);
                            bottom = Math.min(bottom, box.bottom);
                        }
                    }
                    return { fits: rect.top >= top - 1 && rect.bottom <= bottom + 1,
                        top: rect.top, bottom: rect.bottom, visibleTop: top, visibleBottom: bottom };
                });
                assert.ok(visible.fits, `${selector} is visible after keyboard focus: ${JSON.stringify(visible)}`);
                return;
            }
            await page.keyboard.press('Tab');
        }
        assert.fail(`${selector} was not reachable with Tab`);
    }

    await t.test('detail loading, completion, retry, account error and listing-only source', async () => {
        let release;
        detailGate = new Promise((resolve) => { release = resolve; });
        await openDetail();
        const status = page.locator('#sbbs_detail [role=status]');
        assert.equal(await status.textContent(), 'Loading card details...');
        assert.equal(await status.getAttribute('aria-live'), 'polite');
        await capture('detail-loading');
        release();
        await page.locator('.sbbs-detail-name').waitFor();
        assert.match(await status.textContent(), /Details loaded for Mara/);
        assert.equal(await page.locator('.sbbs-description').first().textContent(), CARD.description);
        assert.equal(await page.locator('.sbbs-description').nth(1).textContent(), CARD.firstMessage);
        assert.equal(await page.locator('.sbbs-description').nth(2).textContent(), CARD.creatorNotes);
        detailStatus = 503;
        detailResponse = { error: 'source_down' };
        await openDetail();
        await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
        assert.match(await status.textContent(), /Could not load/);
        await capture('detail-error');
        detailStatus = 200;
        detailResponse = CARD;
        await page.getByRole('button', { name: 'Try again', exact: true }).press('Enter');
        await page.locator('.sbbs-detail-name').waitFor();
        detailResponse = { ...CARD, id: 'wrong-card' };
        await openDetail();
        await page.getByText('BotSearcher rejected a mismatched card response. Try searching again.').waitFor();
        assert.equal(await page.locator('.sbbs-import:visible').count(), 0);
        detailStatus = 401;
        detailResponse = { error: 'botbooru_session_expired' };
        await openDetail({ ...SOURCE, id: 'botbooru', label: 'BotBooru' });
        await page.getByText('Your BotBooru login expired. Log in again under Extensions > BotSearcher.').waitFor();
        const before = requests.filter((path) => path.endsWith('/detail')).length;
        await openDetail({ ...SOURCE, capabilities: { detail: false } });
        await page.getByRole('heading', { name: 'Description (listing excerpt)' }).waitFor();
        assert.equal(requests.filter((path) => path.endsWith('/detail')).length, before);
        assert.equal(await page.locator('.sbbs-description').first().textContent(), CARD.tagline);
        await capture('detail-listing-only');
        detailStatus = 200;
        detailResponse = CARD;
    });

    for (const [width, height, scale = 1] of VIEWPORTS) {
        const size = `${width}x${height}${scale === 1 ? '' : '-fontscale2'}`;
        await t.test(`${size}: detail and keyboard`, async () => {
            detailStatus = 200;
            detailResponse = CARD;
            await page.setViewportSize({ width, height });
            await page.evaluate((scale) => document.documentElement.style.setProperty('--fontScale', scale), scale);
            await openDetail();
            await page.locator('.sbbs-detail-name').waitFor();
            await capture(`detail-${size}`);
            await fit();
            assert.equal(await page.locator('.sbbs-detail-tags').getAttribute('open'), null);
            assert.equal(await page.locator('.sbbs-detail-tags .sbbs-tag').count(), 30);
            if (width <= 768) {
                const intro = await page.locator('.sbbs-detail-intro').boundingBox();
                const image = await page.locator('.sbbs-detail-image').boundingBox();
                assert.ok(intro.y + intro.height <= image.y, 'identity and intro precede artwork');
                const main = await page.locator('.sbbs-detail-main').boundingBox();
                assert.ok(image.y + image.height <= main.y, 'artwork never overlaps the tags or prose');
            } else {
                assert.equal(await page.locator('.sbbs-description').first().evaluate((node) => {
                    const ruler = document.createElement('div');
                    ruler.style.width = '70ch';
                    node.append(ruler);
                    const fits = node.getBoundingClientRect().width <= ruler.getBoundingClientRect().width + 1;
                    ruler.remove();
                    return fits;
                }), true, 'desktop prose is at most 70ch');
            }
            await tabTo('#sbbs_detail .sbbs-reveal');
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#sbbs_detail .sbbs-blurred').count(), 0);
            await page.locator('#sbbs_detail .sbbs-back').focus();
            await tabTo('.sbbs-detail-tags > summary');
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('.sbbs-detail-tags').getAttribute('open'), '');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => window.selectedTag), CARD.tags[0]);
            await page.locator('.sbbs-detail-tags > summary').press('Enter');
            await tabTo('#sbbs_detail .sbbs-import');
        });

        await t.test(`${size}: intake and keyboard`, async () => {
            await page.evaluate(async () => {
                document.querySelector('.sbbs-root').dataset.view = 'intake';
                await window.ui.showIntake(document.querySelector('#sbbs_intake'),
                    { card: window.ui.card, source: window.ui.source }, () => {});
            });
            await capture(`intake-overview-${size}`);
            await fit();
            assert.ok(!(await page.locator('#sbbs_intake').textContent()).includes(PRIVATE_TEXT));
            assert.match(await page.locator('.sbbs-intake-tokens').textContent(), /tokens/);
            await tabTo('.sbbs-intake-add-copy input');
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.locator('.sbbs-intake-replace input').isChecked(), true);
            assert.equal(await page.locator('.sbbs-intake-replace-note').isVisible(), true);
            await tabTo('#sbbs_intake .sbbs-import');
            await capture(`intake-${size}`);
            await tabTo('#sbbs_intake .sbbs-intake-back');
        });

        await t.test(`${size}: batch and keyboard`, async () => {
            await page.evaluate(async () => {
                document.querySelector('.sbbs-root').dataset.view = 'intake';
                await window.ui.showBulkImport(document.querySelector('#sbbs_intake'),
                    Array.from({ length: 30 }, (_, i) => ({ item: { ...window.ui.card,
                        name: `${i + 1}. ${'Long-card-name'.repeat(10)}` }, source: window.ui.source })), () => {}, { autoStart: false });
            });
            await capture(`bulk-list-${size}`);
            await fit();
            const listSize = await page.locator('.sbbs-bulk-list').evaluate((node) => ({ scroll: node.scrollHeight, visible: node.clientHeight }));
            assert.ok(listSize.scroll > listSize.visible && listSize.visible > 0, `batch list scrolls: ${JSON.stringify(listSize)}`);
            await page.locator('.sbbs-bulk-review-card').first().focus();
            await tabTo('.sbbs-bulk-review-card:first-of-type');
            await tabTo('.sbbs-bulk .sbbs-intake-back');
            await capture(`bulk-${size}`);
            await page.locator('.sbbs-bulk-review-card').first().press('Enter');
            await page.locator('.sbbs-bulk-review .sbbs-intake-choice').waitFor();
            await capture(`bulk-review-${size}`);
            await fit();
            await tabTo('.sbbs-bulk-review .sbbs-import');
            await tabTo('.sbbs-bulk-review .sbbs-intake-back');
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('.sbbs-bulk-review-card').first().evaluate((node) => document.activeElement === node), true);
        });
    }

    await t.test('multiple installed copies, incomplete scan and tag-removal focus', async () => {
        collection = [...collection, { ...collection[0], avatar: 'second-copy.png' }];
        report = structuredClone(REPORT);
        report.inside.scan = { complete: false, reasons: ['unsupported-extension'.repeat(15)] };
        await page.setViewportSize({ width: 320, height: 400 });
        await page.evaluate(() => document.documentElement.style.setProperty('--fontScale', 1));
        await page.evaluate(async () => {
            document.querySelector('.sbbs-root').dataset.view = 'intake';
            await window.ui.showIntake(document.querySelector('#sbbs_intake'),
                { card: window.ui.card, source: window.ui.source }, () => {});
        });
        await fit();
        await tabTo('.sbbs-intake-match');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('.sbbs-intake-match').disabled);
        assert.equal(await page.locator('.sbbs-intake-match').inputValue(), 'second-copy.png');
        assert.ok(!(await page.locator('#sbbs_intake').textContent()).includes(PRIVATE_TEXT));
        await tabTo('#sbbs_intake .sbbs-import');
        await capture('intake-multiple-incomplete-320x400');
        await page.evaluate(() => {
            document.querySelector('.sbbs-root').dataset.view = 'grid';
            document.querySelector('#sbbs_filters').hidden = false;
            const filters = window.ui.buildFilters(document.querySelector('#sbbs_filter_fields'),
                [{ key: 'tags', type: 'tags', label: 'Tags' }], () => {});
            filters.set('tags', 'one,two,three');
        });
        await page.getByRole('button', { name: 'Remove tag two', exact: true }).focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove tag three');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Remove tag one');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'sbbs_filter_tags');
        await fit();
        await capture('filters-keyboard-320x400');
    });

    await t.test('current template toolbar hooks wrap and native disclosures remain keyboard reachable', async (t) => {
        // Fixture content fills the other agent's real template hooks. Behaviour
        // of named-search persistence and shortlist actions lives in browser tests.
        await page.evaluate(async () => {
            const { el } = await import('/client/render.js');
            document.querySelector('.sbbs-root').dataset.view = 'grid';
            document.querySelector('#sbbs_filters').hidden = true;
            document.querySelector('#sbbs_named_controls').hidden = false;
            document.querySelector('#sbbs_named_consent').checked = true;
            document.querySelector('#sbbs_named_consent_label').textContent = 'Save named searches';
            document.querySelector('#sbbs_named_privacy').textContent = 'Named searches are saved only with your consent.';
            document.querySelector('#sbbs_named_list').append(new Option('Long saved search name '.repeat(12), 'saved'));
            const list = document.querySelector('#sbbs_shortlist_items');
            for (let i = 0; i < 10; i++) {
                const row = el('li', 'sbbs-shortlist-item');
                row.append(el('span', undefined, 'UnbrokenCharacterName'.repeat(12)),
                    el('button', 'menu_button sbbs-shortlist-review', 'Review'),
                    el('button', 'menu_button sbbs-shortlist-remove', 'Remove'));
                list.append(row);
            }
            document.querySelector('#sbbs_shortlist_count').textContent = 'Shortlist (10)';
            document.querySelector('#sbbs_shortlist_import').disabled = false;
            document.querySelector('#sbbs_shortlist_clear').disabled = false;
        });
        for (const [width, height, scale = 1] of VIEWPORTS) {
            const size = `${width}x${height}${scale === 1 ? '' : '-fontscale2'}`;
            await page.setViewportSize({ width, height });
            await page.evaluate((scale) => document.documentElement.style.setProperty('--fontScale', scale), scale);
            await page.evaluate(() => {
                document.querySelector('#sbbs_named_searches').open = false;
                document.querySelector('#sbbs_shortlist').open = false;
            });
            await t.test(`${size}: toolbar`, async () => {
                await page.locator('#sbbs_query').focus();
                await capture(`toolbar-${size}`);
                await fit();
                const source = await page.locator('#sbbs_source').boundingBox();
                assert.ok(source.width >= 100, `source picker stays legible: ${source.width}px`);
                const header = await page.locator('.sbbs-root > header').evaluate((node) => {
                    const style = getComputedStyle(node);
                    return { overflowY: style.overflowY,
                        scrollable: node.scrollHeight > node.clientHeight + 1 };
                });
                assert.equal(header.overflowY, 'visible', 'search header is never its own scroll box');
                assert.equal(header.scrollable, false, 'search header is fully exposed, not clipped');
                const queryBox = await page.locator('#sbbs_query').boundingBox();
                const headerBox = await page.locator('.sbbs-root > header').boundingBox();
                assert.ok(queryBox && headerBox && queryBox.y >= headerBox.y - 1
                    && queryBox.y + queryBox.height <= headerBox.y + headerBox.height + 1,
                'search field is fully visible inside the header');
                const resultsHeight = await page.locator('.sbbs-body').evaluate((node) => node.clientHeight);
                assert.ok(resultsHeight > 50, `toolbar leaves space for results: ${resultsHeight}px`);
                await tabTo('#sbbs_inspect_file');
            });
            await t.test(`${size}: named searches`, async () => {
                await tabTo('#sbbs_named_searches > summary');
                await page.keyboard.press('Enter');
                await capture(`named-searches-${size}`);
                await tabTo('#sbbs_named_name');
                await page.keyboard.type('Archive characters');
                await tabTo('#sbbs_named_save');
                await tabTo('#sbbs_named_list');
                await fit();
                await tabTo('#sbbs_named_remove');
            });
            await t.test(`${size}: shortlist`, async () => {
                await tabTo('#sbbs_shortlist_count');
                await page.keyboard.press('Enter');
                await capture(`shortlist-${size}`);
                await tabTo('.sbbs-shortlist-review');
                await fit();
                await tabTo('#sbbs_shortlist_clear');
            });
        }
    });
    await t.test('visible menu labels wrap between words and remain unclipped in every captured state', () => {
        assert.equal(labelFailures.length, 0, labelFailures.flatMap(({ screenshot, failures }) =>
            failures.map((failure) => `${screenshot}: ${JSON.stringify(failure)}`)).join('\n'));
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], 'every request stayed in the fake host and was explicitly routed');
    assert.ok(!requests.includes('/api/characters/import'), 'layout checks never import anything');
});
