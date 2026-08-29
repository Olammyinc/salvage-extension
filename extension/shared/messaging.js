/**
 * Runtime- message boundary checks (Milestone 3, defence in depth).
 *
 * Pure, chrome-free helpers used by the background service worker to gate the
 * runtime message boundary before any message is acted on, plus the explicit
 * double-confirmation gate for permanent purge. Keeping these pure means the
 * destructive boundary rules are unit-testable without a chrome runtime.
 *
 * The extension declares no `externally_connectable`, so the only legitimate
 * senders are the extension's own pages/popup, which always carry
 * `sender.id === chrome.runtime.id`. Any message lacking that is untrusted and
 * must be ignored rather than processed.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BRMessaging = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /**
   * Pure: is a message sender a trusted extension origin?
   *
   * Accepts the `sender` payload Chrome provides to onMessage listeners. When
   * Chrome supplies a sender id (every extension-origin message does), it must
   * match the extension's own runtime id. A missing/empty sender id is treated
   * as untrusted (defence in depth): the service worker must not act on
   * messages it cannot attribute to itself.
   *
   * @param {object|null} sender chrome.runtime.onMessage sender
   * @param {string} runtimeId chrome.runtime.id
   * @returns {boolean}
   */
  function isTrustedSender(sender, runtimeId) {
    if (!sender || !sender.id) { return false; }
    if (!runtimeId || typeof runtimeId !== 'string') { return false; }
    return String(sender.id) === String(runtimeId);
  }

  /**
   * Pure: is a trash-purge message carrying the explicit double-confirmation
   * sentinel the destructive path requires? The worker refuses to call
   * chrome.bookmarks.remove unless the popup has separately confirmed and
   * re-sent `confirmed: 'confirmed'`.
   *
   * @param {object|null} message the runtime message payload
   * @returns {boolean}
   */
  function isConfirmedPurge(message) {
    return !!(message && message.confirmed === 'confirmed');
  }

  // ---- Exported for the service worker and the test suite -------------------
  return {
    isTrustedSender: isTrustedSender,
    isConfirmedPurge: isConfirmedPurge
  };
});
