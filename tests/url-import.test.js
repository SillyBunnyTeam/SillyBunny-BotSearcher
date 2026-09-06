import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import zlib from 'node:zlib';

import { createSaucepanAccounts } from '../server/accounts.js';
import { buildPrivateCard, parseJannyUrl, resolveAvatarUrl } from '../server/janny-browser.js';
import { createRouter } from '../server/router.js';
import {
    assembleFragments,
    parseCompanionUrl,
    saucepan,
} from '../server/sources/saucepan.js';
import { PNG_SIGNATURE, crc32Range, validateCardBytes } from '../server/cardbytes.js';

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
    assert.deepEqual(store.cardRequest('profile-a').context, { bearerToken: 'saucepan-test-token' });
    assert.deepEqual(await store.status('profile-b'), { source: 'saucepan', loggedIn: false });
    assert.throws(() => store.cardRequest('profile-b'), (error) => error.code === 'saucepan_login_required');
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
    let avatarPng = null;
    const jannyBrowser = {
        async fetchCard(url) {
            calls.push(url);
            return { id: UUID, card: CARD, avatarPng };
        },
    };
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'url-import-admin', admin: true } };
        next();
    });
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

    // With a portrait the same card comes back inside a PNG, so the host keeps
    // the picture instead of substituting its generic one.
    avatarPng = tinyPng();
    const pictured = await post({ source: 'jannyai', url: `https://janitorai.com/characters/${UUID}` });
    assert.equal(pictured.status, 200);
    assert.equal(pictured.headers.get('x-sbbs-card-kind'), 'png');
    assert.match(pictured.headers.get('content-disposition'), /\.png"$/);
    const bytes = Buffer.from(await pictured.arrayBuffer());
    assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(validateCardBytes(bytes, 'png').inside.name, 'Bridge card');
});

function tinyPng() {
    const chunk = (type, data) => {
        const out = Buffer.alloc(data.length + 12);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'latin1');
        data.copy(out, 8);
        out.writeUInt32BE(crc32Range(out, 4, 8 + data.length), 8 + data.length);
        return out;
    };
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
        chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

test('the avatar is only ever fetched from the fixed JanitorAI image host', () => {
    const ella = 'https://ella.janitorai.com/bot-avatars/RKZ7faULC-0hCJm-_FzxO.webp?width=1200';
    assert.equal(resolveAvatarUrl({ avatar: 'RKZ7faULC-0hCJm-_FzxO.webp' }), ella);
    assert.equal(resolveAvatarUrl({ profile_image: 'a.jpg' }), 'https://ella.janitorai.com/bot-avatars/a.jpg?width=1200');
    assert.equal(resolveAvatarUrl({ avatar: 'x.webp' }, 'https://ella.janitorai.com/chats/y.png?width=400'), 'https://ella.janitorai.com/chats/y.png?width=400');

    // Metadata and page markup are attacker-influenced: nothing else is fetched.
    assert.equal(resolveAvatarUrl({ avatar: 'https://ella.janitorai.com/bot-avatars/a.png' }), null);
    assert.equal(resolveAvatarUrl({ avatar: '../etc/passwd.png' }), null);
    assert.equal(resolveAvatarUrl({ avatar: 'a.svg' }), null);
    assert.equal(resolveAvatarUrl({}, 'http://ella.janitorai.com/bot-avatars/a.png'), null);
    assert.equal(resolveAvatarUrl({}, 'https://ella.janitorai.com:8443/bot-avatars/a.png'), null);
    assert.equal(resolveAvatarUrl({}, 'https://user:pw@ella.janitorai.com/bot-avatars/a.png'), null);
    assert.equal(resolveAvatarUrl({}, 'https://ella.janitorai.com.evil/bot-avatars/a.png'), null);
    assert.equal(resolveAvatarUrl({}, 'https://ella.janitorai.com/other/a.png'), null);
    assert.equal(resolveAvatarUrl({}, 'https://127.0.0.1/bot-avatars/a.png'), null);
    assert.equal(resolveAvatarUrl(null, null), null);
});

test('Janny URL parsing allows the site and JanitorAI import forms only', () => {
    assert.equal(parseJannyUrl(`https://jannyai.com/characters/${UUID}_character-test`).id, UUID);
    assert.equal(parseJannyUrl(`https://janitorai.com/characters/${UUID}`)?.id, UUID);
    assert.equal(parseJannyUrl(`https://jannyai.com/characters/${UUID}?next=evil`), null);
    assert.equal(parseJannyUrl(`https://evil-jannyai.com/characters/${UUID}`), null);
});
