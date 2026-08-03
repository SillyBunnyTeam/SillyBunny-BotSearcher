/**
 * Wyvern — https://app.wyvern.chat
 *
 * Wyvern publishes complete card data through its public browse API but offers
 * no downloadable card file: there is no /export, /download or /card.png. So
 * this adapter uses the `inline` import mode — it assembles a v2 card from the
 * published fields, and the router runs that through exactly the same
 * validation a downloaded card gets.
 *
 * Two things worth carrying faithfully rather than quietly dropping:
 * lorebooks and regex_scripts. Regex scripts rewrite messages as they pass
 * through, which is the closest a card comes to executable content, so they
 * are imported as the author intended AND counted in the trust panel. Silently
 * discarding them would give the user a card that behaves differently from the
 * one they looked at, which is its own kind of dishonesty.
 *
 * Avatars are on Cloudflare Images, which accepts a flexible variant: `w=320`
 * returns 28 KB where the default `public` variant returns 82 KB.
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, own, hostCheckedUrl, isPlainObject } from '../validate.js';
import { mintRef } from '../refs.js';
import { pageCursor } from '../paging.js';

const API = 'https://app.wyvern.chat';
const IMAGE_HOST = 'imagedelivery.net';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Cloudflare Images path: /<accountHash>/<imageId>/<variant> */
const CF_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

const PREVIEW_WIDTH = Object.freeze({ grid: 320, detail: 640 });

function idOf(character) {
    const id = own(character, 'id') ?? own(character, '_id');
    return typeof id === 'string' && ID.test(id) ? id : null;
}

function tagsOf(character) {
    const out = [];
    for (const key of ['tags', 'community_tags']) {
        const list = own(character, key);
        if (Array.isArray(list)) {
            out.push(...list.filter((tag) => typeof tag === 'string'));
        }
    }
    return [...new Set(out)];
}

function contentRating(character, tags) {
    const rating = own(character, 'rating');
    if (typeof rating === 'string' && ['nsfw', 'explicit', 'adult'].includes(rating.toLowerCase())) {
        return 'sensitive';
    }
    if (typeof rating === 'string' && ['sfw', 'safe', 'general'].includes(rating.toLowerCase())) {
        return 'sfw';
    }
    const lowered = tags.map((tag) => tag.toLowerCase());
    return ['nsfw', 'nsfl', 'gore', 'explicit', 'smut'].some((flag) => lowered.includes(flag))
        ? 'sensitive'
        : 'unknown';
}

function creatorOf(character) {
    const creator = own(character, 'creator');
    if (typeof creator === 'string') {
        return creator;
    }
    return own(creator, 'username') ?? own(creator, 'displayName') ?? own(creator, 'name') ?? '';
}

/**
 * Splits a Cloudflare Images URL into the two path segments we need, after
 * checking the host. Anything unexpected yields null rather than a guess.
 */
function imageRefOf(character) {
    const url = hostCheckedUrl(own(character, 'avatar'), [IMAGE_HOST]);
    if (url === null) {
        return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !CF_SEGMENT.test(parts[0]) || !CF_SEGMENT.test(parts[1])) {
        return null;
    }
    return { c: parts[0], i: parts[1] };
}

function imageUrl(ref, size) {
    return `https://${IMAGE_HOST}/${ref.c}/${ref.i}/w=${PREVIEW_WIDTH[size] ?? PREVIEW_WIDTH.grid}`;
}

function countEntries(lorebooks) {
    if (!Array.isArray(lorebooks)) {
        return null;
    }
    let total = 0;
    for (const book of lorebooks) {
        const entries = own(book, 'entries');
        if (Array.isArray(entries)) {
            total += entries.length;
        } else if (isPlainObject(entries)) {
            total += Object.keys(entries).length;
        }
    }
    return total;
}

function insideOf(character) {
    const greetings = own(character, 'alternate_greetings') ?? own(character, 'greetings');
    const regex = own(character, 'regex_scripts');
    const gallery = own(character, 'gallery');

    return {
        lorebookEntries: countEntries(own(character, 'lorebooks')),
        alternateGreetings: Array.isArray(greetings) ? greetings.length : null,
        hasSystemPrompt: reportedNonEmpty(character, 'pre_history_instructions'),
        hasPostHistoryInstructions: reportedNonEmpty(character, 'post_history_instructions'),
        hasDepthPrompt: reportedNonEmpty(character, 'character_note'),
        regexScripts: Array.isArray(regex) ? regex.length : null,
        embeddedAssets: Array.isArray(gallery) ? gallery.length : null,
        specVersion: 'chara_card_v2',
        originSite: 'Wyvern',
    };
}

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function reportedNonEmpty(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key) ? nonEmpty(own(object, key)) : null;
}

