/**
 * Small JanitorAI browser bridge, based on JAR's Playwright flow.
 *
 * Playwright is loaded only when the user asks to use this bridge. The browser
 * is headful and persistent so its cookies and Cloudflare clearance live in a
 * server-side profile; no cookie or bearer is returned to the client.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://janitorai.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ENV = 'SBBS_JANNY_PROFILE_DIR';
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let playwrightImport;

export class JannyBrowserError extends Error {
    constructor(code, status = 503) {
        super(code);
        this.name = 'JannyBrowserError';
        this.code = code;
        this.status = status;
    }
}

/** Accepts only the fixed public JannyAI/JanitorAI character URL forms. */
export function parseJannyUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 512) {
        return null;
    }
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !['jannyai.com', 'janitorai.com'].includes(url.hostname)
        || (url.port !== '' && url.port !== '443')
        || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        return null;
    }
    const match = url.pathname.match(/^\/characters\/([0-9a-f-]{36})(?:_[A-Za-z0-9-]{1,160})?\/?$/i);
    if (!match || !UUID.test(match[1])) {
        return null;
    }
    return {
        id: match[1],
        url: `${ORIGIN}/characters/${match[1]}`,
    };
}

function profileDir() {
    const configured = typeof process.env[PROFILE_ENV] === 'string'
        ? process.env[PROFILE_ENV].trim()
        : '';
    return path.resolve(configured || path.join(PLUGIN_ROOT, '.sillybunny-janny-profile'));
}

async function loadPlaywright() {
    if (!playwrightImport) {
        playwrightImport = import('playwright').catch(() => null);
    }
    const module = await playwrightImport;
    if (!module?.chromium) {
        throw new JannyBrowserError('janny_browser_unavailable', 503);
    }
    return module;
}

async function openPersistentContext(directory) {
    const { chromium } = await loadPlaywright();
    try {
        return await chromium.launchPersistentContext(directory, {
            headless: false,
            viewport: null,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--window-position=80,60',
                '--window-size=1100,820',
            ],
        });
    } catch {
        throw new JannyBrowserError('janny_browser_unavailable', 503);
    }
}

async function pageFor(context) {
    const existing = context.pages().find((page) => page.url().includes('janitorai.com'));
    const page = existing ?? context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout?.(15000);
    return page;
}

async function inPageFetch(page, url, init = {}) {
    return page.evaluate(async ({ target, request }) => {
        function decode(raw) {
            try {
                return decodeURIComponent(raw);
            } catch {
                return raw;
            }
        }

        function tokenFrom(raw) {
            if (!raw) {
                return null;
            }
            let value = decode(raw);
            if (value.startsWith('base64-')) {
                value = value.slice(7);
            }
            if (value.startsWith('eyJ') && value.split('.').length === 3) {
                return value;
            }
            for (const candidate of [value, (() => {
                try {
                    return atob(value.replace(/-/g, '+').replace(/_/g, '/'));
                } catch {
                    return '';
                }
            })()]) {
                if (!candidate) {
                    continue;
                }
                const match = candidate.match(/"access_token":"(eyJ[^"]+)"/);
                if (match) {
                    return match[1];
                }
                try {
                    const parsed = JSON.parse(candidate);
                    const token = parsed?.access_token ?? parsed?.accessToken ?? parsed?.token
                        ?? parsed?.currentSession?.access_token;
                    if (typeof token === 'string' && token.startsWith('eyJ')) {
                        return token;
                    }
                } catch {
                    // Try the next storage value.
                }
            }
            return null;
        }

        let token = null;
        try {
            const parts = {};
            for (const cookie of (document.cookie || '').split('; ')) {
                const separator = cookie.indexOf('=');
                if (separator < 0) {
                    continue;
                }
                const match = cookie.slice(0, separator).match(/^(sb-.*-auth-token)(?:\.(\d+))?$/);
                if (match) {
                    const base = match[1];
                    const index = Number(match[2] ?? 0);
                    (parts[base] ||= {})[index] = cookie.slice(separator + 1);
                }
            }
            for (const base of Object.keys(parts)) {
                const joined = Object.keys(parts[base])
                    .map(Number)
                    .sort((left, right) => left - right)
                    .map((index) => parts[base][index])
                    .join('');
                token = tokenFrom(joined);
                if (token) {
                    break;
                }
            }
        } catch {
            // Local storage is the usual Supabase path.
        }
        if (!token) {
            try {
                for (let index = 0; index < localStorage.length; index += 1) {
                    token = tokenFrom(localStorage.getItem(localStorage.key(index)));
                    if (token) {
                        break;
                    }
                }
            } catch {
                // Let the request answer the actual authentication state.
            }
        }

        const headers = { accept: 'application/json, text/plain, */*', ...(request.headers || {}) };
        if (token) {
            headers.authorization = `Bearer ${token}`;
        }
        const response = await fetch(target, {
            ...request,
            credentials: 'include',
            headers,
        });
        return { status: response.status, body: await response.text() };
    }, { target: url, request: init });
}

