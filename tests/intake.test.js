/**
 * The card intake screen.
 *
 * What matters here is that the screen tells the truth about a card and cannot
 * import one behind the user's back: nothing reaches /api/characters/import
 * until a button is pressed, the report distinguishes what the bytes say from
 * what the listing claimed, and a card that could not be inspected says so
 * instead of quietly importing unscanned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The token cost is measured after the report renders, on its own promise
 * chain. Tests must let it land before restoring the globals, or it writes into
 * a DOM whose `document` has already been taken away. Bounded and silent: a
 * count that never arrives is the business of the test that asserts it.
 */
async function settle(container) {
    const measuring = () => /Measuring token cost/
        .test(container.querySelector('.sbbs-intake-tokens')?.textContent ?? '');
    for (let attempt = 0; attempt < 100 && measuring(); attempt++) {
        await tick();
    }
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) {
            return;
        }
        await tick();
    }
    throw new Error(message);
}

const REPORT = {
    kind: 'png',
    spec: 'chara_card_v2',
    inside: {
        scan: { complete: true, reasons: [] },
        name: 'Seraphina',
        creator: 'realauthor',
        characterVersion: '1.2',
        specVersion: 'chara_card_v2',
        sha256: 'a'.repeat(64),
        byteSize: 4096,
        lorebookEntries: 34,
        alternateGreetings: 4,
        hasSystemPrompt: true,
        hasPostHistoryInstructions: false,
        hasDepthPrompt: true,
        regexScripts: 2,
        embeddedAssets: 0,
        tagCount: 3,
        macros: { count: 7, names: ['char', 'user'] },
        html: { count: 1, fields: ['description'], hasScriptOrIframe: false },
        externalUrls: { count: 2, hosts: ['files.example'] },
        extensions: { known: ['depth_prompt'], unknown: ['risu_ext'] },
        malformed: [],
        privateInfo: [{ kind: 'email', field: 'creator_notes', redacted: 'ja****om' }],
        promptText: {
            truncated: false,
            fields: {
                description: 'A knight.',
                personality: '',
                scenario: '',
                firstMessage: 'Hello.',
                messageExample: '',
                systemPrompt: 'Be a knight.',
                postHistoryInstructions: '',
            },
            lorebook: {
                truncated: false,
                // The stub tokenizer counts characters, so these lengths are the
                // token numbers the screen should report.
                always: 'ABCDE',
                conditional: 'ABCDEFGHIJ',
                alwaysEntries: 1,
                conditionalEntries: 33,
            },
        },
    },
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

/**
 * Installs a DOM plus a host stub.
 * `routes` maps a path fragment to a handler returning a Response.
 */
function installHost({ characters = [], routes = {}, getCharacters, getOneCharacter } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><section id="intake"></section></body></html>', {
        url: 'https://sillybunny.test/',
        pretendToBeVisual: true,
    });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
        File: globalThis.File,
        toastr: globalThis.toastr,
        requestAnimationFrame: globalThis.requestAnimationFrame,
    };

    const calls = [];
    const stored = structuredClone(characters);
    const loaded = [];
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    globalThis.toastr = { success() {}, error() {} };
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url);
        calls.push({ path, options });
        for (const [fragment, handler] of Object.entries(routes)) {
            if (path.includes(fragment)) {
                return handler(options, stored);
            }
        }
        if (path === '/api/characters/all') {
            return jsonRoute(stored)();
        }
        if (path.startsWith('/characters/')) {
            const avatar = decodeURIComponent(path.slice('/characters/'.length));
            const entry = stored.find((record) => record.avatar === avatar);
            return entry ? new Response(new Uint8Array([...PNG_BYTES, ...new TextEncoder().encode(JSON.stringify(entry))])) : new Response('', { status: 404 });
        }
        if (path === '/api/characters/import') {
            let avatar = options.body.get('preserved_name');
            if (!avatar) {
                avatar = 'sera.png';
                for (let n = 1; stored.some((entry) => entry.avatar === avatar); n++) {
                    avatar = `sera${n}.png`;
                }
            }
            const record = { avatar, name: 'Seraphina', data: { description: 'A knight.' } };
            const index = stored.findIndex((entry) => entry.avatar === avatar);
            if (index < 0) {
                stored.push(record);
            } else {
                stored[index] = record;
            }
            return jsonRoute({ file_name: avatar.slice(0, -4) })();
        }
        if (path === '/api/characters/delete') {
            const index = stored.findIndex((entry) => entry.avatar === JSON.parse(options.body).avatar_url);
            if (index >= 0) {
                stored.splice(index, 1);
            }
        }
        return new Response('{}', { status: 200 });
    };
    // The real host leaves `characters` empty until getCharacters() has run, so
    // the stub does the same — a stub that pre-populates it would hide exactly
    // the bug this models.
    globalThis.SillyTavern = {
        getContext: () => ({
            characters: loaded,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            getCharacters: getCharacters ?? (async () => {
                loaded.splice(0, loaded.length, ...structuredClone(stored));
            }),
            getOneCharacter,
            getTokenCountAsync: async (text) => text.length,
            selectCharacterById: async () => {},
        }),
    };

    return {
        calls,
        stored,
        loaded,
        dom,
        container: dom.window.document.querySelector('#intake'),
        restore() {
            dom.window.close();
            Object.assign(globalThis, previous);
        },
    };
}

