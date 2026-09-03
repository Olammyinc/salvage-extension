/**
 * Safe cleanup / Salvage Trash.
 *
 * Two layers, deliberately separated so the hard data-safety rules live in
 * pure, chrome-free functions (unit-testable) while the chrome-bound
 * controller never reasons about eligibility itself:
 *
 *   eligibility & preview (pure)
 *     - which items are currently selectable for cleanup:
 *         * duplicate records (keep the oldest/lowest-id original; ONLY the
 *           duplicates are selectable — never the original);
 *         * link records whose persisted status is EXACTLY `unreachable`.
 *       `could_not_check` (and any other status) is never selectable and never
 *       removable.
 *     - the itemized dry-run preview shown before any action.
 *   mutation & checkpointing (controller, injected chrome)
 *     - moves selected items from their ORIGINAL parent to a visible
 *       "Salvage Trash" folder. The same chrome.bookmarks.move() is used for
 *       both cleanup and restore, so browser-tree cleanup is fully reversible
 *       (nothing is ever chrome.bookmarks.remove'd during normal cleanup).
 *     - PERMANENT removal ONLY happens through an explicit purge path, and
 *       only for tracked Trash records that have passed the 30-day retention
 *       window AND received a separate confirmation.
 *     - a backup gate forces a full backup export before the first bulk move;
 *       `backupExportedAt` is persisted ONLY after the user actually initiated
 *       a download.
 *     - every operation is serialized (single-flight) and checkpointed to
 *       storage in small batches, so overlapping move/restore cannot collide
 *       and a worker termination mid-batch preserves a durable undo record.
 *
 * Neutral internal identifiers, no product name embedded. The user-visible
 * folder name ("Salvage Trash") and all cleanup copy live in constants.js.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./cleanup'), require('./constants'));
  } else {
    root.BRTrash = factory(root.BRCleanup, root.BRConstants);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (cleanup, constants) {
  'use strict';

  var KEYS = constants.KEYS;

  // ---- Kind marker for a selectable item ------------------------------------
  var KIND_DUPLICATE = 'duplicate';
  var KIND_DEAD_LINK = 'dead-link';

  /** 30-day retention: the minimum age before an item may even be considered.
   *  A manual purge is still never automatic and always doubly confirmed. */
  var RETENTION_MS = constants.MILLIS_PER_DAY * constants.TRASH_RETENTION_DAYS;

  /** Small per-storage-write batch so a single durable update is tiny. */
  var DEFAULT_BATCH_SIZE = 10;

  /**
   * Pure: is a persisted link status eligible for cleanup selection?
   * ONLY `unreachable` (confirmed 404/410). `could_not_check` and every other
   * status are never selectable and never removable.
   */
  function isDeadLinkStatus(status) {
    return status === constants.LINK_STATUS_UNREACHABLE;
  }

  /**
   * Pure: the selectable items for cleanup from the persisted duplicate groups.
   * Given groups shaped like cleanup.computeDuplicateGroups().groups (each with
   * `items` sorted ascending by id and `duplicates` = items minus the lowest-id
   * original), only the duplicates are selectable — the original is never.
   *
   * @param {Array<object>} groups duplicate groups
   * @returns {Array<{id,title,url,kind,groupKey}>} selectable duplicate items
   */
  function selectableDuplicates(groups) {
    var out = [];
    (groups || []).forEach(function (g) {
      (g.duplicates || []).forEach(function (d) {
        if (d && d.id != null && typeof d.url === 'string' && d.url) {
          out.push({
            id: String(d.id),
            title: typeof d.title === 'string' ? d.title : '',
            url: d.url,
            kind: KIND_DUPLICATE,
            groupKey: g && g.normalizedUrl ? g.normalizedUrl : ''
          });
        }
      });
    });
    return out;
  }

  /**
   * Pure: the selectable items from link-checked records whose persisted status
   * is exactly `unreachable`, excluding soft-deleted records.
   *
   * @param {Array<object>} records persisted bookmark records
   * @returns {Array<{id,title,url,kind}>} selectable confirmed-dead items
   */
  function selectableDeadLinks(records) {
    var out = [];
    (records || []).forEach(function (r) {
      if (typeof r.deletedAt === 'number' && r.deletedAt > 0) { return; }
      if (isDeadLinkStatus(r.linkStatus) && r.url) {
        out.push({
          id: String(r.id),
          title: typeof r.title === 'string' ? r.title : '',
          url: r.url,
          kind: KIND_DEAD_LINK
        });
      }
    });
    return out;
  }

  /**
   * Pure: re-derive which of the requested items are actually eligible to be
   * moved, from the PERSISTED scan records — never trusting the popup's supplied
   * item payloads. Only non-original exact-duplicate copies (selectableDuplicates
   * over the persisted records) and records whose persisted linkStatus is exactly
   * `unreachable` (selectableDeadLinks) may be moved. Any requested id that is not
   * in that eligibility set is refused (ignored), so a compromised or foreign
   * caller cannot move arbitrary bookmark ids.
   *
   * The returned move-set is built solely from the derived selectable items (its
   * own id/title/url/kind), never from the request body.
   *
   * @param {Array<{id:*} >} requestedItems ids the caller asked to move
   * @param {Array<object>} records persisted scan records (the source of truth)
   * @returns {{moveItems:Array<{id,title,url,kind,groupKey?}>, requestedCount:number, refusedCount:number}}
   */
  function resolveEligibleMoveItems(requestedItems, records) {
    var eligible = selectableDuplicates(cleanup.computeDuplicateGroups(records).groups)
      .concat(selectableDeadLinks(records));
    var byId = {};
    var i;
    for (i = 0; i < eligible.length; i++) { byId[String(eligible[i].id)] = eligible[i]; }
    var req = {};
    var requestedIds = [];
    (requestedItems || []).forEach(function (it) {
      if (it && it.id != null) { var s = String(it.id); if (!req[s]) { req[s] = true; requestedIds.push(s); } }
    });
    var moveItems = [];
    // Preserve the deterministic eligibility order; only ids the caller actually
    // named are included, and only with the DERIVED (not caller-supplied) fields.
    for (i = 0; i < eligible.length; i++) {
      if (req[String(eligible[i].id)]) { moveItems.push(JSON.parse(JSON.stringify(eligible[i]))); }
    }
    var refusedCount = 0;
    for (i = 0; i < requestedIds.length; i++) {
      if (!byId[requestedIds[i]]) { refusedCount += 1; }
    }
    return { moveItems: moveItems, requestedCount: requestedIds.length, refusedCount: refusedCount };
  }

  /**
   * Pure: build the itemized dry-run preview for a set of selected items.
   * Never mutates anything; this is exactly what the confirmation UI renders.
   *
   * @param {Array<{id,title,url,kind}>} items selectable items
   * @returns {{count,duplicateCount,deadLinkCount,items:[...]}}
   */
  function buildDryRun(items) {
    items = items || [];
    var duplicateCount = 0;
    var deadLinkCount = 0;
    var projected = items.map(function (it) {
      var kind = it.kind === KIND_DEAD_LINK ? KIND_DEAD_LINK : KIND_DUPLICATE;
      if (kind === KIND_DUPLICATE) { duplicateCount += 1; } else { deadLinkCount += 1; }
      return {
        id: String(it.id),
        title: it.title || '',
        url: it.url || '',
        kind: kind
      };
    });
    return {
      count: projected.length,
      duplicateCount: duplicateCount,
      deadLinkCount: deadLinkCount,
      items: projected
    };
  }

  /**
   * Pure: does a bulk move require the backup gate? True until a real
   * backup download has been recorded (backupExportedAt present and > 0).
   */
  function backupGateRequired(backupExportedAt) {
    return !(typeof backupExportedAt === 'number' && backupExportedAt > 0);
  }

  /**
   * Pure: resolve the restore target for a tracked trash entry.
   *
   * Returns the ORIGINAL parent id when that folder still exists in the tree,
   * otherwise the Bookmarks Bar id (safe fallback — never refuses to restore).
   *
   * @param {object} entry tracked trash entry (has originalParentId)
   * @param {Array<object>} tree chrome.bookmarks.getTree() output
   * @param {string} barId the Bookmarks Bar root id, e.g. '1'
   * @returns {string} the parent id to move back into
   */
  function resolveRestoreParent(entry, tree, barId) {
    var map = {};
    (function walk(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n) { continue; }
        map[String(n.id)] = n;
        if (n.children) { walk(n.children); }
      }
    })(tree || []);
    var original = entry && entry.originalParentId != null ? String(entry.originalParentId) : null;
    if (original && map[original] && Object.prototype.hasOwnProperty.call(map[original], 'children')) {
      return map[original].id;
    }
    // Fallback to the Bookmarks Bar root if supplied and present.
    if (barId != null && map[barId]) { return String(barId); }
    return String(entry.originalParentId != null ? entry.originalParentId : barId);
  }

  /**
   * Pure: is a tracked trash entry past retention and therefore merely ELIGIBLE
   * to be presented for explicit purge? Returning true never purges anything —
   * the caller must separately confirm and only purge tracked records.
   */
  function isEligibleForPurge(entry, now, retentionMs) {
    if (!entry || entry.restoredAt) { return false; }
    if (typeof entry.movedAt !== 'number' || entry.movedAt <= 0) { return false; }
    var retention = (typeof retentionMs === 'number' && retentionMs > 0) ? retentionMs : RETENTION_MS;
    return (now - entry.movedAt) >= retention;
  }

  /**
   * Pure: filter a requested purge id-set down to the tracked, retention-eligible
   * entries. Entries not yet eligible are refused (never auto-purged / never
   * purged early). Restored entries are excluded too.
   *
   * @param {Array<string>} requestedIds ids the user asked to purge
   * @param {Array<object>} trashEntries all tracked trash entries
   * @param {number} now
   * @param {number} [retentionMs]
   * @returns {{eligible:Array<object>, refusedCount:number}}
   */
  function eligibleForPurge(requestedIds, trashEntries, now, retentionMs) {
    // Deduplicate requested ids UP FRONT so a crafted duplicate-id purge request
    // can never flow duplicate ids into the running set and call
    // bookmarkApi.remove twice for the same bookmark. Each unique id is then
    // examined exactly once (eligible once, refused at most once).
    var arg = requestedIds || [];
    var unique = [];
    var seen = {};
    for (var i = 0; i < arg.length; i++) {
      if (arg[i] == null) { continue; }
      var sid = String(arg[i]);
      if (!seen[sid]) { seen[sid] = true; unique.push(sid); }
    }
    var byId = {};
    (trashEntries || []).forEach(function (e) { byId[String(e.id)] = e; });
    var eligible = [];
    var refused = 0;
    unique.forEach(function (sid) {
      var e = byId[sid];
      if (e && isEligibleForPurge(e, now, retentionMs)) { eligible.push(e); }
      else { refused += 1; }
    });
    return { eligible: eligible, refusedCount: refused };
  }

  /**
   * Controller — chrome-bound but every hard rule inherits from the pure
   * helpers above.
   *
   *  deps:
   *   {
   *     bookmarkApi: {
   *       getTree(): Promise<BookmarkTreeNode[]>,
   *       create({parentId, title}): Promise<BookmarkTreeNode>,
   *       move(id, {parentId}): Promise<BookmarkTreeNode>,
   *       get(id): Promise<BookmarkTreeNode>,   // returns {id,parentId,index}
   *       remove(id): Promise<void>             // used ONLY by explicit purge
   *     },
   *     storageGet(keys): Promise<object>,
   *     storageSet(obj): Promise<void>,
   *     getNow(): number,
   *     createFolder?: ({parentId,title}) => Promise<node>, // when getTree+create
   *     batchSize?: number,
   *     barId?: string,          // Bookmarks Bar root id (default '1')
   *     retentionDays?: number   // override for tests
   *   }
   */
  function createTrashController(deps) {
    var bookmarkApi = deps.bookmarkApi;
    var storageGet = deps.storageGet;
    var storageSet = deps.storageSet;
    var getNow = deps.getNow || function () { return Date.now(); };
    var batchSize = (typeof deps.batchSize === 'number' && deps.batchSize > 0)
      ? deps.batchSize : DEFAULT_BATCH_SIZE;
    var barId = deps.barId != null ? String(deps.barId) : '1';
    var barIdResolved = !!deps.barId;
    var retentionMs = (typeof deps.retentionDays === 'number' && deps.retentionDays > 0)
      ? constants.MILLIS_PER_DAY * deps.retentionDays : RETENTION_MS;

    // Detect the Bookmarks Bar/Toolbar id from the real bookmark tree.
    // Chrome uses numeric ids ('1' for Bookmarks Bar under root '0');
    // Firefox uses string ids ('toolbar_____' under root 'root________').
    // Prefer the well-known bar ids over another root child. Do not lock the
    // default in after an incomplete tree; a later getTree() may be usable.
    function resolveBarIdFromTree(tree) {
      if (barIdResolved) { return; }
      var rootNode = Array.isArray(tree) ? tree[0] : null;
      var children = rootNode && Array.isArray(rootNode.children) ? rootNode.children : null;
      if (!children || !children.length) { return; }
      var fallbackId = null;
      for (var i = 0; i < children.length; i++) {
        if (!children[i] || children[i].id == null) { continue; }
        var childId = String(children[i].id);
        if (!childId) { continue; }
        if (childId === 'toolbar_____' || childId === '1') {
          barId = childId;
          barIdResolved = true;
          return;
        }
        if (fallbackId == null) { fallbackId = childId; }
      }
      if (fallbackId != null) {
        barId = fallbackId;
        barIdResolved = true;
      }
    }

    // Controller-local single-flight tail (same pattern as scan/link controllers).
    // Pure orchestration: never holds trash state; prevents overlapping
    // move/restore/purge from colliding on the same real bookmark tree.
    var operationTail = Promise.resolve();
    function serialize(fn) {
      return function () {
        var self = this;
        var args = arguments;
        var run = operationTail.then(function () { return fn.apply(self, args); });
        operationTail = run.then(function () {}, function () {});
        return run;
      };
    }

    function readTrash() {
      return storageGet([KEYS.TRASH]).then(function (res) { return res[KEYS.TRASH] || []; });
    }
    function readLastBatch() {
      return storageGet([KEYS.TRASH_LAST_BATCH]).then(function (res) { return res[KEYS.TRASH_LAST_BATCH] || null; });
    }
    function readBackupGate() {
      return storageGet([KEYS.TRASH_BACKUP_GATE]).then(function (res) {
        return res[KEYS.TRASH_BACKUP_GATE] || null;
      });
    }
    function writeBackupGate(g) {
      var p = {}; p[KEYS.TRASH_BACKUP_GATE] = g; p[KEYS.SCHEMA] = constants.SCHEMA_VERSION;
      return storageSet(p);
    }
    function writeTrash(entries) {
      var p = {}; p[KEYS.TRASH] = entries; p[KEYS.SCHEMA] = constants.SCHEMA_VERSION;
      return storageSet(p);
    }
    function writeLastBatch(batch) {
      var p = {}; p[KEYS.TRASH_LAST_BATCH] = batch; p[KEYS.SCHEMA] = constants.SCHEMA_VERSION;
      return storageSet(p);
    }

    // Find the user-approved visible "Salvage Trash" folder, creating it under
    // the Bookmarks Bar if needed. Never creates a second copy while one exists.
    function ensureTrashFolder() {
      return bookmarkApi.getTree().then(function (tree) {
        resolveBarIdFromTree(tree);
        var found = null;
        (function walk(nodes) {
          for (var i = 0; i < nodes.length && !found; i++) {
            var n = nodes[i];
            if (!n) { continue; }
            if (Object.prototype.hasOwnProperty.call(n, 'children') &&
                String(n.parentId) === barId &&
                n.title === constants.TRASH_FOLDER_NAME) { found = n; return; }
            if (n.children) { walk(n.children); }
          }
        })(tree || []);
        if (found) { return found.id; }
        return bookmarkApi.create({ parentId: barId, title: constants.TRASH_FOLDER_NAME })
          .then(function (created) { return created.id; });
      });
    }

    // Capture the original location of an item's bookmark id: parentId + index.
    function captureOrigin(id) {
      return bookmarkApi.get(String(id)).then(function (node) {
        return {
          id: String(id),
          parentId: node && node.parentId != null ? String(node.parentId) : null,
          index: node && typeof node.index === 'number' ? node.index : null
        };
      });
    }

    function now() { return getNow(); }

    /**
     * DRY-RUN preview (no mutation). Accepts selectable items and returns the
     * itemized confirmation object. Also returns the gate state so the UI can
     * route through backup first.
     */
    function previewImpl(items) {
      return readBackupGate().then(function (gate) {
        return {
          ok: true,
          dryRun: buildDryRun(items),
          gateRequired: backupGateRequired(gate && gate.exportedAt)
        };
      });
    }

    /**
     * Bulk move selected items to the Salvage Trash folder.
     *
     * SAFETY:
     *  - Never calls chrome.bookmarks.remove / removeTree at any point.
     *  - Gated on the backup gate: before the first bulk move the user must
     *    have actually initiated a backup download (recorded via
     *    recordBackupDone). A GateRequired result moves nothing.
     *  - Server-side eligibility: the popup's supplied item payloads are NEVER
     *    trusted. The eligible move-set is re-derived from the persisted scan
     *    records (non-original exact-duplicate copies + records whose persisted
     *    linkStatus is exactly `unreachable`); any requested id that is not in
     *    that set is refused/ignored.
     *  - Moves are small-batch; each batch's trash metadata and durable
     *    last-batch record are persisted BEFORE the next batch runs, so a
     *    worker termination preserves a durable undo path (this worker, or a
     *    restarted one, can restore from TRASH_LAST_BATCH).
     *  - Each moved record is marked `deletedAt` in the persisted scan records
     *    so a trashed item is excluded from future duplicate/link detection,
     *    and the marker survives a fresh rescan (the scan re-applies it for
     *    ids still tracked, non-restored, in Salvage Trash).
     *
     * @param {Array<{id}>} requestedItems item ids the popup selected
     * @returns {Promise<{ok, gateRequired?, movedCount, refusedCount?, batch?}>}
     */
    function bulkMoveImpl(requestedItems) {
      var gate;
      return readBackupGate()
        .then(function (g) { gate = g; return readRecords(); })
        .then(function (records) {
          var derived = resolveEligibleMoveItems(requestedItems, records);
          // A refused/ineligible request must never mutate the tree: build the
          // dry-run only from the DERIVED eligible set.
          if (backupGateRequired(gate && gate.exportedAt)) {
            return { ok: true, gateRequired: true, movedCount: 0, dryRun: buildDryRun(derived.moveItems), refusedCount: derived.refusedCount };
          }
          if (!derived.moveItems.length) {
            return { ok: true, gateRequired: false, movedCount: 0, refusedCount: derived.refusedCount, dryRun: buildDryRun(derived.moveItems) };
          }
          return ensureTrashFolder().then(function (trashFolderId) {
            return performMoves(derived.moveItems, trashFolderId, derived.refusedCount);
          });
        });
    }

    function readRecords() {
      return storageGet([KEYS.RECORDS]).then(function (res) { return res[KEYS.RECORDS] || []; });
    }

    /**
     * Mark (or clear) the `deletedAt` scan-record marker for a set of ids.
     * A positive timestamp excludes a record from duplicate/link detection;
     * null (on restore/undo) re-includes it. Reading + writing the full records
     * array keeps it atomic under the controller's single-flight serialization.
     */
    function patchRecordsDeleted(ids, deletedAt) {
      var want = {};
      (ids || []).forEach(function (id) { want[String(id)] = true; });
      return storageGet([KEYS.RECORDS]).then(function (res) {
        var records = res[KEYS.RECORDS] || [];
        var changed = false;
        records.forEach(function (r) {
          if (want[String(r.id)] && r.deletedAt !== deletedAt) { r.deletedAt = deletedAt; changed = true; }
        });
        if (!changed) { return undefined; }
        var p = {}; p[KEYS.RECORDS] = records; p[KEYS.SCHEMA] = constants.SCHEMA_VERSION;
        return storageSet(p);
      });
    }

    // Persist the `deletedAt` marker for a whole (already-moved) batch.
    function markBatchDeleted(entries) {
      return patchRecordsDeleted((entries || []).map(function (e) { return e.id; }), now());
    }

    function performMoves(items, trashFolderId, refusedCount) {
      var trashArray = [];
      var movedCount = 0;
      var lastBatch = null;
      var i = 0;
      refusedCount = refusedCount || 0;

      // Move a single batch sequentially (no interleaving chrome calls), then
      // append the batch's entries to the in-memory trash array and persist the
      // full tracked set PLUS the durable last-batch BEFORE the next batch runs.
      function moveSlice(slice, folderId) {
        var entries = [];
        var idx = 0;
        function nextItem() {
          if (idx >= slice.length) { return Promise.resolve(entries); }
          var item = slice[idx];
          return captureOrigin(item.id).then(function (origin) {
            var entry = {
              id: item.id,
              title: item.title,
              url: item.url,
              kind: item.kind,
              originalParentId: origin.parentId,
              originalIndex: origin.index,
              movedAt: now()
            };
            if (item.groupKey) { entry.groupKey = item.groupKey; }
            return bookmarkApi.move(item.id, { parentId: folderId }).then(function () {
              entries.push(entry);
              idx += 1;
              return nextItem();
            });
          });
        }
        return nextItem();
      }

      function flushBatch(entries) {
        // Append exactly once, in order, to the accumulated tracked set.
        trashArray = trashArray.concat(entries);
        movedCount += entries.length;
        // Durable undo record: the WHOLE most recent batch, so a restarted
        // worker can undo exactly what was just moved.
        lastBatch = { createdAt: now(), entries: entries.slice() };
        // Persist trash metadata AND the pending deletedAt marker together so a
        // worker kill never leaves a moved record actively selectable again.
        return writeTrash(trashArray)
          .then(function () { return markBatchDeleted(entries); })
          .then(function () { return writeLastBatch(lastBatch); });
      }

      function loop() {
        if (i >= items.length) { return done(); }
        var slice = items.slice(i, i + batchSize);
        return moveSlice(slice, trashFolderId).then(function (entries) {
          return flushBatch(entries).then(function () {
            i += slice.length;
            return loop();
          });
        });
      }

      function done() {
        return { ok: true, gateRequired: false, movedCount: movedCount, refusedCount: refusedCount,
                 batch: lastBatch ? { createdAt: lastBatch.createdAt, movedCount: movedCount } : null };
      }

      return readTrash().then(function (existing) { trashArray = existing || []; return loop(); });
    }

    /**
     * Record that a backup download was successfully initiated. The ONLY place
     * `backupExportedAt` is written; the popup calls this AFTER the blob URL
     * click has actually started the download. Until this lands, bulk moves are
     * gated.
     */
    function recordBackupDoneImpl() {
      var g = { exportedAt: now() };
      return writeBackupGate(g).then(function () { return { ok: true, exportedAt: g.exportedAt }; });
    }

    /**
     * Restore selected tracked trash entries back to their original parent
     * (or the Bookmarks Bar fallback). Moves, never removes; reversible. Only
     * entries that are still under trash (not yet restored) are touched.
     */
    function restoreSelectedImpl(ids) {
      var trashEntries;
      return readTrash().then(function (t) { trashEntries = t; return bookmarkApi.getTree(); })
        .then(function (tree) {
          resolveBarIdFromTree(tree);
          var byId = {};
          trashEntries.forEach(function (e) { byId[String(e.id)] = e; });
          var targetEntries = (ids || []).map(function (id) { return byId[String(id)]; })
            .filter(function (e) { return e && !e.restoredAt; });
          return restoreEntries(targetEntries, tree);
        });
    }

    /**
     * Undo the last bulk batch: restore every entry recorded in the durable
     * last-batch (the whole last batch) back to its original parent. Uses the
     * persisted batch so a restarted / recreated worker can undo what a
     * terminated worker just did.
     */
    function undoLastBatchImpl() {
      var lastBatch;
      return readLastBatch().then(function (lb) {
        lastBatch = lb;
        if (!lastBatch || !lastBatch.entries || !lastBatch.entries.length) {
          return { ok: true, restoredCount: 0, message: 'nothing-to-undo' };
        }
        return readTrash().then(function (trashEntries) {
          // Undo only entries STILL tracked in trash and not yet restored. An
          // entry may have been individually restored (Restore selected) or
          // permanently purged since the batch ran; a `move` on a purged
          // bookmark id would otherwise reject and break the whole undo, and a
          // re-move of an already-restored entry would be a redundant no-op
          // that misreports the restored count. The durable batch is the
          // identity of "what the last bulk move did"; the current trash set is
          // the source of truth for "what can still be brought back".
          var tracked = {};
          (trashEntries || []).forEach(function (e) { tracked[String(e.id)] = e; });
          var undoable = (lastBatch.entries || []).filter(function (e) {
            var cur = tracked[String(e.id)];
            return !!cur && !cur.restoredAt;
          });
          return bookmarkApi.getTree().then(function (tree) {
            resolveBarIdFromTree(tree);
            if (!undoable.length) {
              return { ok: true, restoredCount: 0, message: 'nothing-to-undo' };
            }
            return restoreEntries(undoable, tree);
          });
        });
      });
    }

    function restoreEntries(targetEntries, tree) {
      var restoredCount = 0;
      var idx = 0;
      var batch = [];
      function next() {
        if (idx >= targetEntries.length) { return markRestored(); }
        var e = targetEntries[idx];
        var parentId = resolveRestoreParent(e, tree, barId);
        return bookmarkApi.move(e.id, { parentId: parentId }).then(function () {
          e.restoredAt = now();
          e.restoredTo = parentId;
          restoredCount += 1;
          batch.push(e);
          idx += 1;
          return next();
        });
      }
      function markRestored() {
        // Persist the restored markers durably (small batches already applied to
        // the in-memory array as we went; write the whole trash array once) and
        // clear the `deletedAt` scan-record marker so a restored item returns to
        // normal duplicate/link detection.
        var restoredIds = (targetEntries || []).map(function (e) { return e.id; });
        return readTrash().then(function (trashEntries) {
          var byId = {};
          trashEntries.forEach(function (x) { byId[String(x.id)] = x; });
          var changes = [];
          (targetEntries || []).forEach(function (e) {
            if (byId[String(e.id)]) { byId[String(e.id)].restoredAt = e.restoredAt; byId[String(e.id)].restoredTo = e.restoredTo; changes.push(e); }
          });
          var merged = [];
          for (var k in byId) { if (Object.prototype.hasOwnProperty.call(byId, k)) { merged.push(byId[k]); } }
          return writeTrash(merged)
            .then(function () { return patchRecordsDeleted(restoredIds, null); })
            .then(function () {
              return { ok: true, restoredCount: restoredCount };
            });
        });
      }
      return next();
    }

    function readPurgeCheckpoint() {
      return storageGet([KEYS.TRASH_PURGE]).then(function (res) { return res[KEYS.TRASH_PURGE] || null; });
    }
    function writePurgeCheckpoint(cp) {
      var p = {}; p[KEYS.TRASH_PURGE] = cp; p[KEYS.SCHEMA] = constants.SCHEMA_VERSION;
      return storageSet(p);
    }
    function clearPurgeCheckpoint() {
      return writePurgeCheckpoint(null);
    }

    /**
     * Explicit permanent purge of tracked trash entries PAST retention, after a
     * separate confirmation. This is the ONLY path that ever calls
     * chrome.bookmarks.remove, and it is scoped strictly to the tracked
     * retention-eligible ids in `TRASH`. Nothing here is automatic, and items
     * that are not yet retention-eligible are refused (never purged early).
     *
     * Robustness:
     *  - A single `bookmarkApi.remove` failure because the item no longer exists
     *    EXTERNALLY (already deleted outside the extension) must NOT abort the
     *    batch: the outcome the user asked for ("no longer tracked") is already
     *    true, so the tracked entry is finalized (dropped) and other ids continue.
     *    Other, unexpected errors leave the entry tracked and continue (the batch
     *    is never silently killed by one bad id).
     *  - Multi-item purge is durable/checkpointed (TRASH_PURGE): before the first
     *    remove the pending+done set is persisted, and it is updated as ids are
     *    processed. A terminated MV3 worker resumes the exact remaining set on a
     *    later confirmed purge — never auto-purging and never losing track.
     *
     * @param {Array<string>} ids tracked ids the user confirmed for permanent
     *        deletion
     * @returns {Promise<{ok, purgedCount, refusedCount, failedCount}>}
     */
    function purgeConfirmedImpl(ids) {
      var trashEntries;
      return readTrash().then(function (t) {
        trashEntries = t;
        return readPurgeCheckpoint();
      }).then(function (existingCp) {
        var checkpoint;
        // Resume an in-progress purge from a terminated worker if one exists;
        // re-derive from the CURRENT trash each time so restored/already-purged
        // ids are never re-touched and nothing is ever purged early.
        if (existingCp && existingCp.running && existingCp.running.length) {
          var stillInTrash = {};
          trashEntries.forEach(function (e) { stillInTrash[String(e.id)] = e; });
          var resumeRunning = (existingCp.done || []).slice(); // keep done set
          checkpoint = {
            running: (existingCp.running || []).filter(function (id) { return isEligibleForPurge(stillInTrash[String(id)], now(), retentionMs); }),
            done: resumeRunning,
            refused: existingCp.refused || 0,
            startedAt: existingCp.startedAt || now()
          };
        } else {
          var filtered = eligibleForPurge(ids, trashEntries, now(), retentionMs);
          if (!filtered.eligible.length) {
            return clearPurgeCheckpoint().then(function () {
              return { ok: true, purgedCount: 0, refusedCount: filtered.refusedCount, failedCount: 0 };
            });
          }
          checkpoint = {
            running: filtered.eligible.map(function (e) { return String(e.id); }),
            done: [],
            refused: filtered.refusedCount,
            startedAt: now()
          };
        }
        return writePurgeCheckpoint(checkpoint).then(function () {
          return runPurge(checkpoint, trashEntries);
        });
      });
    }

    function runPurge(checkpoint, trashEntries) {
      var purgedCount = 0;
      var failedCount = 0;
      var idx = 0;
      var running = checkpoint.running;

      function persistProgress() {
        // Persist trash + the durable purge checkpoint so a terminated worker
        // resumes exactly here. Never writes trash alone (metadata must not
        // become "forever" if the worker dies mid-changes).
        return writeTrash(trashEntries).then(function () { return writePurgeCheckpoint(checkpoint); });
      }

      function next() {
        if (idx >= running.length) {
          return clearPurgeCheckpoint().then(function () {
            return { ok: true, purgedCount: purgedCount, refusedCount: checkpoint.refused || 0, failedCount: failedCount };
          });
        }
        var id = running[idx];
        return attemptPurgeOne(trashEntries, id).then(function (outcome) {
          if (outcome.alreadyGone) {
            // The item no longer exists outside the extension: the end state is
            // already "not tracked", so finalize it (drop metadata) rather than
            // aborting the batch — and it is not counted as a failed purge.
            trashEntries = trashEntries.filter(function (x) { return String(x.id) !== String(id); });
            purgedCount += 1;
          } else if (outcome.purged) {
            trashEntries = trashEntries.filter(function (x) { return String(x.id) !== String(id); });
            purgedCount += 1;
          } else {
            // Unexpected error removing this id: leave it tracked and continue
            // (the batch must never be silently killed or lose the metadata).
            failedCount += 1;
          }
          checkpoint.done.push(String(id));
          idx += 1;
          return persistProgress().then(function () { return next(); });
        });
      }

      return next();
    }

    // Attempt to permanently remove one tracked id. Resolves with:
    //   { purged: true }               on a successful chrome.remove
    //   { alreadyGone: true }          when the external item no longer exists
    //   { purged: false }              on any other (unexpected) error
    function attemptPurgeOne(trashEntries, id) {
      return bookmarkApi.remove(String(id))
        .then(function () { return { purged: true }; })
        .catch(function (err) {
          // Distinguish "already gone externally" (finalize, not an error) from
          // other unexpected failures (which must keep the tracked entry).
          var msg = err && err.message ? String(err.message) : '';
          var gone = /missing|not.?found|not exists|not exist|no longer/i.test(msg);
          if (gone) { return { alreadyGone: true }; }
          return { purged: false };
        });
    }


    /**
     * Status for the Trash view: list tracked entries (with restored flag),
     * whether a backup gate is pending, and which entries are retention-eligible
     * for explicit purge.
     */
    function statusImpl() {
      return Promise.all([readTrash(), readLastBatch(), readBackupGate(), bookmarkApi.getTree()]).then(function (r) {
        var trash = r[0], lastBatch = r[1], gate = r[2], tree = r[3];
        var nowV = now();
        var purgeEligible = (trash || []).filter(function (e) { return isEligibleForPurge(e, nowV, retentionMs); })
          .map(function (e) { return String(e.id); });
        return {
          ok: true,
          trash: trash || [],
          lastBatch: lastBatch,
          gateRequired: backupGateRequired(gate && gate.exportedAt),
          backupExportedAt: gate && gate.exportedAt,
          purgeEligibleIds: purgeEligible,
          now: nowV
        };
      });
    }

    return {
      preview: serialize(previewImpl),
      bulkMove: serialize(bulkMoveImpl),
      recordBackupDone: serialize(recordBackupDoneImpl),
      restoreSelected: serialize(restoreSelectedImpl),
      undoLastBatch: serialize(undoLastBatchImpl),
      purgeConfirmed: serialize(purgeConfirmedImpl),
      status: serialize(statusImpl),
      // Pure helpers exported for tests + UI reuse
      selectableDuplicates: selectableDuplicates,
      selectableDeadLinks: selectableDeadLinks,
      resolveEligibleMoveItems: resolveEligibleMoveItems,
      buildDryRun: buildDryRun,
      backupGateRequired: backupGateRequired,
      resolveRestoreParent: resolveRestoreParent,
      isEligibleForPurge: isEligibleForPurge,
      eligibleForPurge: eligibleForPurge,
      isDeadLinkStatus: isDeadLinkStatus,
      KIND_DUPLICATE: KIND_DUPLICATE,
      KIND_DEAD_LINK: KIND_DEAD_LINK,
      RETENTION_MS: RETENTION_MS,
      DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE
    };
  }

  return {
    isDeadLinkStatus: isDeadLinkStatus,
    selectableDuplicates: selectableDuplicates,
    selectableDeadLinks: selectableDeadLinks,
    resolveEligibleMoveItems: resolveEligibleMoveItems,
    buildDryRun: buildDryRun,
    backupGateRequired: backupGateRequired,
    resolveRestoreParent: resolveRestoreParent,
    isEligibleForPurge: isEligibleForPurge,
    eligibleForPurge: eligibleForPurge,
    createTrashController: createTrashController,
    KIND_DUPLICATE: KIND_DUPLICATE,
    KIND_DEAD_LINK: KIND_DEAD_LINK,
    RETENTION_MS: RETENTION_MS,
    DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE
  };
});
