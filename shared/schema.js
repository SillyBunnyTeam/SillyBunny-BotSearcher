/**
 * Shared contract between the frontend extension and the server plugin.
 *
 * Loaded by BOTH halves: by Node from disk, and by the browser over HTTP from
 * /scripts/extensions/third-party/SillyBunny-BotSearcher/shared/schema.js.
 * It must therefore stay pure ESM with no `node:` imports and no DOM access.
 *
 * The two halves are installed as separate git clones and can drift, so every
 * response carries PROTOCOL_VERSION and the client refuses to talk to a server
 * that reports a different one.
 */

/** Bumped only when the request/response contract changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Release version. `tests/version-sync.test.js` asserts this matches package.json and manifest.json. */
export const VERSION = '0.1.0';

export const PLUGIN_ID = 'sillybunny-botsearcher';

/** Directory name of the frontend extension; also the repo name. */
export const EXTENSION_NAME = 'SillyBunny-BotSearcher';

/**
 * Fields a normalized search result may contain. `server/normalize.js` builds
 * records by picking from this list — it never spreads an upstream object, so
 * unknown upstream fields can never reach the DOM.
 */
export const CARD_SUMMARY_FIELDS = Object.freeze([
    'source',
    'id',
    'name',
    'tagline',
    'creator',
    'tags',
    'nsfw',
    'stats',
    'createdAt',
    // Absolute https thumbnail URL, built by the adapter and host-checked twice
    // (server before it is sent, client before it reaches an <img>). Used in
    // 'direct' image mode.
    'thumbUrl',
    // Opaque HMAC-signed token for the /thumb proxy. Added in Phase 2.
    'thumbRef',
    'pageUrl',
    'importUrl',
    'nativeImport',
]);

/** Detail adds the long-form text fields. Same whitelist discipline. */
export const CARD_DETAIL_FIELDS = Object.freeze([
    ...CARD_SUMMARY_FIELDS,
    'description',
    'firstMessage',
    'creatorNotes',
    'inside',
]);

/** Per-field length caps, applied server-side by `str()` before the client ever sees them. */
export const FIELD_LIMITS = Object.freeze({
    id: 128,
    shortText: 200,
    longText: 8000,
    tagLength: 48,
    tagCount: 32,
    itemsPerPage: 48,
});

/** Request body cap. Anything larger is rejected with 413 before parsing. */
export const MAX_REQUEST_BYTES = 8192;

export const IMAGE_MODES = Object.freeze(['proxy', 'direct', 'off']);

export const THUMB_SIZES = Object.freeze(['grid', 'detail']);

/** Source health states surfaced by /healthz. */
export const SOURCE_STATES = Object.freeze(['up', 'unknown', 'down']);
