/**
 * Outbound-request hardening, thumbnail refs, image sniffing and the circuit
 * breaker — the parts that decide what this plugin can be made to do by a
 * hostile or merely broken upstream.
 *
 * A local http server stands in for a card site. Reaching it needs
 * allowInsecureForTests, which no shipped adapter sets (asserted below).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { fetchJson, fetchBytes } from '../server/http.js';
import { mintRef, verifyRef } from '../server/refs.js';
import { detectImageType } from '../server/imagetype.js';
import { markFailure, markSuccess, isDown, stateOf, clearAll, classify } from '../server/health.js';
import { SOURCES } from '../server/registry.js';

/** Starts a throwaway upstream; returns { port, url, requests, close }. */
async function upstream(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        handler(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    return {
        port,
        requests,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function testAdapter(hosts) {
    return { id: 'test', allowedHosts: hosts, allowInsecureForTests: true };
}

test('a response larger than maxBytes is refused without buffering it', async () => {
    const server = await upstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // 8 MB against a 64 KB cap.
        res.end(JSON.stringify({ blob: 'x'.repeat(8 * 1024 * 1024) }));
    });

    try {
        const adapter = testAdapter(['127.0.0.1']);
        await assert.rejects(
            () => fetchJson(adapter, `http://127.0.0.1:${server.port}/big`, { maxBytes: 64 * 1024, timeoutMs: 5000 }),
            (error) => error.code === 'too_large',
        );
    } finally {
        await server.close();
    }
});

test('a redirect to another host is refused and that host is never contacted', async () => {
    const victim = await upstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"leaked":true}');
    });

    const redirector = await upstream((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.2:${victim.port}/pwn` });
        res.end();
    });

    try {
        // Only 127.0.0.1 is allow-listed, so the hop to 127.0.0.2 must fail.
        const adapter = testAdapter(['127.0.0.1']);
        await assert.rejects(
            () => fetchJson(adapter, `http://127.0.0.1:${redirector.port}/start`, { timeoutMs: 5000 }),
            (error) => error.code === 'host_not_allowed',
        );
        assert.equal(victim.requests.length, 0, 'the off-allow-list host must never receive a request');
    } finally {
        await redirector.close();
        await victim.close();
    }
});

test('a same-host redirect is followed, but the chain is bounded', async () => {
    let hops = 0;
    const server = await upstream((req, res) => {
        if (req.url === '/final') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }
        hops += 1;
        res.writeHead(302, { Location: `/hop${hops}` });
        res.end();
    });

    try {
        const adapter = testAdapter(['127.0.0.1']);

        // One hop then a result: fine.
        const oneHop = await upstream((req, res) => {
            if (req.url === '/final') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } else {
                res.writeHead(302, { Location: '/final' });
                res.end();
            }
        });
        const body = await fetchJson(adapter, `http://127.0.0.1:${oneHop.port}/start`, { timeoutMs: 5000 });
        assert.deepEqual(body, { ok: true });
        await oneHop.close();

        // An endless chain is cut off rather than followed.
        await assert.rejects(
            () => fetchJson(adapter, `http://127.0.0.1:${server.port}/start`, { timeoutMs: 5000 }),
            (error) => error.code === 'too_many_redirects',
        );
    } finally {
        await server.close();
    }
});

test('a server that never answers is abandoned at the timeout', async () => {
    const server = await upstream(() => { /* deliberately never responds */ });

    try {
        const adapter = testAdapter(['127.0.0.1']);
        const startedAt = Date.now();
        await assert.rejects(
            () => fetchJson(adapter, `http://127.0.0.1:${server.port}/hang`, { timeoutMs: 700 }),
            (error) => error.code === 'timeout',
        );
        assert.ok(Date.now() - startedAt < 4000, 'must give up near the timeout, not hang');
    } finally {
        await server.close();
    }
});

