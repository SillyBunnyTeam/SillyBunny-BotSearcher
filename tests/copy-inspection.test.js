import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanKeeps, cleanPlan, intakeSections, tokenFootprint } from '../client/copy.js';
import { validateCardBytes } from '../server/cardbytes.js';

test('an incomplete or unavailable scan cannot look like an empty complete report', () => {
    for (const scan of [undefined, { complete: false, reasons: ['string_limit'] }, { complete: false, reasons: [] }]) {
        const inside = { scan, promptText: { truncated: false, fields: {} } };
        const sections = intakeSections(inside);
        const report = JSON.stringify(sections);
        assert.match(report, /Not fully inspected/);
        assert.match(report, /counts and findings may be incomplete/i);
        assert.match(report, /Token counts are measured separately/);
        assert.doesNotMatch(report, /string_limit|None|Nothing|safe/i);
        assert.ok(sections.some((section) => section.rows.some((row) => row.tone === 'warn')));
        assert.ok(cleanPlan(inside).length > 0, 'unknown removals must not become nothing to remove');
        assert.match(cleanPlan(inside).join(' '), /where present/);
    }
});

test('inspection completeness never substitutes for token measurement completeness', () => {
    const complete = { scan: { complete: true, reasons: [] }, promptText: { truncated: true, fields: {} } };
    assert.deepEqual(intakeSections(complete), []);
    assert.deepEqual(cleanPlan(complete), []);
    assert.match(tokenFootprint({ measured: false }).headline, /could not be measured/);

    const incomplete = { scan: { complete: false, reasons: ['child_limit'] } };
    assert.match(JSON.stringify(intakeSections(incomplete)), /Not fully inspected/);
    assert.match(tokenFootprint({ measured: true, always: 10, greeting: 0, examples: 0, lorebook: null }).headline, /10 tokens/);
});

test('macro arguments and token-only text cannot reach any inspection copy', () => {
    const sentinel = 'private_argument_sentinel_7351';
    const description = `{{setvar::${sentinel}::value}} {{getvar::${sentinel}}}`;
    const inside = validateCardBytes(Buffer.from(JSON.stringify({ name: 'Private', description }))).inside;
    const display = JSON.stringify([intakeSections(inside), cleanPlan(inside), cleanKeeps(inside)]);
    assert.match(display, /\{\{setvar\}\}/);
    assert.ok(!display.includes(sentinel));
    assert.equal(inside.promptText.fields.description, description);

    const invalidNames = [null, {}, `setvar::${sentinel}`, `random ${sentinel}`, `name/${sentinel}`, 'a'.repeat(65)];
    const malformed = intakeSections({ ...inside, macros: { count: 7, names: [...invalidNames, 'user'] } });
    const row = malformed.flatMap((section) => section.rows).find((entry) => entry.label === 'Macros');
    assert.equal(row.value, '7 uses: {{user}}');
    assert.ok(!JSON.stringify(malformed).includes(sentinel));
});

test('complete cleaning copy states both removals and retained behaviour', () => {
    const inside = {
        scan: { complete: true, reasons: [] },
        regexScripts: 1,
        extensions: { unknown: ['extra'] },
        malformed: [{ field: 'extra', problem: 'is not a field in this card format' }],
        privateInfo: [{ kind: 'email', field: 'description', redacted: 'pr****st' }],
        lorebookEntries: 2,
        alternateGreetings: 1,
        hasSystemPrompt: true,
        hasPostHistoryInstructions: true,
        hasDepthPrompt: true,
        macros: { count: 1, names: ['user'] },
        html: { count: 1, hasScriptOrIframe: true },
    };
    assert.deepEqual(cleanPlan(inside), [
        '1 regex script', '1 unrecognised extension block (extra)', '1 field outside the card format', '1 personal detail',
    ]);
    const keeps = cleanKeeps(inside).join(', ');
    for (const phrase of ['2 lorebook entries', '1 greeting', 'the system prompt', 'post-history instructions', 'the depth prompt', 'macros', 'embedded scripts or iframes']) {
        assert.ok(keeps.includes(phrase), phrase);
    }
    assert.ok(cleanKeeps({ ...inside, html: { count: 1, hasScriptOrIframe: false } }).includes('HTML formatting in retained fields'));
    assert.match(JSON.stringify(intakeSections(inside)), /Behaviour|Unrecognised/);
    assert.doesNotMatch(JSON.stringify([cleanPlan(inside), cleanKeeps(inside)]), /safe|harmless/i);
});
