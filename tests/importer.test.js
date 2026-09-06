import test from 'node:test';
import assert from 'node:assert/strict';

const CARD = Object.freeze({ id: 'card-1' });
const SOURCE = Object.freeze({ id: 'quillgen' });

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function response(body, { status = 200, headers = {} } = {}) {
    return new Response(body, { status, headers });
}

function installHost(fetchImpl, characters = [], { revisionResponse, collectionResponse, ...extra } = {}) {
    const previousFetch = globalThis.fetch;
    const previousSillyTavern = globalThis.SillyTavern;
    const previousWindow = globalThis.window;
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('/characters/')) {
            const avatar = decodeURIComponent(String(url).slice('/characters/'.length));
            return revisionResponse ? revisionResponse(avatar, options)
                : response(characters.some((entry) => entry.avatar === avatar) ? PNG_BYTES : '', {
                    status: characters.some((entry) => entry.avatar === avatar) ? 200 : 404,
                });
        }
        if (String(url) === '/api/characters/all') {
            return collectionResponse ? collectionResponse(options) : response(JSON.stringify(characters));
        }
        return fetchImpl(url, options);
    };
    // render.js resolves every candidate URL against the page origin, so the
    // host-check paths need one even outside a browser.
    globalThis.window = { location: { origin: 'https://sillybunny.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({
            characters,
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
            getCharacters: async () => {},
            ...extra,
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
        return response('{"file_name":"Seraphina"}');
    }, characters);

    try {
        const { commitPreparedCardImport, readCharacterRevision } = await import('../client/importer.js?replace');
        const expectedRevision = await readCharacterRevision('Seraphina.png');
        const result = await commitPreparedCardImport({
            file: new File(['bytes'], 'card.png', { type: 'image/png' }),
            kind: 'png',
        }, { replaceAvatar: 'Seraphina.png', expectedRevision });

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
        return response(JSON.stringify({ file_name: `avatar-${ordinal}` }));
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

test('Undo keeps targets literal and closes only the active character chat', async () => {
    const characters = [
        { avatar: 'Other.png', name: 'Other' },
        { avatar: 'Seraphina.png', name: 'Seraphina' },
    ];
    const calls = [];
    const commands = [];
    let refreshes = 0;
    let closes = 0;
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
            closeCurrentChat: async () => { closes++; characterId = undefined; return true; },
        }),
    };

    try {
        const { removeCharacter, readCharacterRevision } = await import('../client/importer.js?remove');
        const expectedRevision = await readCharacterRevision('Seraphina.png');

        // Not the open character: the route, then a list refresh.
        characterId = '0';
        await removeCharacter('Seraphina.png', { expectedRevision });
        assert.deepEqual(calls, [{ url: '/api/characters/delete', body: { avatar_url: 'Seraphina.png', delete_chats: false } }]);
        assert.equal(refreshes, 1);
        assert.deepEqual(commands, []);

        // The open character: close its chat, then use the same literal route.
        characterId = '1';
        await removeCharacter('Seraphina.png', { expectedRevision });
        assert.equal(calls.length, 2);
        assert.equal(closes, 1);
        assert.deepEqual(commands, [], 'filenames must never become interpreted commands');

        await assert.rejects(removeCharacter('Missing.png', { expectedRevision }), /character_missing/);
    } finally {
        restore();
    }
});

test('the checked import receipt identifies the card despite unrelated collection additions', async () => {
    const characters = [];
    const restore = installHost(async () => {
        characters.push({ avatar: 'Imported.png', name: 'Imported' }, { avatar: 'Unrelated.png', name: 'Unrelated' });
        return response('{"file_name":"Imported"}');
    }, characters, {
        getCharacters: async () => characters.splice(0, characters.length, ...structuredClone(characters)),
    });
    try {
        const { commitPreparedCardImport } = await import('../client/importer.js?receipt-identity');
        const added = await commitPreparedCardImport({ file: new File(['{}'], 'card.json'), kind: 'json' });
        assert.equal(added.avatar, 'Imported.png');
        assert.equal(added.committed, true);
        assert.equal(added.canUndo, true);
        assert.equal(added.refreshed, true);
        assert.match(added.revision, /^[a-f0-9]{64}$/);
    } finally {
        restore();
    }
});

