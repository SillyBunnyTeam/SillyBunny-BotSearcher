/**
 * The per-source filter panel.
 *
 * Controls are built from the selected source's `capabilities.filters`, which
 * the server derives from the adapter. A source that cannot apply a filter never
 * shows the control for it — the same rule the SFW toggle follows, and for the
 * same reason: a control that silently does nothing is worse than no control.
 *
 * Values live in the DOM rather than in a parallel object, so there is one place
 * for them to be wrong.
 */

import { el, setText } from './render.js';
import { FILTER_LIMITS } from '../shared/schema.js';

/**
 * Builds the controls for one source and returns a handle for reading them.
 *
 * @param {HTMLElement} host the container to fill
 * @param {readonly {key: string, type: string, label: string, placeholder?: string}[]} declared
 * @param {() => void} onChange fired when a value changes, for re-running the search
 * @returns {{ read: () => Record<string, unknown>, count: () => number, clear: () => void, set: (key: string, value: string) => boolean }}
 */
export function buildFilters(host, declared, onChange) {
    host.replaceChildren();

    const specs = Array.isArray(declared) ? declared : [];
    /** @type {Map<string, { spec: any, input: HTMLInputElement, tags: Set<string>, chips: HTMLElement | null }>} */
    const fields = new Map();

    for (const spec of specs) {
        if (!spec?.key || !spec?.type) {
            continue;
        }

        const wrap = el('div', `sbbs-filter sbbs-filter-${spec.type}`);
        const id = `sbbs_filter_${spec.key}`;

        const label = el('label', 'sbbs-filter-label', spec.label ?? spec.key);
        label.htmlFor = id;
        wrap.append(label);

        const input = document.createElement('input');
        input.id = id;
        input.className = 'text_pole';
        input.autocomplete = 'off';

        const field = { spec, input, tags: new Set(), chips: null };

        if (spec.type === 'number') {
            input.type = 'number';
            input.min = String(FILTER_LIMITS.numberMin);
            input.max = String(FILTER_LIMITS.numberMax);
            input.step = '1';
            input.addEventListener('change', () => onChange());
        } else {
            input.type = 'text';
            input.maxLength = spec.type === 'tags'
                ? FILTER_LIMITS.tagLength * FILTER_LIMITS.tagCount
                : FILTER_LIMITS.textLength;
            if (spec.placeholder) {
                input.placeholder = spec.placeholder;
            }

            if (spec.type === 'tags') {
                // Enter and comma both commit a tag. Enter must not reach the
                // form, or every tag would also submit a search.
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                        event.preventDefault();
                        if (commitTags(field, input.value)) {
                            input.value = '';
                            renderChips(field, onChange);
                            onChange();
                        }
                    } else if (event.key === 'Backspace' && input.value === '' && field.tags.size > 0) {
                        const last = [...field.tags].pop();
                        field.tags.delete(last);
                        renderChips(field, onChange);
                        onChange();
                    }
                });
                // Pasting "a, b, c" should not need three keystrokes to commit.
                input.addEventListener('blur', () => {
                    if (commitTags(field, input.value)) {
                        input.value = '';
                        renderChips(field, onChange);
                        onChange();
                    }
                });
            } else {
                input.addEventListener('change', () => onChange());
            }
        }

        wrap.append(input);

        if (spec.type === 'tags') {
            field.chips = el('div', 'sbbs-filter-chips');
            field.chips.setAttribute('role', 'list');
            wrap.append(field.chips);
        }

        fields.set(spec.key, field);
        host.append(wrap);
    }

    return {
        read() {
            const out = {};
            for (const [key, field] of fields) {
                if (field.spec.type === 'tags') {
                    // Anything typed but not yet committed still counts: a user
                    // who types a tag and hits Search means it.
                    const pending = splitTags(field.input.value);
                    const all = [...field.tags, ...pending];
                    if (all.length > 0) {
                        out[key] = all.slice(0, FILTER_LIMITS.tagCount);
                    }
                } else if (field.spec.type === 'number') {
                    const value = Number(field.input.value);
                    if (field.input.value !== '' && Number.isFinite(value)) {
                        out[key] = value;
                    }
                } else {
                    const text = field.input.value.trim();
                    if (text !== '') {
                        out[key] = text;
                    }
                }
            }
            return out;
        },

        count() {
            return Object.keys(this.read()).length;
        },

        clear() {
            for (const field of fields.values()) {
                field.input.value = '';
                field.tags.clear();
                if (field.chips) {
                    renderChips(field, onChange);
                }
            }
        },

        /** Adds a value to a filter, e.g. from clicking a tag on a result card. */
        set(key, value) {
            const field = fields.get(key);
            if (!field) {
                return false;
            }
            if (field.spec.type === 'tags') {
                if (!commitTags(field, value)) {
                    return false;
                }
                renderChips(field, onChange);
            } else {
                field.input.value = String(value);
            }
            return true;
        },
    };
}

function splitTags(raw) {
    return String(raw ?? '')
        .split(',')
        .map((tag) => tag.trim().slice(0, FILTER_LIMITS.tagLength))
        .filter((tag) => tag !== '');
}

/** @returns {boolean} whether anything was added */
function commitTags(field, raw) {
    let added = false;
    for (const tag of splitTags(raw)) {
        // Case-insensitive dedupe, first spelling wins — sources are inconsistent
        // about capitalising their own tags.
        const seen = [...field.tags].some((existing) => existing.toLowerCase() === tag.toLowerCase());
        if (!seen && field.tags.size < FILTER_LIMITS.tagCount) {
            field.tags.add(tag);
            added = true;
        }
    }
    return added;
}

function renderChips(field, onChange) {
    if (!field.chips) {
        return;
    }
    field.chips.replaceChildren();

    for (const tag of field.tags) {
        const chip = el('span', 'sbbs-filter-chip');
        chip.setAttribute('role', 'listitem');
        setText(chip, tag);

        const remove = el('button', 'sbbs-filter-chip-remove');
        remove.type = 'button';
        // The tag itself is in the name, so screen-reader users are not left
        // with a list of identical "Remove" buttons.
        remove.setAttribute('aria-label', `Remove tag ${tag}`);
        setText(remove, '×');
        remove.addEventListener('click', () => {
            field.tags.delete(tag);
            renderChips(field, onChange);
            onChange();
        });

        chip.append(remove);
        field.chips.append(chip);
    }
}
