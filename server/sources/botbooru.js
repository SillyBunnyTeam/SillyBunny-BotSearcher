/**
 * Botbooru — https://botbooru.com
 *
 * Tier 0 and the reference adapter. Two things make it the right first source:
 * its JSON API is clean and unauthenticated, and SillyBunny already imports
 * botbooru.com natively (src/endpoints/content-manager.js:1631 dispatches to
 * downloadBotbooruCharacter, which re-asserts the PNG signature itself). So
 * importing reuses SillyBunny's existing URL importer; this adapter supplies
 * discovery and a server-built URL rather than another download path.
 *
 * Endpoints, all verified live:
 *   GET /posts/?q=&limit=&offset=&sort=&sfw_only=&hide_ai=  -> { total, posts[] }
 *   GET /post/<id>                                          -> full card metadata
 *   GET /images/preview/<320|640>/<filename>                -> thumbnail
 *   GET /api/post-count                                     -> { total }
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, pick, own } from '../validate.js';
import { mintRef } from '../refs.js';
import { offsetCursor } from '../paging.js';

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

function contentRating(names) {
    // Conservative: only an explicit sfw tag clears a card. Botbooru is mostly
    // adult, so "unknown" must not render unblurred.
    return names.includes(SFW_TAG) ? 'sfw' : 'sensitive';
}

/**
 * The image filename becomes a path segment, so it must not be able to
 * introduce one. This is the only field from the payload that reaches a URL.
 *
 * The lookahead requires at least one letter or digit, which rules out ".."
 * and ".". Those cannot leave the host — the allow-list sees to that — but a
 * URL we build should never contain a traversal in the first place.
 */
const FILENAME_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]{1,128}$/;

/**
 * @param {unknown} post
 * @returns {string | null}
 */
function filenameOf(post) {
    const filename = own(post, 'filename');
    return typeof filename === 'string' && FILENAME_PATTERN.test(filename) ? filename : null;
}

function revisionOf(post) {
    const revision = own(post, 'card_image_revision');
    return typeof revision === 'number' && Number.isFinite(revision) ? Math.floor(revision) : null;
}

/**
 * @param {unknown} post
 * @param {'grid' | 'detail'} size
 * @returns {string | null}
 */
function previewUrl(post, size) {
    const filename = filenameOf(post);
    if (filename === null) {
        return null;
    }
    return buildPreviewUrl(filename, revisionOf(post), size);
}

function buildPreviewUrl(filename, revision, size) {
    const url = new URL(`/images/preview/${PREVIEW_SIZES[size]}/${encodeURIComponent(filename)}`, BASE);
    if (revision !== null && revision !== undefined) {
        url.searchParams.set('v', String(revision));
    }
    return url.toString();
}

/**
 * The opaque token behind the /thumb proxy. Carries no host and no path
 * separator — only the filename and its cache-busting revision.
 * @param {unknown} post
 */
function previewRef(post) {
    const filename = filenameOf(post);
    if (filename === null) {
        return null;
    }
    const revision = revisionOf(post);
    return mintRef('botbooru', revision === null ? { f: filename } : { f: filename, v: revision });
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
        contentRating: contentRating(names),
        stats: {
            views: own(post, 'views'),
            downloads: own(post, 'downloads'),
            favorites: own(post, 'favorite_count'),
            tokens: own(post, 'token_count'),
        },
        createdAt: own(post, 'created_at'),
        thumbUrl: previewUrl(post, 'grid'),
        thumbRef: previewRef(post),
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
        contentRating: contentRating(names),
        stats: {
            views: own(post, 'views'),
            downloads: own(post, 'downloads'),
            favorites: own(post, 'fork_count'),
            tokens: undefined,
        },
        createdAt: own(post, 'created_at'),
        thumbUrl: previewUrl(post, 'detail'),
        thumbRef: previewRef(post),
        pageUrl: `${BASE}/character/${id}`,
        importUrl: `${BASE}/character/${id}`,
        nativeImport: true,
        description: own(post, 'description'),
        firstMessage: own(post, 'first_mes'),
        creatorNotes: own(post, 'creator_notes'),
        inside: {
            lorebookEntries: countLorebookEntries(lorebook, own(post, 'has_lorebook')),
            alternateGreetings: Array.isArray(greetings) ? greetings.length : null,
            hasSystemPrompt: reportedNonEmpty(post, 'system_prompt'),
            hasPostHistoryInstructions: reportedNonEmpty(post, 'post_history_instructions'),
            hasDepthPrompt: reportedDepth(post),
            embeddedAssets: Array.isArray(own(gallery, 'images')) ? own(gallery, 'images').length : null,
            specVersion: 'chara_card_v2',
            originSite: own(post, 'origin'),
        },
    });
}