test('HTTP 200 errors fail both add and replace, and an invalid receipt never authorises Undo', async () => {
    const characters = [{ avatar: 'Existing.png', name: 'Existing' }];
    let payload = '{"error":true}';
    const restore = installHost(async () => response(payload), characters);
    try {
        const { commitPreparedCardImport, readCharacterRevision } = await import('../client/importer.js?invalid-receipts');
        const prepared = { file: new File(['{}'], 'card.json'), kind: 'json' };
        const expectedRevision = await readCharacterRevision('Existing.png');
        for (const options of [{}, { replaceAvatar: 'Existing.png', expectedRevision }]) {
            await assert.rejects(commitPreparedCardImport(prepared, options), /import_failed/);
        }
        for (payload of ['{}', 'not json', '{"file_name":"../Other"}', '{"file_name":"Other\\\\file"}']) {
            const result = await commitPreparedCardImport(prepared);
            assert.equal(result.committed, null);
            assert.equal(result.avatar, null);
            assert.equal(result.canUndo, false);
        }
        payload = '{"file_name":"Other"}';
        const mismatched = await commitPreparedCardImport(prepared, { replaceAvatar: 'Existing.png', expectedRevision });
        assert.equal(mismatched.avatar, null, 'a mismatched replacement receipt must not supply another target');
    } finally {
        restore();
    }
});

test('a committed import stays successful when the host list refresh fails or silently does nothing', async () => {
    for (const getCharacters of [async () => { throw new Error('offline'); }, async () => {}]) {
        const characters = [];
        let imports = 0;
        const restore = installHost(async () => {
            imports++;
            characters.push({ avatar: 'Saved.png', name: 'Saved' });
            return response('{"file_name":"Saved"}');
        }, characters, { getCharacters });
        try {
            const { commitPreparedCardImport } = await import('../client/importer.js?refresh-outcome');
            const result = await commitPreparedCardImport({ file: new File(['{}'], 'card.json'), kind: 'json' });
            assert.equal(result.committed, true);
            assert.equal(result.refreshed, false);
            assert.equal(result.avatar, 'Saved.png');
            assert.equal(imports, 1, 'refresh errors must never retry a successful write');
        } finally {
            restore();
        }
    }
});

test('native fallback uses checked receipts and withholds Undo when the receipt is ambiguous', async () => {
    for (const confirmed of [true, false]) {
        const characters = [];
        const calls = [];
        const restore = installHost(async url => {
            calls.push(url);
            if (url === '/api/content/importURL') {
                return response(PNG_BYTES, { headers: { 'X-Custom-Content-Type': 'character' } });
            }
            characters.push({ avatar: 'Native.png', name: 'Native' });
            return response(confirmed ? '{"file_name":"Native"}' : '{}');
        }, characters, {
            importFromExternalUrl: async () => { assert.fail('opaque native importer must not be used'); },
        });
        try {
            const { importCard } = await import('../client/importer.js?native-attribution');
            const result = await importCard(NATIVE_CARD, NATIVE_SOURCE);
            assert.equal(result.committed, confirmed ? true : null);
            assert.equal(result.canUndo, confirmed);
            assert.equal(result.avatar, confirmed ? 'Native.png' : null);
            assert.deepEqual(calls, ['/api/content/importURL', '/api/characters/import']);
        } finally {
            restore();
        }
    }
});

test('cancellation stops queued writes but lets an already-sent import return its receipt', async () => {
    const characters = [];
    let release;
    let imports = 0;
    const restore = installHost(async (_url, options) => {
        imports++;
        assert.equal(options.signal, undefined, 'screen disposal must not abort an already-sent write');
        await new Promise(resolve => { release = resolve; });
        characters.push({ avatar: 'Saved.png', name: 'Saved' });
        return response('{"file_name":"Saved"}');
    }, characters);
    try {
        const { commitPreparedCardImport } = await import('../client/importer.js?cancel-queue');
        const prepared = { file: new File(['{}'], 'card.json'), kind: 'json' };
        const active = new AbortController();
        const queued = new AbortController();
        const first = commitPreparedCardImport(prepared, { signal: active.signal });
        await new Promise(resolve => setTimeout(resolve, 0));
        const second = commitPreparedCardImport(prepared, { signal: queued.signal });
        const rejected = assert.rejects(second, { name: 'AbortError' });
        queued.abort();
        active.abort();
        release();
        assert.equal((await first).committed, true);
        await rejected;
        assert.equal(imports, 1);
    } finally {
        restore();
    }
});

test('changed or unverifiable revisions block replacement and Undo before any write', async () => {
    const characters = [{ avatar: 'Existing.png', name: 'Existing' }];
    let bytes = PNG_BYTES;
    let writes = 0;
    const restore = installHost(async () => { writes++; return response('{}'); }, characters, {
        revisionResponse: () => response(bytes),
    });
    try {
        const { commitPreparedCardImport, readCharacterRevision, removeCharacter } = await import('../client/importer.js?revision-guards');
        const expectedRevision = await readCharacterRevision('Existing.png');
        bytes = new Uint8Array([...PNG_BYTES, 1]);
        const prepared = { file: new File(['{}'], 'card.json'), kind: 'json' };
        await assert.rejects(commitPreparedCardImport(prepared, { replaceAvatar: 'Existing.png', expectedRevision }), /character_changed/);
        await assert.rejects(removeCharacter('Existing.png', { expectedRevision }), /character_changed/);
        await assert.rejects(removeCharacter('Existing.png'), /character_unverified/);
        await assert.rejects(commitPreparedCardImport(prepared, { replaceAvatar: 'Existing.png' }), /character_unverified/);
        assert.equal(writes, 0);
    } finally {
        restore();
    }
});

