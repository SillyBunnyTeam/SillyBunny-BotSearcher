import test from 'node:test';
import assert from 'node:assert/strict';

import { readSvelteKitData } from '../server/devalue.js';

function payload(data) {
    return { nodes: [{ type: 'data', data }] };
}

test('shared devalue references are resolved once without changing the decoded shape', () => {
    const result = readSvelteKitData(payload([
        { first: 1, second: 1 },
        { name: 2 },
        'shared card',
    ]));

    assert.deepEqual(result, {
        first: { name: 'shared card' },
        second: { name: 'shared card' },
    });
    assert.strictEqual(result.first, result.second, 'a shared reference should retain shared identity');
});

test('wide shared-reference graphs stop at the decoded slot budget', () => {
    const result = readSvelteKitData(payload([
        { cards: 1 },
        new Array(100_001).fill(2),
        { name: 3 },
        'small',
    ]));

    assert.equal(result, null);
});

test('repeated string references stop at the decoded string budget', () => {
    const result = readSvelteKitData(payload([
        { cards: 1 },
        new Array(10_000).fill(2),
        'x'.repeat(1024),
    ]));

    assert.equal(result, null);
});

test('cycles are cut without recursing forever', () => {
    const result = readSvelteKitData(payload([
        { cards: 1 },
        [1],
    ]));

    assert.deepEqual(result, { cards: [null] });
});
