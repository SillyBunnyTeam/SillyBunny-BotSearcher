/**
 * Botbooru — https://botbooru.com
 *
 * Tier 0 and the reference adapter. Two things make it the right first source:
 * its JSON API is clean and unauthenticated, and SillyBunny already imports
 * botbooru.com natively (src/endpoints/content-manager.js:1631 dispatches to
 * downloadBotbooruCharacter, which re-asserts the PNG signature itself). So
 * importing adds no new trust surface at all — we only supply discovery.
 *
 * Endpoints, all verified live:
 *   GET /posts/?q=&limit=&offset=&sort=&sfw_only=&hide_ai=  -> { total, posts[] }
 *   GET /post/<id>                                          -> full card metadata
 *   GET /images/preview/<320|640>/<filename>                -> thumbnail
 *   GET /api/post-count                                     -> { total }
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, pick, own } from '../validate.js';

const BASE = 'https://botbooru.com';

/**
 * The preview endpoint takes an allow-list of edge sizes, not an arbitrary
 * number: 320 and 640 answer 200, while 200/256/384/400/512 answer 400.
 * (CleanBotBrowser asks for 480 and 720, which is why its Botbooru thumbnails
 * are broken.)
 */
const PREVIEW_SIZES = Object.freeze({ grid: 320, detail: 640 });

const SORTS = Object.freeze(['latest', 'curated', 'downloads', 'favorites', 'views', 'random']);

/** Botbooru's own Meta taxonomy marks safe cards; absence means assume adult. */
const SFW_TAG = 'sfw';

/**
 * @param {unknown} rawTags Botbooru tag objects: { id, name, category }
 */
function tagNames(rawTags) {
    if (!Array.isArray(rawTags)) {
        return [];
    }
    return rawTags
        .map((tag) => (tag && typeof tag === 'object' ? own(tag, 'name') : tag))
        .filter((name) => typeof name === 'string');
}

/**
 * The card's writer is carried as a tag in the "Writer" category. Search results
 * carry no uploader name, so this is the only creator signal available there.
 */
function writerFrom(rawTags) {
    if (!Array.isArray(rawTags)) {
        return '';
    }
    for (const tag of rawTags) {
        if (tag && typeof tag === 'object' && own(tag, 'category') === 'Writer') {
            const name = own(tag, 'name');
            if (typeof name === 'string') {
                return name;
            }
        }
    }
    return '';
}

function isNsfw(names) {
    // Conservative: only an explicit sfw tag clears a card. Botbooru is mostly
    // adult, so "unknown" must not render unblurred.
    return !names.includes(SFW_TAG);
}

/**
 * @param {unknown} post
 * @param {'grid' | 'detail'} size
 * @returns {string | null}
 */
function previewUrl(post, size) {
    const filename = own(post, 'filename');
    // Path segment, so it must not be able to introduce one.
    if (typeof filename !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(filename)) {
        return null;
    }

    const url = new URL(`/images/preview/${PREVIEW_SIZES[size]}/${encodeURIComponent(filename)}`, BASE);

    const revision = own(post, 'card_image_revision');
    if (typeof revision === 'number' && Number.isFinite(revision)) {
        url.searchParams.set('v', String(Math.floor(revision)));
    }

    return url.toString();
}

function idOf(post) {
    const id = own(post, 'id');
    return typeof id === 'number' && Number.isFinite(id) ? String(Math.floor(id)) : '';
}

function toSummary(post) {
    const names = tagNames(own(post, 'tags'));
    const id = idOf(post);

    return buildSummary({
        source: 'botbooru',
        id,
        name: own(post, 'character_name'),
        tagline: own(post, 'tagline') || own(post, 'description_excerpt'),
        creator: writerFrom(own(post, 'tags')),
        tags: names,
        nsfw: isNsfw(names),
        stats: {
            views: own(post, 'views'),
            downloads: own(post, 'downloads'),
            favorites: own(post, 'favorite_count'),
            tokens: own(post, 'token_count'),
        },
        createdAt: own(post, 'created_at'),
        thumbUrl: previewUrl(post, 'grid'),
        pageUrl: id ? `${BASE}/character/${id}` : null,
        // Accepted by content-manager.js's parseBotbooruUrl -> /download/png/<id>.
        importUrl: id ? `${BASE}/character/${id}` : null,
        nativeImport: true,
    });
}

