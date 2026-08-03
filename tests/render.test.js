/**
 * Unit tests for the URL allow-check that gates every <img> and <a> this
 * extension creates. These are the cases that matter: a suffix or substring
 * check would pass several of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// render.js only touches window.location.origin at call time.
globalThis.window = { location: { origin: 'http://127.0.0.1:8000' } };

const { isAllowedImageUrl, setText } = await import('../client/render.js');

const HOSTS = ['botbooru.com'];

test('accepts an https URL whose host is exactly allow-listed', () => {
    assert.equal(isAllowedImageUrl('https://botbooru.com/images/preview/320/a.png', HOSTS), true);
    assert.equal(isAllowedImageUrl('HTTPS://BOTBOORU.COM/images/a.png', HOSTS), true, 'host compare is case-insensitive');
});

test('accepts our own same-origin proxy path', () => {
    assert.equal(isAllowedImageUrl('/api/plugins/sillybunny-botsearcher/thumb?ref=x', HOSTS), true);
});

test('rejects look-alike hosts that a suffix or substring check would accept', () => {
    const attacks = [
        'https://botbooru.com.evil.tld/a.png',   // substring check would pass
        'https://evil-botbooru.com/a.png',       // endsWith check would pass
        'https://notbotbooru.com/a.png',
        'https://sub.botbooru.com/a.png',        // we allow no subdomains unless listed
        'https://evil.tld/?x=botbooru.com',
    ];
    for (const url of attacks) {
        assert.equal(isAllowedImageUrl(url, HOSTS), false, `must reject ${url}`);
    }
});

test('rejects dangerous and non-https schemes', () => {
    for (const url of [
        'javascript:alert(1)',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        'blob:http://127.0.0.1:8000/abc',
        'file:///etc/passwd',
        'http://botbooru.com/a.png',
    ]) {
        assert.equal(isAllowedImageUrl(url, HOSTS), false, `must reject ${url}`);
    }
});

test('rejects a same-origin path that only looks like our base', () => {
    for (const url of [
        '//evil.example/api/plugins/sillybunny-botsearcher/thumb',
        '/api/plugins/sillybunny-botsearcher-evil/thumb',
        '/api/plugins/other/thumb',
    ]) {
        assert.equal(isAllowedImageUrl(url, HOSTS), false, `must reject ${url}`);
    }
});

test('rejects non-strings, empties and a missing allow-list', () => {
    assert.equal(isAllowedImageUrl(undefined, HOSTS), false);
    assert.equal(isAllowedImageUrl(null, HOSTS), false);
    assert.equal(isAllowedImageUrl('', HOSTS), false);
    assert.equal(isAllowedImageUrl(42, HOSTS), false);
    assert.equal(isAllowedImageUrl({ toString: () => 'https://botbooru.com/a.png' }, HOSTS), false);
    assert.equal(isAllowedImageUrl('https://botbooru.com/a.png', undefined), false);
    assert.equal(isAllowedImageUrl('https://botbooru.com/a.png', 'botbooru.com'), false, 'a string is not an allow-list');
});

test('setText writes markup as literal text, never as elements', () => {
    const writes = [];
    const fakeElement = { set textContent(v) { writes.push(v); } };

    setText(fakeElement, '<img src=x onerror=alert(1)>');
    setText(fakeElement, null);
    setText(fakeElement, 0);

    assert.deepEqual(writes, ['<img src=x onerror=alert(1)>', '', '0']);
    assert.doesNotThrow(() => setText(null, 'x'), 'a missing element must be a no-op');
});
