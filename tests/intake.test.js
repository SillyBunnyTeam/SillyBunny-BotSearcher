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
function installHost({ characters = [], routes = {}, getCharacters } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><section id="intake"></section></body></html>', {
        url: 'https://sillybunny.test/',
    });
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        fetch: globalThis.fetch,
        SillyTavern: globalThis.SillyTavern,
        File: globalThis.File,
        toastr: globalThis.toastr,
    };

    const calls = [];
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.toastr = { success() {}, error() {} };
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url);
        calls.push({ path, options });
        for (const [fragment, handler] of Object.entries(routes)) {
            if (path.includes(fragment)) {
                return handler(options);
            }
        }
        return new Response('{}', { status: 200 });
    };
    // The real host leaves `characters` empty until getCharacters() has run, so
    // the stub does the same — a stub that pre-populates it would hide exactly
    // the bug this models.
    const loaded = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            characters: loaded,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            getCharacters: getCharacters ?? (async () => {
                loaded.splice(0, loaded.length, ...characters);
            }),
            getTokenCountAsync: async (text) => text.length,
            selectCharacterById: async () => {},
        }),
    };

    return {
        calls,
        container: dom.window.document.querySelector('#intake'),
        restore() {
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
        assert.match(text, /risu_ext/, 'unrecognised extension data is named');
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

test('a local file is inspected without contacting any source', async () => {
    const host = installHost({ routes: { '/inspect': jsonRoute(REPORT) } });

    try {
        const { showIntake } = await import('../client/intake.js?local-file');
        const file = new File([PNG_BYTES], 'downloaded card.png', { type: 'image/png' });
        await showIntake(host.container, { file }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-list'), 'report did not render');

        assert.match(host.container.textContent, /Local file \(downloaded card\.png\)/);
        assert.deepEqual(
            host.calls.map((call) => call.path).filter((path) => !path.includes('/inspect')),
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
        getCharacters: async () => {
            throw new Error('offline');
        },
        routes: {
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
    let refreshed = 0;
    const host = installHost({
        characters: [{ avatar: 'Seraphina.png', name: 'Seraphina', data: { description: 'A knight.' } }],
        routes: {
            '/card': () => new Response(PNG_BYTES, { headers: { 'X-SBBS-Card-Kind': 'png' } }),
            '/inspect': jsonRoute(REPORT),
        },
    });
    const context = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern = {
        getContext: () => {
            const ctx = context();
            return { ...ctx, getCharacters: async () => { refreshed++; return ctx.getCharacters(); } };
        },
    };

    try {
        const { showIntake } = await import('../client/intake.js?collection-refresh');
        await showIntake(host.container, { card: CARD, source: BYTE_SOURCE }, () => {});
        await waitFor(() => host.container.querySelector('.sbbs-intake-duplicate'), 'duplicate line did not render');

        assert.ok(refreshed > 0, 'the character list must be refreshed before it is trusted');
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
