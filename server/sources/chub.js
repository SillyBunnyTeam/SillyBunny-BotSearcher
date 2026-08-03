/**
 * Chub — https://chub.ai
 *
 * Three hosts, and the distinction matters:
 *   gateway.chub.ai     the JSON API we call
 *   avatars.charhub.io  the images the thumbnail proxy fetches
 *   chub.ai             where a character's page and its import URL live —
 *                       this plugin never contacts it; SillyBunny's own
 *                       importer does (content-manager.js:1631)
 * Only the first two are in allowedHosts, so nothing here can make the server
 * request chub.ai.
 *
 * Chub does send `access-control-allow-origin: *`, so a browser could call it
 * directly. We still go through the server, both for privacy — Chub should not
 * see the user's IP or queries — and so every source behaves identically.
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, pick, own } from '../validate.js';
import { mintRef } from '../refs.js';

const API = 'https://gateway.chub.ai';
const AVATARS = 'https://avatars.charhub.io';
const SITE = 'https://chub.ai';

/**
 * The authoritative list, from the API's own error response when handed an
 * unknown value. Trimmed to the ones that mean something to a person.
 */
const SORTS = Object.freeze([
    'default',
    'download_count',
    'star_count',
    'n_favorites',
    'rating',
    'trending',
    'trending_downloads',
    'created_at',
    'last_activity_at',
    'newcomer',
    'n_tokens',
    'name',
    'random',
]);

/**
 * "creator/slug" — the identifier, the page path and the avatar path at once.
 *
 * The lookaheads require each segment to contain a letter or digit. Without
 * them "../.." matches, since "." is otherwise a legal character: harmless in
 * practice, because the host allow-list is the real control and new URL()
 * normalizes the result, but there is no reason to construct a traversal at all.
 */
const FULL_PATH = /^(?=[^/]*[A-Za-z0-9])[A-Za-z0-9._~-]{1,64}\/(?=[^/]*[A-Za-z0-9])[A-Za-z0-9._~-]{1,160}$/;

function fullPathOf(node) {
    const value = own(node, 'fullPath');
    return typeof value === 'string' && FULL_PATH.test(value) ? value : null;
}

function creatorOf(fullPath) {
    return fullPath.slice(0, fullPath.indexOf('/'));
}

/**
 * Built from fullPath rather than read from the node's own `avatar_url`: the
 * upstream field is attacker-influenced, the reconstruction is not.
 */
function avatarUrl(fullPath) {
    return `${AVATARS}/avatars/${fullPath}/avatar.webp`;
}

function previewRef(fullPath) {
    return mintRef('chub', { p: fullPath });
}

/**
 * Chub exposes `nsfw_image` plus a topic list. Either signal is enough to blur.
 */
function isNsfw(node, topics) {
    if (own(node, 'nsfw_image') === true) {
        return true;
    }
    const lowered = topics.map((topic) => String(topic).toLowerCase());
    return ['nsfw', 'nsfl', 'gore', 'explicit'].some((flag) => lowered.includes(flag));
}

function topicsOf(node) {
    const topics = own(node, 'topics');
    return Array.isArray(topics) ? topics.filter((topic) => typeof topic === 'string') : [];
}

function toSummary(node) {
    const fullPath = fullPathOf(node);
    if (fullPath === null) {
        return null;
    }

    const topics = topicsOf(node);

    return buildSummary({
        source: 'chub',
        id: fullPath,
        name: own(node, 'name'),
        tagline: own(node, 'tagline') || own(node, 'description'),
        creator: creatorOf(fullPath),
        tags: topics,
        nsfw: isNsfw(node, topics),
        stats: {
            views: own(node, 'nChats'),
            downloads: own(node, 'starCount'),
            favorites: own(node, 'n_favorites'),
            tokens: own(node, 'nTokens'),
        },
        createdAt: own(node, 'createdAt'),
        thumbUrl: avatarUrl(fullPath),
        thumbRef: previewRef(fullPath),
        pageUrl: `${SITE}/characters/${fullPath}`,
        // parseChubUrl (content-manager.js) reads this back as { id: fullPath }.
        importUrl: `${SITE}/characters/${fullPath}`,
        nativeImport: true,
    });
}

