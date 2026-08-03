/**
 * SillyBunny-BotSearcher — server plugin entry point.
 *
 * Loaded by src/plugin-loader.js, which reads `main` from our package.json.
 * Contract: an `info` object with string id/name/description, an `init(router)`,
 * and an optional `exit()`. Mounted at /api/plugins/<info.id>.
 *
 * This half exists because the card sites do not send CORS headers, so the
 * browser cannot call them. Putting the calls here means the server owns every
 * outbound URL — no client-supplied URL is ever fetched, and no third-party
 * relay is involved at any point.
 */

import { PLUGIN_ID } from '../shared/schema.js';
import { createRouter } from './router.js';
import { LOG_TAG } from './guards.js';

export const info = {
    id: PLUGIN_ID,
    name: 'SillyBunny BotSearcher',
    description: 'Server half of the BotSearcher extension: searches character card sites and normalizes their responses.',
};

const state = {
    startedAt: Date.now(),
    /** @type {Set<NodeJS.Timeout>} Any timer created later must land here so exit() can clear it. */
    timers: new Set(),
};

/**
 * @param {import('express').Router} router
 */
export function init(router) {
    createRouter(router, state);
    console.log(`[${LOG_TAG}] mounted at /api/plugins/${PLUGIN_ID}`);
}

export async function exit() {
    // src/plugin-loader.js:87 returns () => Promise.all(exitHooks.map(fn => fn()))
    // and src/server-main.js awaits it before process.exit(). A rejection here
    // means the server never exits, so nothing may escape this function.
    try {
        for (const timer of state.timers) {
            clearInterval(timer);
        }
        state.timers.clear();
    } catch {
        // Nothing actionable during shutdown.
    }
}
