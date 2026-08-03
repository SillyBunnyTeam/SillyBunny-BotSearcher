/**
 * The only three functions in this extension allowed to put dynamic data into the DOM.
 *
 * Invariant I4. Everything a card site returns is written by a stranger, and
 * SillyBunny runs with `helmet({ contentSecurityPolicy: false })`
 * (src/server-main.js:109), so there is no CSP backstop — these checks are the
 * only defence. There is no innerHTML, insertAdjacentHTML or $().html() anywhere
 * under client/; `tests/render-safety.test.js` enforces that.
 */

import { PLUGIN_BASE } from './constants.js';

/**
 * Writes untrusted text. Cannot create elements, however hostile the input.
 * @param {Element | null | undefined} element
 * @param {unknown} value
 */
export function setText(element, value) {
    if (!element) {
        return;
    }
    element.textContent = value === null || value === undefined ? '' : String(value);
}

/**
 * True only for a same-origin plugin path, or an https URL whose hostname is an
 * EXACT member of allowedHosts.
 *
 * Exact match matters: a suffix test like `host.endsWith('botbooru.com')` also
 * accepts `evil-botbooru.com`, and a `includes()` test also accepts
 * `botbooru.com.evil.tld`. Neither is acceptable.
 *
 * @param {unknown} raw
 * @param {readonly string[]} allowedHosts
 * @returns {boolean}
 */
export function isAllowedImageUrl(raw, allowedHosts) {
    if (typeof raw !== 'string' || raw === '') {
        return false;
    }

    // Our own proxy endpoint. Anchored to the full base so a scheme-relative
    // "//evil.example" or a bare "/apiX" cannot slip through.
    if (raw.startsWith(`${PLUGIN_BASE}/`)) {
        return true;
    }

    let url;
    try {
        url = new URL(raw, window.location.origin);
    } catch {
        return false;
    }

    // Rejects javascript:, data:, blob:, file: and plain http:.
    if (url.protocol !== 'https:') {
        return false;
    }

    if (!Array.isArray(allowedHosts)) {
        return false;
    }

    return allowedHosts.includes(url.hostname.toLowerCase());
}

/**
 * Points an <img> at a URL, or clears it if the URL fails the check.
 * @param {HTMLImageElement | null | undefined} img
 * @param {unknown} url
 * @param {readonly string[]} allowedHosts
 * @returns {boolean} whether the source was accepted
 */
export function setImgSafe(img, url, allowedHosts) {
    if (!img) {
        return false;
    }

    if (!isAllowedImageUrl(url, allowedHosts)) {
        img.removeAttribute('src');
        return false;
    }

    // Set before src so they apply to the request itself.
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = String(url);
    return true;
}

/**
 * Points an <a> at a URL, or disables it if the URL fails the check.
 * @param {HTMLAnchorElement | null | undefined} anchor
 * @param {unknown} url
 * @param {readonly string[]} allowedHosts
 * @returns {boolean} whether the link was accepted
 */
export function setLinkSafe(anchor, url, allowedHosts) {
    if (!anchor) {
        return false;
    }

    if (!isAllowedImageUrl(url, allowedHosts)) {
        anchor.removeAttribute('href');
        anchor.setAttribute('aria-disabled', 'true');
        return false;
    }

    anchor.rel = 'noopener noreferrer nofollow';
    anchor.target = '_blank';
    anchor.referrerPolicy = 'no-referrer';
    anchor.removeAttribute('aria-disabled');
    anchor.href = String(url);
    return true;
}

/**
 * Creates an element with an optional class and text. Text goes through
 * textContent, never innerHTML.
 * @param {string} tag
 * @param {string} [className]
 * @param {unknown} [text]
 */
export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        setText(node, text);
    }
    return node;
}
