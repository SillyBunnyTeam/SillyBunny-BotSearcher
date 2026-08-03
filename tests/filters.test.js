/**
 * The per-source filter panel.
 *
 * The panel is built from what a source declares it can apply, so the things
 * worth pinning are: nothing is offered that the source cannot do, values come
 * back in the shape the server expects, and a half-entered tag is not silently
 * dropped when the user hits Search.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { FILTER_LIMITS } from '../shared/schema.js';

const DECLARED = [
    { key: 'tags', type: 'tags', label: 'Has all of these tags' },
    { key: 'excludeTags', type: 'tags', label: 'Without these tags' },
    { key: 'creator', type: 'text', label: 'Creator' },
    { key: 'minTokens', type: 'number', label: 'Min tokens' },
    { key: 'uploadedAfter', type: 'date', label: 'Uploaded after' },
    { key: 'ocOnly', type: 'boolean', label: 'Original characters only' },
];

/** Installs a DOM and returns the panel plus a change counter. */
async function panel(declared = DECLARED) {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'https://local.test/' });
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;

    const { buildFilters } = await import('../client/filters.js');
    const host = dom.window.document.getElementById('host');
    const changes = { count: 0 };
    const handle = buildFilters(host, declared, () => { changes.count++; });
    return { host, handle, changes };
}