function toDetail(node, fullPath) {
    const topics = topicsOf(node);
    const definition = own(node, 'definition');
    const lorebook = own(definition, 'embedded_lorebook');
    const greetings = own(definition, 'alternate_greetings');

    return buildDetail({
        source: 'chub',
        id: fullPath,
        name: own(node, 'name'),
        tagline: own(node, 'tagline'),
        creator: creatorOf(fullPath),
        tags: topics,
        nsfw: isNsfw(node, topics),
        stats: {
            views: own(node, 'nChats'),
            downloads: own(node, 'starCount'),
            favorites: own(node, 'n_favorites'),
            tokens: own(node, 'nTokens'),
        },
        createdAt: own(node, 'createdAt'),
        thumbUrl: avatarUrl(fullPath),
        thumbRef: previewRef(fullPath),
        pageUrl: `${SITE}/characters/${fullPath}`,
        importUrl: `${SITE}/characters/${fullPath}`,
        nativeImport: true,
        description: own(definition, 'description') ?? own(node, 'description'),
        // Chub calls this `first_message`, not the card spec's `first_mes`.
        // Reading only the spec name silently produced blank first messages.
        firstMessage: own(definition, 'first_message') ?? own(definition, 'first_mes'),
        creatorNotes: own(definition, 'creator_notes') ?? own(node, 'description'),
        inside: {
            lorebookEntries: countLorebookEntries(lorebook),
            alternateGreetings: Array.isArray(greetings) ? greetings.length : 0,
            hasSystemPrompt: nonEmpty(own(definition, 'system_prompt')),
            hasPostHistoryInstructions: nonEmpty(own(definition, 'post_history_instructions')),
            hasDepthPrompt: nonEmpty(own(own(definition, 'extensions'), 'depth_prompt')),
            embeddedAssets: own(node, 'hasGallery') === true ? null : 0,
            specVersion: own(node, 'primaryFormat') ?? 'chara_card_v2',
            originSite: 'Chub',
        },
    });
}

function nonEmpty(value) {
    if (typeof value === 'string') {
        return value.trim() !== '';
    }
    // depth_prompt arrives as an object on some cards.
    return value !== null && value !== undefined && typeof value === 'object';
}

function countLorebookEntries(lorebook) {
    const entries = own(lorebook, 'entries');
    if (Array.isArray(entries)) {
        return entries.length;
    }
    if (entries && typeof entries === 'object') {
        return Object.keys(entries).length;
    }
    return 0;
}

export const chub = Object.freeze({
    id: 'chub',
    label: 'Chub',
    homepage: SITE,
    allowedHosts: Object.freeze(['gateway.chub.ai', 'avatars.charhub.io']),
    /** Rendered and imported, never fetched by this plugin. */
    linkHosts: Object.freeze(['chub.ai']),
    idPattern: FULL_PATH,
    tier: 1,
    nativeImport: true,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'page',
        sorts: SORTS,
        sfwToggle: true,
        detail: true,
    }),

    async search(ctx, { query, offset, limit, sort, sfwOnly }) {
        const perPage = clampInt(limit, 1, 48, 24);
        // Chub pages rather than offsets; the router speaks offsets, so convert.
        const page = Math.floor(clampInt(offset, 0, 5000, 0) / perPage) + 1;
        const safe = sfwOnly === true;

        const url = new URL('/search', API);
        // The full set is required: omitting `asc` makes sort=default 400.
        url.searchParams.set('search', typeof query === 'string' ? query.slice(0, 128) : '');
        url.searchParams.set('namespace', 'characters');
        url.searchParams.set('first', String(perPage));
        url.searchParams.set('page', String(page));
        url.searchParams.set('sort', pick(sort, SORTS, 'default'));
        url.searchParams.set('asc', 'false');
        url.searchParams.set('nsfw', String(!safe));
        url.searchParams.set('nsfl', String(!safe));
        url.searchParams.set('nsfw_only', 'false');
        url.searchParams.set('include_forks', 'true');
        url.searchParams.set('count', 'false');

        const data = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });

        const payload = own(data, 'data');
        const rawNodes = own(payload, 'nodes');
        const nodes = Array.isArray(rawNodes) ? rawNodes.slice(0, 48) : [];
        const rawCount = own(payload, 'count');
        const total = typeof rawCount === 'number' && Number.isFinite(rawCount) ? Math.floor(rawCount) : null;

        const items = nodes.map(toSummary).filter((item) => item !== null && item.id !== '');

        return {
            total,
            hasMore: total === null ? nodes.length >= perPage : page * perPage < total,
            items,
        };
    },

    async getDetail(ctx, id) {
        const url = new URL(`/api/characters/${id}`, API);
        url.searchParams.set('full', 'true');

        const data = await ctx.fetchJson(url, { maxBytes: 6 << 20, timeoutMs: 12000 });
        const node = own(data, 'node') ?? data;
        return toDetail(node, id);
    },

    getImportTarget(_ctx, id) {
        return { kind: 'url', url: `${SITE}/characters/${id}` };
    },

    thumbUrlFromRef(ref, _size) {
        const fullPath = own(ref, 'p');
        if (typeof fullPath !== 'string' || !FULL_PATH.test(fullPath)) {
            throw new Error('bad_ref');
        }
        // Chub serves one avatar size; both grid and detail use it.
        return avatarUrl(fullPath);
    },

    async probe(ctx) {
        const url = new URL('/search', API);
        url.searchParams.set('search', '');
        url.searchParams.set('namespace', 'characters');
        url.searchParams.set('first', '1');
        url.searchParams.set('page', '1');
        url.searchParams.set('sort', 'default');
        url.searchParams.set('asc', 'false');
        url.searchParams.set('nsfw', 'false');
        url.searchParams.set('count', 'false');

        const data = await ctx.fetchJson(url, { maxBytes: 1 << 20, timeoutMs: 8000 });
        return Array.isArray(own(own(data, 'data'), 'nodes'));
    },
});