test('outbound requests carry no cookie, authorization or referer', async () => {
    const server = await upstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });

    try {
        await fetchJson(testAdapter(['127.0.0.1']), `http://127.0.0.1:${server.port}/x`, { timeoutMs: 5000 });

        const sent = server.requests[0].headers;
        for (const header of ['cookie', 'authorization', 'referer', 'origin', 'x-csrf-token', 'x-forwarded-for']) {
            assert.equal(sent[header], undefined, `${header} must never be forwarded upstream`);
        }
        assert.ok(sent['user-agent']);
        assert.ok(sent['accept']);
    } finally {
        await server.close();
    }
});

test('a plain http URL is refused for every shipped adapter', async () => {
    for (const [id, adapter] of Object.entries(SOURCES)) {
        assert.notEqual(adapter.allowInsecureForTests, true, `${id} must not carry the test-only insecure flag`);
        await assert.rejects(
            () => fetchJson(adapter, `http://${adapter.allowedHosts[0]}/x`, { timeoutMs: 2000 }),
            (error) => error.code === 'insecure_scheme',
            `${id} must refuse http://`,
        );
    }
});

test('a host outside the adapter allow-list is refused before any request', async () => {
    for (const [id, adapter] of Object.entries(SOURCES)) {
        for (const host of ['evil.tld', `${adapter.allowedHosts[0]}.evil.tld`, `evil-${adapter.allowedHosts[0]}`]) {
            await assert.rejects(
                () => fetchJson(adapter, `https://${host}/x`, { timeoutMs: 2000 }),
                (error) => error.code === 'host_not_allowed',
                `${id} must refuse ${host}`,
            );
        }
    }
});

test('malformed upstream JSON is reported, not thrown raw', async () => {
    const server = await upstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{not json');
    });

    try {
        await assert.rejects(
            () => fetchJson(testAdapter(['127.0.0.1']), `http://127.0.0.1:${server.port}/x`, { timeoutMs: 5000 }),
            (error) => error.code === 'bad_json',
        );
    } finally {
        await server.close();
    }
});

test('an upstream payload with __proto__ is refused', async () => {
    const server = await upstream((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"posts":[{"__proto__":{"polluted":true}}]}');
    });

    try {
        await assert.rejects(
            () => fetchJson(testAdapter(['127.0.0.1']), `http://127.0.0.1:${server.port}/x`, { timeoutMs: 5000 }),
            (error) => error.code === 'unsafe_json',
        );
        assert.equal({}.polluted, undefined);
    } finally {
        await server.close();
    }
});

// ---- thumbnail refs ----

test('a minted ref round-trips', () => {
    const ref = mintRef('botbooru', { f: 'abc.png', v: 2 });
    assert.equal(typeof ref, 'string');
    assert.deepEqual(verifyRef('botbooru', ref), { f: 'abc.png', v: 2 });
});

test('a ref cannot be forged, tampered with, or replayed across sources', () => {
    const ref = mintRef('botbooru', { f: 'abc.png', v: 1 });
    const [payload, signature] = ref.split('.');

    // Forged outright.
    assert.equal(verifyRef('botbooru', 'eyJmIjoiLi4vLi4vZXRjL3Bhc3N3ZCJ9.AAAAAAAAAAAAAAAAAAAAAA'), null);
    // Payload swapped, signature kept.
    const otherPayload = Buffer.from(JSON.stringify({ f: 'evil.png' })).toString('base64url');
    assert.equal(verifyRef('botbooru', `${otherPayload}.${signature}`), null);
    // Signature altered.
    assert.equal(verifyRef('botbooru', `${payload}.${'A'.repeat(signature.length)}`), null);
    // Minted for one source, presented as another.
    assert.equal(verifyRef('someothersource', ref), null);
    // Structurally wrong.
    for (const bad of ['', '.', 'nodot', `${payload}.`, `.${signature}`, 'a'.repeat(600), null, undefined, 42, {}]) {
        assert.equal(verifyRef('botbooru', bad), null, `must reject ${JSON.stringify(bad)}`);
    }
});

