import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_INGEST_BYTES } from '../shared/schema.js';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function streamResponse(chunks, { headers = {}, onCancel, close = true } = {}) {
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            if (close) {
                controller.close();
            }
        },
        cancel() {
            onCancel?.();
        },
    }), { status: 200, headers });
}

function installClient(fetchImpl) {
    const previousFetch = globalThis.fetch;
    const previousSillyTavern = globalThis.SillyTavern;
    const previousWindow = globalThis.window;
    globalThis.fetch = fetchImpl;
    globalThis.window = { location: { origin: 'https://local.test' } };
    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }) }),
    };
    return () => {
        globalThis.fetch = previousFetch;
        globalThis.SillyTavern = previousSillyTavern;
        globalThis.window = previousWindow;
    };
}

const SOURCE = Object.freeze({ id: 'chub', directHosts: ['gateway.chub.ai'] });
const DIRECT_URL = 'https://gateway.chub.ai/api/characters?search=elf';

test('server-plugin capability probing treats old hosts and non-admin users as fallbacks', async () => {
    const responses = [
        jsonResponse({ error: 'Forbidden' }, 403),
        jsonResponse({ error: 'Not found' }, 404),
        jsonResponse({
            apiVersion: 1,
            exactGitRelease: true,
            existingPluginsOnly: true,
            installsDependencies: true,
            dependencyPolicy: 'npm-ci-production-ignore-scripts',
            safeRestart: false,
            serverPluginsEnabled: true,
            available: false,
        }),
        jsonResponse({
            apiVersion: 1,
            exactGitRelease: true,
            existingPluginsOnly: true,
            installsDependencies: true,
            safeRestart: true,
            serverPluginsEnabled: true,
            available: true,
        }),
        jsonResponse({
            apiVersion: 1,
            exactGitRelease: true,
            existingPluginsOnly: true,
            installsDependencies: true,
            dependencyPolicy: 'npm-ci-production-ignore-scripts',
            safeRestart: true,
            serverPluginsEnabled: true,
            available: true,
        }),
    ];
    const calls = [];
    const restore = installClient(async (url, options) => {
        calls.push({ url: String(url), options });
        return responses.shift();
    });

    try {
        const { getServerPluginUpdateCapabilities, UPDATE_CAPABILITY } =
            await import('../client/api.js?update-capabilities');
        assert.equal((await getServerPluginUpdateCapabilities()).status, UPDATE_CAPABILITY.FORBIDDEN);
        assert.equal((await getServerPluginUpdateCapabilities()).status, UPDATE_CAPABILITY.LEGACY);
        assert.equal((await getServerPluginUpdateCapabilities()).status, UPDATE_CAPABILITY.UNSUPPORTED);
        assert.equal((await getServerPluginUpdateCapabilities()).status, UPDATE_CAPABILITY.UNSUPPORTED);
        assert.equal((await getServerPluginUpdateCapabilities()).status, UPDATE_CAPABILITY.AVAILABLE);
        assert.ok(calls.every((call) => call.url.endsWith('/api/server-admin/server-plugins/capabilities')));
        assert.ok(calls.every((call) => call.options.cache === 'no-store'));
    } finally {
        restore();
    }
});

test('server-plugin release request sends only the fixed directory and frontend version', async () => {
    let call;
    const restore = installClient(async (url, options) => {
        call = { url: String(url), options };
        return jsonResponse({ ok: true, action: 'unchanged', restarting: false });
    });

    try {
        const { applyServerPluginRelease } = await import('../client/api.js?apply-release');
        await applyServerPluginRelease();

        assert.ok(call.url.endsWith('/api/server-admin/server-plugins/apply-release'));
        assert.equal(call.options.method, 'POST');
        assert.equal(call.options.credentials, 'same-origin');
        assert.equal(call.options.headers['X-CSRF-Token'], 'test');
        assert.equal(call.options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(call.options.body), {
            directoryName: 'SillyBunny-BotSearcher',
            targetVersion: '0.3.0',
        });
    } finally {
        restore();
    }
});

