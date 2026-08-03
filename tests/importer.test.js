import test from 'node:test';
import assert from 'node:assert/strict';

const CARD = Object.freeze({ id: 'card-1' });
const SOURCE = Object.freeze({ id: 'quillgen' });
const INSIDE = Object.freeze({ specVersion: 'chara_card_v3', hasSystemPrompt: true });

function response(body, { status = 200, headers = {} } = {}) {
    return new Response(body, { status, headers });
}

function installHost(fetchImpl, characters = []) {
    const previousFetch = globalThis.fetch;
    const previousSillyTavern = globalThis.SillyTavern;
    globalThis.fetch = fetchImpl;
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
    };
}

test('preparing a byte card inspects retained bytes without importing them', async () => {
    const calls = [];
    const payload = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Prepared' } });
    const restore = installHost(async (url, options) => {
        calls.push({ url: String(url), options });
        return response(payload, {
            headers: {
                'X-SBBS-Card-Kind': 'json',
                'X-SBBS-Card-Inside': encodeURIComponent(JSON.stringify(INSIDE)),
            },
        });
    });

    try {
        const { prepareCardImport } = await import('../client/importer.js?prepare-only');
        const prepared = await prepareCardImport(CARD, SOURCE);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url.endsWith('/card'), true);
        assert.equal(prepared.kind, 'json');
        assert.deepEqual(prepared.inside, INSIDE);
        assert.equal(await prepared.file.text(), payload);
    } finally {
        restore();
    }
});

test('committing inspected cards serializes host imports and retains the inspected report', async () => {
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
            inside: { hasSystemPrompt: true },
        };
        const second = {
            file: new File(['second bytes'], 'second.json', { type: 'application/json' }),
            kind: 'json',
            inside: { hasDepthPrompt: true },
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
        assert.deepEqual(firstResult.inside, first.inside);
        assert.equal(secondResult.avatar, 'avatar-2.png');
        assert.deepEqual(secondResult.inside, second.inside);
    } finally {
        restore();
    }
});
