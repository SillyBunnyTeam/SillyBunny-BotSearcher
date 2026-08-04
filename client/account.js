/**
 * Retained public BotBooru account state.
 *
 * The bearer never crosses the server boundary. This module keeps only the
 * bounded status needed to keep the settings drawer and open browser dialogs in
 * agreement when a login, logout or account preference changes.
 */

import { post } from './api.js';

const SOURCE = 'botbooru';
const USERNAME_LIMIT = 64;

const listeners = new Set();
let operation = 0;
let pendingMutations = 0;
let state = Object.freeze({
    known: false,
    loggedIn: false,
    username: '',
    nsfwEnabled: false,
    nsflEnabled: false,
    nsflActive: null,
    error: null,
    revision: 0,
});

function normalize(value) {
    return {
        known: true,
        loggedIn: value?.loggedIn === true,
        username: typeof value?.username === 'string' ? value.username.slice(0, USERNAME_LIMIT) : '',
        nsfwEnabled: value?.nsfwEnabled === true,
        nsflEnabled: value?.nsflEnabled === true,
        nsflActive: typeof value?.nsflActive === 'boolean' ? value.nsflActive : null,
    };
}

function samePublicState(left, right) {
    return left.known === right.known
        && left.loggedIn === right.loggedIn
        && left.username === right.username
        && left.nsfwEnabled === right.nsfwEnabled
        && left.nsflEnabled === right.nsflEnabled
        && left.nsflActive === right.nsflActive;
}

function publish(value, { forceRevision = false, error = null } = {}) {
    const next = normalize(value);
    const changed = forceRevision || !samePublicState(state, next) || state.error !== error;
    state = Object.freeze({
        ...next,
        error,
        revision: state.revision + (changed ? 1 : 0),
    });
    for (const listener of listeners) {
        listener(state);
    }
    return state;
}

export function getBotbooruAccount() {
    return state;
}

export function subscribeBotbooruAccount(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
}

export async function refreshBotbooruAccount({ signal } = {}) {
    const expectedOperation = operation;
    try {
        const result = await post('/account/status', { source: SOURCE }, { signal });
        if (expectedOperation === operation) {
            publish(result);
        }
    } catch (error) {
        if (expectedOperation === operation) {
            publishAccountError(error);
        }
        throw error;
    }
    return getBotbooruAccount();
}

export async function loginBotbooruAccount(username, password, { signal } = {}) {
    pendingMutations++;
    try {
        const expectedOperation = ++operation;
        const result = await post('/account/login', {
            source: SOURCE,
            username,
            password,
        }, { signal });
        if (expectedOperation === operation) {
            publish(result, { forceRevision: true });
        }
        return getBotbooruAccount();
    } finally {
        pendingMutations--;
    }
}

export async function setBotbooruNsfw(enabled, { signal } = {}) {
    pendingMutations++;
    try {
        const expectedOperation = ++operation;
        try {
            const result = await post('/account/nsfw', {
                source: SOURCE,
                enabled: enabled === true,
            }, { signal });
            if (expectedOperation === operation) {
                publish(result, { forceRevision: true });
            }
        } catch (error) {
            if (expectedOperation === operation) {
                publishAccountError(error);
            }
            throw error;
        }
        return getBotbooruAccount();
    } finally {
        pendingMutations--;
    }
}

export async function logoutBotbooruAccount({ signal } = {}) {
    pendingMutations++;
    try {
        const expectedOperation = ++operation;
        const result = await post('/account/logout', { source: SOURCE }, { signal });
        if (expectedOperation === operation) {
            publish(result, { forceRevision: true });
        }
        return getBotbooruAccount();
    } finally {
        pendingMutations--;
    }
}

/**
 * Synchronizes an account failure returned by search or detail with every open
 * surface. Merged-search failures also use this path; the browser removes only
 * BotBooru records while preserving valid results from other sources.
 */
export function noteBotbooruAccountError(error) {
    // A response from a request issued before a login or preference mutation
    // cannot authoritatively describe the session that mutation is replacing.
    if (pendingMutations > 0) {
        return false;
    }
    return publishAccountError(error);
}

function publishAccountError(error) {
    const code = error?.code;
    if (![
        'botbooru_login_required',
        'botbooru_session_expired',
        'botbooru_nsfw_disabled',
    ].includes(code)) {
        return false;
    }

    operation++;
    if (code === 'botbooru_nsfw_disabled' && state.loggedIn) {
        publish({ ...state, nsfwEnabled: false }, { forceRevision: true, error: code });
    } else {
        publish({ loggedIn: false }, { forceRevision: true, error: code });
    }
    return true;
}
