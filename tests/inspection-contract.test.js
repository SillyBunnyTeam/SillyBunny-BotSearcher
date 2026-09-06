import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

test('inspection handlers return completeness and cleaning returns 422 without partial bytes', async (t) => {
    const keyPath = fileURLToPath(new URL('../.cursor-key', import.meta.url));
    const read = fs.readFileSync;
    const dummyKey = t.mock.method(fs, 'readFileSync', (file, ...options) =>
        file === keyPath ? Buffer.alloc(32) : read(file, ...options));
    const { createRouter } = await import('../server/router.js');
    dummyKey.mock.restore();

    const routes = new Map();
    createRouter({ get() {}, post: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, {
        startedAt: Date.now(), accounts: {}, saucepan: {}, jannyBrowser: {},
    });
    const post = (route, card) => new Promise((resolve) => {
        let status = 200;
        routes.get(route)({ rawBody: Buffer.from(JSON.stringify(card)), ip: 'inspection-contract-test' }, {
            set() {},
            status(value) { status = value; return this; },
            json(body) { resolve({ status, body }); },
            send(body) { resolve({ status, body }); },
        });
    });

    const plain = { name: 'Card', description: '{{setvar::private_argument_sentinel::value}}' };
    const complete = await post('/inspect', plain);
    assert.equal(complete.status, 200);
    const report = complete.body;
    assert.deepEqual(report.inside.scan, { complete: true, reasons: [] });
    assert.deepEqual(report.inside.macros.names, ['setvar']);
    assert.equal(report.inside.promptText.fields.description, plain.description);

    const long = await post('/inspect', { name: '', description: 'x'.repeat(128 * 1024 + 1) });
    assert.equal(long.status, 200);
    const limited = long.body;
    assert.deepEqual(limited.inside.scan, { complete: false, reasons: ['string_limit'] });
    assert.equal(limited.inside.promptText.truncated, false);

    for (const nested of [
        Array.from({ length: 10_000 }, () => ({})),
        Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`field${index}`, 'private@example.test'])),
    ]) {
        const card = { name: 'Budget', description: '', nested };
        const inspection = await post('/inspect', card);
        assert.equal(inspection.status, 200);
        assert.equal(inspection.body.inside.scan.complete, false);
        const clean = await post('/clean', card);
        assert.equal(clean.status, 422);
        assert.deepEqual(clean.body, { error: 'clean_incomplete' });
    }
});
