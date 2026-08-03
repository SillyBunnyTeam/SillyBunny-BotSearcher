/**
 * The search-result cache.
 *
 * Its job is that toggling a control does not re-ask a card site a question it
 * answered a moment ago. What matters is that it recognises the same search
 * however the body was assembled, forgets stale answers, and stays bounded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createResultCache, keyOf } from '../client/cache.js';

test('the same search is recognised regardless of key order', () => {
    // The body is assembled differently for a merged search than a single one,
    // and JSON.stringify follows insertion order — so a plain stringify would
    // miss its own entry.
    const a = { source: 'chub', query: 'elf', filters: { sfwOnly: true, tags: ['Elf'] } };
    const b = { filters: { tags: ['Elf'], sfwOnly: true }, query: 'elf', source: 'chub' };

    assert.equal(keyOf(a), keyOf(b));

    const cache = createResultCache();
    cache.set(a, { items: [1] });
    assert.deepEqual(cache.get(b), { items: [1] });
});

test('a different search is a different entry', () => {
    const cache = createResultCache();
    cache.set({ source: 'chub', query: 'elf' }, 'first');

    assert.equal(cache.get({ source: 'chub', query: 'orc' }), null);
    assert.equal(cache.get({ source: 'botbooru', query: 'elf' }), null);
    // Array order is meaningful — it decides which source wins a dedupe.
    assert.notEqual(keyOf({ sources: ['a', 'b'] }), keyOf({ sources: ['b', 'a'] }));
});

test('an entry expires rather than going stale', () => {
    let now = 1000;
    const cache = createResultCache({ ttlMs: 5000, now: () => now });
    cache.set({ q: 1 }, 'value');

    now = 5999;
    assert.equal(cache.get({ q: 1 }), 'value');

    now = 6001;
    assert.equal(cache.get({ q: 1 }), null);
    assert.equal(cache.size, 0, 'an expired entry is dropped, not left taking room');
});

test('the cache is bounded and evicts what was used longest ago', () => {
    const cache = createResultCache({ maxEntries: 3 });
    cache.set({ q: 1 }, 'one');
    cache.set({ q: 2 }, 'two');
    cache.set({ q: 3 }, 'three');

    // Touching 1 makes 2 the least recently used.
    assert.equal(cache.get({ q: 1 }), 'one');
    cache.set({ q: 4 }, 'four');

    assert.equal(cache.size, 3);
    assert.equal(cache.get({ q: 2 }), null, 'the least recently used entry goes first');
    assert.equal(cache.get({ q: 1 }), 'one');
    assert.equal(cache.get({ q: 4 }), 'four');
});

test('re-setting a key does not grow the cache', () => {
    const cache = createResultCache({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) {
        cache.set({ q: 1 }, i);
    }
    assert.equal(cache.size, 1);
    assert.equal(cache.get({ q: 1 }), 9, 'the newest answer wins');
});

test('clear empties it, because cached pages are listing text from adult sites', () => {
    const cache = createResultCache();
    cache.set({ q: 1 }, 'value');
    cache.clear();

    assert.equal(cache.size, 0);
    assert.equal(cache.get({ q: 1 }), null);
});

test('undefined fields do not split an entry in two', () => {
    // `sort` is absent for a merged search and present for a single one; an
    // explicit undefined must not read as a different question.
    assert.equal(keyOf({ source: 'chub', sort: undefined }), keyOf({ source: 'chub' }));
});