function toDetail(post, id) {
    const names = tagNames(own(post, 'tags'));
    const lorebook = own(post, 'lorebook_json');
    const greetings = own(post, 'alternate_greetings');
    const gallery = own(post, 'mini_gallery');

    return buildDetail({
        source: 'botbooru',
        id,
        name: own(post, 'character_name'),
        tagline: own(post, 'tagline'),
        creator: own(post, 'uploader_name') || writerFrom(own(post, 'tags')),
        tags: names,
        nsfw: isNsfw(names),
        stats: {
            views: own(post, 'views'),
            downloads: own(post, 'downloads'),
            favorites: own(post, 'fork_count'),
            tokens: undefined,
        },
        createdAt: own(post, 'created_at'),
        thumbUrl: previewUrl(post, 'detail'),
        pageUrl: `${BASE}/character/${id}`,
        importUrl: `${BASE}/character/${id}`,
        nativeImport: true,
        description: own(post, 'description'),
        firstMessage: own(post, 'first_mes'),
        creatorNotes: own(post, 'creator_notes'),
        inside: {
            lorebookEntries: countLorebookEntries(lorebook, own(post, 'has_lorebook')),
            alternateGreetings: Array.isArray(greetings) ? greetings.length : 0,
            hasSystemPrompt: nonEmptyString(own(post, 'system_prompt')),
            hasPostHistoryInstructions: nonEmptyString(own(post, 'post_history_instructions')),
            hasDepthPrompt: hasDepthPrompt(own(post, 'depth_prompt')),
            embeddedAssets: Array.isArray(own(gallery, 'images')) ? own(gallery, 'images').length : 0,
            specVersion: 'chara_card_v2',
            originSite: own(post, 'origin'),
        },
    });
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function hasDepthPrompt(value) {
    return nonEmptyString(own(value, 'prompt'));
}

/**
 * Lorebook entries are what make an imported card able to inject text later, so
 * the count is the single most useful number in the trust panel.
 */
function countLorebookEntries(lorebook, hasLorebook) {
    if (!lorebook || typeof lorebook !== 'object') {
        return hasLorebook === true ? null : 0;
    }
    const entries = own(lorebook, 'entries');
    if (Array.isArray(entries)) {
        return entries.length;
    }
    if (entries && typeof entries === 'object') {
        return Object.keys(entries).length;
    }
    return hasLorebook === true ? null : 0;
}

export const botbooru = Object.freeze({
    id: 'botbooru',
    label: 'Botbooru',
    homepage: BASE,
    allowedHosts: Object.freeze(['botbooru.com']),
    idPattern: /^\d{1,12}$/,
    tier: 0,
    nativeImport: true,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'offset',
        sorts: SORTS,
        sfwToggle: true,
        detail: true,
    }),

    async search(ctx, { query, offset, limit, sort, sfwOnly, hideAi }) {
        const url = new URL('/posts/', BASE);
        url.searchParams.set('limit', String(clampInt(limit, 1, 48, 24)));
        url.searchParams.set('offset', String(clampInt(offset, 0, 5000, 0)));
        url.searchParams.set('sort', pick(sort, SORTS, 'latest'));

        if (typeof query === 'string' && query !== '') {
            url.searchParams.set('q', query.slice(0, 128));
        }
        if (sfwOnly) {
            url.searchParams.set('sfw_only', 'true');
        }
        if (hideAi) {
            url.searchParams.set('hide_ai', 'true');
        }

        const data = await ctx.fetchJson(url, { maxBytes: 2 << 20, timeoutMs: 8000 });

        const rawPosts = own(data, 'posts');
        const posts = Array.isArray(rawPosts) ? rawPosts.slice(0, 48) : [];
        const rawTotal = own(data, 'total');
        const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? Math.floor(rawTotal) : null;

        const items = posts.map(toSummary).filter((item) => item.id !== '');
        const start = clampInt(offset, 0, 5000, 0);

        return {
            total,
            hasMore: total === null ? items.length > 0 : start + posts.length < total,
            items,
        };
    },

    async getDetail(ctx, id) {
        const url = new URL(`/post/${encodeURIComponent(id)}`, BASE);
        const post = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });
        return toDetail(post, id);
    },

    getImportTarget(_ctx, id) {
        return { kind: 'url', url: `${BASE}/character/${id}` };
    },

    async probe(ctx) {
        const data = await ctx.fetchJson(new URL('/api/post-count', BASE), { maxBytes: 4096, timeoutMs: 5000 });
        return typeof own(data, 'total') === 'number';
    },
});