test('the adapter refuses a ref whose filename could escape its path segment', () => {
    const { botbooru } = SOURCES;

    // Even a correctly signed ref is re-validated at the point of use.
    for (const filename of ['../../etc/passwd', 'a/b.png', 'x'.repeat(200), '', 'a b.png']) {
        const ref = verifyRef('botbooru', mintRef('botbooru', { f: filename }));
        assert.throws(() => botbooru.thumbUrlFromRef(ref ?? { f: filename }, 'grid'), /bad_ref/);
    }

    const good = verifyRef('botbooru', mintRef('botbooru', { f: 'abc.png', v: 3 }));
    const url = new URL(botbooru.thumbUrlFromRef(good, 'grid'));
    assert.equal(url.origin, 'https://botbooru.com');
    assert.equal(url.pathname, '/images/preview/320/abc.png');
    assert.equal(url.searchParams.get('v'), '3');

    // Size is chosen from our own allow-list, never from the ref.
    assert.match(new URL(botbooru.thumbUrlFromRef(good, 'detail')).pathname, /\/640\//);
    assert.match(new URL(botbooru.thumbUrlFromRef(good, 'nonsense')).pathname, /\/320\//);
});

// ---- image sniffing ----

test('only raster image formats are accepted, and SVG never is', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(9)]);
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(6)]);
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
    const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif', 'latin1')]);

    assert.equal(detectImageType(png), 'image/png');
    assert.equal(detectImageType(jpeg), 'image/jpeg');
    assert.equal(detectImageType(gif), 'image/gif');
    assert.equal(detectImageType(webp), 'image/webp');
    assert.equal(detectImageType(avif), 'image/avif');

    // An SVG is XML that can carry script. It is refused, not sanitized.
    assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
    assert.equal(detectImageType(Buffer.from('<?xml version="1.0"?><svg/>')), null);
    assert.equal(detectImageType(Buffer.from('<!DOCTYPE html><html><script>alert(1)</script>')), null);
    assert.equal(detectImageType(Buffer.from('GIF87b----')), null, 'a near-miss signature is not enough');
    assert.equal(detectImageType(Buffer.alloc(4)), null, 'too short to identify');
    assert.equal(detectImageType('not a buffer'), null);
});

// ---- circuit breaker ----

test('three transient failures trip the breaker, and a success clears it', () => {
    clearAll();
    const transient = { code: 'network', detail: 'ECONNRESET' };

    assert.equal(markFailure('s1', transient), false);
    assert.equal(markFailure('s1', transient), false);
    assert.equal(isDown('s1'), false, 'two failures must not hide a source');

    assert.equal(markFailure('s1', transient), true);
    assert.equal(isDown('s1'), true);
    assert.equal(stateOf('s1'), 'down');

    markSuccess('s1');
    assert.equal(isDown('s1'), false);
    assert.equal(stateOf('s1'), 'up');
});

test('an unrecoverable failure trips the breaker immediately', () => {
    clearAll();

    // DNS gone: this is api.saucepan.ai's actual state today.
    assert.equal(markFailure('dead', { code: 'network', detail: 'getaddrinfo ENOTFOUND api.saucepan.ai' }), true);
    assert.equal(isDown('dead'), true);

    clearAll();
    // Cloudflare bot wall: caibotlist's actual state today.
    assert.equal(markFailure('blocked', { code: 'http_error', detail: '403' }), true);

    clearAll();
    // Endpoint withdrawn: sakura's actual state today.
    assert.equal(markFailure('moved', { code: 'http_error', detail: '404' }), true);
});

test('failures are classified by how recoverable they are', () => {
    assert.equal(classify({ code: 'network', detail: 'getaddrinfo ENOTFOUND x' }), 'dns');
    assert.equal(classify({ code: 'http_error', detail: '403' }), 'forbidden');
    assert.equal(classify({ code: 'http_error', detail: '404' }), 'not_found');
    assert.equal(classify({ code: 'http_error', detail: '500' }), 'transient');
    assert.equal(classify({ code: 'timeout' }), 'transient');
    assert.equal(classify({ code: 'host_not_allowed' }), 'host_not_allowed');
    assert.equal(classify({}), 'transient');
});

test('an unknown source reports unknown, not down', () => {
    clearAll();
    assert.equal(stateOf('never-seen'), 'unknown');
    assert.equal(isDown('never-seen'), false);
});