function jsonRoute(body, status = 200) {
    return () => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const BYTE_SOURCE = Object.freeze({ id: 'quillgen', label: 'Quillgen' });
const CARD = Object.freeze({ id: 'card-1', name: 'Seraphina', creator: 'listingauthor' });

test('the report is shown and nothing is imported until a button is pressed', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?report');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        const text = host.container.textContent;
        assert.match(text, /Seraphina/);
        assert.match(text, /2 scripts/, 'regex scripts are reported');
        assert.match(text, /34 entries/, 'the lorebook is reported');
        assert.match(text, /7 uses/, 'macros are reported');
        assert.match(text, /risu_ext/, 'unrecognized extension data is named');
        assert.match(text, /files\.example/, 'external URL hosts are named');
        assert.match(text, /ja\*\*\*\*om/, 'private details are shown redacted');
        assert.match(text, /SHA-256 aaaaaaaaaaaa/);
        // The card's own creator disagrees with the listing; both are shown.
        assert.match(text, /realauthor \(the listing says listingauthor\)/);
        // Validation is not a safety verdict, and the screen must not imply it is.
        assert.match(text, /does not establish that the card's instructions are safe/);

        assert.ok(
            !host.calls.some((call) => call.path.includes('/api/characters/import')),
            'inspecting must not import',
        );
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('the token cost is split by when each part is actually in context', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?tokens');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await settle(host.container);

        const text = host.container.textContent;
        // Stub tokenizer = one token per character. Always-in-context is
        // 'A knight.' + '\n' + 'Be a knight.' = 22; the greeting is 'Hello.' = 6;
        // there are no example messages; the always-on lorebook entry is 5.
        assert.match(text, /Always in context/);
        assert.match(text, /22 tokens/, 'the always-in-context bucket is counted');
        assert.match(text, /6 tokens/, 'the opening message is counted separately');
        assert.match(text, /5 tokens across 1 entry/, 'always-on lorebook entries are counted');
        assert.match(text, /up to 10 tokens across 33 entries/, 'keyword entries are a ceiling, not a cost');
        // 22 + 6 + 0 + 5
        assert.match(text, /About 33 tokens are in context before you send anything/);
        // The measured text itself must never reach the page.
        assert.ok(!/A knight\./.test(text), 'card text is counted, never rendered');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a card whose lorebook is too large reports that, rather than a wrong number', async () => {
    const report = structuredClone(REPORT);
    report.inside.promptText.lorebook = {
        truncated: true,
        always: '',
        conditional: '',
        alwaysEntries: 12,
        conditionalEntries: 400,
    };
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(report),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?bigbook');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await settle(host.container);

        const text = host.container.textContent;
        assert.match(text, /Too large to measure/);
        // The card's own fields are unaffected by the lorebook's budget.
        assert.match(text, /22 tokens/);
        assert.match(text, /About 28 tokens are in context/, 'an unmeasured lorebook adds nothing');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('an installed card of the same name is reported with what differs', async () => {
    const host = installHost({
        characters: [{
            avatar: 'Seraphina.png',
            name: 'Seraphina',
            data: {
                description: 'A different knight.',
                first_mes: 'Hello.',
                system_prompt: 'Be a knight.',
                character_book: { entries: new Array(34) },
                alternate_greetings: new Array(4),
            },
        }],
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?duplicate');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-duplicate'), 'duplicate line did not render');

        const duplicate = host.container.querySelector('.sbbs-intake-duplicate').textContent;
        assert.match(duplicate, /Already in your collection as "Seraphina"/);
        assert.match(duplicate, /description/, 'the differing field is named');
        assert.ok(!/lorebook/.test(duplicate), 'matching counts must not be reported as differences');

        // Replacing is offered only when there is something to replace.
        assert.ok(host.container.querySelector('.sbbs-intake-replace'));
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a card that is not installed says so and offers no replace option', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?not-installed');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-duplicate'), 'duplicate line did not render');

        assert.match(host.container.querySelector('.sbbs-intake-duplicate').textContent, /not in your collection/);
        assert.equal(host.container.querySelector('.sbbs-intake-replace'), null);
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('clean import states what it removes and what it keeps, and routes through /clean', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
            '/clean': () => new Response(PNG_BYTES),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?clean');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-clean-note'), 'clean note did not render');

        const note = host.container.querySelector('.sbbs-intake-clean-note').textContent;
        assert.match(note, /removes 2 regex scripts/);
        assert.match(note, /1 unrecognised extension block \(risu_ext\)/);
        assert.match(note, /1 personal detail/);
        assert.match(note, /keeps 34 lorebook entries/, 'the character must be kept, and said to be');
        assert.match(note, /the system prompt/);

        host.container.querySelector('.sbbs-import-clean').click();
        await waitFor(
            () => host.calls.some((call) => call.path.includes('/api/characters/import')),
            'clean import did not reach the importer',
        );

        const order = host.calls.map((call) => call.path);
        assert.ok(
            order.findIndex((path) => path.includes('/clean')) < order.findIndex((path) => path.includes('/api/characters/import')),
            'the cleaned bytes must be what is imported',
        );
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('exact import sends the untouched bytes', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?exact');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-import'), 'actions did not render');

        host.container.querySelector('.sbbs-import').click();
        await waitFor(
            () => host.calls.some((call) => call.path.includes('/api/characters/import')),
            'exact import did not reach the importer',
        );

        assert.ok(!host.calls.some((call) => call.path.includes('/clean')), 'exact import must not clean');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a native card that cannot be downloaded is reported as not inspected', async () => {
    const host = installHost({
        routes: { '/api/content/importURL': () => new Response('nope', { status: 502 }) },
    });

    try {
        const { showIntake } = await import('../client/intake.js?not-inspected');
        await showIntake(host.container, {
            card: { id: 'x', name: 'Blocked', importUrl: 'https://chub.ai/characters/a/b' },
            source: { id: 'chub', label: 'Chub', nativeImport: true, clientHosts: ['chub.ai'] },
        }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-detail-actions'), 'fallback did not render');

        const text = host.container.textContent;
        assert.match(text, /could not download this card/);
        assert.match(text, /was not inspected/, 'the state must be named, not glossed over');
        // The unscanned route stays available, but labelled for what it is.
        assert.match(text, /Import without inspecting/);
        assert.ok(!host.calls.some((call) => call.path.includes('/api/characters/import')));
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a blocked JannyAI card offers its source page and local-card recovery', async () => {
    const host = installHost({
        routes: { '/api/content/importURL': () => new Response('blocked', { status: 403 }) },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-recovery');
        await showIntake(host.container, {
            card: {
                id: '311a6844-61d6-4468-aa98-91ecc7fbae86',
                name: 'Blocked Janny card',
                pageUrl: 'https://jannyai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-blocked',
                importUrl: 'https://janitorai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-blocked',
            },
            source: {
                id: 'jannyai',
                label: 'JannyAI',
                nativeImport: true,
                clientHosts: ['jannyai.com', 'janitorai.com'],
            },
        }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-recovery'), 'Janny recovery did not render');

        assert.match(host.container.textContent, /Cloudflare may be blocking/);
        assert.match(host.container.textContent, /Inspect a card file/);
        const link = host.container.querySelector('.sbbs-intake-recovery a');
        assert.equal(link?.textContent, 'Open JannyAI page');
        assert.equal(link?.href, 'https://jannyai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-blocked');
        assert.equal(link?.target, '_blank');
        assert.ok(host.container.querySelector('button.sbbs-import'), 'native import fallback must remain available');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a JannyAI inspection error after download does not offer download recovery', async () => {
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response(PNG_BYTES, {
                headers: { 'X-Custom-Content-Type': 'character' },
            }),
            '/inspect': jsonRoute({ error: 'card_invalid' }, 422),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-invalid-card');
        await showIntake(host.container, {
            card: {
                id: '311a6844-61d6-4468-aa98-91ecc7fbae86',
                pageUrl: 'https://jannyai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-invalid',
                importUrl: 'https://janitorai.com/characters/311a6844-61d6-4468-aa98-91ecc7fbae86_character-invalid',
            },
            source: {
                id: 'jannyai',
                label: 'JannyAI',
                nativeImport: true,
                clientHosts: ['jannyai.com', 'janitorai.com'],
            },
        }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-detail-actions'), 'error state did not render');

        assert.equal(host.container.querySelector('.sbbs-intake-recovery'), null);
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a local file is inspected without contacting any source', async () => {
    const host = installHost({ routes: { '/inspect': jsonRoute(REPORT) } });

    try {
        const { showIntake } = await import('../client/intake.js?local-file');
        const file = new File([PNG_BYTES], 'downloaded card.png', { type: 'image/png' });
        await showIntake(host.container, { file }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        assert.match(host.container.textContent, /Local file \(downloaded card\.png\)/);
        assert.deepEqual(
            host.calls.map((call) => call.path).filter((path) => !path.includes('/inspect') && path !== '/api/characters/all'),
            [],
            'a local card must not cause a source request',
        );
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('an unreadable collection is reported as unknown, never as "not installed"', async () => {
    // Regression: the screen used to read getContext().characters directly. That
    // list is empty until the app has fetched it, so an installed card was
    // reported as absent — a false all-clear on the one question the user came
    // here to ask.
    const host = installHost({
        getCharacters: async () => {},
        routes: {
            '/api/characters/all': jsonRoute({ error: true }, 500),
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?collection-unknown');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-duplicate'), 'duplicate line did not render');

        const text = host.container.querySelector('.sbbs-intake-duplicate').textContent;
        assert.match(text, /could not read your collection/);
        assert.ok(!/not in your collection/.test(text), 'unknown must not be reported as absent');
        // Nothing to replace when nothing is known.
        assert.equal(host.container.querySelector('.sbbs-intake-replace'), null);
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('the collection is refreshed before comparing, not read stale', async () => {
    const host = installHost({
        characters: [{ avatar: 'Seraphina.png', name: 'Seraphina', data: { description: 'A knight.' } }],
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });
    try {
        const { showIntake } = await import('../client/intake.js?collection-refresh');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-duplicate'), 'duplicate line did not render');

        assert.ok(host.calls.some((call) => call.path === '/api/characters/all'), 'the character list read must have an explicit success response');
        assert.match(
            host.container.querySelector('.sbbs-intake-duplicate').textContent,
            /Already in your collection as "Seraphina"/,
        );
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('contents the listing never mentioned are called out', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?undisclosed');
        // The listing claimed a plain card; the bytes carry rather more.
        const card = { ...CARD, inside: { lorebookEntries: 0, regexScripts: 0, hasSystemPrompt: false } };
        await showIntake(host.container, { card, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-undisclosed'), 'undisclosed line did not render');

        const text = host.container.querySelector('.sbbs-intake-undisclosed').textContent;
        assert.match(text, /also contains/);
        assert.match(text, /34 lorebook entries/);
        assert.match(text, /2 regex scripts/);
        assert.match(text, /a system prompt/);
    } finally {
        await settle(host.container);
        host.restore();
    }
});

const JANNY_SOURCE = Object.freeze({
    id: 'jannyai',
    label: 'JannyAI',
    nativeImport: true,
    clientHosts: Object.freeze(['jannyai.com', 'janitorai.com']),
    capabilities: Object.freeze({ browserImport: true }),
});
const JANNY_CARD = Object.freeze({
    id: '0b7a1a71-4c62-4de1-a44c-6f06a4ffe421',
    name: 'Seraphina',
    importUrl: 'https://janitorai.com/characters/0b7a1a71-4c62-4de1-a44c-6f06a4ffe421',
    pageUrl: 'https://jannyai.com/characters/0b7a1a71-4c62-4de1-a44c-6f06a4ffe421_character-seraphina',
});

test('a JannyAI card uses the zero-setup native downloader before the browser bridge', async () => {
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response(PNG_BYTES, { headers: { 'X-Custom-Content-Type': 'character' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-native-first');
        await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        assert.ok(host.calls.some((call) => call.path.includes('/api/content/importURL')), 'native download runs first');
        assert.ok(!host.calls.some((call) => call.path.includes('/url-card')), 'the bridge is not asked when native works');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a blocked native download falls back to the browser bridge', async () => {
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response('blocked', { status: 502 }),
            '/url-card': () => new Response(JSON.stringify({ spec: 'chara_card_v2' }), {
                headers: { 'X-SBBS-Card-Kind': 'json' },
            }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-bridge-fallback');
        await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        const nativeAt = host.calls.findIndex((call) => call.path.includes('/api/content/importURL'));
        const bridgeAt = host.calls.findIndex((call) => call.path.includes('/url-card'));
        assert.ok(nativeAt >= 0 && bridgeAt > nativeAt, 'the bridge runs only after native fails');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a native JSON card has no portrait, so the bridge is still asked and its PNG wins', async () => {
    // SillyBunny's importer gives every JSON card its generic portrait; only a
    // PNG keeps the picture. The bridge's PNG is what ends up inspected.
    const inspected = [];
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response(JSON.stringify({ spec: 'chara_card_v2' }), {
                headers: { 'X-Custom-Content-Type': 'character', 'Content-Type': 'application/json' },
            }),
            '/url-card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': (options) => {
                inspected.push(options.body.name);
                return jsonRoute(REPORT)();
            },
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-json-then-bridge');
        await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        assert.ok(host.calls.some((call) => call.path.includes('/url-card')), 'the bridge runs after a portrait-less native card');
        assert.deepEqual(inspected.map((name) => name.split('.').pop()), ['json', 'png'], 'each candidate is inspected once, the PNG last');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a native JSON card is still imported with the generic portrait when the bridge is down', async () => {
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response(JSON.stringify({ spec: 'chara_card_v2' }), {
                headers: { 'X-Custom-Content-Type': 'character', 'Content-Type': 'application/json' },
            }),
            '/url-card': jsonRoute({ error: 'janny_browser_unavailable' }, 503),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-json-fallback');
        await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        assert.equal(host.calls.filter((call) => call.path.includes('/inspect')).length, 1, 'the accepted report is not requested twice');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('a native reply that is not a card at all sends the import to the bridge', async () => {
    // A 200 with a Cloudflare page or a bare image used to be accepted and only
    // fail at inspection, after the bridge had lost its turn.
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response('<html>blocked</html>', { headers: { 'X-Custom-Content-Type': 'character' } }),
            '/url-card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': (options) => (options.body.name.endsWith('.png')
                ? jsonRoute(REPORT)()
                : jsonRoute({ error: 'not_json' }, 422)()),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-garbage-then-bridge');
        await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        assert.ok(host.calls.some((call) => call.path.includes('/url-card')), 'the bridge runs when native bytes fail inspection');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('with no bridge available a blocked JannyAI card keeps the native guidance and a retry', async () => {
    const host = installHost({
        routes: {
            '/api/content/importURL': () => new Response('blocked', { status: 502 }),
            '/url-card': jsonRoute({ error: 'janny_browser_unavailable' }, 503),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?janny-both-fail');
        await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
        await waitFor(() => /Cloudflare may be blocking/.test(host.container.textContent), 'native failure message did not render');

        const text = host.container.textContent;
        assert.match(text, /Setting up JannyAI browser import under Extensions > BotSearcher/);
        assert.match(text, /Import without inspecting/);
        assert.match(text, /Try again/);
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('with the review off, a card not yet installed is imported at once and can be undone', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?direct');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, { direct: true });
        await waitFor(() => host.container.querySelector('.sbbs-undo-import'), 'direct import did not finish');

        assert.ok(host.calls.some((call) => call.path.includes('/api/characters/import')), 'the card must be imported');
        assert.equal(host.container.querySelector('.sbbs-intake-list'), null, 'no report is rendered');
        assert.match(host.container.textContent, /Seraphina/);
        assert.match(host.container.querySelector('.sbbs-import-status').textContent, /Imported\./);
        assert.ok(host.container.querySelector('.sbbs-open-character'));

        host.container.querySelector('.sbbs-undo-import').click();
        await waitFor(() => /Import undone/.test(host.container.textContent), 'undo did not report');
        const deletion = host.calls.find((call) => call.path.includes('/api/characters/delete'));
        assert.deepEqual(JSON.parse(deletion.options.body), { avatar_url: 'sera.png', delete_chats: false });
        assert.equal(host.container.querySelector('.sbbs-open-character'), null, 'Open goes with the character');
    } finally {
        host.restore();
    }
});

test('with the review off, an installed character still gets the review screen', async () => {
    const host = installHost({
        characters: [{ name: 'Seraphina', avatar: 'sera.png', data: {} }],
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?direct-installed');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, { direct: true });
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'the review did not render');

        assert.ok(!host.calls.some((call) => call.path.includes('/api/characters/import')), 'nothing may be imported unasked');
        assert.match(host.container.textContent, /Already in your collection as "Seraphina"/);
        assert.ok(host.container.querySelector('.sbbs-intake-replace'), 'the replace choice is offered');
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('an ordinary import offers Undo, and undoing it reopens the choice', async () => {
    const host = installHost({
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showIntake } = await import('../client/intake.js?undo');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-import'), 'actions did not render');
        await settle(host.container);

        const exact = host.container.querySelector('.sbbs-import');
        exact.click();
        await waitFor(() => host.container.querySelector('.sbbs-undo-import'), 'import did not finish');
        assert.equal(exact.disabled, true);

        host.container.querySelector('.sbbs-undo-import').click();
        await waitFor(() => /Import undone/.test(host.container.textContent), 'undo did not report');
        assert.equal(exact.disabled, false, 'the card can be imported again');
        assert.equal(exact.textContent, 'Import exactly');
    } finally {
        host.restore();
    }
});

test('a batch imports each card, skips installed ones, obeys the download limit, and can be undone', async () => {
    let cardCalls = 0;
    const host = installHost({
        routes: {
            '/card': () => {
                // The server's limiter answers once with a wait; the batch obeys it.
                if (++cardCalls === 1) {
                    return new Response(JSON.stringify({ error: 'rate_limited', retryAfter: 0.01 }), { status: 429 });
                }
                return new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } });
            },
            '/inspect': jsonRoute(REPORT),
        },
    });

    try {
        const { showBulkImport } = await import('../client/intake.js?bulk');
        const entries = [
            { item: { id: 'card-1', name: 'Seraphina' }, source: BYTE_SOURCE },
            { item: { id: 'card-2', name: 'Seraphina (mirror)' }, source: { id: 'chub', label: 'Chub' } },
        ];
        await showBulkImport(host.container, entries, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-undo-import'), 'the batch did not finish');

        const outcomes = [...host.container.querySelectorAll('.sbbs-bulk-outcome')].map((node) => node.textContent);
        assert.equal(outcomes[0], 'Imported.');
        assert.match(outcomes[1], /Already in your collection as "Seraphina".*Not imported\./);
        assert.equal(cardCalls, 3, 'the first card was fetched again after the wait; the second once');
        assert.equal(host.calls.filter((call) => call.path.includes('/api/characters/import')).length, 1);
        assert.match(host.container.querySelector('.sbbs-state').textContent, /Imported 1 card\. 1 already in your collection\./);
        assert.match(host.container.textContent, /Chub/, 'each line names its site');

        host.container.querySelector('.sbbs-undo-import').click();
        await waitFor(() => /Removed 1 of 1 imported card/.test(host.container.textContent), 'undo did not report');
        assert.equal(host.calls.filter((call) => call.path.includes('/api/characters/delete')).length, 1);
        assert.equal(host.container.querySelectorAll('.sbbs-bulk-outcome')[0].textContent, 'Removed again');
    } finally {
        host.restore();
    }
});

test('incomplete or unreported inspection coverage always opens review and disables cleaning', async () => {
    for (const scan of [{ complete: false, reasons: ['text_budget'] }, undefined]) {
        const report = structuredClone(REPORT);
        report.inside.scan = scan;
        const host = installHost({
            routes: {
                '/card': () => new Response(PNG_BYTES),
                '/inspect': jsonRoute(report),
            },
        });
        try {
            const { showIntake } = await import('../client/intake.js?coverage-review');
            await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, { direct: true });
            assert.ok(host.container.querySelector('.sbbs-intake-scan-warning'));
            assert.equal(host.container.querySelector('.sbbs-import-clean').disabled, true);
            assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
            assert.doesNotMatch(host.container.textContent, /A knight\.|Be a knight\.|ABCDEFGHIJ/);
        } finally {
            await settle(host.container);
            host.restore();
        }
    }
});

test('unknown collection reads cannot trigger review-disabled or batch imports', async () => {
    const host = installHost({
        getCharacters: async () => {},
        routes: {
            '/card': () => new Response(PNG_BYTES),
            '/inspect': jsonRoute(REPORT),
            '/api/characters/all': jsonRoute({ error: true }, 500),
        },
    });
    try {
        const { showIntake, showBulkImport } = await import('../client/intake.js?unknown-collection-policy');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, { direct: true });
        assert.match(host.container.querySelector('.sbbs-intake-duplicate').textContent, /could not read your collection/);
        await settle(host.container);
        await showBulkImport(host.container, [{ item: CARD, source: BYTE_SOURCE }], () => {});
        assert.match(host.container.querySelector('.sbbs-state').textContent, /1 collection check unavailable/);
        assert.doesNotMatch(host.container.querySelector('.sbbs-state').textContent, /already in your collection/);
        assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
        assert.equal(host.container.querySelector('.sbbs-bulk-review-card').hidden, false);
    } finally {
        host.restore();
    }
});

test('lazy installed cards are loaded with the host helper, with failed comparisons reported as unknown', async () => {
    for (const succeeds of [true, false]) {
        let fullLoads = 0;
        const host = installHost({
            characters: [{ avatar: 'sera.png', name: 'Seraphina', shallow: true, data: {} }],
            getOneCharacter: async avatar => {
                fullLoads++;
                if (succeeds) {
                    const ctx = globalThis.SillyTavern.getContext();
                    const index = ctx.characters.findIndex(entry => entry.avatar === avatar);
                    ctx.characters[index] = {
                        avatar, name: 'Seraphina', data: {
                            description: 'A knight.', first_mes: 'Hello.', system_prompt: 'Be a knight.',
                            character_book: { entries: new Array(34) }, alternate_greetings: new Array(4),
                        },
                    };
                }
            },
            routes: {
                '/card': () => new Response(PNG_BYTES),
                '/inspect': jsonRoute(REPORT),
            },
        });
        try {
            const { showIntake } = await import('../client/intake.js?lazy-comparison');
            await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
            assert.equal(fullLoads, 1);
            const text = host.container.querySelector('.sbbs-intake-duplicate').textContent;
            assert.match(text, succeeds ? /compared fields and counts match/ : /could not be compared/);
            assert.doesNotMatch(text, /different description/);
        } finally {
            await settle(host.container);
            host.restore();
        }
    }
});

test('same-name copy selection precedes actions and fixes the replacement target before cleaning', async () => {
    let releaseClean;
    const host = installHost({
        characters: [
            { avatar: 'first.png', name: 'Seraphina', data: { description: 'first hidden text' } },
            { avatar: '{{user}}.png', name: 'Seraphina', data: { description: 'second hidden text' } },
        ],
        routes: {
            '/card': () => new Response(PNG_BYTES),
            '/inspect': jsonRoute(REPORT),
            '/clean': () => new Promise(resolve => { releaseClean = () => resolve(new Response(PNG_BYTES)); }),
        },
    });
    try {
        const { showIntake } = await import('../client/intake.js?copy-choice');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await settle(host.container);
        const select = host.container.querySelector('.sbbs-intake-match');
        assert.deepEqual([...select.options].map(option => option.value), ['first.png', '{{user}}.png']);
        assert.match(select.textContent, /\{\{user\}\}\.png/);
        select.value = '{{user}}.png';
        select.dispatchEvent(new host.dom.window.Event('change'));
        const replace = host.container.querySelector('.sbbs-intake-replace input');
        await waitFor(() => !replace.disabled, 'chosen installed copy did not load');
        replace.click();
        const exact = host.container.querySelector('.sbbs-import');
        const clean = host.container.querySelector('.sbbs-import-clean');
        assert.equal(exact.textContent, 'Replace exactly');
        assert.equal(clean.textContent, 'Clean and replace');
        assert.equal(host.container.querySelector('.sbbs-intake-replace-note').hidden, false);
        assert.match(host.container.querySelector('.sbbs-intake-replace-note').textContent, /no Undo/);
        assert.ok(host.container.querySelector('.sbbs-intake-choice').compareDocumentPosition(exact) & host.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
        clean.click();
        await waitFor(() => releaseClean, 'cleaning did not start');
        assert.equal(select.disabled, true);
        assert.equal(replace.disabled, true);
        assert.equal(host.container.querySelector('.sbbs-intake-add-copy input').disabled, true);
        replace.checked = false;
        select.value = 'first.png';
        releaseClean();
        await waitFor(() => /Replaced\./.test(host.container.querySelector('.sbbs-import-status').textContent), 'replacement did not settle');
        const write = host.calls.find(call => call.path === '/api/characters/import');
        assert.equal(write.options.body.get('preserved_name'), '{{user}}.png');
        assert.equal(host.container.querySelector('.sbbs-undo-import'), null);
        assert.doesNotMatch(host.container.textContent, /first hidden text|second hidden text|A knight\./);
    } finally {
        host.restore();
    }
});

test('Back during collection lookup or cleaning prevents a later import', async () => {
    for (const phase of ['collection', 'clean']) {
        let release;
        const controller = new AbortController();
        const host = installHost({
            routes: {
                '/card': () => new Response(PNG_BYTES),
                '/inspect': jsonRoute(REPORT),
                ...(phase === 'collection' ? {
                    '/api/characters/all': () => new Promise(resolve => { release = () => resolve(jsonRoute([])()); }),
                } : {
                    '/clean': () => new Promise(resolve => { release = () => resolve(new Response(PNG_BYTES)); }),
                }),
            },
        });
        try {
            const { showIntake } = await import('../client/intake.js?cancel-preparation');
            const opened = showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {
                controller.abort();
                host.container.replaceChildren();
            }, { signal: controller.signal, direct: phase === 'collection' });
            if (phase === 'clean') {
                await opened;
                await settle(host.container);
                host.container.querySelector('.sbbs-import-clean').click();
            }
            await waitFor(() => release, `${phase} did not start`);
            host.container.querySelector('.sbbs-back').click();
            release();
            await opened;
            await tick();
            assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
            assert.equal(host.container.childElementCount, 0);
        } finally {
            host.restore();
        }
    }
});

test('batch disposal during an ignored collection cancellation cannot start a write', async () => {
    let release;
    const controller = new AbortController();
    const host = installHost({ routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute(REPORT),
        '/api/characters/all': () => new Promise(resolve => { release = () => resolve(jsonRoute([])()); }),
    } });
    try {
        const { showBulkImport } = await import('../client/intake.js?batch-cancel');
        const running = showBulkImport(host.container, [{ item: CARD, source: BYTE_SOURCE }], () => {}, { signal: controller.signal });
        await waitFor(() => release, 'collection check did not start');
        controller.abort();
        release();
        await running;
        assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
    } finally {
        host.restore();
    }
});

test('a completed old direct import reports its receipt without appending into a newer intake', async () => {
    let releaseImport;
    const receipts = [];
    const host = installHost({ routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute(REPORT),
        '/api/characters/import': (_options, stored) => new Promise(resolve => {
            releaseImport = () => {
                stored.push({ avatar: 'saved.png', name: 'Seraphina', data: {} });
                resolve(jsonRoute({ file_name: 'saved' })());
            };
        }),
    } });
    try {
        const { showIntake } = await import('../client/intake.js?late-receipt');
        const first = showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, {
            direct: true,
            onImported: receipt => receipts.push(receipt),
        });
        await waitFor(() => releaseImport, 'import did not start');
        assert.equal(host.container.querySelector('.sbbs-back').disabled, true);
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await settle(host.container);
        releaseImport();
        await first;
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].committed, true);
        assert.equal(host.container.querySelector('.sbbs-undo-import'), null);
        assert.equal(host.container.querySelectorAll('.sbbs-intake-title').length, 1);
        assert.equal(host.container.querySelectorAll('.sbbs-import').length, 1);
    } finally {
        host.restore();
    }
});

test('Stop after current card retains completed rows and Undo without starting the next card', async () => {
    let releaseImport;
    let backs = 0;
    const host = installHost({ routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute(REPORT),
        '/api/characters/import': (_options, stored) => new Promise(resolve => {
            releaseImport = () => {
                stored.push({ avatar: 'saved.png', name: 'Seraphina', data: {} });
                resolve(jsonRoute({ file_name: 'saved' })());
            };
        }),
    } });
    try {
        const { showBulkImport } = await import('../client/intake.js?stop-batch');
        const running = showBulkImport(host.container, [
            { item: CARD, source: BYTE_SOURCE },
            { item: { id: 'two', name: 'Second' }, source: BYTE_SOURCE },
        ], () => { backs++; });
        await waitFor(() => releaseImport, 'first import did not start');
        const stop = host.container.querySelector('.sbbs-back');
        assert.match(stop.textContent, /Stop after current card/);
        stop.click();
        assert.equal(backs, 0);
        releaseImport();
        await running;
        assert.match(host.container.querySelector('.sbbs-state').textContent, /Stopped\. Imported 1 card\. 1 not started/);
        assert.equal(host.calls.filter(call => call.path.endsWith('/card')).length, 1);
        const undo = host.container.querySelector('.sbbs-undo-import');
        assert.equal(undo.hidden, false);
        assert.equal(undo.disabled, false);
        assert.equal(host.dom.window.document.activeElement, stop);
        undo.click();
        await waitFor(() => /Removed 1 of 1 imported card/.test(host.container.querySelector('.sbbs-state').textContent), 'stopped batch did not undo');
        assert.equal(host.stored.length, 0);
    } finally {
        host.restore();
    }
});

test('failed-only retry does not reimport successful rows and a supplied start policy waits', async () => {
    let failSecond = true;
    let secondDownloads = 0;
    const host = installHost({ routes: {
        '/card': options => {
            const { id } = JSON.parse(options.body);
            if (id === 'two') {
                secondDownloads++;
                if (failSecond) {
                    failSecond = false;
                    return jsonRoute({ error: 'source_busy' }, 503)();
                }
            }
            return new Response(PNG_BYTES);
        },
        '/inspect': options => {
            const report = structuredClone(REPORT);
            report.inside.name = options.body.name.includes('two') ? 'Second' : 'First';
            return jsonRoute(report)();
        },
        '/api/characters/import': (options, stored) => {
            const name = options.body.get('avatar').name.includes('two') ? 'Second' : 'First';
            stored.push({ name, avatar: `${name}.png`, data: {} });
            return jsonRoute({ file_name: name })();
        },
    } });
    try {
        const { showBulkImport } = await import('../client/intake.js?retry-batch');
        await showBulkImport(host.container, [
            { item: { id: 'one', name: 'First' }, source: BYTE_SOURCE },
            { item: { id: 'two', name: 'Second' }, source: BYTE_SOURCE },
        ], () => {}, { autoStart: false });
        assert.equal(host.calls.length, 0);
        host.container.querySelector('.sbbs-bulk-start').click();
        const retry = host.container.querySelector('.sbbs-bulk-retry');
        await waitFor(() => !retry.hidden && !retry.disabled, 'failed row did not become retryable');
        assert.equal(host.calls.filter(call => call.path === '/api/characters/import').length, 1);
        retry.click();
        await waitFor(() => /Imported 2 cards\./.test(host.container.querySelector('.sbbs-state').textContent), 'failed-only retry did not finish');
        assert.equal(secondDownloads, 2);
        assert.equal(host.calls.filter(call => call.path === '/api/characters/import').length, 2);
        assert.deepEqual(host.stored.map(entry => entry.name), ['First', 'Second']);
    } finally {
        host.restore();
    }
});

test('reviewing a skipped batch card preserves other results and restores focus on return', async () => {
    const host = installHost({
        characters: [{ name: 'Seraphina', avatar: 'old.png', data: {} }],
        routes: {
            '/card': () => new Response(PNG_BYTES),
            '/inspect': jsonRoute(REPORT),
        },
    });
    try {
        const { showBulkImport } = await import('../client/intake.js?batch-review');
        await showBulkImport(host.container, [{ item: CARD, source: BYTE_SOURCE }], () => {});
        const row = host.container.querySelector('.sbbs-bulk-row');
        const reviewButton = row.querySelector('.sbbs-bulk-review-card');
        reviewButton.click();
        const review = host.container.querySelector('.sbbs-bulk-review');
        await waitFor(() => review.querySelector('.sbbs-intake-choice'), 'batch review did not render');
        await settle(review);
        assert.equal(host.container.querySelector('.sbbs-bulk').hidden, true);
        assert.equal(host.container.querySelector('.sbbs-back'), review.querySelector('.sbbs-back'), 'Esc must find the review Back first');
        review.querySelector('.sbbs-back').click();
        assert.equal(host.container.querySelector('.sbbs-bulk').hidden, false);
        assert.equal(host.container.querySelector('.sbbs-bulk-row'), row, 'the batch DOM and its results survive');
        assert.equal(host.dom.window.document.activeElement, reviewButton);
        assert.equal(host.calls.filter(call => call.path.endsWith('/card')).length, 1, 'review reuses already-downloaded bytes');
    } finally {
        host.restore();
    }
});

test('incomplete batch inspections wait for review even under a clean policy', async () => {
    const report = structuredClone(REPORT);
    report.inside.scan = { complete: false, reasons: ['nodes'] };
    const host = installHost({ routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute(report),
    } });
    try {
        const { showBulkImport } = await import('../client/intake.js?batch-incomplete');
        await showBulkImport(host.container, [{ item: CARD, source: BYTE_SOURCE }], () => {}, { mode: 'clean' });
        assert.match(host.container.querySelector('.sbbs-state').textContent, /1 card needs inspection review/);
        assert.equal(host.calls.some(call => call.path.endsWith('/clean') || call.path === '/api/characters/import'), false);
        assert.equal(host.container.querySelector('.sbbs-bulk-review-card').disabled, false);
    } finally {
        host.restore();
    }
});

test('BotBooru intake errors offer the uniquely named inline account control', async () => {
    const host = installHost({ routes: {
        '/card': jsonRoute({ error: 'botbooru_login_required' }, 401),
        '/account/status': jsonRoute({ loggedIn: false }),
    } });
    try {
        const { showIntake } = await import('../client/intake.js?inline-botbooru');
        await showIntake(host.container, { card: CARD, source: { id: 'botbooru', label: 'BotBooru' } }, () => {});
        assert.match(host.container.querySelector('.sbbs-state').textContent, /Log in to BotBooru below/);
        assert.ok(host.container.querySelector('[id^="sbbs_intake_botbooru_"]'));
        await tick();
    } finally {
        host.restore();
    }
});

test('Janny action and restoration failures keep their actionable error rather than the native failure', async () => {
    for (const code of ['janny_admin_required', 'janny_browser_request_failed', 'janny_restore_failed']) {
        const host = installHost({ routes: {
            '/api/content/importURL': () => new Response('', { status: 502 }),
            '/url-card': jsonRoute({ error: code }, 503),
        } });
        try {
            const { showIntake } = await import('../client/intake.js?janny-action-errors');
            const { intakeErrorMessage } = await import('../client/copy.js');
            await showIntake(host.container, { card: JANNY_CARD, source: JANNY_SOURCE }, () => {});
            assert.equal(host.container.querySelector('.sbbs-state').textContent, intakeErrorMessage({ code }, 'jannyai'));
            assert.doesNotMatch(host.container.querySelector('.sbbs-state').textContent, /Cloudflare may be blocking/);
        } finally {
            host.restore();
        }
    }
});

test('a duplicate appearing just before automatic commit opens review rather than importing', async () => {
    let checks = 0;
    const installed = { name: 'Seraphina', avatar: 'newly-added.png', data: {} };
    const host = installHost({ characters: [installed], routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute(REPORT),
        '/api/characters/all': () => jsonRoute(++checks === 1 ? [] : [installed])(),
    } });
    try {
        const { showIntake } = await import('../client/intake.js?late-duplicate-review');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, { direct: true });
        assert.ok(host.container.querySelector('.sbbs-intake-choice'));
        assert.match(host.container.querySelector('.sbbs-intake-duplicate').textContent, /Already in your collection/);
        assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
        assert.equal(host.calls.filter(call => call.path.endsWith('/card')).length, 1);
    } finally {
        await settle(host.container);
        host.restore();
    }
});

test('an import added from batch review remains in the batch Undo list', async () => {
    const host = installHost({
        characters: [{ name: 'Seraphina', avatar: 'original.png', data: {} }],
        routes: {
            '/card': () => new Response(PNG_BYTES),
            '/inspect': jsonRoute(REPORT),
        },
    });
    try {
        const { showBulkImport } = await import('../client/intake.js?batch-review-import');
        await showBulkImport(host.container, [{ item: CARD, source: BYTE_SOURCE }], () => {});
        host.container.querySelector('.sbbs-bulk-review-card').click();
        const review = host.container.querySelector('.sbbs-bulk-review');
        await waitFor(() => review.querySelector('.sbbs-import'), 'review actions did not render');
        await settle(review);
        review.querySelector('.sbbs-import').click();
        await waitFor(() => review.querySelector('.sbbs-undo-import'), 'review import did not settle');
        review.querySelector('.sbbs-back').click();
        const undo = host.container.querySelector('.sbbs-bulk .sbbs-undo-import');
        assert.equal(undo.hidden, false);
        assert.equal(undo.disabled, false);
        assert.match(host.container.querySelector('.sbbs-bulk .sbbs-state').textContent, /Imported 1 card\./);
        undo.click();
        await waitFor(() => host.stored.length === 1 && undo.hidden, 'review import was not undone from the batch');
        assert.equal(host.stored[0].avatar, 'original.png', 'the pre-existing copy must remain untouched');
    } finally {
        host.restore();
    }
});

test('cleaning refusal is visible, disables further cleaning and never imports', async () => {
    const host = installHost({ routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute(REPORT),
        '/clean': jsonRoute({ error: 'clean_incomplete' }, 422),
    } });
    try {
        const { showIntake } = await import('../client/intake.js?clean-incomplete');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await settle(host.container);
        const clean = host.container.querySelector('.sbbs-import-clean');
        clean.click();
        await waitFor(() => /not all contents could be checked/.test(host.container.querySelector('.sbbs-import-status').textContent), 'cleaning refusal was not reported');
        assert.equal(clean.disabled, true);
        assert.equal(host.container.querySelector('.sbbs-import').disabled, false);
        assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
    } finally {
        host.restore();
    }
});

test('an empty incomplete report never claims that contents are absent or nothing needs cleaning', async () => {
    const host = installHost({ routes: {
        '/card': () => new Response(PNG_BYTES),
        '/inspect': jsonRoute({ inside: { name: 'Unknown card', scan: { complete: false, reasons: ['nodes'] } } }),
    } });
    try {
        const { showIntake } = await import('../client/intake.js?empty-incomplete');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {}, { direct: true });
        assert.match(host.container.querySelector('.sbbs-intake-scan-warning').textContent, /Not fully inspected/);
        assert.doesNotMatch(host.container.textContent, /No lorebook, scripts|nothing to remove/);
        assert.equal(host.calls.some(call => call.path === '/api/characters/import'), false);
    } finally {
        await settle(host.container);
        host.restore();
    }
});