function toRecord(character, build) {
    const id = idOf(character);
    if (id === null) {
        return null;
    }

    const tags = tagsOf(character);
    const image = imageRefOf(character);

    return build({
        source: 'wyvern',
        id,
        name: own(character, 'name'),
        tagline: own(character, 'tagline'),
        creator: creatorOf(character),
        tags,
        contentRating: contentRating(character, tags),
        stats: {
            views: undefined,
            downloads: own(character, 'likes'),
            favorites: own(character, 'likes'),
            tokens: own(character, 'token_count'),
        },
        createdAt: own(character, 'created_at'),
        thumbUrl: image === null ? null : imageUrl(image, 'grid'),
        thumbRef: image === null ? null : mintRef('wyvern', image),
        pageUrl: `${API}/characters/${id}`,
        importUrl: null,
        nativeImport: false,
        description: own(character, 'description'),
        firstMessage: own(character, 'first_mes'),
        creatorNotes: own(character, 'creator_notes'),
        inside: insideOf(character),
    });
}

/** Only strings; anything else becomes an empty field rather than a surprise. */
function text(value) {
    return typeof value === 'string' ? value : '';
}

function stringList(value, cap = 32) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, cap) : [];
}

export const wyvern = Object.freeze({
    id: 'wyvern',
    label: 'Wyvern',
    homepage: API,
    allowedHosts: Object.freeze(['app.wyvern.chat', IMAGE_HOST]),
    idPattern: ID,
    tier: 2,
    nativeImport: false,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'page',
        sorts: Object.freeze(['default']),
        sfwToggle: false,
        detail: true,
    }),

    async search(ctx, { query, cursor, limit }) {
        const pageSize = clampInt(limit, 1, 48, 24);
        const page = pageCursor(cursor);
        const url = new URL('/api/characters/public', API);
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('page', String(page));
        if (typeof query === 'string' && query !== '') {
            url.searchParams.set('search', query.slice(0, 128));
        }

        // Wyvern returns full card bodies, so a page is large.
        const data = await ctx.fetchJson(url, { maxBytes: 12 << 20, timeoutMs: 15000 });

        const raw = own(data, 'characters');
        const characters = Array.isArray(raw) ? raw.slice(0, pageSize) : [];
        const rawTotal = own(data, 'total');
        const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? Math.floor(rawTotal) : null;

        const items = characters.map((character) => toRecord(character, buildSummary)).filter((item) => item !== null);
        return {
            total,
            next: characters.length > 0
                && (total === null ? characters.length >= pageSize : page * pageSize < total)
                ? { p: page + 1 }
                : null,
            items,
        };
    },

    async getDetail(ctx, id) {
        const character = await ctx.fetchJson(new URL(`/api/characters/${encodeURIComponent(id)}`, API), {
            maxBytes: 8 << 20,
            timeoutMs: 15000,
        });
        return toRecord(own(character, 'character') ?? character, buildDetail)
            ?? buildDetail({ source: 'wyvern', id });
    },

    getImportTarget() {
        return { kind: 'inline', expect: 'json' };
    },

    /**
     * Assembles a v2 card. Every field is coerced to the type the spec expects,
     * so a hostile value cannot change the card's SHAPE — only its content,
     * which is the author's prerogative anyway.
     */
    async buildCard(ctx, id) {
        const raw = await ctx.fetchJson(new URL(`/api/characters/${encodeURIComponent(id)}`, API), {
            maxBytes: 8 << 20,
            timeoutMs: 15000,
        });
        const character = own(raw, 'character') ?? raw;

        const name = text(own(character, 'name')) || 'Unnamed';
        const regex = own(character, 'regex_scripts');
        const lorebooks = own(character, 'lorebooks');

        const data = {
            name,
            description: text(own(character, 'description')),
            personality: text(own(character, 'personality')),
            scenario: text(own(character, 'scenario')),
            first_mes: text(own(character, 'first_mes')),
            mes_example: text(own(character, 'mes_example')),
            creator_notes: text(own(character, 'creator_notes')),
            system_prompt: text(own(character, 'pre_history_instructions')),
            post_history_instructions: text(own(character, 'post_history_instructions')),
            alternate_greetings: stringList(own(character, 'alternate_greetings') ?? own(character, 'greetings')),
            tags: stringList(tagsOf(character)),
            creator: text(creatorOf(character)),
            character_version: '',
            extensions: {},
        };

        // Carried through as the author published them, and reported to the
        // user by the trust panel rather than dropped behind their back.
        if (Array.isArray(regex) && regex.length > 0) {
            data.extensions.regex_scripts = regex;
        }

        const entries = Array.isArray(lorebooks)
            ? lorebooks.flatMap((book) => (Array.isArray(own(book, 'entries')) ? own(book, 'entries') : []))
            : [];
        if (entries.length > 0) {
            data.character_book = { name: `${name} lorebook`, entries };
        }

        return { spec: 'chara_card_v2', spec_version: '2.0', data };
    },

    thumbUrlFromRef(ref, size) {
        const account = own(ref, 'c');
        const image = own(ref, 'i');
        if (typeof account !== 'string' || !CF_SEGMENT.test(account)
            || typeof image !== 'string' || !CF_SEGMENT.test(image)) {
            throw new Error('bad_ref');
        }
        return imageUrl({ c: account, i: image }, size === 'detail' ? 'detail' : 'grid');
    },

    async probe(ctx) {
        const url = new URL('/api/characters/public', API);
        url.searchParams.set('limit', '1');
        const data = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });
        return Array.isArray(own(data, 'characters'));
    },
});
