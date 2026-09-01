/**
 * Scan controller — chunked, checkpointed, resumable bookmark import.
 *
 * Design constraints (TECHNICAL-ARCHITECTURE.md §A):
 *   - No global scan state. Everything needed to resume is read from and
 *     written to storage on every wake.
 *   - The scan runs in chunks (~75 links) and checkpoints after every chunk.
 *   - The next chunk is scheduled with chrome.alarms, never timers.
 *   - Terminating the worker mid-scan at any point must leave a resume that
 *     completes with identical final counts (idempotent; reprocessing a chunk
 *     is harmless).
 *   - What remained for later milestones (deletion, writes, network checks)
 *     is intentionally out of scope here.
 *
 * To make the chunk/checkpoint/resume logic verifiable without Chrome, all
 * external APIs are injected via `deps`. The extension passes chrome-backed
 * implementations; the test harness passes deterministic mocks. Both drive
 * the exact same code path.
 *
 *  deps shape:
 *   {
 *     bookmarkApi:  { getTree(): Promise<BookmarkTreeNode[]> }
 *     storageGet(keys): Promise<object>
 *     storageSet(obj): Promise<void>
 *     loadRules(): Promise<rulesData>
 *     scheduleWake(minutes): void          // chrome.alarms.create
 *     clearWake(): void                    // chrome.alarms.clear on completion
 *     sendProgress(payload): void          // surface progress (options)
 *     getNow(): number                     // epoch ms (injected for tests)
 *     activeWindowMs?: number              // budget per worker wake (ms);
 *                                          // defaults to constants.ACTIVE_WINDOW_MS
 *   }
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants'), require('./normalize'), require('./categorize'), require('./report'), require('./cleanup'));
  } else {
    root.BRScan = factory(root.BRConstants, root.BRNormalize, root.BRCategorize, root.BRReport, root.BRCleanup);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (constants, normalize, categorize, report, cleanup) {
  'use strict';

  var KEYS = constants.KEYS;
  var PHASE = constants.PHASE;
  var CHUNK_SIZE = constants.CHUNK_SIZE;
  var SCHEMA_VERSION = constants.SCHEMA_VERSION;

  /**
   * Build a scan controller. Each call returns a fresh controller with no
   * shared mutable scan state; all progress lives in storage.
   *
   * Concurrency: every public driver (startNewScan, resume, processActiveWindow)
   * funnels through a controller-local single-flight promise. That promise is
   * pure orchestration — it never holds scan data, so it does not violate the
   * "no global scan state" rule (storage remains the only scan-state source of
   * truth). Serializing drivers guarantees that a user-triggered rescan cannot
   * interleave, mid-window, with an older scan's storage writes: a stale async
   * write is always flushed to storage *before* the next operation begins, so
   * it can never overwrite the newer scan's queue/checkpoint/records/report.
   */
  function createScanController(deps) {
    var storageGet = deps.storageGet;
    var storageSet = deps.storageSet;
    var bookmarkApi = deps.bookmarkApi;
    var loadRules = deps.loadRules;
    var scheduleWake = deps.scheduleWake;
    var clearWake = deps.clearWake;
    var sendProgress = deps.sendProgress || function () {};
    var getNow = deps.getNow || function () { return Date.now(); };
    // Optional M3 integration: returns a Promise of string ids currently tracked
    // (and NOT restored) in Salvage Trash. When supplied, the scan re-applies the
    // soft-delete (`deletedAt`) marker to those records on completion so a fresh
    // rescan never re-offers a trashed item and its copy never re-enters
    // duplicate/link detection even though the bookmark still lives under
    // Salvage Trash. Absent (no trash integration), records stay as-is.
    var loadTrashDeletedIds = (typeof deps.loadTrashDeletedIds === 'function') ? deps.loadTrashDeletedIds : null;

    // Controller-local single-flight tail. A failure in one operation must not
    // poison the next, so the tail swallows errors while callers still receive
    // the original (rejecting) promise.
    var operationTail = Promise.resolve();

    function serialize(fn) {
      return function () {
        var self = this;
        var args = arguments;
        var run = operationTail.then(function () {
          return fn.apply(self, args);
        });
        operationTail = run.then(function () {}, function () {});
        return run;
      };
    }

    async function readCheckpoint() {
      var res = await storageGet([KEYS.CHECKPOINT]);
      return res[KEYS.CHECKPOINT] || {
        phase: PHASE.IDLE,
        totalCount: 0,
        processedCount: 0,
        lastProcessedId: null,
        updatedAt: 0,
        scanStartedAt: null,
        scanCompletedAt: null,
        durationMs: null
      };
    }

    async function writeCheckpoint(cp) {
      var payload = {};
      payload[KEYS.CHECKPOINT] = cp;
      payload[KEYS.SCHEMA] = SCHEMA_VERSION;
      await storageSet(payload);
    }

    /**
     * Flatten the bookmark tree into an ordered, deterministic list of work
     * items (URL leaves) carrying enough to build persisted records.
     */
    function flattenTree(nodes, pathPrefix) {
      var out = [];
      pathPrefix = pathPrefix || [];
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node) { continue; }
        var isFolder = Object.prototype.hasOwnProperty.call(node, 'children');
        if (isFolder) {
          out = out.concat(flattenTree(node.children || [], pathPrefix.concat([node.title || ''])));
        } else if (typeof node.url === 'string' && node.url) {
          out.push({
            id: String(node.id),
            title: node.title || '',
            url: node.url,
            dateAdded: typeof node.dateAdded === 'number' ? node.dateAdded : 0,
            dateLastUsed: typeof node.dateLastUsed === 'number' ? node.dateLastUsed : 0,
            folderPath: pathPrefix
          });
        }
      }
      return out;
    }

    /**
     * Convert a work item into a persisted bookmark record matching the
     * architecture's storage schema (TECHNICAL-ARCHITECTURE.md §5). Fields
     * that describe work out of Milestone 1 scope are carried as honest
     * neutral placeholders (deletedAt null, linkStatus unchecked).
     */
    function itemToRecord(item, rules, now) {
      var domain = normalize.extractDomain(item.url);
      var cat = categorize.categorize(item, rules);
      return {
        id: item.id,
        title: item.title,
        url: item.url,
        domain: domain,
        folderPath: item.folderPath,
        tags: [],
        category: cat.category,
        categorySource: cat.source,
        categoryConfidence: cat.confidence,
        userCorrected: false,
        summary: null,
        summarySource: 'none',
        pageType: constants.PAGE_TYPE_DEFAULT,
        duplicateGroup: null,
        linkStatus: constants.LINK_STATUS_UNCHECKED,
        linkCheckedAt: null,
        deletedAt: null,
        dateAdded: item.dateAdded,
        dateLastUsed: item.dateLastUsed,
        lastScanned: now
      };
    }

    /**
     * Idempotent upsert: replaying an already-persisted record is harmless,
     * and a user correction is never overwritten by a rescan.
     */
    function upsertRecords(existing, incoming, now) {
      var byId = Object.create(null);
      var i;
      for (i = 0; i < existing.length; i++) { byId[existing[i].id] = existing[i]; }
      for (i = 0; i < incoming.length; i++) {
        var rec = incoming[i];
        var prior = byId[rec.id];
        var merged = {
          id: rec.id,
          title: rec.title,
          url: rec.url,
          domain: rec.domain,
          folderPath: rec.folderPath,
          tags: (prior && prior.tags) ? prior.tags : [],
          category: rec.category,
          categorySource: rec.categorySource,
          categoryConfidence: rec.categoryConfidence,
          userCorrected: false,
          summary: (prior && prior.summary) || null,
          summarySource: (prior && prior.summarySource) || 'none',
          pageType: (prior && prior.pageType) || constants.PAGE_TYPE_DEFAULT,
          duplicateGroup: (prior && prior.duplicateGroup) || null,
          linkStatus: (prior && prior.linkStatus) || constants.LINK_STATUS_UNCHECKED,
          linkCheckedAt: (prior && prior.linkCheckedAt) || null,
          deletedAt: (prior && prior.deletedAt) || null,
          dateAdded: rec.dateAdded,
          dateLastUsed: rec.dateLastUsed,
          lastScanned: now
        };
        if (prior && prior.userCorrected) {
          merged.category = prior.category;
          merged.categorySource = prior.categorySource;
          merged.categoryConfidence = prior.categoryConfidence;
          merged.userCorrected = true;
        }
        byId[rec.id] = merged;
      }
      var result = [];
      for (var id in byId) {
        if (Object.prototype.hasOwnProperty.call(byId, id)) { result.push(byId[id]); }
      }
      result.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      return result;
    }

    /**
     * Start (or restart) a full scan. Clears the previous scan's records and
     * report up front so the final records are exactly the current bookmark
     * tree (a bookmark removed outside the extension must not linger in the
     * records or inflate the report total). Then finds the fresh tree,
     * flattens the queue, checkpoints totalCount, and processes the first
     * active window.
     */
    function startNewScanImpl() {
      var rules;
      return loadRules()
        .then(function (r) { rules = r; return bookmarkApi.getTree(); })
        .then(function (nodes) {
          var rootNodes = nodes || [];
          var queue = flattenTree(rootNodes, []);
          // Milestone 2 detection: derive the read-only tree analysis (empty
          // folders + same-name merge candidates) now, while we hold the tree.
          // It is persisted alongside the scan queue so a worker-terminated and
          // resumed scan still reports the same folder findings at completion.
          var folderFindings = cleanup.analyzeFolders(rootNodes);
          var payload = {};
          payload[KEYS.QUEUE] = queue;
          payload[KEYS.RECORDS] = [];      // rescan reflects the current tree
          payload[KEYS.REPORT] = null;     // stale report dropped until finished
          payload[KEYS.LAST_SCAN] = null;
          // A fresh rescan rebuilds the records with `unchecked` link statuses, so
          // any previous link-check results are now MEANINGLESS: the persisted
          // `linkReport` (summary) and `linkCheckpoint` (lifecycle) describe a
          // different records array. Drop both so a stale "385 confirmed dead"
          // summary can never sit above a fresh zero-result list — the popup must
          // re-run the opt-in link check to get results for the current tree. An
          // in-flight check (phase SCANNING) is also invalidated; its own
          // `targetStillValid` guard would have aborted it anyway once it read the
          // replaced records.
          payload[KEYS.LINK_REPORT] = null;
          payload[KEYS.LINK_CHECKPOINT] = null;
          payload[KEYS.FOLDER_FINDINGS] = folderFindings;
          payload[KEYS.CHECKPOINT] = {
            phase: PHASE.SCANNING,
            totalCount: queue.length,
            processedCount: 0,
            lastProcessedId: null,
            updatedAt: getNow(),
            // Wall-clock start persists so the total elapsed duration across
            // every chunk, worker termination, alarm wake and resume is exact,
            // not just the final active-window span.
            scanStartedAt: getNow()
          };
          payload[KEYS.SCHEMA] = SCHEMA_VERSION;
          return storageSet(payload);
        })
        .then(function () {
          return processActiveWindowImpl(rules);
        });
    }

    /**
     * User-initiated "Scan now" request (popup). Unlike startNewScan, which a
     * caller may always force, this is the rapid-click-safe entry point: while
     * a scan is already in the SCANNING phase this is a no-op that resolves to
     * { skipped: true }, so repeated/rapid Scan now clicks can never queue a
     * second full rescan on top of a running one (which would otherwise restart
     * the scan over and over and surface as a loop). Once the current scan
     * reaches DONE a later request starts a fresh scan as normal.
     *
     * Serialized like the other drivers, so the phase check and the scan it may
     * start never interleave with another in-flight write.
     */
    function requestScanImpl() {
      return readCheckpoint().then(function (cp) {
        if (cp.phase === PHASE.SCANNING) {
          return { skipped: true, phase: cp.phase };
        }
        return startNewScanImpl().then(function () { return { skipped: false }; });
      });
    }

    /**
     * Resume an incomplete scan (worker restarted mid-scan), or do nothing if
     * the scan is already done. Called from the top level on worker startup
     * and from onAlarm.
     */
    function resumeImpl() {
      return readCheckpoint().then(function (cp) {
        if (cp.phase === PHASE.SCANNING && cp.processedCount < cp.totalCount) {
          return loadRules().then(function (rules) {
            return processActiveWindowImpl(rules);
          });
        }
        return null;
      });
    }

    /**
     * Compute and persist the Library Report once the scan reaches the end.
     */
    async function finishScan(cp) {
      var res = await storageGet([KEYS.RECORDS, KEYS.FOLDER_FINDINGS]);
      var records = res[KEYS.RECORDS] || [];
      // The tree-derived folder findings were persisted at scan start. If none
      // are present (e.g. a resume from a pre-M2 checkpoint) the report simply
      // carries zero empty-folder / merge findings.
      var folderFindings = res[KEYS.FOLDER_FINDINGS] || null;
      var now = getNow();
      // M3 trash integration: a fresh rescan rebuilds records from the live tree
      // (which still contains items under Salvage Trash). Re-apply the soft-delete
      // marker to any record whose bookmark is currently tracked, non-restored, in
      // Salvage Trash, so trashed items are never re-offered for cleanup and their
      // copies never re-inflate duplicate/link metrics — even though the bookmark
      // itself remains in the tree under Salvage Trash.
      if (loadTrashDeletedIds) {
        var trashedIds = await loadTrashDeletedIds();
        if (trashedIds && trashedIds.length) {
          var set = {};
          trashedIds.forEach(function (id) { set[String(id)] = true; });
          records.forEach(function (r) { if (set[String(r.id)]) { r.deletedAt = now; } });
        }
      }
      // Exact wall-clock scan duration. When a start timestamp exists (the scan
      // was instrumented), the duration spans the full elapsed time across all
      // wakes — including any that were interrupted by worker termination. When
      // it is absent (resume from an older checkpoint without a start stamp) we
      // fall back to the completed timestamp with a null duration rather than
      // fabricating one.
      var scanStartedAt = (typeof cp.scanStartedAt === 'number') ? cp.scanStartedAt : null;
      var scanCompletedAt = now;
      var durationMs = (scanStartedAt !== null) ? Math.max(0, scanCompletedAt - scanStartedAt) : null;
      var payload = {};
      payload[KEYS.REPORT] = report.computeReport(records, now, {
        folderFindings: folderFindings,
        timing: { scanStartedAt: scanStartedAt, scanCompletedAt: scanCompletedAt, durationMs: durationMs }
      });
      payload[KEYS.RECORDS] = records;
      payload[KEYS.LAST_SCAN] = now;
      payload[KEYS.CHECKPOINT] = {
        phase: PHASE.DONE,
        totalCount: cp.totalCount,
        processedCount: cp.totalCount,
        lastProcessedId: cp.lastProcessedId,
        updatedAt: now,
        scanStartedAt: scanStartedAt,
        scanCompletedAt: scanCompletedAt,
        durationMs: durationMs
      };
      await storageSet(payload);
      clearWake();
      sendProgress({ phase: PHASE.DONE, processedCount: cp.totalCount, totalCount: cp.totalCount });
      return payload;
    }

    /**
     * Process one active worker window: apply chunks sequentially, checkpoint
     * after every chunk (idempotent upsert), and stop as soon as either the
     * scan is complete or the active-window budget for this wake is reached.
     * When the scan is not complete the next wake is scheduled with
     * chrome.alarms and control returns to the worker; the next wake resumes
     * from the persisted checkpoint. The budget is intentionally not stored
     * across wakes — each wake starts a fresh window — which is what makes it
     * safe under worker termination: a killed worker only shortens the current
     * window and never corrupts the scan, because resume always re-reads the
     * checkpoint from storage. No timers are used; the wake is the only
     * driver.
     */
    async function processActiveWindowImpl(rules) {
      var cp = await readCheckpoint();
      // An idle or done scan has nothing left to do (idempotent replay).
      if (cp.phase !== PHASE.SCANNING) {
        await writeCheckpoint(cp); // no-op; keep schema stamped
        return;
      }
      // Still in the scanning phase but already at (or past) the end: either
      // the tree is empty (totalCount 0), or the worker was killed between the
      // last batch write and finishScan. Either way the scan has not been
      // finalised, so persist the (possibly empty) report, mark DONE, and
      // clear alarms. Without this an empty library would hang forever in
      // "scanning" with no report and no alarm.
      if (cp.processedCount >= cp.totalCount) {
        await finishScan(cp);
        return;
      }

      var budgetMs = (typeof deps.activeWindowMs === 'number' && deps.activeWindowMs > 0)
        ? deps.activeWindowMs
        : constants.ACTIVE_WINDOW_MS;
      var wakeStart = getNow();

      var res = await storageGet([KEYS.QUEUE, KEYS.RECORDS]);
      var queue = res[KEYS.QUEUE] || [];
      var now = getNow();
      var cursor = cp.processedCount;
      var lastId = cp.lastProcessedId || null;
      var budgetExceeded = false;

      while (cursor < queue.length) {
        if (getNow() - wakeStart >= budgetMs) {
          budgetExceeded = true;
          break;
        }

        var chunk = queue.slice(cursor, cursor + CHUNK_SIZE);
        var nextCursor = cursor + chunk.length;
        lastId = chunk.length ? String(chunk[chunk.length - 1].id) : lastId;

        var toPersist = [];
        for (var i = 0; i < chunk.length; i++) {
          toPersist.push(itemToRecord(chunk[i], rules, now));
        }

        var merged = upsertRecords(res[KEYS.RECORDS] || [], toPersist, now);

        var batch = {
          [KEYS.RECORDS]: merged,
          [KEYS.SCHEMA]: SCHEMA_VERSION
        };
        batch[KEYS.CHECKPOINT] = {
          phase: PHASE.SCANNING,
          totalCount: cp.totalCount,
          processedCount: nextCursor,
          lastProcessedId: lastId,
          updatedAt: now,
          // Preserve the wall-clock start stamp through every chunk so a worker
          // termination/wake never loses it and the final duration stays exact.
          scanStartedAt: cp.scanStartedAt
        };
        await storageSet(batch);

        res[KEYS.RECORDS] = merged; // keep local accumulated copy for next chunk
        cursor = nextCursor;

        sendProgress({
          phase: PHASE.SCANNING,
          processedCount: nextCursor,
          totalCount: cp.totalCount,
          lastProcessedId: lastId
        });
      }

      if (cursor >= cp.totalCount) {
        return finishScan({ ...cp, lastProcessedId: lastId });
      }

      // Scan not complete: this wake's budget is spent (or its queue is
      // exhausted within the window). Re-arm the wake and yield to the worker.
      scheduleWake(constants.ALARM_MINUTES);

      if (budgetExceeded) {
        sendProgress({
          phase: PHASE.SCANNING,
          processedCount: cursor,
          totalCount: cp.totalCount,
          lastProcessedId: lastId,
          windowBoundary: true
        });
      }
    }

    return {
      startNewScan: serialize(startNewScanImpl),
      requestScan: serialize(requestScanImpl),
      resume: serialize(resumeImpl),
      processActiveWindow: serialize(processActiveWindowImpl),
      flattenTree: flattenTree,
      itemToRecord: itemToRecord,
      upsertRecords: upsertRecords
    };
  }

  return {
    createScanController: createScanController
  };
});
