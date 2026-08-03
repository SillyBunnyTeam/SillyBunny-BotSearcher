/**
 * Signed, opaque thumbnail references.
 *
 * The whole point of the thumbnail proxy is privacy, and the naive way to build
 * one — /thumb?url=https://... — would be a full server-side request forgery,
 * and strictly worse than loading the image directly. So /thumb never accepts a
 * URL. It accepts a token that THIS process minted during a search, carrying
 * only the few opaque fields the adapter needs to rebuild the URL from its own
 * fixed base.
 *
 * Even a compromised upstream cannot steer us: the payload holds no host and no
 * path separator, the adapter re-validates every field, and a token this process
 * did not mint fails the signature check before it is ever parsed.
 */

import crypto from 'node:crypto';

/**
 * One random secret per process. Refs do not survive a restart, which is fine —
 * the client simply re-runs its search. Nothing is persisted, so there is no
 * key file to leak and no rotation to manage.
 */
const SECRET = crypto.randomBytes(32);

const SIGNATURE_LENGTH = 22;
const MAX_REF_LENGTH = 512;

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(source, payloadPart) {
    // The source is inside the signed material, so a ref minted for one source
    // cannot be replayed against another adapter's URL builder.
    return base64url(
        crypto.createHmac('sha256', SECRET).update(`${source}|${payloadPart}`).digest(),
    ).slice(0, SIGNATURE_LENGTH);
}

/**
 * @param {string} source
 * @param {Record<string, string | number>} payload small and flat
 * @returns {string | null}
 */
export function mintRef(source, payload) {
    if (typeof source !== 'string' || !payload || typeof payload !== 'object') {
        return null;
    }

    let payloadPart;
    try {
        payloadPart = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    } catch {
        return null;
    }

    if (payloadPart.length > MAX_REF_LENGTH - SIGNATURE_LENGTH - 1) {
        return null;
    }

    return `${payloadPart}.${sign(source, payloadPart)}`;
}

/**
 * Verifies then parses. In that order — an unsigned ref is never JSON.parse'd.
 *
 * @param {string} source
 * @param {unknown} ref
 * @returns {Record<string, unknown> | null}
 */
export function verifyRef(source, ref) {
    if (typeof source !== 'string' || typeof ref !== 'string' || ref === '' || ref.length > MAX_REF_LENGTH) {
        return null;
    }

    const separator = ref.lastIndexOf('.');
    if (separator <= 0 || separator === ref.length - 1) {
        return null;
    }

    const payloadPart = ref.slice(0, separator);
    const provided = ref.slice(separator + 1);

    if (!/^[A-Za-z0-9_-]+$/.test(payloadPart) || !/^[A-Za-z0-9_-]+$/.test(provided)) {
        return null;
    }

    const expected = sign(source, payloadPart);

    // Constant-time compare. timingSafeEqual throws on a length mismatch, so
    // check that first.
    if (provided.length !== expected.length) {
        return null;
    }
    if (!crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    return parsed;
}
