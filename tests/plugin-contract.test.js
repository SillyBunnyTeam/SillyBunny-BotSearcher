/**
 * The plugin must satisfy src/plugin-loader.js's contract exactly, and must not
 * be able to take SillyBunny down. Both are easy to break silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const plugin = await import('../server/index.js');

test('exports the info/init/exit shape the loader requires', () => {
    // src/plugin-loader.js:277-300 reads these and skips the plugin if any is missing.
    assert.equal(typeof plugin.info, 'object');
    for (const field of ['id', 'name', 'description']) {
        assert.equal(typeof plugin.info[field], 'string', `info.${field} must be a string`);
        assert.notEqual(plugin.info[field], '', `info.${field} must not be empty`);
    }
    assert.match(plugin.info.id, /^[a-z0-9_-]+$/, 'isValidPluginID rejects anything else');
    assert.equal(typeof plugin.init, 'function');
    assert.equal(typeof plugin.exit, 'function');
});

test('init registers routes synchronously', () => {
    // src/plugin-loader.js:311-321 only calls app.use() when router.stack.length > 0
    // at the moment init() resolves. Registering after an await silently unmounts us.
    const router = express.Router();
    const returned = plugin.init(router);

    assert.equal(returned, undefined, 'init should not be async — the loader checks stack length on resolve');
    assert.ok(router.stack.length > 0, 'no routes were registered synchronously');
});

test('exposes a GET probe so the client can detect us without a CSRF token', () => {
    const router = express.Router();
    plugin.init(router);

    const healthz = router.stack.find((layer) => layer.route?.path === '/healthz');
    assert.ok(healthz, '/healthz must exist');
    assert.equal(healthz.route.methods.get, true, '/healthz must be a GET: csrf-sync only skips GET/HEAD/OPTIONS');
});

test('healthz answers without any outbound request', async () => {
    const router = express.Router();
    plugin.init(router);

    const app = express();
    app.use('/api/plugins/sillybunny-botsearcher', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/plugins/sillybunny-botsearcher/healthz`);
        assert.equal(response.status, 200);

        const body = await response.json();
        assert.equal(body.ok, true);
        assert.equal(typeof body.protocol, 'number');
        assert.equal(typeof body.version, 'string');
        assert.ok(Array.isArray(body.sources));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('exit never rejects', async () => {
    // src/server-main.js awaits Promise.all(exitHooks) before process.exit().
    // A rejection here means the server never shuts down.
    await assert.doesNotReject(() => plugin.exit());
    await assert.doesNotReject(() => plugin.exit(), 'must stay safe when called twice');
});

test('getSource cannot be steered onto the prototype chain', async () => {
    const { getSource } = await import('../server/registry.js');

    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.equal(getSource(key), null, `getSource('${key}') must not resolve`);
    }
    for (const value of [undefined, null, '', 42, {}, [], Symbol('x')]) {
        assert.equal(getSource(value), null);
    }
});
