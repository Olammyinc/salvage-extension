/**
 * Shared configuration and structured user-visible product copy.
 *
 * The literal user-visible product name lives in a single place:
 * `_locales/en/messages.json` (`extensionName`). In the extension runtime the
 * name is fetched from there via `chrome.i18n.getMessage` so renaming the
 * product is a one-line change in messages.json. When running under Node (unit
 * tests, no chrome.* API), a neutral, non-product placeholder is used instead
 * so imports never panic. All other user-facing strings live here.
 *
 * Neutral internal identifiers (storage keys, alarm names, schema version)
 * deliberately do not embed any product name, so renaming later never
 * requires migrating real user data.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BRConstants = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Product identity -------------------------------------------------------
  // Sole source of the literal product name is `_locales/en/messages.json`
  // (`extensionName`). Read it through chrome.i18n when running in the browser
  // runtime; fall back to a neutral, non-product placeholder under Node (unit
  // tests) where no chrome.* API exists.
  var PRODUCT_NAME =
    (typeof chrome === 'object' &&
      chrome !== null &&
      typeof chrome.i18n === 'object' &&
      typeof chrome.i18n.getMessage === 'function')
      ? chrome.i18n.getMessage('extensionName')
      : 'Bookmark Extension';

  // Neutral storage keys (no product name embedded) -------------------------
  var KEYS = {
    SCHEMA: 'schemaVersion',
    CHECKPOINT: 'checkpoint',
    QUEUE: 'queue',
    RECORDS: 'records',
    REPORT: 'report',
    LAST_SCAN: 'lastScanAt',
    // Detection: folder findings (empty folders + merge candidates)
    // derived from a read-only tree snapshot, plus the link-check lifecycle
    // (its own checkpoint and its result summary). Link statuses themselves are
    // written back on each record (linkStatus / linkCheckedAt).
    FOLDER_FINDINGS: 'folderFindings',
    LINK_CHECKPOINT: 'linkCheckpoint',
    LINK_REPORT: 'linkReport',
    // Safe cleanup: tracked Trash metadata is kept SEPARATE from the
    // live scan `records`. TRASH holds the tracked trash entries (original
    // parentId, title, url, originalIndex, kind, movedAt); TRASH_LAST_BATCH is
    // the durable record of the most recent bulk-move batch so a restarted MV3
    // worker can Undo it; TRASH_BACKUP_GATE records the first completed backup
    // download timestamp that gates the first bulk move.
    TRASH: 'trash',
    TRASH_LAST_BATCH: 'trashLastBatch',
    TRASH_BACKUP_GATE: 'trashBackupGate',
    // Durable progress for an in-flight, explicit confirmed multi-item purge. It
    // records which tracked ids are pending and which are done so a terminated MV3
    // worker resumes the exact remaining set. Purging is NEVER automatic: this
    // key only exists while an eligible, separately-confirmed purge is in flight
    // and is cleared on completion.
    TRASH_PURGE: 'trashPurge'
  };

  var SCHEMA_VERSION = 1;

  // Scan configuration ------------------------------------------------------
  // ~75 links per chunk.
  var CHUNK_SIZE = 75;
  var ALARM_NAME = 'scanner-wake';
  // The link check is a separate lifecycle from the library scan, so it owns a
  // neutral, distinct alarm name. This keeps a scan wake from being cleared by
  // link completion (and vice versa) and lets the service worker route each
  // alarm only to the controller that scheduled it.
  var LINK_ALARM_NAME = 'link-check-wake';
  // Chrome throttles alarms to roughly one wake per minute. Chunks are
  // processed within each active worker window and the alarm re-arms to the
  // next wake.
  var ALARM_MINUTES = 1;
  // An MV3 service worker is terminated when it goes idle (~30 s) or exceeds
  // its active-window budget. We therefore bound how long a single worker
  // wake may keep processing: once this budget is reached the controller
  // checkpoints where it is, schedules the alarm, and yields. Because resume
  // always reads the checkpoint from storage, this budget is safe across
  // termination — losing the in-memory timing on a kill only shortens a
  // window, never corrupts the scan. A small default keeps well under
  // Chrome's ~30 s idle kill.
  var ACTIVE_WINDOW_MS = 20000;
  // Stale threshold: "not opened in over 2 years".
  var STALE_YEARS = 2;
  var MILLIS_PER_DAY = 86400000;
  var DAYS_PER_YEAR = 365.25;

  // Folder naming rule for the "New Folder" metric.
  var NEW_FOLDER_RE = /^New Folder(\s*\(\d+\))?\s*$/i;

  // Checkpoint phases.
  var PHASE = {
    IDLE: 'idle',
    SCANNING: 'scanning',
    DONE: 'done',
    FAILED: 'failed'
  };

  // Categorization behaviour ------------------------------------------------
  var CATEGORY_SOURCE = 'heuristic';
  var CATEGORY_CONFIDENCE = 1; // rules match is exact by construction in M1
  // Neutral fallback category used when no domain/keyword rule matches.
  var DEFAULT_CATEGORY = 'Other';
  var CATEGORIES = [
    'Development',
    'Recipes',
    'Travel',
    'Shopping',
    'Work',
    'Learning',
    'Tools',
    'Research',
    'News',
    'Entertainment',
    'Other'
  ];

  // Link status: three-state result. Only a
  // confirmed dead response (404/410) may be `unreachable`; every other
  // failure — 401, 403, 429, 5xx, unresolved redirects, challenges, CORS and
  // timeout errors — is `could_not_check`. Successful 2xx responses (including
  // normal followed redirects) are `reachable`. Before any check runs the
  // schema holds `unchecked` so nothing is asserted without evidence.
  var LINK_STATUS_UNCHECKED = 'unchecked';
  var LINK_STATUS_REACHABLE = 'reachable';
  var LINK_STATUS_UNREACHABLE = 'unreachable';
  var LINK_STATUS_COULD_NOT_CHECK = 'could_not_check';
  var PAGE_TYPE_DEFAULT = 'bookmark';

  // Link-check configuration ------------------------------------------------
  // A per-request timeout bounds a single fetch within an active worker
  // window. It is a per-operation bound (not cross-wake scheduling), so using
  // a bounded timer inside the fetch is consistent with the alarms-only rule
  // for scan continuation. Timeouts are always classified could_not_check.
  var LINK_CHECK_TIMEOUT_MS = 8000;
  // Network-bound checks are smaller than scan chunks so a worker window stays
  // within its budget while link statuses settle.
  var LINK_CHUNK_SIZE = 25;
  var LINK_ACTIVE_WINDOW_MS = 15000;

  // Backup export configuration -----------------------------------------------
  // A restorable JSON export is always complete (never partial, never gated).
  var BACKUP_SCHEMA = 'bookmark-library-backup';
  var BACKUP_VERSION = 1;
  var BACKUP_FILE_NAME = 'bookmark-library-backup.json';

  // Safe cleanup ---------------------------------------------------------------
  // The user-approved, visible folder into which selected items are MOVED (never
  // deleted during normal cleanup), so browser-tree cleanup is fully reversible.
  var TRASH_FOLDER_NAME = 'Salvage Trash';
  // Minimum retention (days) before a tracked trash entry may even be presented
  // for explicit permanent purge. Purge is NEVER automatic and always doubly
  // confirmed; only tracked records past retention may be presented.
  var TRASH_RETENTION_DAYS = 30;

  // Report metrics ----------------------------------------------------------
  // Keys used inside the persisted report object.
  var METRIC = {
    TOTAL: 'total',
    LIBRARY_AGE_YEARS: 'libraryAgeYears',
    SAVED_SINCE: 'savedSince',
    OLDEST: 'oldestBookmark',
    DUPLICATES: 'duplicates',
    NEW_FOLDER: 'newFolderCount',
    STALE_OVER_2_YEARS: 'staleOver2Years',
    NO_RECORDED_OPENING: 'noRecordedOpening',
    OPEN_HISTORY: 'openHistoryCount',
    OPEN_COVERAGE: 'openHistoryCoverage',
    TOP_CATEGORIES: 'topCategories',
    UNCATEGORIZED: 'uncategorized',
    GENERATED_AT: 'generatedAt',
    // Detection fields. The count keys stay exact and neutral; the
    // *_LIST keys carry the read-only detail the popup renders behind each
    // count (never mutating anything).
    DUPLICATE_GROUPS_LIST: 'duplicateGroupsList',
    EMPTY_FOLDERS: 'emptyFolders',
    EMPTY_FOLDERS_LIST: 'emptyFoldersList',
    SAME_NAME_MERGE: 'sameNameMergeGroups',
    SAME_NAME_MERGE_LIST: 'sameNameMergeList',
    // Scan + link-check duration instrumentation. Exact raw milliseconds are
    // persisted so the wall-clock span across worker wakes, termination and
    // resume is preserved verbatim; neutral formatting happens only at render.
    SCAN_STARTED_AT: 'scanStartedAt',
    SCAN_COMPLETED_AT: 'scanCompletedAt',
    LINK_STARTED_AT: 'linkStartedAt',
    LINK_COMPLETED_AT: 'linkCompletedAt',
    DURATION_MS: 'durationMs'
  };

  var TOP_CATEGORY_LIMIT = 3;

  // Formatting helpers used by report.js to build neutral copy ---------------
  // All copy is intentionally neutral: this is someone's accumulated library,
  // and the report must never shame or scold the user.

  function formatMonthYear(ms) {
    var d = new Date(ms);
    var months = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ];
    return months[d.getMonth()] + ' ' + d.getFullYear();
  }

  // "9" from a span of milliseconds on the 365.25-day-year basis.
  function yearsBetween(msFrom, msTo) {
    return Math.floor((msTo - msFrom) / MILLIS_PER_DAY / DAYS_PER_YEAR);
  }

  // Neutral duration formatter. Accepts exact raw milliseconds and renders a
  // short human scale ("12s", "2m 3s"). Sub-second raw input still produces a
  // stable, neutral output ("< 1s") rather than inventing precision.
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { return '0s'; }
    var totalSeconds = ms / 1000;
    if (totalSeconds < 1) { return '< 1s'; }
    if (totalSeconds < 60) {
      var s = Math.round(totalSeconds);
      return s === 1 ? '1s' : s + 's';
    }
    var minutes = Math.floor(totalSeconds / 60);
    var remSeconds = Math.round(totalSeconds - minutes * 60);
    if (remSeconds === 60) { minutes += 1; remSeconds = 0; }
    var parts = [];
    if (minutes > 0) { parts.push(minutes === 1 ? '1m' : minutes + 'm'); }
    if (remSeconds > 0) { parts.push(remSeconds === 1 ? '1s' : remSeconds + 's'); }
    return parts.length ? parts.join(' ') : minutes + 'm';
  }

  // ---- User-visible copy (report + UI) --------------------------------------
  var COPY = {
    appName: PRODUCT_NAME,

    libraryLine: function (total, ageYears) {
      return PRODUCT_NAME + ' found your library: ' + total + ' bookmarks, ' +
        'saved over ' + ageYears + ' years.';
    },
    libraryLineShort: function (total) {
      return 'Your library: ' + total + ' bookmarks';
    },

    scanInProgress: 'Scanning your library. Progress is saved and resumes automatically if interrupted.',
    progressLine: function (processed, total) {
      return 'Scanning your library (' + processed + ' of ' + total + '). ' +
        'Progress is saved and resumes automatically if interrupted.';
    },
    scanStarting: 'Starting scan...',
    scanDone: 'Ready.',
    scanFailed: 'Scan could not complete. Click Scan now to retry.',

    // Duration instrumentation copy: exposed next to the Library Report, using
    // the neutral formatter. The total and duration come from persisted data.
    scanDurationLine: function (total, durationMs) {
      return 'Scanned ' + total + ' bookmark' + (total === 1 ? '' : 's') + ' in ' + formatDuration(durationMs);
    },

    metricLabels: {
      // Each maps a metric key to its neutral report line.
      // Placeholder {n} is replaced with the exact count.
    },

    newFolderLine: function (n) {
      return n + ' in folders named "New Folder"';
    },
    newFolderCta: 'Sort these',
    staleLine: function (n) {
      return n + ' last recorded opening over 2 years ago';
    },
    staleCta: 'Review',
    noRecordedOpeningLine: function (n) {
      return n + ' with no recorded opening';
    },
    noRecordedOpeningCta: 'Review',
    // Instrumentation for open-history provenance: how many bookmarks carry a
    // recorded open event, and at what fraction of the library.
    openHistoryLine: function (count, total, coverage) {
      return 'Open history recorded for ' + count + ' of ' + total +
        ' bookmarks (' + Math.round(coverage * 100) + '%).';
    },
    oldestLine: function (moniker) {
      return 'Oldest bookmark: ' + moniker;
    },
    topicsHeader: 'Your biggest topics: ',
    topicsSeparator: ' \u00b7 ',
    savedSince: function (moniker) {
      return 'Saved since ' + moniker;
    },

    emptyState: 'No scan results yet. Start a scan to see your library report.',
    scanNow: 'Scan now',
    rescan: 'Rescan',
    backButton: 'Back',
    footerNote: 'Read-only. Your bookmark tree is never modified.',
    reportTitle: 'Library Report',
    openList: 'Filtered list',
    listCountLine: function (n) {
      return n + ' shown in this read-only list';
    },

    // ---- Detection copy (backup export + cleanup findings) -------------------
    // Always-visible, never-gated backup export.
    backupButton: 'Back up library',
    backupDescription: 'Export your full bookmark tree as a JSON file you can restore from. The export is always complete.',
    backupReady: 'Backup exported.',
    backupFailed: 'Backup could not be created.',
    backupFilename: 'bookmark-library-backup.json',

    // Exact duplicates (from persisted records, excluding soft-deleted).
    duplicatesLine: function (n) {
      return n + ' exact duplicate' + (n === 1 ? '' : 's');
    },
    duplicatesCta: 'Review',

    // Empty folders (from a read-only tree snapshot).
    emptyFoldersLine: function (n) {
      return n + ' empty folder' + (n === 1 ? '' : 's');
    },
    emptyFoldersCta: 'Review',

    // Same-name folder merge candidates (reported only, never merged).
    sameNameMergeLine: function (n) {
      return n + ' same-name folder group' + (n === 1 ? '' : 's') + ' that could be merged';
    },
    sameNameMergeCta: 'Review',

    // ---- Link-check copy (opt-in, permission-gated) --------------------------
    linkCheckSection: 'Dead links',
    linkCheckButton: 'Check links',
    linkCheckExplain: 'Checking links sends a request to each bookmarked page. This needs temporary access and can take a while. Nothing is modified or deleted.',
    linkCheckGranting: 'Requesting access to check links...',
    linkCheckRunning: 'Checking links. Progress is saved and resumes automatically if interrupted.',
    // Truthful in-flight progress, rendered only while a check is actually
    // running. The counts come from the persisted link checkpoint so the
    // numbers always match what will be finished — never a fabricated state.
    linkCheckProgressLine: function (processed, total) {
      return 'Checking links (' + processed + ' of ' + total + '). ' +
        'Progress is saved and resumes automatically if interrupted.';
    },
    linkCheckNeedsAccess: 'Temporary access is required to check links. Grant it to continue.',
    linkCheckNotRun: 'Links have not been checked yet.',
    linkCheckReachableLine: function (n) { return n + ' reachable'; },
    linkCheckUnreachableLine: function (n) { return n + ' confirmed dead'; },
    linkCheckCouldNotCheckLine: function (n) { return n + ' could not be checked'; },
    // Duration line shown above the three-state split after a completed check.
    linkCheckDurationLine: function (checked, durationMs) {
      return 'Checked ' + checked + ' link' + (checked === 1 ? '' : 's') + ' in ' + formatDuration(durationMs);
    },

    // ---- Cleanup copy (Salvage Trash) -----------------------------------------
    // Cleanup selection / dry-run / confirmation.
    cleanupSelectForTrash: 'Select items to move to ' + TRASH_FOLDER_NAME,
    cleanupSelectedCta: function (n) { return 'Move ' + n + ' to ' + TRASH_FOLDER_NAME; },
    cleanupRemoveSelected: 'Move selected',
    cleanupNothingSelected: 'Select items to move first.',
    // Itemized dry-run confirmation (backed by buildDryRun).
    cleanupDryRunTitle: function (n) {
      return 'Move ' + n + ' item' + (n === 1 ? '' : 's') + ' to ' + TRASH_FOLDER_NAME + '?';
    },
    cleanupDryRunDuplicates: function (n) { return n + ' exact duplicate' + (n === 1 ? '' : 's'); },
    cleanupDryRunDeadLinks: function (n) { return n + ' confirmed dead link' + (n === 1 ? '' : 's'); },
    cleanupDryRunExplain: 'These will be MOVED (not deleted) so you can undo anytime.',
    cleanupConfirmMove: 'Move to trash',
    cleanupCancel: 'Cancel',
    cleanupMoveDone: function (n) { return 'Moved ' + n + ' item' + (n === 1 ? '' : 's') + ' to ' + TRASH_FOLDER_NAME + '. You can undo from the Trash view.'; },
    cleanupMoveFailed: 'Could not move items.',
    // Used when a cleanup move resolved OK but moved ZERO items because every
    // requested selection was already gone / no longer eligible (rescan reset the
    // link statuses, or the items were already moved). Never claim a successful
    // move on `movedCount === 0`.
    cleanupMoveRefused: 'Nothing was moved. The selected items are no longer eligible (they may already be in ' + TRASH_FOLDER_NAME + ' or were reset by a rescan).',
    // Backup gate.
    cleanupBackupRequired: 'Back up your library first. The first bulk cleanup is gated behind a full backup export.',
    cleanupBackupNow: 'Back up and continue',
    cleanupGateCleared: 'Backup recorded. You can now move items safely.',

    // Trash view.
    trashSection: 'Trash',
    trashEmpty: 'Trash is empty.',
    trashBackupNote: 'A backup was recorded before your first bulk move.',
    trashRestoreSelected: 'Restore selected',
    trashRestoreDone: function (n) { return 'Restored ' + n + ' item' + (n === 1 ? '' : 's') + '.'; },
    trashUndoLast: 'Undo last move',
    trashUndoNothing: 'Nothing to undo.',
    trashNoRestored: 'Use the boxes to select items to restore.',
    // Retention-based explicit purge (never automatic, doubly confirmed).
    trashPurgeEligible: function (n) { return n + ' item' + (n === 1 ? '' : 's') + ' in trash for 30+ days.'; },
    trashPurgeCta: 'Purge eligible',
    trashPurgeConfirmTitle: function (n) { return 'Permanently delete ' + n + ' item' + (n === 1 ? '' : 's') + '? This cannot be undone.'; },
    trashPurgeExplain: 'Only items tracked in trash for over 30 days are eligible. Nothing else is touched.',
    trashPurgeConfirm: 'Delete permanently',
    trashPurgeDone: function (n) { return 'Permanently deleted ' + n + ' item' + (n === 1 ? '' : 's') + '.'; },
    trashPurgeRefused: 'Some items were not yet eligible and were left in trash.',
    trashNoEligible: 'No items are eligible for permanent deletion yet.',
    // Permissions / status.
    trashNothingSelected: 'Select trash items first.',

    pageTitle: PRODUCT_NAME,

    anonymousPageTitle: 'Bookmarks for ' + PRODUCT_NAME
  };

  return {
    PRODUCT_NAME: PRODUCT_NAME,
    KEYS: KEYS,
    SCHEMA_VERSION: SCHEMA_VERSION,
    CHUNK_SIZE: CHUNK_SIZE,
    ALARM_NAME: ALARM_NAME,
    LINK_ALARM_NAME: LINK_ALARM_NAME,
    ALARM_MINUTES: ALARM_MINUTES,
    ACTIVE_WINDOW_MS: ACTIVE_WINDOW_MS,
    STALE_YEARS: STALE_YEARS,
    MILLIS_PER_DAY: MILLIS_PER_DAY,
    DAYS_PER_YEAR: DAYS_PER_YEAR,
    NEW_FOLDER_RE: NEW_FOLDER_RE,
    PHASE: PHASE,
    CATEGORY_SOURCE: CATEGORY_SOURCE,
    CATEGORY_CONFIDENCE: CATEGORY_CONFIDENCE,
    DEFAULT_CATEGORY: DEFAULT_CATEGORY,
    CATEGORIES: CATEGORIES,
    LINK_STATUS_UNCHECKED: LINK_STATUS_UNCHECKED,
    LINK_STATUS_REACHABLE: LINK_STATUS_REACHABLE,
    LINK_STATUS_UNREACHABLE: LINK_STATUS_UNREACHABLE,
    LINK_STATUS_COULD_NOT_CHECK: LINK_STATUS_COULD_NOT_CHECK,
    LINK_CHECK_TIMEOUT_MS: LINK_CHECK_TIMEOUT_MS,
    LINK_CHUNK_SIZE: LINK_CHUNK_SIZE,
    LINK_ACTIVE_WINDOW_MS: LINK_ACTIVE_WINDOW_MS,
    BACKUP_SCHEMA: BACKUP_SCHEMA,
    BACKUP_VERSION: BACKUP_VERSION,
    BACKUP_FILE_NAME: BACKUP_FILE_NAME,
    TRASH_FOLDER_NAME: TRASH_FOLDER_NAME,
    TRASH_RETENTION_DAYS: TRASH_RETENTION_DAYS,
    PAGE_TYPE_DEFAULT: PAGE_TYPE_DEFAULT,
    METRIC: METRIC,
    TOP_CATEGORY_LIMIT: TOP_CATEGORY_LIMIT,
    formatMonthYear: formatMonthYear,
    yearsBetween: yearsBetween,
    formatDuration: formatDuration,
    COPY: COPY
  };
});
