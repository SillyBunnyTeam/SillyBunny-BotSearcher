/**
 * Mechanical enforcement of the two invariants that are easiest to erode by
 * accident, and that no runtime check can catch after the fact.
 *
 * I1 — the frontend never talks to anything but our own origin.
 * I4 — untrusted data reaches the DOM only through render.js's writers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = path.join(ROOT, 'client');

function clientFiles() {
    return fs.readdirSync(CLIENT_DIR)
        .filter((name) => name.endsWith('.js'))
        .map((name) => ({ name, text: fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8') }));
}

/** Strips block and line comments so prose in a comment cannot fail a test. */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('I1: no absolute remote URL appears in client code', () => {
    for (const { name, text } of clientFiles()) {
        const code = stripComments(text);
        const hits = code.match(/https?:\/\//g) ?? [];
        assert.deepEqual(
            hits, [],
            `${name} contains an absolute URL. Every frontend request must be same-origin, `
            + 'routed through PLUGIN_BASE. If a remote host is needed, the server owns it.',
        );
    }
});

test('I4: client code never assigns HTML', () => {
    // `.html(` would catch jQuery's setter; we do not use jQuery at all.
    const banned = [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /\$\([^)]*\)\.html\(/, /createContextualFragment/];

    for (const { name, text } of clientFiles()) {
        const code = stripComments(text);
        for (const pattern of banned) {
            assert.equal(
                pattern.test(code), false,
                `${name} matches ${pattern}. Untrusted text must go through setText(); `
                + 'static chrome comes from renderExtensionTemplateAsync().',
            );
        }
    }
});

test('I4: render.js is the only module importing the DOM writers from outside', () => {
    // Sanity check that render.js actually exports what the other rules assume.
    const text = fs.readFileSync(path.join(CLIENT_DIR, 'render.js'), 'utf8');
    for (const name of ['setText', 'setImgSafe', 'setLinkSafe', 'isAllowedImageUrl']) {
        assert.match(text, new RegExp(`export function ${name}\\b`), `render.js must export ${name}`);
    }
});

test('version is identical across schema.js, package.json and manifest.json', async () => {
    const { VERSION } = await import('../shared/schema.js');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

    assert.equal(pkg.version, VERSION, 'package.json version drifted from shared/schema.js');
    assert.equal(manifest.version, VERSION, 'manifest.json version drifted from shared/schema.js');
});

test('manifest and package agree on the extension identity', async () => {
    const { PLUGIN_ID, EXTENSION_NAME } = await import('../shared/schema.js');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    // src/plugin-loader.js:266 rejects anything else, and the route path is derived from it.
    assert.match(PLUGIN_ID, /^[a-z0-9_-]+$/);
    assert.equal(pkg.name, PLUGIN_ID);
    assert.match(EXTENSION_NAME, /^[A-Za-z0-9._-]+$/, 'extension dir name must survive sanitize()');
});
