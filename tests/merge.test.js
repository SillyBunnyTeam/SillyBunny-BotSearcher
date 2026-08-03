/**
 * Merging results from several sources.
 *
 * The claims worth pinning are the ones a user would notice being wrong: every
 * source gets room in the list, a card mirrored across two sites appears once,
 * and two genuinely different characters that happen to share a name both
 * survive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { interleave, dedupe, identityKey, sharePageBudget } from '../server/merge.js';

function item(source, name, creator = '') {
    return { source, name, creator, id: `${source}:${name}` };
}

test('results interleave so no source is buried below another', () => {
    const merged = interleave([
        { source: 'a', items: [item('a', 'A1'), item('a', 'A2'), item('a', 'A3')] },
        { source: 'b', items: [item('b', 'B1'), item('b', 'B2'), item('b', 'B3')] },
    ], 6);

    assert.deepEqual(merged.map((entry) => entry.name), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
});

test('a source that returned less does not stall the rest', () => {
    const merged = interleave([
        { source: 'a', items: [item('a', 'A1')] },
        { source: 'b', items: [item('b', 'B1'), item('b', 'B2'), item('b', 'B3')] },
    ], 6);

    // No gaps where the short list ran out.
    assert.deepEqual(merged.map((entry) => entry.name), ['A1', 'B1', 'B2', 'B3']);
});

test('the merged page honours the limit', () => {
    const merged = interleave([
        { source: 'a', items: Array.from({ length: 20 }, (_, i) => item('a', `A${i}`)) },
        { source: 'b', items: Array.from({ length: 20 }, (_, i) => item('b', `B${i}`)) },
    ], 5);

    assert.equal(merged.length, 5);
    // Still alternating, so the cut does not favour one source.
    assert.deepEqual(merged.map((entry) => entry.source), ['a', 'b', 'a', 'b', 'a']);
});

test('empty and missing groups are ignored rather than producing holes', () => {
    assert.deepEqual(interleave([], 5), []);
    assert.deepEqual(interleave([{ source: 'a', items: [] }], 5), []);
    assert.deepEqual(
        interleave([{ source: 'a' }, { source: 'b', items: [item('b', 'B1')] }], 5).map((e) => e.name),
        ['B1'],
    );
});

test('a card mirrored across sources appears once, from the first source listed', () => {
    const merged = dedupe(interleave([
        { source: 'chub', items: [item('chub', 'Elfnein', 'Aremmm')] },
        { source: 'botbooru', items: [item('botbooru', 'Elfnein', 'Aremmm')] },
    ], 10));

    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'chub', 'the user listed chub first');
});

test('re-uploads that differ only in punctuation, case or accents are one card', () => {
    const merged = dedupe([
        item('a', 'Elfnein & Carol', 'Aremmm'),
        item('b', 'elfnein and carol', 'Aremmm'),
        item('c', 'Elfnein  &  Carol!', 'aremmm'),
        item('d', 'Renée', 'Zoë'),
        item('e', 'Renee', 'Zoe'),
    ]);

    // "and" vs "&" is a real difference in the stripped form, so those stay two.
    assert.deepEqual(merged.map((entry) => entry.source), ['a', 'b', 'd']);
});

test('two different characters with the same name both survive', () => {
    const merged = dedupe([
        item('a', 'Alice', 'someone'),
        item('b', 'Alice', 'someone-else'),
    ]);

    assert.equal(merged.length, 2, 'the creator is part of the identity for a reason');
});

test('a card with no creator is never deduplicated away', () => {
    // "Sakura" from two sites is usually two characters. Dropping one to make
    // the list tidier would lose a real result.
    assert.equal(identityKey({ name: 'Sakura', creator: '' }), null);
    assert.equal(identityKey({ name: '', creator: 'someone' }), null);

    const merged = dedupe([item('a', 'Sakura'), item('b', 'Sakura')]);
    assert.equal(merged.length, 2);
});

test('the seen set carries across pages so page two does not repeat page one', () => {
    const seen = new Set();
    const first = dedupe([item('a', 'Elfnein', 'Aremmm')], seen);
    const second = dedupe([item('b', 'Elfnein', 'Aremmm'), item('b', 'Other', 'Aremmm')], seen);

    assert.equal(first.length, 1);
    assert.deepEqual(second.map((entry) => entry.name), ['Other']);
});

test('the page budget is shared out, and no source is asked for nothing', () => {
    assert.deepEqual(sharePageBudget(24, 4), [6, 6, 6, 6]);
    // The remainder goes to the earliest sources rather than being lost.
    assert.deepEqual(sharePageBudget(10, 4), [3, 3, 2, 2]);
    assert.equal(sharePageBudget(10, 4).reduce((a, b) => a + b, 0), 10);

    // More sources than results still asks each for at least one, or a source
    // would silently drop out of every search.
    assert.deepEqual(sharePageBudget(2, 4), [1, 1, 1, 1]);
    assert.deepEqual(sharePageBudget(24, 1), [24]);
    assert.deepEqual(sharePageBudget(24, 0), []);
});
