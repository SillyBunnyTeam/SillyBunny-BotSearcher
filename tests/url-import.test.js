import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createSaucepanAccounts } from '../server/accounts.js';
import { buildPrivateCard, parseJannyUrl } from '../server/janny-browser.js';
import { createRouter } from '../server/router.js';
import {
    assembleFragments,
    parseCompanionUrl,
    saucepan,
} from '../server/sources/saucepan.js';
import { validateCardBytes } from '../server/cardbytes.js';

const UUID = '311a6844-61d6-4468-aa98-91ecc7fbae86';
const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Bridge card', description: 'A character.' },
};

function fragmentHash(mask, key, text) {
    const rotl = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;
    let hash = (2166136261 ^ rotl(mask, 7) ^ rotl(key ^ mask, 13)) >>> 0;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
}

function fragment(mask, key, text) {
    return { key, text, proof: fragmentHash(mask, key, text) };
}

function content(mask, entries) {
    return { mask, fragments: entries.map(([key, text]) => fragment(mask, key, text)) };
}

test('Saucepan URLs and proof fragments stay source-bound and ordered', () => {
    assert.deepEqual(
        parseCompanionUrl('https://saucepan.ai/companion/abcdef12?x=1'),
        null,
    );
    assert.deepEqual(
        parseCompanionUrl('https://saucepan.ai/companion/abcdef12/'),
        { id: 'abcdef12', url: 'https://saucepan.ai/companion/abcdef12' },
    );

    const mask = 0;
    const real = content(mask, [[9, 'second'], [2, 'first']]);
    real.fragments.push({ key: 4, text: 'decoy', proof: 0 });
    assert.equal(assembleFragments(real), 'firstsecond');
});

test('Saucepan assembles a validated v2 card from its two API shapes', async () => {
    const mask = 0x2468ace0;
    const calls = [];
    const context = {
        async fetchJson(url) {
            calls.push(String(url));
            if (url.pathname.includes('/definition')) {
                return {
                    sections: [
                        { title: 'Companion Core', content: content(mask, [[2, 'Core text.']]) },
                        { title: 'Example Dialogue', content: content(mask, [[3, '<START>Hi.']]) },
                    ],
                };
            }
            return {
                companion: {
                    display_name: 'Saucepan character',
                    tags: ['fantasy'],
                    starting_scenarios_fragments: [
                        { message: content(mask, [[4, 'Hello there.']]) },
                        { message: content(mask, [[5, 'Alternate hello.']]) },
                    ],
                },
            };
        },
    };

    const card = await saucepan.buildCard(context, 'abcdef12');
    assert.equal(calls.length, 2);
    assert.equal(card.data.name, 'Saucepan character');
    assert.equal(card.data.description, 'Core text.');
    assert.equal(card.data.first_mes, 'Hello there.');
    assert.deepEqual(card.data.alternate_greetings, ['Alternate hello.']);
    assert.equal(validateCardBytes(Buffer.from(JSON.stringify(card)), 'json').spec, 'chara_card_v2');
});

test('Saucepan bearers stay profile-scoped and out of public status', async () => {
    const adapter = {
        async login() {
            return 'saucepan-test-token';
        },
    };
    const store = createSaucepanAccounts({
        adapter,
        makeContext: (_adapter, options) => options,
    });

    await store.login('profile-a', 'alice', 'password');
    assert.deepEqual(await store.status('profile-a'), { source: 'saucepan', loggedIn: true });
    assert.deepEqual(store.context('profile-a'), { bearerToken: 'saucepan-test-token' });
    assert.deepEqual(await store.status('profile-b'), { source: 'saucepan', loggedIn: false });
    assert.throws(() => store.context('profile-b'), (error) => error.code === 'saucepan_login_required');
});

test('the Janny browser mapper reconstructs a private card from a captured prompt', () => {
    const payload = {
        messages: [
            {
                role: 'system',
                content: '<UserPersona>Ignore me.</UserPersona>\n<Jane\'s Persona>Private definition.</Jane\'s Persona>\n<Scenario>At home.</Scenario>',
            },
            { role: 'assistant', content: 'Welcome.' },
        ],
    };
    const card = buildPrivateCard(payload, {
        name: 'Jane',
        first_message: 'Hello first.',
        custom_tags: ['private'],
    });

    assert.equal(card.data.name, 'Jane');
    assert.equal(card.data.description, 'Private definition.');
    assert.equal(card.data.scenario, 'At home.');
    assert.equal(card.data.first_mes, 'Hello first.');
    assert.deepEqual(card.data.tags, ['private']);
    assert.equal(validateCardBytes(Buffer.from(JSON.stringify(card)), 'json').spec, 'chara_card_v2');
});

test('the URL-card bridge accepts only the two explicit source URL forms', async (t) => {
    const calls = [];
    const jannyBrowser = {
        async fetchCard(url) {
            calls.push(url);
            return { id: UUID, card: CARD };
        },
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    createRouter(router, {
        startedAt: Date.now(),
        jannyBrowser,
        saucepan: {
            status: () => ({ source: 'saucepan', loggedIn: false }),
            clear() {},
        },
    });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());

    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/url-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const rejected = await post({ source: 'jannyai', url: 'https://evil.example/characters/' + UUID });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 0);

    const accepted = await post({
        source: 'jannyai',
        url: `https://jannyai.com/characters/${UUID}_character-test`,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('x-sbbs-card-kind'), 'json');
    assert.deepEqual(JSON.parse(await accepted.text()), CARD);
    assert.deepEqual(calls, [`https://jannyai.com/characters/${UUID}_character-test`]);
});

test('Janny URL parsing allows the site and JanitorAI import forms only', () => {
    assert.equal(parseJannyUrl(`https://jannyai.com/characters/${UUID}_character-test`).id, UUID);
    assert.equal(parseJannyUrl(`https://janitorai.com/characters/${UUID}`)?.id, UUID);
    assert.equal(parseJannyUrl(`https://jannyai.com/characters/${UUID}?next=evil`), null);
    assert.equal(parseJannyUrl(`https://evil-jannyai.com/characters/${UUID}`), null);
});