async function jsonFromPage(page, url) {
    let result;
    try {
        result = await inPageFetch(page, url);
    } catch {
        throw new JannyBrowserError('janny_browser_request_failed', 502);
    }
    if (result.status === 401 || result.status === 403) {
        throw new JannyBrowserError('janny_login_required', 401);
    }
    if (result.status >= 400) {
        throw new JannyBrowserError('janny_card_unavailable', 502);
    }
    try {
        return JSON.parse(result.body);
    } catch {
        throw new JannyBrowserError('janny_card_unavailable', 502);
    }
}

async function settingsRequest(page, url, init = {}) {
    let result;
    try {
        result = await inPageFetch(page, url, init);
    } catch {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    if (result.status === 401 || result.status === 403) {
        throw new JannyBrowserError('janny_login_required', 401);
    }
    if (result.status >= 400) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    if (result.body.trim() === '') {
        return null;
    }
    try {
        return JSON.parse(result.body);
    } catch {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
}

async function enterCaptureMode(page) {
    const url = `${ORIGIN}/hampter/api-settings`;
    const before = await settingsRequest(page, url);
    const settings = before?.settings && typeof before.settings === 'object' ? before.settings : {};
    const original = {
        selectedProxyConfigId: settings.selected_proxy_config_id ?? null,
        source: settings.source ?? null,
        generationSettings: settings.generation_settings && typeof settings.generation_settings === 'object'
            ? settings.generation_settings
            : null,
    };
    const preset = {
        api_key: `sk-${crypto.randomBytes(36).toString('base64url')}`,
        api_url: `http://127.0.0.1:${crypto.randomInt(8001, 65001)}/v1/chat/completions`,
        model: 'gpt-4o',
        name: crypto.randomBytes(9).toString('base64url'),
        prompt_id: null,
        client_id: crypto.randomUUID(),
    };
    let serverId = null;
    try {
        await settingsRequest(page, `${url}/proxy-configs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(preset),
        });
        const after = await settingsRequest(page, url);
        const created = (Array.isArray(after?.proxy_configs) ? after.proxy_configs : [])
            .find((candidate) => candidate?.client_id === preset.client_id);
        if (created?.id === undefined || created?.id === null) {
            throw new JannyBrowserError('janny_private_capture_failed', 502);
        }
        serverId = String(created.id);
        await settingsRequest(page, url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ selected_proxy_config_id: serverId }),
        });
        // These are best-effort because older JanitorAI accounts may reject one
        // field while still accepting the selected proxy preset.
        await settingsRequest(page, url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'proxy' }),
        }).catch(() => {});
        await settingsRequest(page, url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                generation_settings: { ...(original.generationSettings ?? {}), context_length: 0 },
            }),
        }).catch(() => {});
        return { ...original, serverId };
    } catch (error) {
        if (serverId !== null) {
            await inPageFetch(page, `${url}/proxy-configs/${encodeURIComponent(serverId)}`, {
                method: 'DELETE',
            }).catch(() => {});
        }
        throw error;
    }
}

async function restoreCaptureMode(page, snapshot) {
    if (!snapshot) {
        return;
    }
    const url = `${ORIGIN}/hampter/api-settings`;
    const patch = { selected_proxy_config_id: snapshot.selectedProxyConfigId };
    if (snapshot.source !== null) {
        patch.source = snapshot.source;
    }
    if (snapshot.generationSettings !== null) {
        patch.generation_settings = snapshot.generationSettings;
    }
    await inPageFetch(page, url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    }).catch(() => {});
    await inPageFetch(page, `${url}/proxy-configs/${encodeURIComponent(snapshot.serverId)}`, {
        method: 'DELETE',
    }).catch(() => {});
}

function characterOf(payload) {
    return payload?.character && typeof payload.character === 'object' ? payload.character : payload;
}

function text(value, max = 32768) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function greetingsOf(meta) {
    const values = [];
    const add = (value) => {
        const item = text(value).trim();
        if (item !== '' && !values.includes(item)) {
            values.push(item);
        }
    };
    if (Array.isArray(meta?.first_messages)) {
        meta.first_messages.forEach(add);
    }
    add(meta?.first_message);
    if (Array.isArray(meta?.alternate_greetings)) {
        meta.alternate_greetings.forEach(add);
    }
    return values;
}

function buildPublicCard(meta) {
    const greetings = greetingsOf(meta);
    const personality = text(meta?.personality).trim();
    const scenario = text(meta?.scenario).trim();
    if (!meta?.showdefinition || (personality === '' && scenario === '')) {
        throw new JannyBrowserError('janny_private_card_unsupported', 422);
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: text(meta?.name, 200) || 'Unnamed',
            description: personality,
            personality: '',
            scenario,
            first_mes: greetings[0] ?? '',
            mes_example: text(meta?.example_dialogs),
            creator_notes: text(meta?.description),
            system_prompt: text(meta?.system_prompt),
            post_history_instructions: text(meta?.post_history_instructions),
            alternate_greetings: greetings.slice(1),
            tags: Array.isArray(meta?.custom_tags)
                ? meta.custom_tags.filter((tag) => typeof tag === 'string').slice(0, 32)
                : [],
            creator: text(meta?.creator_name ?? meta?.creator ?? meta?.user?.username, 200),
            character_version: '',
            extensions: {},
        },
    };
}

function systemContent(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const message = messages.find((candidate) => candidate?.role === 'system') ?? messages[0];
    if (typeof message?.content === 'string') {
        return message.content;
    }
    if (Array.isArray(message?.content)) {
        return message.content
            .map((part) => typeof part === 'string' ? part : part?.text)
            .filter((part) => typeof part === 'string')
            .join('');
    }
    return '';
}

function cardTextFromCapture(payload) {
    const content = systemContent(payload);
    const pattern = /<([^<>\n]*?)Persona>([\s\S]*?)<\/[^<>\n]*?Persona>/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        if (/^user(?:\s*persona)?$/i.test(match[1].trim())) {
            continue;
        }
        return {
            name: match[1].replace(/['’]s\s*$/i, '').trim(),
            text: match[2].trim(),
        };
    }
    return null;
}

function taggedText(payload, tag) {
    const match = systemContent(payload).match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : '';
}

function assistantText(payload) {
    const message = (Array.isArray(payload?.messages) ? payload.messages : [])
        .find((candidate) => candidate?.role === 'assistant' && typeof candidate.content === 'string');
    return message?.content?.trim() ?? '';
}

export function buildPrivateCard(payload, meta) {
    const captured = cardTextFromCapture(payload);
    if (!captured?.text) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    const greetings = greetingsOf(meta);
    const firstMessage = greetings[0] ?? assistantText(payload);
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: text(meta?.name, 200) || captured.name || 'Unnamed',
            description: captured.text,
            personality: '',
            scenario: text(meta?.scenario) || taggedText(payload, 'Scenario'),
            first_mes: firstMessage,
            mes_example: text(meta?.example_dialogs) || taggedText(payload, 'Example'),
            creator_notes: text(meta?.description),
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: greetings.slice(1),
            tags: Array.isArray(meta?.custom_tags)
                ? meta.custom_tags.filter((tag) => typeof tag === 'string').slice(0, 32)
                : [],
            creator: text(meta?.creator_name ?? meta?.creator ?? meta?.user?.username, 200),
            character_version: '',
            extensions: {},
        },
    };
}

async function capturedResponseBody(response) {
    try {
        return await response.json();
    } catch {
        const raw = await response.text().catch(() => '');
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}

async function sendMessage(page, message) {
    const inputs = ['textarea[placeholder]', 'form textarea', 'textarea', 'div[contenteditable="true"]'];
    const deadline = Date.now() + 15000;
    let input = null;
    while (Date.now() < deadline && !input) {
        for (const selector of inputs) {
            const candidate = page.locator(selector).last();
            if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
                input = candidate;
                break;
            }
        }
        if (!input) {
            await page.waitForTimeout(300);
        }
    }
    if (!input) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }

    await input.click();
    if (await input.getAttribute('contenteditable') === 'true') {
        await input.evaluate((element) => { element.textContent = ''; });
        await page.keyboard.insertText(message);
    } else {
        await input.fill(message);
    }

    const buttons = [
        'button[aria-label*="send" i]',
        'button[class*="sendButton" i]',
        'button[type="submit"]',
    ];
    for (const selector of buttons) {
        const button = page.locator(selector).last();
        if (await button.count() > 0 && await button.isVisible().catch(() => false)
            && await button.isEnabled().catch(() => false)) {
            await button.click();
            return;
        }
    }
    await input.press('Enter');
}

async function createChat(page, id) {
    const result = await inPageFetch(page, `${ORIGIN}/hampter/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ character_id: id }),
    });
    if (result.status === 401 || result.status === 403) {
        throw new JannyBrowserError('janny_login_required', 401);
    }
    if (result.status >= 400) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    try {
        const data = JSON.parse(result.body);
        return data?.id === null || data?.id === undefined ? null : String(data.id);
    } catch {
        return null;
    }
}

