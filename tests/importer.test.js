import test from 'node:test';
import assert from 'node:assert/strict';

const CARD = Object.freeze({ id: 'card-1' });
const SOURCE = Object.freeze({ id: 'quillgen' });

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function response(body, { status = 200, headers = {} } = {}) {
    return new Response(body, { status, headers });
}

function installHost(fetchImpl, characters = []) {
    const previousFetch = globalThis.fetch;
    const previousSillyTavern = globalThis.SillyTavern;
    const previousWindow = globalThis.window;
    globalThis.fetch = fetchImpl;
    // render.js resolves every candidate URL against the page origin, so the
    // host-check paths need one even outside a browser.
    globalThis.window = { location: { origin: 'https://sillybunny.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
            getCharacters: async () => {},
        }),
    };
    return () => {
        globalThis.fetch = previousFetch;
        globalThis.SillyTavern = previousSillyTavern;
        globalThis.window = previousWindow;
    };
}

test('preparing a byte card retains the bytes without importing them', async () => {
    const calls = [];
    const payload = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Prepared' } });
    const restore = installHost(async (url, options) => {
        calls.push({ url: String(url), options });
        return response(payload, { headers: { 'X-SBBS-Card-Kind': 'json' } });
    });

    try {
        const { prepareCardImport } = await import('../client/importer.js?prepare-only');
        const prepared = await prepareCardImport(CARD, SOURCE);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url.endsWith('/card'), true);
        assert.equal(prepared.kind, 'json');
        assert.equal(await prepared.file.text(), payload);
    } finally {
        restore();
    }
});

// ---- native sources ----

const NATIVE_CARD = Object.freeze({ id: 'abc', importUrl: 'https://chub.ai/characters/a/b' });
const NATIVE_SOURCE = Object.freeze({ id: 'chub', nativeImport: true, clientHosts: ['chub.ai'] });

test('a native card is downloaded by the host route, and nothing is imported', async () => {
    const calls = [];
    const restore = installHost(async (url, options) => {
        calls.push({ url: String(url), options });
        return response(PNG_BYTES, { headers: { 'X-Custom-Content-Type': 'character' } });
    });

    try {
        const { fetchNativeCardBytes } = await import('../client/importer.js?native-bytes');
        const prepared = await fetchNativeCardBytes(NATIVE_CARD, NATIVE_SOURCE);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/api/content/importURL', 'the host downloads it, not this plugin');
        assert.deepEqual(JSON.parse(calls[0].options.body), { url: NATIVE_CARD.importUrl });
        // The magic bytes decide, not the response headers.
        assert.equal(prepared.kind, 'png');
        assert.equal(prepared.file.name, 'chub-abc.png');
        // Nothing reached the character importer.
        assert.ok(!calls.some((call) => call.url.includes('/api/characters/import')));
    } finally {
        restore();
    }
});

test('a lorebook returned by the host route is refused', async () => {
    // /api/content/importURL serves lorebooks from the same path. Only a
    // character may ever reach the importer.
    const restore = installHost(async () => response(PNG_BYTES, {
        headers: { 'X-Custom-Content-Type': 'lorebook' },
    }));

    try {
        const { fetchNativeCardBytes } = await import('../client/importer.js?native-lorebook');
        await assert.rejects(
            () => fetchNativeCardBytes(NATIVE_CARD, NATIVE_SOURCE),
            (error) => error.message === 'not_a_character',
        );
    } finally {
        restore();
    }
});

test('an import URL off the source\'s own hosts is refused before any request', async () => {
    const calls = [];
    const restore = installHost(async (url) => {
        calls.push(String(url));
        return response('{}');
    });

    try {
        const { fetchNativeCardBytes } = await import('../client/importer.js?native-host-check');
        await assert.rejects(
            () => fetchNativeCardBytes({ id: 'x', importUrl: 'https://evil.example/card' }, NATIVE_SOURCE),
            (error) => error.message === 'import_url_rejected',
        );
        assert.deepEqual(calls, [], 'nothing may be requested for a rejected URL');
    } finally {
        restore();
    }
});

test('a failed host download reports itself rather than importing anyway', async () => {
    const restore = installHost(async () => response('nope', { status: 500 }));

    try {
        const { fetchNativeCardBytes } = await import('../client/importer.js?native-failure');
        await assert.rejects(
            () => fetchNativeCardBytes(NATIVE_CARD, NATIVE_SOURCE),
            (error) => error.message === 'native_download_failed',
        );
    } finally {
        restore();
    }
});

