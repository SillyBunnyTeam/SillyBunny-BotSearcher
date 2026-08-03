import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { acquire, acquireThumbnail, consume } from '../server/limits.js';

function uniqueKey(name) {
    return `${name}-${process.pid}-${Date.now()}-${Math.random()}`;
}

test('the global thumbnail queue drops an aborted waiter and frees the slot', async () => {
    const key = uniqueKey('thumb-global');
    const leases = await Promise.all(
        Array.from({ length: 8 }, () => acquire('thumbGlobal', key)),
    );
    assert.ok(leases.every(Boolean));

    const controller = new AbortController();
    const queued = acquire('thumbGlobal', key, { signal: controller.signal });
    controller.abort();
    assert.equal(await queued, null, 'an aborted browser request must leave the queue');

    for (const release of leases) {
        release();
    }

    const afterAbort = await acquire('thumbGlobal', key, { timeoutMs: 50 });
    assert.equal(typeof afterAbort, 'function', 'an abandoned waiter must not retain a global slot');
    afterAbort();
});

test('source thumbnail slots have a bounded queue and hand released slots forward', async () => {
    const key = uniqueKey('thumb-source');
    const first = await acquire('thumbSource', key);
    const second = await acquire('thumbSource', key);
    assert.equal(typeof first, 'function');
    assert.equal(typeof second, 'function');

    assert.equal(
        await acquire('thumbSource', key, { maxWaiters: 0 }),
        null,
        'a full queue must not accept unlimited work',
    );

    const queued = acquire('thumbSource', key, { timeoutMs: 1000 });
    first();
    const forwarded = await queued;
    assert.equal(typeof forwarded, 'function', 'a released source slot should wake exactly one waiter');

    second();
    forwarded();
});

test('thumbnail source waiters do not occupy process-wide slots', async () => {
    const source = uniqueKey('busy-source');
    const sourceLeases = await Promise.all([
        acquire('thumbSource', source),
        acquire('thumbSource', source),
    ]);
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const waiters = controllers.map((controller, index) => acquireThumbnail(
        `${uniqueKey('caller')}-${index}`,
        source,
        { signal: controller.signal },
    ));

    // The source queue is now full, but no waiter should have touched the
    // global pool while it waits for this source.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const global = await acquire('thumbGlobal', uniqueKey('unrelated-global'), { timeoutMs: 50 });
    assert.equal(typeof global, 'function', 'a busy source must not starve unrelated thumbnails');
    global();

    for (const controller of controllers) {
        controller.abort();
    }
    assert.deepEqual(await Promise.all(waiters), Array(8).fill(null));
    for (const release of sourceLeases) {
        release();
    }
});

test('expensive egress limits fail closed when the limiter itself fails', async (t) => {
    const originalConsume = RateLimiterMemory.prototype.consume;
    RateLimiterMemory.prototype.consume = async () => {
        throw new Error('synthetic limiter failure');
    };
    t.after(() => {
        RateLimiterMemory.prototype.consume = originalConsume;
    });
    t.mock.method(console, 'error', () => {});

    assert.deepEqual(
        await consume('thumbGlobal', uniqueKey('limiter-failure'), { failClosed: true }),
        { allowed: false, retryAfterSeconds: 1 },
    );
});
