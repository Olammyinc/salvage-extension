/**
 * Library Report — pure metric computation.
 *
 * Computes the Library Report entirely from the scan's persisted records.
 * No page fetches, no network. Every count is exact, never estimated.
 *
 * All open-history metrics use a documented, deterministic proxy because the
 * Chrome bookmarks API exposes no complete open history (see README).
 *
 * This module has no chrome dependencies so it can run identically under
 * node (test harness) and in the browser worker.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalize'), require('./constants'), require('./cleanup'));
  } else {
    root.BRReport = factory(root.BRNormalize, root.BRConstants, root.BRCleanup);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (normalize, constants, cleanup) {
  'use strict';

  var METRIC = constants.METRIC;
  var STALE_YEARS = constants.STALE_YEARS;
  var MILLIS_PER_DAY = constants.MILLIS_PER_DAY;
  var DAYS_PER_YEAR = constants.DAYS_PER_YEAR;
  var NEW_FOLDER_RE = constants.NEW_FOLDER_RE;
  var TOP_CATEGORY_LIMIT = constants.TOP_CATEGORY_LIMIT;
  var formatMonthYear = constants.formatMonthYear;

  /**
   * A "recorded opening" is a positive, present dateLastUsed. Chrome began
   * persisting dateLastUsed around Chrome 114–117 and only writes it when a
   * bookmark is opened through the bookmark UI; on a real long-lived library
   * most bookmarks carry no dateLastUsed regardless of how often they were
   * actually opened. We therefore never claim "never opened"; we only report
   * what is provable: whether any open event was *recorded* for a bookmark.
   */
  function hasRecordedOpening(record) {
    return typeof record.dateLastUsed === 'number' && record.dateLastUsed > 0;
  }

  /**
   * "Last activity" is only meaningful when a recorded opening exists. For a
   * record without a positive dateLastUsed the last activity is unknown, so
   * we return 0 rather than fabricating a value from dateAdded (which would
   * incorrectly imply the bookmark was reopened at its creation time).
   */
  function lastActivityMs(record) {
    return hasRecordedOpening(record) ? record.dateLastUsed : 0;
  }

  /**
   * "Stale" ("no recorded opening in over STALE_YEARS years") is only claimed
   * for records that have a positive dateLastUsed older than STALE_YEARS.
   * Records without a recorded opening are unknown, not stale: treating an
   * absent dateLastUsed as "last activity = dateAdded" would misread "added a
   * long time ago" as "not opened in a long time", which is not provable.
   */
  function isStaleOverYears(record, now) {
    if (!hasRecordedOpening(record)) { return false; }
    var ago = now - STALE_YEARS * MILLIS_PER_DAY * DAYS_PER_YEAR;
    return record.dateLastUsed < ago;
  }

  // Build a marker for "exact duplicate", ignoring the first occurrence of a
  // normalized URL and excluding soft-deleted records. Delegates to cleanup's
  // group computation so the count and the reported groups always agree.
  function computeDuplicateCount(records) {
    return cleanup.computeDuplicateGroups(records).totalDuplicates;
  }

  function isInNewFolder(record) {
    var path = record.folderPath || [];
    for (var i = 0; i < path.length; i++) {
      if (NEW_FOLDER_RE.test(path[i])) {
        return true;
      }
    }
    return false;
  }

  function computeTopCategories(records, limit) {
    var counts = Object.create(null);
    for (var i = 0; i < records.length; i++) {
      var cat = records[i].category || constants.DEFAULT_CATEGORY;
      counts[cat] = (counts[cat] || 0) + 1;
    }
    var arr = [];
    for (var key in counts) {
      if (Object.prototype.hasOwnProperty.call(counts, key)) {
        arr.push({ name: key, count: counts[key] });
      }
    }
    arr.sort(function (a, b) {
      if (b.count !== a.count) { return b.count - a.count; }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return arr.slice(0, limit);
  }

  /**
   * Compute the full Library Report from an array of persisted bookmark
   * records.
   * @param {Array<object>} records
   * @param {number} now  epoch ms (injected for determinism in tests)
   * @param {object} [extras] optional detection inputs:
   *   { folderFindings } — the persisted read-only tree analysis produced by
   *   cleanup.analyzeFolders(). When absent, empty-folder / merge metrics are
   *   reported as zero (the scan had no tree-analysis snapshot yet).
   *   { timing } — optional { scanStartedAt, scanCompletedAt, durationMs } scan
   *   clock instrumentation, stamped verbatim onto the report so raw ms are
   *   preserved.
   * @returns {object} report
   */
  function computeReport(records, now, extras) {
    records = records || [];
    now = typeof now === 'number' ? now : Date.now();
    extras = extras || {};
    var timing = extras.timing || {};
    var startedAt = (typeof timing.scanStartedAt === 'number') ? timing.scanStartedAt : null;
    var completedAt = (typeof timing.scanCompletedAt === 'number') ? timing.scanCompletedAt : null;
    var durationMs = (typeof timing.durationMs === 'number') ? timing.durationMs : null;

    var total = records.length;

    // Oldest + span.
    var oldest = null;
    var newest = null;
    for (var i = 0; i < records.length; i++) {
      var added = records[i].dateAdded;
      if (typeof added !== 'number' || !(added > 0)) { continue; }
      if (oldest === null || added < oldest) { oldest = added; }
      if (newest === null || added > newest) { newest = added; }
    }

    var ageYears = 0;
    if (oldest !== null && newest !== null) {
      ageYears = Math.floor((newest - oldest) / MILLIS_PER_DAY / DAYS_PER_YEAR);
    }

    var oldestRecord = null;
    if (oldest !== null) {
      for (var j = 0; j < records.length; j++) {
        if (records[j].dateAdded === oldest) {
          oldestRecord = records[j];
          break;
        }
      }
    }

    // Exact duplicates: deterministic groups from persisted records (excluding
    // soft-deleted). DUPLICATES stays an exact count; DUPLICATE_GROUPS_LIST
    // carries the read-only groups the popup renders.
    var dupGroups = cleanup.computeDuplicateGroups(records);
    var duplicates = dupGroups.totalDuplicates;
    var duplicateGroupsList = stripDuplicateDetails(dupGroups.groups);
    var folderFindings = extras.folderFindings || null;
    var emptyFolders = (folderFindings && folderFindings.emptyFolders) || [];
    var sameNameGroups = (folderFindings && folderFindings.sameNameMergeGroups) || [];
    var emptyFoldersList = stripFolderDetails(emptyFolders);
    var sameNameMergeList = stripMergeDetails(sameNameGroups);

    var newFolderCount = 0;
    var staleOver2Years = 0;
    var noRecordedOpening = 0;
    var openHistoryCount = 0;
    for (var k = 0; k < records.length; k++) {
      var r = records[k];
      if (isInNewFolder(r)) { newFolderCount += 1; }
      if (isStaleOverYears(r, now)) { staleOver2Years += 1; }
      if (hasRecordedOpening(r)) { openHistoryCount += 1; } else { noRecordedOpening += 1; }
    }
    // Coverage fraction of the library that carries a recorded opening.
    var openCoverage = total > 0 ? openHistoryCount / total : 0;

    var topCategories = computeTopCategories(records, TOP_CATEGORY_LIMIT);

    var uncategorized = 0;
    for (var m = 0; m < records.length; m++) {
      if ((records[m].category || constants.DEFAULT_CATEGORY) === constants.DEFAULT_CATEGORY) {
        uncategorized += 1;
      }
    }

    var report = {};
    report[METRIC.TOTAL] = total;
    report[METRIC.LIBRARY_AGE_YEARS] = ageYears;
    report[METRIC.SAVED_SINCE] = oldest !== null ? formatMonthYear(oldest) : null;
    report[METRIC.OLDEST] = {
      id: oldestRecord ? oldestRecord.id : null,
      moniker: oldest !== null ? formatMonthYear(oldest) : null,
      title: oldestRecord ? oldestRecord.title : null,
      url: oldestRecord ? oldestRecord.url : null,
      dateAdded: oldest
    };
    report[METRIC.DUPLICATES] = duplicates;
    report[METRIC.DUPLICATE_GROUPS_LIST] = duplicateGroupsList;
    report[METRIC.EMPTY_FOLDERS] = emptyFoldersList.length;
    report[METRIC.EMPTY_FOLDERS_LIST] = emptyFoldersList;
    report[METRIC.SAME_NAME_MERGE] = sameNameMergeList.length;
    report[METRIC.SAME_NAME_MERGE_LIST] = sameNameMergeList;
    report[METRIC.NEW_FOLDER] = newFolderCount;
    report[METRIC.STALE_OVER_2_YEARS] = staleOver2Years;
    report[METRIC.NO_RECORDED_OPENING] = noRecordedOpening;
    report[METRIC.OPEN_HISTORY] = openHistoryCount;
    report[METRIC.OPEN_COVERAGE] = openCoverage;
    report[METRIC.TOP_CATEGORIES] = topCategories;
    report[METRIC.UNCATEGORIZED] = uncategorized;
    report[METRIC.GENERATED_AT] = now;
    // Scan duration instrumentation (raw ms preserved verbatim).
    report[METRIC.SCAN_STARTED_AT] = startedAt;
    report[METRIC.SCAN_COMPLETED_AT] = completedAt;
    report[METRIC.DURATION_MS] = durationMs;

    return report;
  }

  // Strip down to a serializable, read-only description of each duplicate
  // group. Item fields are limited to what the read-only list renders and
  // nothing implies a write path.
  function stripDuplicateDetails(groups) {
    if (!groups) { return []; }
    return groups.map(function (g) {
      return {
        normalizedUrl: g.normalizedUrl,
        count: g.count,
        items: g.items.map(function (r) { return duckRecord(r); }),
        duplicates: g.duplicates.map(function (r) { return duckRecord(r); })
      };
    });
  }

  function stripFolderDetails(folders) {
    if (!folders) { return []; }
    return folders.map(function (f) {
      return { id: f.id, title: f.title, path: f.path };
    });
  }

  function stripMergeDetails(groups) {
    if (!groups) { return []; }
    return groups.map(function (g) {
      return {
        parentPath: g.parentPath,
        name: g.name,
        displayName: g.displayName,
        count: g.count,
        folders: g.folders.map(function (f) { return { id: f.id, title: f.title, path: f.path }; })
      };
    });
  }

  function duckRecord(r) {
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      folderPath: r.folderPath,
      category: r.category,
      deletedAt: (typeof r.deletedAt === 'number') ? r.deletedAt : null
    };
  }

  return {
    computeReport: computeReport,
    lastActivityMs: lastActivityMs,
    hasRecordedOpening: hasRecordedOpening,
    isStaleOverYears: isStaleOverYears,
    computeDuplicateCount: computeDuplicateCount,
    isInNewFolder: isInNewFolder,
    computeTopCategories: computeTopCategories
  };
});