async function capturePrivateCard(page, id, meta) {
    let snapshot = null;
    let chatId = null;
    try {
        snapshot = await enterCaptureMode(page);
        chatId = await createChat(page, id);
        if (!chatId) {
            throw new JannyBrowserError('janny_private_capture_failed', 502);
        }
        await page.goto(`${ORIGIN}/chats/${encodeURIComponent(chatId)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        const responsePromise = page.waitForResponse((response) => response.url().includes('/generateAlpha')
            && response.request().method() === 'POST', { timeout: 120000 });
        await sendMessage(page, '.');
        const response = await responsePromise;
        const payload = await capturedResponseBody(response);
        return buildPrivateCard(payload, meta);
    } catch (error) {
        if (error instanceof JannyBrowserError) {
            throw error;
        }
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    } finally {
        if (chatId !== null) {
            await inPageFetch(page, `${ORIGIN}/hampter/chats/${encodeURIComponent(chatId)}`, {
                method: 'DELETE',
            }).catch(() => {});
        }
        await restoreCaptureMode(page, snapshot);
    }
}

/**
 * @param {{ profileDir?: string }} [options]
 */
export function createJannyBrowser({ profileDir: configuredProfileDir } = {}) {
    const directory = path.resolve(configuredProfileDir || profileDir());
    let context = null;
    let starting = null;
    // ponytail: one persistent page is shared by the browser bridge; serialize
    // navigation and capture until a multi-page pool is actually needed.
    let operationTail = Promise.resolve();

    function exclusive(operation) {
        const run = operationTail.then(operation, operation);
        operationTail = run.catch(() => {});
        return run;
    }

    async function ensureContext() {
        if (context) {
            return context;
        }
        if (starting) {
            return starting;
        }
        starting = openPersistentContext(directory)
            .then((opened) => {
                context = opened;
                starting = null;
                opened.on?.('close', () => {
                    if (context === opened) {
                        context = null;
                    }
                });
                return opened;
            })
            .catch((error) => {
                starting = null;
                throw error;
            });
        return starting;
    }

    async function status() {
        if (!context) {
            return { ready: false, loggedIn: false };
        }
        try {
            const page = await pageFor(context);
            if (!page.url().includes('janitorai.com')) {
                await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            }
            const payload = await jsonFromPage(page, `${ORIGIN}/hampter/profiles/mine`);
            return { ready: true, loggedIn: payload !== null };
        } catch (error) {
            if (error instanceof JannyBrowserError && error.code === 'janny_login_required') {
                return { ready: true, loggedIn: false };
            }
            return { ready: true, loggedIn: false, code: 'janny_browser_request_failed' };
        }
    }

    return Object.freeze({
        async status() {
            return exclusive(status);
        },

        async login() {
            return exclusive(async () => {
                const opened = await ensureContext();
                const page = await pageFor(opened);
                await page.goto(`${ORIGIN}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                return status();
            });
        },

        async logout() {
            return exclusive(async () => {
                if (!context) {
                    return { ready: false, loggedIn: false };
                }
                try {
                    const page = await pageFor(context);
                    if (!page.url().includes('janitorai.com')) {
                        await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    }
                    await page.evaluate(() => {
                        try { localStorage.clear(); } catch {}
                        try { sessionStorage.clear(); } catch {}
                    }).catch(() => {});
                    await context.clearCookies();
                } catch {
                    // Logout is best-effort; the visible status will report the
                    // session on the next check.
                }
                return { ready: true, loggedIn: false };
            });
        },

        async fetchCard(rawUrl) {
            return exclusive(async () => {
                const parsed = parseJannyUrl(rawUrl);
                if (!parsed) {
                    throw new JannyBrowserError('bad_import_url', 400);
                }
                const opened = await ensureContext();
                const page = await pageFor(opened);
                await page.goto(parsed.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                const payload = await jsonFromPage(page, `${ORIGIN}/hampter/characters/${encodeURIComponent(parsed.id)}`);
                const meta = characterOf(payload);
                return {
                    id: parsed.id,
                    card: meta?.showdefinition && (text(meta?.personality).trim() !== '' || text(meta?.scenario).trim() !== '')
                        ? buildPublicCard(meta)
                        : await capturePrivateCard(page, parsed.id, meta),
                };
            });
        },

        async close() {
            return exclusive(async () => {
                const opened = context;
                context = null;
                starting = null;
                await opened?.close().catch(() => {});
            });
        },
    });
}
