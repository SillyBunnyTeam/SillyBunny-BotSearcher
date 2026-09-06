import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { jannyBrowserControl } from '../client/settings.js';
import { accountErrorMessage } from '../client/copy.js';

test('Janny recovery stays visible until restored, and successful logout reports signed out', async (t) => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const previous = Object.fromEntries(['document', 'fetch', 'SillyTavern'].map((key) => [key, globalThis[key]]));
    const calls = [];
    let result = { ready: true, loggedIn: true, restorePending: true };
    let statusCode = 200;
    Object.assign(globalThis, {
        document: dom.window.document,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }) },
        fetch: async (url) => {
            calls.push(String(url).split('/').at(-1));
            return new Response(JSON.stringify(result), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
        },
    });
    t.after(() => {
        Object.assign(globalThis, previous);
        dom.window.close();
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const control = jannyBrowserControl();
    document.body.append(control);
    const status = control.querySelector('[role="status"]');
    const recovery = control.lastElementChild;
    const [login, refresh, logout] = control.querySelectorAll('button');
    const restoreMessage = accountErrorMessage({ code: 'janny_restore_failed' }, 'JannyAI');
    await tick();
    assert.equal(status.textContent, restoreMessage, 'logged-in must not hide pending recovery without a code');
    assert.equal(recovery.hidden, false);
    assert.match(recovery.textContent, /Refresh status retries.*same JanitorAI account.*only in server memory.*Do not restart.*manually restore/);
    assert.equal(refresh.disabled, false);
    assert.equal(logout.disabled, false);

    result = { ready: false, loggedIn: false, code: 'janny_restore_failed' };
    refresh.click();
    await tick();
    assert.equal(status.textContent, restoreMessage, 'closed window must not hide recovery');
    assert.equal(login.disabled, false);
    assert.equal(recovery.hidden, false, 'the restoration error alone must expose recovery instructions');

    result = { ready: true, loggedIn: true, restorePending: false };
    login.click();
    await tick();
    assert.match(status.textContent, /session is ready/);
    assert.equal(recovery.hidden, true);

    for (const code of ['janny_restore_failed', 'janny_browser_request_failed']) {
        statusCode = 502;
        result = { error: code };
        logout.click();
        await tick();
        assert.equal(status.textContent, accountErrorMessage({ code }, 'JannyAI'));
        assert.equal(logout.disabled, false, 'failed logout must retain the session');
        assert.equal(recovery.hidden, false, 'a later request failure must not discard pending recovery');
    }

    statusCode = 200;
    result = { ready: true, loggedIn: true, restorePending: false, code: 'janny_browser_request_failed' };
    refresh.click();
    await tick();
    assert.equal(status.textContent, accountErrorMessage({ code: result.code }, 'JannyAI'));
    assert.equal(recovery.hidden, true);

    result = { ready: false, loggedIn: false, restorePending: false };
    logout.click();
    await tick();
    assert.match(status.textContent, /Not logged in/);
    assert.doesNotMatch(status.textContent, /window.*not open/);
    assert.equal(logout.disabled, true);
    assert.equal(recovery.hidden, true);
    assert.deepEqual(calls, ['status', 'status', 'login', 'logout', 'logout', 'status', 'logout']);
});
