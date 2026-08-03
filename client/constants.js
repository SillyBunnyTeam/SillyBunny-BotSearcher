/**
 * The only place the frontend learns where to send a request.
 *
 * Invariant I1: no `http://` or `https://` literal may appear anywhere under
 * client/. Every request this extension makes is same-origin, either to our
 * plugin or to SillyBunny's fixed server-administration API.
 * `tests/no-remote-urls.test.js` enforces it.
 */

import { PLUGIN_ID, EXTENSION_NAME } from '../shared/schema.js';

export { PLUGIN_ID, EXTENSION_NAME };

/** Same-origin base for every call. Never concatenated with anything client-supplied. */
export const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;

/** Fixed host capability used to update an existing server plugin release. */
export const SERVER_PLUGIN_ADMIN_BASE = '/api/server-admin/server-plugins';

/** Public host endpoint used to detect completion of a controlled restart. */
export const SERVER_VERSION_PATH = '/version';

/** Path form used by renderExtensionTemplateAsync(). */
export const EXTENSION_PATH = `third-party/${EXTENSION_NAME}`;

/** Key under context.extensionSettings. */
export const SETTINGS_KEY = 'SillyBunnyBotSearcher';

/** DOM ids we own. Unique so the extensions-drawer deduper cannot mistake them for someone else's. */
export const DOM_IDS = Object.freeze({
    importAction: 'sbbs_import_action',
    wandItem: 'sbbs_wand_item',
    settingsRoot: 'sbbs_settings',
});

export const LOG_TAG = 'BotSearcher';
