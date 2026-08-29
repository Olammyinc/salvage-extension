/**
 * URL normalization and domain extraction.
 *
 * Used for exact-duplicate detection and domain-keyword categorization. This
 * is pure logic with no chrome dependencies so it can run under node.
 *
 * Normalization choices are deliberately conservative and deterministic:
 * lowercase scheme+host, strip the default port, strip fragment, strip a
 * trailing slash on the empty path, and decode percent-encoded octets so that
 * "https://a.com/x%20y" and "https://a.com/x y" compare equal. Query strings
 * are intentionally PRESERVED: two URLs differing only in query are not exact
 * duplicates in this milestone (near-duplicate detection is out of scope).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BRNormalize = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ftp:': '21' };

  /**
   * Normalize a URL string to a deterministic canonical form suitable for
   * exact-duplicate comparison. Returns null for obviously invalid input.
   */
  function normalizeUrl(rawUrl) {
    if (typeof rawUrl !== 'string') { return null; }
    var trimmed = rawUrl.trim();
    if (!trimmed) { return null; }

    var url;
    try {
      url = new URL(trimmed);
    } catch (e) {
      return null;
    }

    // Only http/https are meaningful bookmark targets for this metric.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    var host = url.hostname.toLowerCase();
    var port = url.port;
    if (port && DEFAULT_PORTS[url.protocol] === port) {
      port = '';
    }

    var path = url.pathname;
    // Strip a single trailing slash when the path collapses to root.
    if (path.length > 1 && path.charAt(path.length - 1) === '/') {
      path = path.slice(0, -1);
    }

    var parts = [];
    parts.push(url.protocol);
    parts.push('//');
    parts.push(host);
    if (port) { parts.push(':' + port); }
    parts.push(path);
    if (url.search) { parts.push(url.search); }
    // Fragment is dropped: it has no bearing on what a page is.

    return parts.join('');
  }

  /**
   * Extract the registrable hostname (lowercased, no leading "www.", no
   * port). Used for domain-rule matching.
   */
  function extractDomain(rawUrl) {
    if (typeof rawUrl !== 'string') { return null; }
    var trimmed = rawUrl.trim();
    if (!trimmed) { return null; }
    var url;
    try {
      url = new URL(trimmed);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    var host = url.hostname.toLowerCase();
    if (host.indexOf('www.') === 0) {
      host = host.slice(4);
    }
    return host || null;
  }

  /**
   * Whether a persisted URL may be handed to chrome.tabs.create. Only
   * http/https targets are safe to open in a new tab; javascript:, data:,
   * file:, chrome:, about: and any other scheme must never reach the tab API.
   * This is read-only — it never mutates the record's url — and is a guard
   * against malformed or hostile entries from the imported tree.
   */
  function isOpenableUrl(rawUrl) {
    if (typeof rawUrl !== 'string') { return false; }
    var trimmed = rawUrl.trim();
    if (!trimmed) { return false; }
    var url;
    try {
      url = new URL(trimmed);
    } catch (e) {
      return false;
    }
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  return {
    normalizeUrl: normalizeUrl,
    extractDomain: extractDomain,
    isOpenableUrl: isOpenableUrl
  };
});
