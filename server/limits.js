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

/**
 * In-flight caps, so a burst cannot open many sockets at once.
 *
 * These QUEUE rather than reject. That distinction is the whole point: a grid
 * renders 24 <img> tags at once and the browser opens about six connections
 * immediately. A cap that answered 503 at capacity permanently broke every
 * image past the limit — an <img> does not retry — so most of the grid stayed
 * blank while the server reported no errors at all.
 */
const inFlight = new Map();

/** @type {Map<string, Array<{ resolve: (v: unknown) => void, timer: NodeJS.Timeout }>>} */
const waiting = new Map();

const CONCURRENCY = Object.freeze({
    source: 2,
    // Bounds peak memory. A source without a preview endpoint may be capped at
    // 5 MB per image, so four in flight is ~20 MB.
    thumb: 4,
});

/** Longer than any single thumbnail fetch, short enough not to pile up. */
const DEFAULT_WAIT_MS = 20000;

function releaseSlot(slot) {
    const queue = waiting.get(slot);
    if (queue && queue.length > 0) {
        // Hand the slot straight to the next waiter; the count stays the same.
        const next = queue.shift();
        if (queue.length === 0) {
            waiting.delete(slot);
        }
        clearTimeout(next.timer);
        next.resolve(true);
        return;
    }

    const remaining = (inFlight.get(slot) ?? 1) - 1;
    if (remaining <= 0) {
        inFlight.delete(slot);
    } else {
        inFlight.set(slot, remaining);
    }
}

function makeRelease(slot) {
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        releaseSlot(slot);
    };
}

/**
 * Waits for a slot rather than refusing one.
 *
 * @param {'source' | 'thumb'} kind
 * @param {string} key
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<(() => void) | null>} a release function, or null if the wait timed out
 */
export async function acquire(kind, key, { timeoutMs = DEFAULT_WAIT_MS } = {}) {
    const slot = `${kind}:${key}`;
    const current = inFlight.get(slot) ?? 0;

    if (current < CONCURRENCY[kind]) {
        inFlight.set(slot, current + 1);
        return makeRelease(slot);
    }

    const granted = await new Promise((resolve) => {
        const entry = {
            resolve,
            timer: setTimeout(() => {
                const queue = waiting.get(slot);
                if (queue) {
                    const index = queue.indexOf(entry);
                    if (index >= 0) {
                        queue.splice(index, 1);
                    }
                    if (queue.length === 0) {
                        waiting.delete(slot);
                    }
                }
                resolve(false);
            }, timeoutMs),
        };
        // Never hold the process open waiting on a queued request.
        entry.timer.unref?.();

        const queue = waiting.get(slot);
        if (queue) {
            queue.push(entry);
        } else {
            waiting.set(slot, [entry]);
        }
    });

    return granted ? makeRelease(slot) : null;
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