test('replacing an installed character preserves its avatar instead of adding a copy', async () => {
    const characters = [{ avatar: 'Seraphina.png', name: 'Seraphina' }];
    const calls = [];
    const restore = installHost(async (url, options) => {
        calls.push({ url: String(url), options });
        return response('{}');
    }, characters);

    try {
        const { commitPreparedCardImport } = await import('../client/importer.js?replace');
        const result = await commitPreparedCardImport({
            file: new File(['bytes'], 'card.png', { type: 'image/png' }),
            kind: 'png',
        }, { replaceAvatar: 'Seraphina.png' });

        assert.equal(calls[0].options.body.get('preserved_name'), 'Seraphina.png');
        assert.equal(result.avatar, 'Seraphina.png');
        assert.equal(result.name, 'Seraphina');
        assert.equal(characters.length, 1, 'replacing must not add a second copy');
    } finally {
        restore();
    }
});

test('committing inspected cards serializes host imports', async () => {
    const characters = [];
    const calls = [];
    let releaseFirst;
    const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
    let firstImportSeen;
    const firstImportStarted = new Promise((resolve) => { firstImportSeen = resolve; });
    const restore = installHost(async (url, options) => {
        calls.push({ url: String(url), options });
        const ordinal = calls.length;
        if (ordinal === 1) {
            firstImportSeen();
            await firstStarted;
        }
        const uploaded = options.body.get('avatar');
        assert.equal(await uploaded.text(), ordinal === 1 ? 'first bytes' : 'second bytes');
        characters.push({ avatar: `avatar-${ordinal}.png`, name: `Card ${ordinal}` });
        return response('{}');
    }, characters);

    try {
        const { commitPreparedCardImport } = await import('../client/importer.js?serialized-commit');
        const first = {
            file: new File(['first bytes'], 'first.json', { type: 'application/json' }),
            kind: 'json',
        };
        const second = {
            file: new File(['second bytes'], 'second.json', { type: 'application/json' }),
            kind: 'json',
        };

        const firstCommit = commitPreparedCardImport(first);
        await firstImportStarted;
        const secondCommit = commitPreparedCardImport(second);
        await Promise.resolve();
        assert.equal(calls.length, 1, 'the second import waits for the first list-diff transaction');

        releaseFirst();
        const [firstResult, secondResult] = await Promise.all([firstCommit, secondCommit]);
        assert.equal(calls.length, 2);
        assert.equal(firstResult.avatar, 'avatar-1.png');
        assert.equal(secondResult.avatar, 'avatar-2.png');
    } finally {
        restore();
    }
});

test('undoing an import deletes through the plain route unless the character is the open one', async () => {
    const characters = [
        { avatar: 'Other.png', name: 'Other' },
        { avatar: 'Seraphina.png', name: 'Seraphina' },
    ];
    const calls = [];
    const commands = [];
    let refreshes = 0;
    let characterId;
    const restore = installHost(async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return response('{}');
    }, characters);
    // The harness's context has no open character; this test needs to vary it.
    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            characterId,
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
            getCharacters: async () => { refreshes++; },
            executeSlashCommandsWithOptions: async (command) => {
                commands.push(command);
                return { pipe: 'true' };
            },
        }),
    };

    try {
        const { removeCharacter } = await import('../client/importer.js?remove');

        // Not the open character: the route, then a list refresh.
        characterId = '0';
        await removeCharacter('Seraphina.png');
        assert.deepEqual(calls, [{ url: '/api/characters/delete', body: { avatar_url: 'Seraphina.png', delete_chats: false } }]);
        assert.equal(refreshes, 1);
        assert.deepEqual(commands, []);

        // The open character: the host's own command, which also closes its chat.
        characterId = '1';
        await removeCharacter('Seraphina.png');
        assert.equal(calls.length, 1, 'the open character must not be deleted behind the host\'s back');
        assert.deepEqual(commands, ['/char-delete char="Seraphina.png" silent=true deleteChats=false']);

        await assert.rejects(removeCharacter('Missing.png'), /character_missing/);
    } finally {
        restore();
    }
});
