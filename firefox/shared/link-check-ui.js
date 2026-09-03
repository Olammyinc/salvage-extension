/**
 * Dead-link checking — UI state resolution.
 *
 * Dead-link section, pure and deterministic.
 *
 * The popup's link-check section must render exactly ONE state at a time —
 * idle (not checked), running (check in progress with a truthful
 * `processedCount of totalCount`), or completed (three-state result summary).
 * Previously the running state was derived only from a transient in-session
 * flag and the persisted link lifecycle (`linkCheckpoint`) was never read by
 * the popup, so a freshly-started check could show BOTH "not checked yet" and
 * "checking links" at once, with no progress or results visible.
 *
 * This module resolves the view state from the persisted snapshot (the same
 * data `chrome.storage.local` yields to the popup), so the decision is
 * reproducible and unit-testable without a DOM. It performs no network
 * traffic and calls no chrome.* API; it only classifies already-persisted
 * data.
 *
 * The `active` hint is the ONLY non-persisted input: the popup sets it for
 * the synchronous gap between the user clicking "Check links" and the link
 * controller's first durable `linkCheckpoint` write (phase SCANNING). Once
 * that write lands, storage drives the running state even across a popup
 * reopen.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants'));
  } else {
    root.BRLinkUI = factory(root.BRConstants);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (constants) {
  'use strict';

  /**
   * Resolve the mutually-exclusive view state for the link-check section.
   *
   * @param {object} input snapshot fields relevant to the link check:
   *   - `report`          the persisted scan report (or null)
   *   - `linkReport`      the persisted link result summary (or null)
   *   - `linkCheckpoint`  the persisted link lifecycle checkpoint (or null)
   *   - `active`          transient in-session hint that a check was just
   *                       initiated (true only while the very first durable
   *                       checkpoint write has not yet landed)
   * @returns {{
   *   state: 'idle'|'running'|'completed',
   *   progress: { processed:number, total:number }|null,
   *   haveLibrary: boolean,
   *   canCheck: boolean
   * }} One and only one state is ever set; `progress` is present only while
   * running and reads the truthful persisted counts off the checkpoint.
   */
  function linkCheckViewState(input) {
    input = input || {};
    var report = input.report || null;
    var linkReport = input.linkReport || null;
    var cp = input.linkCheckpoint || null;
    var active = !!input.active;

    var haveLibrary = !!(report && typeof report[constants.METRIC.TOTAL] === 'number');

    // A check is "running" when the persisted checkpoint says so, or during
    // the brief in-session gap before that first durable write (the `active`
    // hint). Running is mutually exclusive with both idle and completed.
    var running = active || (cp && cp.phase === constants.PHASE.SCANNING);

    var state;
    if (running) {
      state = 'running';
    } else if (linkReport && typeof linkReport.checked === 'number') {
      state = 'completed';
    } else {
      state = 'idle';
    }

    // Truthful progress: only surfaced from the persisted checkpoint while a
    // check is actually running. Never fabricated from a transient flag.
    var progress = null;
    if (cp && cp.phase === constants.PHASE.SCANNING &&
        typeof cp.processedCount === 'number' && typeof cp.totalCount === 'number') {
      progress = { processed: cp.processedCount, total: cp.totalCount };
    }

    return {
      state: state,
      progress: progress,
      haveLibrary: haveLibrary,
      canCheck: state !== 'running' && haveLibrary
    };
  }

  return {
    linkCheckViewState: linkCheckViewState
  };
});
