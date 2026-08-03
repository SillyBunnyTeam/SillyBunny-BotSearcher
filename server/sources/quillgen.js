/**
 * Quillgen — https://quillgen.app
 *
 * The first source SillyBunny cannot import by URL, so it exercises the byte
 * path: the server downloads /card.png, validates it structurally, and hands
 * the bytes to the browser for the host importer.
 *
 * Everything lives on one host, and the card and avatar URLs are both derived
 * from the character id rather than read from the listing.
 *
 * Quillgen offers an API-key feature for private content. It is deliberately
 * not implemented: a stored credential is a real liability, and browsing public
 * cards does not need one.
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, own } from '../validate.js';
import { mintRef } from '../refs.js';

const BASE = 'https://quillgen.app';
const API = '/v1/public/api/browse/characters';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function avatarUrl(id) {
    return `${BASE}${API}/${id}/avatar`;
}

function cardUrl(id) {
    return `${BASE}${API}/${id}/card.png`;
}

function tagsOf(card) {
    const tags = own(card, 'tags');
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
}

/** Quillgen rates its own content, which is more reliable than guessing from tags. */
function isNsfw(card) {
    if (own(card, 'possibleNsfw') === true) {
        return true;
    }
    const rating = own(card, 'contentRating');
    return typeof rating === 'string' && rating.toLowerCase() !== 'general';
}

function toRecord(card, build) {
    const id = own(card, 'id');
    if (typeof id !== 'string' || !UUID.test(id)) {
        return null;
    }

    const description = own(card, 'description') ?? own(card, 'desc_preview');

    return build({
        source: 'quillgen',
        id,
        name: own(card, 'name'),
        tagline: own(card, 'desc_preview'),
        creator: own(card, 'creator'),
        tags: tagsOf(card),
        nsfw: isNsfw(card),
        stats: { views: undefined, downloads: undefined, favorites: undefined, tokens: undefined },
        createdAt: null,
        thumbUrl: avatarUrl(id),
        thumbRef: mintRef('quillgen', { i: id }),
        pageUrl: `${BASE}/characters/${id}`,
        // No native import: SillyBunny does not know this host, so the bytes
        // come through /card. importUrl stays null so nothing tries the URL path.
        importUrl: null,
        nativeImport: false,
        description,
        firstMessage: '',
        creatorNotes: '',
        inside: {
            // The listing exposes no card internals. The real answer comes from
            // the downloaded bytes at import time, which is the honest source.
            lorebookEntries: null,
            alternateGreetings: 0,
            hasSystemPrompt: false,
            hasPostHistoryInstructions: false,
            hasDepthPrompt: false,
            embeddedAssets: 0,
            specVersion: null,
            originSite: 'Quillgen',
        },
    });
}

export const quillgen = Object.freeze({
    id: 'quillgen',
    label: 'Quillgen',
    homepage: BASE,
    allowedHosts: Object.freeze(['quillgen.app']),
    idPattern: UUID,
    /**
     * Tier 3, so it is off unless the user asks for it. The adapter works — it
     * is the reference implementation for the byte import path — but Quillgen's
     * public browse API returns a total of 1 card no matter the query. The rest
     * of the catalogue sits behind the API key this project will not store, so
     * shipping it on by default would put a one-result source in the picker and
     * look broken.
     */
    tier: 3,
    nativeImport: false,
    /** Avatars are full-size; measured around 1.2 MB for the card image. */
    maxThumbBytes: 3 * 1024 * 1024,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'offset',
        sorts: Object.freeze(['default']),
        sfwToggle: false,
        detail: true,
    }),

    async search(ctx, { query, offset, limit }) {
        const url = new URL(API, BASE);
        url.searchParams.set('limit', String(clampInt(limit, 1, 48, 24)));
        url.searchParams.set('offset', String(clampInt(offset, 0, 5000, 0)));
        if (typeof query === 'string' && query !== '') {
            url.searchParams.set('search', query.slice(0, 128));
        }

        const data = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });

        const raw = own(data, 'cards');
        const cards = Array.isArray(raw) ? raw.slice(0, 48) : [];
        const rawTotal = own(data, 'total');
        const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? Math.floor(rawTotal) : null;

        const items = cards.map((card) => toRecord(card, buildSummary)).filter((item) => item !== null);
        const start = clampInt(offset, 0, 5000, 0);

        return {
            total,
            hasMore: total === null ? cards.length > 0 : start + cards.length < total,
            items,
        };
    },

    async getDetail(ctx, id) {
        const url = new URL(API, BASE);
        url.searchParams.set('limit', '1');
        url.searchParams.set('id', id);

        const data = await ctx.fetchJson(url, { maxBytes: 2 << 20, timeoutMs: 10000 });
        const cards = own(data, 'cards');
        const card = Array.isArray(cards) && cards.length > 0 ? cards[0] : { id };

        return toRecord(card, buildDetail) ?? buildDetail({ source: 'quillgen', id });
    },

    getImportTarget(_ctx, id) {
        return { kind: 'bytes', url: cardUrl(id), expect: 'png' };
    },

    thumbUrlFromRef(ref, _size) {
        const id = own(ref, 'i');
        if (typeof id !== 'string' || !UUID.test(id)) {
            throw new Error('bad_ref');
        }
        return avatarUrl(id);
    },

    async probe(ctx) {
        const url = new URL(API, BASE);
        url.searchParams.set('limit', '1');
        const data = await ctx.fetchJson(url, { maxBytes: 1 << 20, timeoutMs: 8000 });
        return Array.isArray(own(data, 'cards'));
    },
});