test('server-plugin update waits for a new boot and verifies the active release', async () => {
    const calls = [];
    const restore = installClient(async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/apply-release')) {
            return jsonResponse({
                ok: true,
                action: 'restart',
                restarting: true,
                serverBootId: 'old-boot',
            }, 202);
        }
        if (String(url).endsWith('/version')) {
            const versionCalls = calls.filter((entry) => entry.url.endsWith('/version')).length;
            return jsonResponse({ serverBootId: versionCalls === 1 ? 'old-boot' : 'new-boot' });
        }
        if (String(url).endsWith('/healthz')) {
            return jsonResponse({ protocol: 4, version: '0.3.0', sources: [] });
        }
        throw new Error(`unexpected request: ${url}`);
    });

    try {
        const { updateServerPlugin } = await import('../client/api.js?complete-update');
        const phases = [];
        const result = await updateServerPlugin({
            onPhase: (phase) => phases.push(phase),
            restartTimeoutMs: 100,
            verifyTimeoutMs: 100,
            intervalMs: 1,
        });

        assert.equal(result.availability.health.version, '0.3.0');
        assert.deepEqual(phases, ['staging', 'restarting', 'verifying', 'complete']);
        const versionRequests = calls.filter((entry) => entry.url.endsWith('/version'));
        assert.equal(versionRequests.length, 2);
        assert.ok(versionRequests.every((entry) => entry.options.cache === 'no-store'));
    } finally {
        restore();
    }
});

test('restart polling bounds each version request by the overall deadline', async () => {
    let requestSignal;
    const restore = installClient(async (url, options) => {
        assert.ok(String(url).endsWith('/version'));
        requestSignal = options.signal;
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        });
    });

    try {
        const { waitForServerRestart } = await import('../client/api.js?restart-request-timeout');
        await assert.rejects(
            () => waitForServerRestart('old-boot', { timeoutMs: 20, intervalMs: 1 }),
            (error) => error.code === 'restart_timeout',
        );
        assert.equal(requestSignal.aborted, true);
    } finally {
        restore();
    }
});

test('restart polling refuses a missing previous boot marker', async () => {
    let called = false;
    const restore = installClient(async () => {
        called = true;
        return jsonResponse({ serverBootId: 'new-boot' });
    });

    try {
        const { waitForServerRestart } = await import('../client/api.js?restart-marker-required');
        await assert.rejects(
            () => waitForServerRestart('', { timeoutMs: 20, intervalMs: 1 }),
            (error) => error.code === 'restart_marker_missing',
        );
        assert.equal(called, false);
    } finally {
        restore();
    }
});

test('server-plugin staging has an independent finite timeout', async () => {
    let requestSignal;
    const restore = installClient(async (url, options) => {
        assert.ok(String(url).endsWith('/apply-release'));
        requestSignal = options.signal;
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        });
    });

    try {
        const { updateServerPlugin } = await import('../client/api.js?staging-request-timeout');
        await assert.rejects(
            () => updateServerPlugin({ applyTimeoutMs: 20 }),
            (error) => error.code === 'staging_timeout',
        );
        assert.equal(requestSignal.aborted, true);
    } finally {
        restore();
    }
});

test('server-plugin verification bounds a hanging health request by its deadline', async () => {
    let healthSignal;
    const restore = installClient(async (url, options) => {
        if (String(url).endsWith('/apply-release')) {
            return jsonResponse({ ok: true, action: 'unchanged', restarting: false });
        }
        assert.ok(String(url).endsWith('/healthz'));
        healthSignal = options.signal;
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        });
    });

    try {
        const { updateServerPlugin } = await import('../client/api.js?verification-request-timeout');
        await assert.rejects(
            () => updateServerPlugin({ verifyTimeoutMs: 20, intervalMs: 1 }),
            (error) => error.code === 'plugin_verification_failed',
        );
        assert.equal(healthSignal.aborted, true);
    } finally {
        restore();
    }
});

