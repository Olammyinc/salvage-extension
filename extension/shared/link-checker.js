/**
 * Dead-link checking — Milestone 2.
 *
 * Detection runs ONLY on explicit user opt-in, and ONLY after the extension
 * holds the optional `<all_urls>` host permission. It is never run during the
 * library scan and never fetches a bookmarked URL automatically.
 *
 * Results are strictly three-state (FR5): `reachable`, `unreachable`,
 * `could_not_check`. Only a confirmed dead response (HTTP 404 or 410) may be
 * reported `unreachable`. 401/403/429/5xx, unresolved redirects, network/CORS
 * failures, challenges, and timeouts are all `could_not_check` — never
 * `unreachable` — because a false positive here would delete something the
 * user cared about.
 *
 * The pure classifier has no chrome/fetch dependency so it is unit-testable.
 * The permission-gated, chunked controller drives the service worker's fetch
 * with injected dependencies, the active-window budget and chrome.alarms (the
 * same MV3-safe pattern the scan controller uses).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalize'), require('./constants'));
  } else {
    root.BRLinks = factory(root.BRNormalize, root.BRConstants);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (normalize, constants) {
  'use strict';

  var UNREACHABLE_STATUS = { 404: true, 410: true };
  var STATUS_REACHABLE = constants.LINK_STATUS_REACHABLE;
  var STATUS_UNREACHABLE = constants.LINK_STATUS_UNREACHABLE;
  var STATUS_COULD_NOT_CHECK = constants.LINK_STATUS_COULD_NOT_CHECK;

  /**
   * Pure classification of a link-check outcome into one of the three states.
   *
   * Only a resolved 2xx is `reachable`; only a confirmed 404/410 is
   * `unreachable`. Every redirect (3xx), 401/403/429/5xx and all non-ok
   * outcome kinds are `could_not_check` — a redirect is a fresh undiscovered
   * target we never auto-follow into.
   *
   * @param {object} outcome one of:
   *   - { kind:'ok', status:number }
   *     a resolved HTTP response; `status` is the FINAL status after normal
   *     redirect following.
   *   - { kind:'cors_error'|'network_error'|'timeout'|'challenge'|'redirect_error' }
   * @returns {string} 'reachable' | 'unreachable' | 'could_not_check'
   */
  function classify(outcome) {
    if (!outcome) { return STATUS_COULD_NOT_CHECK; }
    if (outcome.kind !== 'ok') { return STATUS_COULD_NOT_CHECK; }

    var status = outcome.status;
    if (status >= 200 && status <= 299) { return STATUS_REACHABLE; }
    if (Object.prototype.hasOwnProperty.call(UNREACHABLE_STATUS, status)) { return STATUS_UNREACHABLE; }
    // Redirects (3xx), 401, 403, 429, 5xx, and any other non-2xx are uncertain,
    // never dead. Redirects are never followed into a landing page.
    return STATUS_COULD_NOT_CHECK;
  }

  /**
   * Run one link check against a URL using the injected fetch implementation.
   *
   * Redirects are NEVER followed: the request uses `redirect: 'error'`, so a
   * 3xx either surfaces as a redirect error (thrown by fetch/AbortSignal) or,
   * in an injected fetch that resolves a 3xx response directly, is classified
   * `could_not_check` by the pure classifier. We deliberately do not auto-follow
   * into a landing page — doing so could reach internal networks behind a
   * redirect and would make the reachability verdict depend on where the URL
   * redirects, which the conservative three-state model must not do.
   *
   * A per-request timeout (default from constants) is enforced with an
   * AbortController (no cross-wake scheduling; the timeout only bounds a single
   * request within the active window). Any non-resolution — network error, CORS,
   * timeout, redirect failure — is classified `could_not_check`.
   *
   * @param {Function} fetchImpl (url, opts) => Promise<Response>
   * @param {string} url the URL to check (http/https only)
   * @param {object} opts { timeoutMs }
   * @returns {Promise<{status:string, detail?:string, statusCode?:number, checkedAt:number}>}
   */
  async function checkUrl(fetchImpl, url, opts) {
    opts = opts || {};
    var timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs : constants.LINK_CHECK_TIMEOUT_MS;
    var now = (typeof opts.getNow === 'function' ? opts.getNow() : Date.now());

    if (!normalize.isOpenableUrl(url)) {
      return { status: STATUS_COULD_NOT_CHECK, detail: 'not-web-url', checkedAt: now };
    }

    var controller = new AbortController();
    var timer = null;
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      // Prefer AbortSignal.timeout when available; the controller fallback is
      // used when the injected fetch environment lacks it (e.g. older Node).
      try {
        var res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        return finalize(res, STATUS_REACHABLE, STATUS_UNREACHABLE, STATUS_COULD_NOT_CHECK, now);
      } catch (e) {
        return { status: STATUS_COULD_NOT_CHECK, detail: classifyFailure(e), checkedAt: now };
      }
    }

    return new Promise(function (resolve) {
      timer = setTimeout(function () {
        controller.abort();
      }, timeoutMs);

      fetchImpl(url, { redirect: 'error', signal: controller.signal })
        .then(function (res) {
          resolve(finalize(res, STATUS_REACHABLE, STATUS_UNREACHABLE, STATUS_COULD_NOT_CHECK, now));
        })
        .catch(function (e) {
          resolve({ status: STATUS_COULD_NOT_CHECK, detail: classifyFailure(e), checkedAt: now });
        })
        .then(function () {
          if (timer) { clearTimeout(timer); }
        });
    });
  }

  function finalize(res, reachable, unreachable, couldNotCheck, now) {
    var status = res && typeof res.status === 'number' ? res.status : 0;
    var kind = classify({ kind: 'ok', status: status });
    // Redirects are never followed and never reachable. Even if an injected
    // fetch resolves a 3xx directly (rather than `redirect:'error'` throwing),
    // a redirect is a fresh, undiscovered target: certainly not confirmed dead,
    // but also not something we auto-followed into. Classify `could_not_check`.
    if (status >= 300 && status <= 399) { kind = couldNotCheck; }
    var base = {
      status: kind,
      statusCode: status,
      detail: kind === reachable
        ? reachable
        : kind === unreachable
          ? 'unreachable'
          : couldNotCheck,
      checkedAt: now
    };
    if (kind === reachable) { base.detail = 'reachable'; }
    return base;
  }

  function classifyFailure(e) {
    if (!e) { return 'network_error'; }
    var name = e && e.name || '';
    if (name === 'AbortError' || name === 'TimeoutError') { return 'timeout'; }
    if (name === 'TypeError') { return e && /abort|cancel/i.test(String(e.message || '')) ? 'timeout' : 'network_error'; }
    return 'network_error';
  }

  /**
   * Permission-gated, chunked link-check controller (MV3-safe).
   *
   * Iterates over the persisted records, checking each web-visible, active
   * bookmark URL, storing `linkStatus`/`linkCheckedAt` back on the record, and
   * checkpointing per chunk so the check survives service-worker termination.
   * An explicit host permission is required to start; without it the controller
   * refuses and never issues a single fetch.
   *
   *  deps shape:
   *   {
   *     fetchImpl(url, opts): Promise<Response>,
   *     storageGet(keys): Promise<object>,
   *     storageSet(obj): Promise<void>,
   *     getNow(): number,
   *     scheduleWake(minutes): void,
   *     clearWake(): void,
   *    hasPermission(): Promise<boolean>|boolean,
   *    sendProgress(payload): void (optional),
   *    activeWindowMs?: number,   // budget per worker wake (ms); enforced per-URL
   *    timeoutMs?: number
   *   }
   */
  function createLinkCheckController(deps) {
    var storageGet = deps.storageGet;
    var storageSet = deps.storageSet;
    var fetchImpl = deps.fetchImpl;
    var hasPermission = deps.hasPermission;
    var scheduleWake = deps.scheduleWake;
    var clearWake = deps.clearWake;
    var getNow = deps.getNow || function () { return Date.now(); };
    var sendProgress = deps.sendProgress || function () {};
    var activeWindowMs = (typeof deps.activeWindowMs === 'number' && deps.activeWindowMs > 0)
      ? deps.activeWindowMs : constants.LINK_ACTIVE_WINDOW_MS;
    var timeoutMs = (typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0)
      ? deps.timeoutMs : constants.LINK_CHECK_TIMEOUT_MS;

    // Controller-local single-flight tail (same pattern as scan-controller):
    // pure orchestration, never holds check state.
    var operationTail = Promise.resolve();
    function serialize(fn) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var run = operationTail.then(function () { return fn.apply(null, args); });
        operationTail = run.then(function () {}, function () {});
        return run;
      };
    }

    function readCheckpoint() {
      return storageGet([constants.KEYS.LINK_CHECKPOINT]).then(function (res) {
        return res[constants.KEYS.LINK_CHECKPOINT] || {
          phase: constants.PHASE.IDLE,
          processedCount: 0,
          totalCount: 0,
          lastProcessedId: null,
          // Snapshot of the checkable record ids the current check was started
          // against. If it no longer matches the live records, a new scan (or an
          // external clear) replaced them mid-check, and the checker finalizes.
          targetIds: [],
          updatedAt: 0,
          linkStartedAt: null,
          linkCompletedAt: null,
          durationMs: null
        };
      });
    }

    function writeCheckpoint(cp) {
      var p = {};
      p[constants.KEYS.LINK_CHECKPOINT] = cp;
      p[constants.KEYS.SCHEMA] = constants.SCHEMA_VERSION;
      return storageSet(p);
    }

    // A "checkable" record: active (not soft-deleted) and a web URL that
    // normalize.isOpenableUrl accepts.
    function isCheckable(rec) {
      return !!rec && cleanupDeleted(rec) && normalize.isOpenableUrl(rec.url);
    }
    function cleanupDeleted(rec) {
      return !(typeof rec.deletedAt === 'number' && rec.deletedAt > 0);
    }

    // Deterministic ids of the current checkable set (records are already kept
    // id-sorted by applyResults, so this ordering is stable across reads).
    function currentTargetIds(records) {
      return (records || []).filter(isCheckable).map(function (r) { return r.id; });
    }

    // True when the live records still match the snapshot the check was started
    // against. A mismatch means a normal scan replaced/cleared the records while
    // the link check was mid-flight, so the checker must finalize safely.
    function targetStillValid(targetIds, records) {
      var snapshot = JSON.stringify(targetIds || []);
      return snapshot === JSON.stringify(currentTargetIds(records));
    }

    function ensurePermission() {
      return Promise.resolve(hasPermission()).then(function (granted) {
        if (!granted) {
          var err = new Error('no-host-permission');
          err.code = 'NO_HOST_PERMISSION';
          throw err;
        }
      });
    }

    function startImpl() {
      return ensurePermission().then(function () {
        return readCheckpoint().then(function (cp) {
          // A fresh, explicit start always re-checks the whole active library.
          return storageGet([constants.KEYS.RECORDS]).then(function (res) {
            var records = res[constants.KEYS.RECORDS] || [];
            var target = records.filter(isCheckable);
            var cp0 = {
              phase: constants.PHASE.SCANNING,
              processedCount: 0,
              totalCount: target.length,
              lastProcessedId: null,
              // Persist the exact checkable set; if a later scan replaces the
              // records, the checker will spot the mismatch and finalize.
              targetIds: target.map(function (r) { return r.id; }),
              updatedAt: getNow(),
              // Wall-clock start persists across wakes/termination so the total
              // elapsed link-check duration is exact, not final-wake only.
              linkStartedAt: getNow()
            };
            var set = {};
            set[constants.KEYS.LINK_REPORT] = null;   // stale results dropped
            set[constants.KEYS.LINK_CHECKPOINT] = cp0;
            set[constants.KEYS.SCHEMA] = constants.SCHEMA_VERSION;
            return storageSet(set).then(function () {
              return processActiveWindowImpl();
            });
          });
        });
      });
    }

    function resumeImpl() {
      return readCheckpoint().then(function (cp) {
        if (cp.phase !== constants.PHASE.SCANNING) { return null; }
        // If permission was revoked, stop safely with partial results.
        return Promise.resolve(hasPermission()).then(function (granted) {
          if (!granted) { return finishImpl(cp); }
          // If a normal scan started while we were mid-check it will have
          // cleared/replaced the records. Finalize safely (DONE, partial/zero
          // results for the current record set) rather than looping forever
          // over a checkpoint whose target no longer exists.
          return storageGet([constants.KEYS.RECORDS]).then(function (res) {
            if (!targetStillValid(cp.targetIds, res[constants.KEYS.RECORDS])) {
              return finishImpl(cp);
            }
            return processActiveWindowImpl();
          });
        });
      });
    }

    function finishImpl(cp) {
      return storageGet([constants.KEYS.RECORDS]).then(function (res) {
        var records = res[constants.KEYS.RECORDS] || [];
        var reachable = 0, unreachable = 0, couldNotCheck = 0, checked = 0;
        for (var i = 0; i < records.length; i++) {
          var ls = records[i].linkStatus;
          if (ls === constants.LINK_STATUS_REACHABLE) { reachable += 1; checked += 1; }
          else if (ls === constants.LINK_STATUS_UNREACHABLE) { unreachable += 1; checked += 1; }
          else if (ls === constants.LINK_STATUS_COULD_NOT_CHECK) { couldNotCheck += 1; checked += 1; }
        }
        var now = getNow();
        // Exact wall-clock link-check duration across all wakes/termination.
        // When a start stamp is absent (resume from an older checkpoint) fall
        // back to a null duration rather than fabricating one.
        var linkStartedAt = (typeof cp.linkStartedAt === 'number') ? cp.linkStartedAt : null;
        var linkCompletedAt = now;
        var durationMs = (linkStartedAt !== null) ? Math.max(0, linkCompletedAt - linkStartedAt) : null;
        var report = {
          ranAt: now,
          linkStartedAt: linkStartedAt,
          linkCompletedAt: linkCompletedAt,
          durationMs: durationMs,
          checked: checked,
          reachable: reachable,
          unreachable: unreachable,
          couldNotCheck: couldNotCheck
        };
        var payload = {};
        payload[constants.KEYS.LINK_REPORT] = report;
        payload[constants.KEYS.LINK_CHECKPOINT] = {
          phase: constants.PHASE.DONE,
          // processedCount reflects the last durable cursor, which may be
          // partial when the check finalized early (records replaced mid-check).
          processedCount: cp.processedCount,
          totalCount: cp.totalCount,
          lastProcessedId: cp.lastProcessedId,
          updatedAt: now,
          linkStartedAt: linkStartedAt,
          linkCompletedAt: linkCompletedAt,
          durationMs: durationMs
        };
        payload[constants.KEYS.SCHEMA] = constants.SCHEMA_VERSION;
        return storageSet(payload).then(function () {
          clearWake();
          sendProgress({ phase: constants.PHASE.DONE, report: report });
          return payload;
        });
      });
    }

    async function processActiveWindowImpl() {
      var cp = await readCheckpoint();
      if (cp.phase !== constants.PHASE.SCANNING) { return; }
      if (cp.processedCount >= cp.totalCount) {
        await finishImpl(cp);
        return;
      }

      var res = await storageGet([constants.KEYS.RECORDS]);
      var records = res[constants.KEYS.RECORDS] || [];
      var target = records.filter(isCheckable);

      // A normal scan cleared/replaced the records under a live check: finalize
      // safely (DONE, partial/zero results) instead of looping over a checkpoint
      // whose target no longer exists.
      if (!targetStillValid(cp.targetIds, records)) {
        await finishImpl(cp);
        return;
      }

      var wakeStart = getNow();
      var cursor = cp.processedCount;
      var lastId = cp.lastProcessedId || null;
      var budgetExceeded = false;

      // Enforce the active-window budget on EVERY URL, not just between chunks.
      // Each result is persisted as soon as it completes and the checkpoint
      // cursor advances only after that durable write, so a worker killed at any
      // point — including mid-window — never loses a completed result and never
      // re-skips an unpersisted one on resume.
      while (cursor < target.length) {
        if (getNow() - wakeStart >= activeWindowMs) { budgetExceeded = true; break; }

        var record = target[cursor];
        var r;
        try {
          r = await checkUrl(fetchImpl, record.url, { timeoutMs: timeoutMs, getNow: getNow });
        } catch (e) {
          r = { status: constants.LINK_STATUS_COULD_NOT_CHECK, detail: 'network_error', checkedAt: getNow() };
        }
        lastId = record.id;
        record.linkStatus = r.status;
        record.linkCheckedAt = r.checkedAt;

        // Write this one result back (idempotent replay-safe: re-checking the
        // same URL overwrites the same status). Only then advance the cursor.
        var merged = applyResults(records, [record]);
        var now = getNow();
        var batch = {
          [constants.KEYS.RECORDS]: merged,
          [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
        };
        batch[constants.KEYS.LINK_CHECKPOINT] = {
          phase: constants.PHASE.SCANNING,
          processedCount: cursor + 1,
          totalCount: target.length,
          lastProcessedId: lastId,
          targetIds: cp.targetIds,
          updatedAt: now,
          // Preserve the wall-clock start stamp across every wake/termination
          // so the final link-check duration stays exact.
          linkStartedAt: cp.linkStartedAt
        };
        await storageSet(batch);

        records = merged;
        cursor += 1;
        sendProgress({
          phase: constants.PHASE.SCANNING,
          processedCount: cursor,
          totalCount: target.length,
          lastProcessedId: lastId
        });
      }

      if (cursor >= target.length) {
        await finishImpl({ ...cp, lastProcessedId: lastId, totalCount: target.length });
        return;
      }
      scheduleWake(constants.ALARM_MINUTES);
      if (budgetExceeded) {
        sendProgress({
          phase: constants.PHASE.SCANNING,
          processedCount: cursor,
          totalCount: target.length,
          lastProcessedId: lastId,
          windowBoundary: true
        });
      }
    }

    function applyResults(existing, updated) {
      var byId = Object.create(null);
      var i;
      for (i = 0; i < existing.length; i++) { byId[existing[i].id] = existing[i]; }
      for (i = 0; i < updated.length; i++) {
        byId[updated[i].id] = updated[i];
      }
      var out = [];
      for (var id in byId) {
        if (Object.prototype.hasOwnProperty.call(byId, id)) { out.push(byId[id]); }
      }
      out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      return out;
    }

    return {
      start: serialize(startImpl),
      resume: serialize(resumeImpl),
      checkUrl: checkUrl,
      classify: classify
    };
  }

  return {
    classify: classify,
    checkUrl: checkUrl,
    createLinkCheckController: createLinkCheckController
  };
});
