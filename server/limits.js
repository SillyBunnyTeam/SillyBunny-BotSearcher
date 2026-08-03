/**
 * Rate limiting and concurrency caps.
 *
 * Two jobs: keep one user's grid from opening a burst of sockets on a small box
 * (the reference deployment is a 1 OCPU / 6 GB ARM instance shared with other
 * apps), and keep this plugin from looking like an attack to the card sites.
 *
 * rate-limiter-flexible's consume() REJECTS with a RateLimiterRes on limit —
 * not with an Error. An unhandled one would reach SillyBunny's
 * unhandledRejection handler and shut the whole server down
 * (src/server-main.js:518-537), so every call site here distinguishes the two.
 */

import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiters = {
    /** Per user, across all sources. */
    search: new RateLimiterMemory({ points: 30, duration: 60 }),
    /** Per source, across all users: protects the upstream site and our IP reputation. */
    sourceGlobal: new RateLimiterMemory({ points: 20, duration: 60 }),
    /** Per user: fetching card bytes is the expensive path. */
    card: new RateLimiterMemory({ points: 10, duration: 60 }),
    /** Per user: one 24-tile grid fires 24 of these at once. */
    thumb: new RateLimiterMemory({ points: 300, duration: 60 }),
};

/**
 * @param {keyof typeof limiters} name
 * @param {string} key
 * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
 */
export async function consume(name, key) {
    try {
        await limiters[name].consume(key, 1);
        return { allowed: true };
    } catch (rejection) {
        // A real Error means the limiter itself broke; fail open rather than
        // taking the feature down, but say so.
        if (rejection instanceof Error) {
            console.error('[BotSearcher] rate limiter error:', rejection.message);
            return { allowed: true };
        }

        const ms = typeof rejection?.msBeforeNext === 'number' ? rejection.msBeforeNext : 1000;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) };
    }
}

/** In-flight caps, so a burst cannot open many sockets at once. */
const inFlight = new Map();

const CONCURRENCY = Object.freeze({
    source: 2,
    thumb: 6,
});

/**
 * @param {'source' | 'thumb'} kind
 * @param {string} key
 * @returns {(() => void) | null} a release function, or null if at capacity
 */
export function acquire(kind, key) {
    const slot = `${kind}:${key}`;
    const current = inFlight.get(slot) ?? 0;

    if (current >= CONCURRENCY[kind]) {
        return null;
    }

    inFlight.set(slot, current + 1);

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        const next = (inFlight.get(slot) ?? 1) - 1;
        if (next <= 0) {
            inFlight.delete(slot);
        } else {
            inFlight.set(slot, next);
        }
    };
}

/**
 * Identifies the caller for per-user limits. request.user is always populated by
 * setUserDataMiddleware (src/users.js), but fall back rather than throw.
 * @param {any} request
 */
export function callerKey(request) {
    const handle = request?.user?.profile?.handle;
    return typeof handle === 'string' && handle !== '' ? handle : 'anonymous';
}