test('server-plugin update preserves structured host error codes', async () => {
    const restore = installClient(async () => jsonResponse({
        error: 'Symlinked plugins cannot be updated automatically.',
        code: 'managed_externally',
    }, 409));

    try {
        const { applyServerPluginRelease } = await import('../client/api.js?update-error');
        await assert.rejects(
            () => applyServerPluginRelease(),
            (error) => error.status === 409
                && error.code === 'managed_externally'
                && /Symlinked/.test(error.message),
        );
    } finally {
        restore();
    }
});

test('browser-direct requests stream a checked response and ingest it only after success', async () => {
    const calls = [];
    const restore = installClient(async (url, options) => {
        calls.push({ url: String(url), options });
        if (calls.length === 1) {
            return jsonResponse({ mode: 'direct', kind: 'search', url: DIRECT_URL, reason: 'forbidden' });
        }
        if (calls.length === 2) {
            return streamResponse([new TextEncoder().encode('{"data":{"nodes":[]}}')]);
        }
        return jsonResponse({ items: [], total: 0 });
    });

    try {
        const { postRouted } = await import('../client/api.js?direct-stream-success');
        const notices = [];
        const result = await postRouted('/search', { query: 'elf', limit: 24 }, SOURCE, {
            allowDirect: true,
            onDirect: (reason) => notices.push(reason),
        });

        assert.deepEqual(result, { items: [], total: 0 });
        assert.equal(calls.length, 3);
        assert.equal(calls[1].url, DIRECT_URL);
        assert.equal(calls[1].options.credentials, 'omit');
        assert.equal(calls[1].options.referrerPolicy, 'no-referrer');
        assert.equal(calls[1].options.redirect, 'error');
        assert.equal(calls[1].options.cache, 'no-store');
        assert.equal(calls[2].url.endsWith('/ingest'), true);
        assert.deepEqual(JSON.parse(calls[2].options.body), {
            query: 'elf',
            limit: 24,
            kind: 'search',
            payload: { data: { nodes: [] } },
        });
        assert.deepEqual(notices, ['forbidden']);
    } finally {
        restore();
    }
});

test('browser-direct requests reject and cancel a chunked oversized response before ingesting it', async () => {
    let cancelled = false;
    let calls = 0;
    const restore = installClient(async () => {
        calls++;
        if (calls === 1) {
            return jsonResponse({ mode: 'direct', kind: 'search', url: DIRECT_URL });
        }
        return streamResponse([new Uint8Array(MAX_INGEST_BYTES + 1)], {
            onCancel: () => { cancelled = true; },
            close: false,
        });
    });

    try {
        const { postRouted } = await import('../client/api.js?direct-stream-too-large');
        await assert.rejects(
            () => postRouted('/search', { query: 'elf' }, SOURCE, { allowDirect: true }),
            (error) => error.code === 'too_large',
        );
        assert.equal(calls, 2, 'the oversized response must never be posted to /ingest');
        assert.equal(cancelled, true, 'the stream must be cancelled when the cap is crossed');
    } finally {
        restore();
    }
});

test('browser-direct requests reject hosts outside the published direct allow-list', async () => {
    let calls = 0;
    const restore = installClient(async () => {
        calls++;
        return jsonResponse({
            mode: 'direct',
            kind: 'search',
            url: 'https://avatars.charhub.io/unsafe-browser-hop',
        });
    });

    try {
        const { postRouted } = await import('../client/api.js?direct-host-check');
        await assert.rejects(
            () => postRouted('/search', { query: 'elf' }, SOURCE, { allowDirect: true }),
            (error) => error.code === 'bad_direct_url',
        );
        assert.equal(calls, 1, 'an invalid direct URL must not be fetched');
    } finally {
        restore();
    }
});

test('bounded response reading coalesces highly fragmented bodies', async () => {
    const restore = installClient(async () => jsonResponse({}));
    try {
        const { readResponseBytes } = await import('../client/api.js?fragmented-response');
        const fragments = Array.from({ length: 4096 }, () => Uint8Array.of(120));
        const bytes = await readResponseBytes(streamResponse(fragments), MAX_INGEST_BYTES);

        assert.equal(bytes.byteLength, fragments.length);
        assert.equal(new TextDecoder().decode(bytes), 'x'.repeat(fragments.length));
    } finally {
        restore();
    }
});
