/**
 * Request-shape validation and the guards applied to parsed upstream JSON.
 *
 * Nothing here trusts a key name. Every lookup driven by client or upstream data
 * goes through hasOwnProperty, and every object we build starts from
 * Object.create(null), so a "__proto__" key is inert data rather than a write
 * to Object.prototype.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} value
 * @returns {boolean} true for a plain object (not an array, not null)
 */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clamps to an integer inside [min, max], falling back for anything unusable.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
    const type = typeof value;
    if (type !== 'number' && type !== 'string') {
        return fallback;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * Returns `value` only if it is one of `allowed`. Never returns caller input
 * that was not explicitly permitted.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
export function pick(value, allowed, fallback) {
    if (typeof value === 'string' && allowed.includes(value)) {
        return value;
    }
    return fallback;
}

/**
 * Depth-limited scan for prototype-poisoning keys. Also acts as a cheap
 * structural bomb guard: deeply nested upstream JSON is rejected rather than
 * recursed into.
 *
 * @param {unknown} value
 * @param {number} [maxDepth]
 * @returns {boolean} true if the value is unsafe to process
 */
export function hasForbiddenKey(value, maxDepth = 6) {
    return scan(value, maxDepth, 0);
}

function scan(value, maxDepth, depth) {
    if (depth > maxDepth) {
        return true; // Too deep to validate; treat as hostile.
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            if (scan(item, maxDepth, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    if (!isPlainObject(value)) {
        return false;
    }

    // Own keys only, and getOwnPropertyNames also catches a non-enumerable
    // "__proto__" that a plain for..in would miss.
    for (const key of Object.getOwnPropertyNames(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            return true;
        }
        if (scan(value[key], maxDepth, depth + 1)) {
            return true;
        }
    }

    return false;
}

/**
 * Reads a property without touching the prototype chain.
 * @param {unknown} object
 * @param {string} key
 */
export function own(object, key) {
    if (!isPlainObject(object) && !Array.isArray(object)) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
        return undefined;
    }
    return object[key];
}

/**
 * Validates the common `{ source, ... }` request envelope.
 * @param {unknown} body
 * @returns {{ ok: true, source: string } | { ok: false, code: string }}
 */
export function readSourceId(body) {
    if (!isPlainObject(body)) {
        return { ok: false, code: 'bad_request' };
    }

    const source = own(body, 'source');
    if (typeof source !== 'string' || source === '' || source.length > 64) {
        return { ok: false, code: 'bad_source' };
    }

    return { ok: true, source };
}