test('an active placeholder filename is deleted literally even if chat closing changes selection', async () => {
    const characters = [{ avatar: '{{user}}.png', name: '{{user}}' }, { avatar: 'Other.png', name: 'Other' }];
    let deleted;
    let commands = 0;
    const restore = installHost(async (_url, options) => {
        deleted = JSON.parse(options.body);
        return response('{}');
    }, characters, {
        characterId: 0,
        closeCurrentChat: async () => true,
        executeSlashCommandsWithOptions: async () => { commands++; },
    });
    const getContext = globalThis.SillyTavern.getContext;
    let characterId = 0;
    globalThis.SillyTavern.getContext = () => ({
        ...getContext(),
        characterId,
        closeCurrentChat: async () => { characterId = 1; return true; },
    });
    try {
        const { readCharacterRevision, removeCharacter } = await import('../client/importer.js?literal-delete');
        await removeCharacter('{{user}}.png', { expectedRevision: await readCharacterRevision('{{user}}.png') });
        assert.deepEqual(deleted, { avatar_url: '{{user}}.png', delete_chats: false });
        assert.equal(commands, 0);
    } finally {
        restore();
    }
});

test('generation guards imports and Undo at the write boundary', async () => {
    const previous = globalThis.document;
    globalThis.document = { body: { dataset: { generating: 'true' } } };
    let writes = 0;
    const restore = installHost(async () => { writes++; return response('{}'); });
    try {
        const { commitPreparedCardImport, removeCharacter } = await import('../client/importer.js?generation-guard');
        await assert.rejects(commitPreparedCardImport({ file: new File(['{}'], 'card.json'), kind: 'json' }), /generation_active/);
        await assert.rejects(removeCharacter('Existing.png', { expectedRevision: 'a'.repeat(64) }), /generation_active/);
        assert.equal(writes, 0);
    } finally {
        restore();
        globalThis.document = previous;
    }
});

test('supplied cancellation signals do not remove preparation deadlines', async () => {
    const originalTimeout = AbortSignal.timeout;
    const timeout = new AbortController();
    const external = new AbortController();
    let sent;
    AbortSignal.timeout = () => timeout.signal;
    const restore = installHost(async (_url, options) => {
        sent = options.signal;
        return new Promise((_resolve, reject) => sent.addEventListener('abort', () => reject(sent.reason), { once: true }));
    });
    try {
        const { prepareCardImport } = await import('../client/importer.js?combined-deadline');
        const pending = prepareCardImport(CARD, SOURCE, { signal: external.signal });
        timeout.abort(new DOMException('timed out', 'TimeoutError'));
        await assert.rejects(pending, { name: 'TimeoutError' });
        assert.equal(sent.aborted, true);
        assert.equal(external.signal.aborted, false);
    } finally {
        restore();
        AbortSignal.timeout = originalTimeout;
    }
});

test('cancelling the native fallback download cannot start its later import', async () => {
    let release;
    let writes = 0;
    const restore = installHost(async url => {
        if (url === '/api/content/importURL') {
            return new Promise(resolve => { release = () => resolve(response(PNG_BYTES, { headers: { 'X-Custom-Content-Type': 'character' } })); });
        }
        writes++;
        return response('{}');
    });
    try {
        const { importCard } = await import('../client/importer.js?native-cancel');
        const controller = new AbortController();
        const pending = importCard(NATIVE_CARD, NATIVE_SOURCE, { signal: controller.signal });
        controller.abort();
        release();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(writes, 0);
    } finally {
        restore();
    }
});

test('automatic imports recheck absence in the queue and never treat a failed check as absent', async () => {
    for (const collectionResponse of [
        () => response('[{"name":"Same","avatar":"Same.png"}]'),
        () => response('{"error":true}', { status: 500 }),
    ]) {
        let writes = 0;
        const restore = installHost(async () => { writes++; return response('{}'); }, [], { collectionResponse });
        try {
            const { commitPreparedCardImport } = await import('../client/importer.js?queued-absence');
            await assert.rejects(
                commitPreparedCardImport({ file: new File(['{}'], 'card.json'), kind: 'json' }, { requireNewName: 'Same' }),
                /duplicate_detected|collection_unavailable/,
            );
            assert.equal(writes, 0);
        } finally {
            restore();
        }
    }
});