function reportedNonEmpty(object, key) {
    if (!object || typeof object !== 'object' || !Object.prototype.hasOwnProperty.call(object, key)) {
        return null;
    }
    const value = own(object, key);
    return typeof value === 'string' ? value.trim() !== '' : null;
}

function reportedDepth(post) {
    if (!Object.prototype.hasOwnProperty.call(post, 'depth_prompt')) {
        return null;
    }
    const value = own(post, 'depth_prompt');
    if (!value || typeof value !== 'object') {
        return false;
    }
    const prompt = own(value, 'prompt');
    return typeof prompt === 'string' ? prompt.trim() !== '' : null;
}

/**
 * Lorebook entries are what make an imported card able to inject text later, so
 * the count is the single most useful number in the trust panel.
 */
function countLorebookEntries(lorebook, hasLorebook) {
    if (!lorebook || typeof lorebook !== 'object') {
        return hasLorebook === true ? null : (hasLorebook === false ? 0 : null);
    }
    const entries = own(lorebook, 'entries');
    if (Array.isArray(entries)) {
        return entries.length;
    }
    if (entries && typeof entries === 'object') {
        return Object.keys(entries).length;
    }
    return hasLorebook === true ? null : (hasLorebook === false ? 0 : null);
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
        hideAiToggle: true,
        detail: true,
    }),

    async search(ctx, { query, cursor, limit, sort, sfwOnly, hideAi }) {
        const pageSize = clampInt(limit, 1, 48, 24);
        const start = offsetCursor(cursor);
        const url = new URL('/posts/', BASE);
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(start));
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
        const posts = Array.isArray(rawPosts) ? rawPosts.slice(0, pageSize) : [];
        const rawTotal = own(data, 'total');
        const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? Math.floor(rawTotal) : null;

        const items = posts.map(toSummary).filter((item) => item.id !== '');
        return {
            total,
            next: posts.length > 0 && (total === null ? posts.length >= pageSize : start + posts.length < total)
                ? { o: start + posts.length }
                : null,
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

    /**
     * Rebuilds the upstream image URL from a verified ref. Re-validates the
     * filename even though minting validated it too: this is the last step
     * before an outbound request, and it must not depend on the mint path
     * having been correct.
     * @param {Record<string, unknown>} ref
     * @param {'grid' | 'detail'} size
     */
    thumbUrlFromRef(ref, size) {
        const filename = own(ref, 'f');
        if (typeof filename !== 'string' || !FILENAME_PATTERN.test(filename)) {
            throw new Error('bad_ref');
        }

        const revision = own(ref, 'v');
        const safeRevision = typeof revision === 'number' && Number.isFinite(revision) ? Math.floor(revision) : null;

        return buildPreviewUrl(filename, safeRevision, size === 'detail' ? 'detail' : 'grid');
    },

    async probe(ctx) {
        const data = await ctx.fetchJson(new URL('/api/post-count', BASE), { maxBytes: 4096, timeoutMs: 5000 });
        return typeof own(data, 'total') === 'number';
    },
});