function key(target, name) {
    const event = new globalThis.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

test('a control appears for each declared filter, and none for a source with none', async () => {
    const withFilters = await panel();
    assert.equal(withFilters.host.querySelectorAll('.sbbs-filter').length, DECLARED.length);
    assert.ok(withFilters.host.querySelector('#sbbs_filter_tags'));
    assert.equal(withFilters.host.querySelector('#sbbs_filter_minTokens').type, 'number');
    assert.equal(withFilters.host.querySelector('#sbbs_filter_uploadedAfter').type, 'date');
    assert.equal(withFilters.host.querySelector('#sbbs_filter_ocOnly').type, 'checkbox');

    const without = await panel([]);
    assert.equal(without.host.children.length, 0, 'a source that declares nothing shows nothing');
    assert.deepEqual(without.handle.read(), {});
});

test('tags commit on Enter and comma without submitting the form', async () => {
    const { host, handle, changes } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');

    input.value = 'Elf';
    const enter = key(input, 'Enter');
    // If this were not prevented, every tag would also fire a fresh search from
    // the enclosing <form>.
    assert.equal(enter.defaultPrevented, true, 'Enter must not reach the search form');

    input.value = 'Romance';
    key(input, ',');

    assert.deepEqual(handle.read(), { tags: ['Elf', 'Romance'] });
    assert.equal(host.querySelectorAll('.sbbs-filter-chip').length, 2);
    assert.equal(changes.count, 2, 'each committed tag re-runs the search');
});

test('a tag typed but not committed still counts when the search runs', async () => {
    const { host, handle } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');

    input.value = 'Elf';
    key(input, 'Enter');
    input.value = 'Vampire';

    // The user typed it and pressed Search. Dropping it would silently return
    // results for a filter they can still see in the box.
    assert.deepEqual(handle.read().tags, ['Elf', 'Vampire']);
});

test('duplicate tags are rejected regardless of capitalisation', async () => {
    const { host, handle } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');

    for (const value of ['Elf', 'elf', 'ELF']) {
        input.value = value;
        key(input, 'Enter');
        input.value = '';
    }

    assert.deepEqual(handle.read(), { tags: ['Elf'] }, 'sources are inconsistent about their own capitalisation');
});

test('backspace on an empty box removes the last tag', async () => {
    const { host, handle } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');

    input.value = 'Elf,Romance';
    key(input, 'Enter');
    input.value = '';

    key(input, 'Backspace');
    assert.deepEqual(handle.read(), { tags: ['Elf'] });
});

test('tag count is capped in the panel, not only on the server', async () => {
    const { host, handle } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');

    input.value = Array.from({ length: 40 }, (_, i) => `tag${i}`).join(',');
    key(input, 'Enter');

    assert.equal(handle.read().tags.length, FILTER_LIMITS.tagCount);
});

test('removing a chip updates the value and re-runs the search', async () => {
    const { host, handle, changes } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');
    input.value = 'Elf,Romance';
    key(input, 'Enter');
    const before = changes.count;

    host.querySelector('.sbbs-filter-chip-remove').click();

    assert.deepEqual(handle.read(), { tags: ['Romance'] });
    assert.equal(changes.count, before + 1);
});

test('a chip remove button names the tag it removes', async () => {
    const { host } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');
    input.value = 'Elf,Romance';
    key(input, 'Enter');

    const labels = [...host.querySelectorAll('.sbbs-filter-chip-remove')]
        .map((button) => button.getAttribute('aria-label'));
    // Otherwise a screen reader announces a row of identical "Remove" buttons.
    assert.deepEqual(labels, ['Remove tag Elf', 'Remove tag Romance']);
});

test('empty and blank values are omitted rather than sent', async () => {
    const { host, handle } = await panel();
    host.querySelector('#sbbs_filter_creator').value = '   ';
    host.querySelector('#sbbs_filter_minTokens').value = '';

    assert.deepEqual(handle.read(), {}, 'a blank box is not a filter');
    assert.equal(handle.count(), 0);
});

test('numbers come back as numbers and text as trimmed text', async () => {
    const { host, handle } = await panel();
    host.querySelector('#sbbs_filter_creator').value = '  Aremmm  ';
    host.querySelector('#sbbs_filter_minTokens').value = '1200';

    assert.deepEqual(handle.read(), { creator: 'Aremmm', minTokens: 1200 });
    assert.equal(handle.count(), 2);
});

test('date and boolean controls participate in read, count, set, and clear', async () => {
    const { host, handle, changes } = await panel();
    const checkbox = host.querySelector('#sbbs_filter_ocOnly');

    assert.ok(checkbox.closest('.checkbox_label'), 'the checkbox uses the host checkbox control row');
    assert.equal(handle.set('uploadedAfter', '2024-02-29'), true);
    assert.equal(handle.set('ocOnly', true), true);
    assert.deepEqual(handle.read(), { uploadedAfter: '2024-02-29', ocOnly: true });
    assert.equal(handle.count(), 2);

    checkbox.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
    assert.equal(changes.count, 1);

    handle.clear();
    assert.deepEqual(handle.read(), {});
    assert.equal(host.querySelector('#sbbs_filter_uploadedAfter').value, '');
    assert.equal(checkbox.checked, false);
});

test('tag fields expose ranked vocabulary suggestions with space normalization', async () => {
    const { host, handle } = await panel();
    const input = host.querySelector('#sbbs_filter_tags');
    const vocabulary = Array.from({ length: 25 }, (_, index) => ({
        n: `dragon_ball_${index}`,
        c: index === 24 ? 'Copyright' : 'Character',
        k: index + 1,
    }));
    vocabulary.push({ n: 'unrelated', c: 'Other', k: 1000 });
    handle.setVocabulary(vocabulary);

    input.value = 'dragon bal';
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    const datalist = host.querySelector(`#${input.getAttribute('list')}`);
    const options = [...datalist.querySelectorAll('option')];
    assert.equal(host.querySelectorAll('datalist').length, 2, 'each declared tag field gets a datalist');
    assert.equal(options.length, 20, 'suggestions are capped');
    assert.equal(options[0].value, 'dragon_ball_24', 'highest-count match comes first');
    assert.equal(options[0].label, 'Copyright · 25');
    assert.equal(options.some((option) => option.value === 'unrelated'), false);
});

test('clear empties every control at once', async () => {
    const { host, handle } = await panel();
    host.querySelector('#sbbs_filter_creator').value = 'Aremmm';
    host.querySelector('#sbbs_filter_tags').value = 'Elf';
    key(host.querySelector('#sbbs_filter_tags'), 'Enter');
    assert.ok(handle.count() > 0);

    handle.clear();

    assert.deepEqual(handle.read(), {});
    assert.equal(host.querySelectorAll('.sbbs-filter-chip').length, 0);
});

test('set() adds a tag from elsewhere, and refuses a filter the source lacks', async () => {
    const { host, handle } = await panel();

    // Backs clicking a tag on a result card.
    assert.equal(handle.set('tags', 'Elf'), true);
    assert.deepEqual(handle.read(), { tags: ['Elf'] });
    assert.equal(host.querySelectorAll('.sbbs-filter-chip').length, 1);

    assert.equal(handle.set('nonsense', 'x'), false, 'an undeclared filter must not be settable');
    assert.equal(handle.set('tags', 'Elf'), false, 'adding the same tag twice is not a change');
});
