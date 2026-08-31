/**
 * Background service worker (Manifest V3).
 *
 * Binds the pure scan controller to chrome.* APIs and wires chrome.alarms
 * and chrome.runtime messages. All scan progress and state live in
 * chrome.storage; no in-memory scan state is kept in this module.
 */
// In Firefox (background.scripts), the shared modules are loaded as classic
// scripts before this file, so their globals already exist.  In Chromium
// (background.service_worker) we must import them ourselves.
if (typeof BRConstants === 'undefined') {
  importScripts(
    '../shared/constants.js',
    '../shared/normalize.js',
    '../shared/categorize.js',
    '../shared/cleanup.js',
    '../shared/backup.js',
    '../shared/link-checker.js',
    '../shared/report.js',
    '../shared/trash.js',
    '../shared/messaging.js',
    '../shared/scan-controller.js'
  );
}

const { KEYS, PHASE, ALARM_NAME, LINK_ALARM_NAME, ALARM_MINUTES } = BRConstants;
const { createScanController } = BRScan;
const { buildBackup, serializeBackup } = BRBackup;
const { createLinkCheckController } = BRLinks;
const { createTrashController } = BRTrash;
const { isTrustedSender, isConfirmedPurge } = BRMessaging;

// Rules are static configuration (not scan state), so the parsed map is
// cached in memory after the first successful load.
let rulesCachePromise = null;

function loadRules() {
  if (!rulesCachePromise) {
    rulesCachePromise = fetch(chrome.runtime.getURL('shared/rules-data.json'))
      .then((r) => {
        if (!r.ok) { throw new Error('rules data fetch failed: ' + r.status); }
        return r.json();
      })
      .catch((err) => {
        rulesCachePromise = null; // allow a later retry
        throw err;
      });
  }
  return rulesCachePromise;
}

let controller = null;

function getController() {
  if (!controller) {
    controller = createScanController({
      bookmarkApi: chrome.bookmarks,
      storageGet: (keys) => chrome.storage.local.get(keys),
      storageSet: (obj) => chrome.storage.local.set(obj),
      loadRules: loadRules,
      scheduleWake: () => chrome.alarms.create(ALARM_NAME, { delayInMinutes: ALARM_MINUTES }),
      clearWake: () => chrome.alarms.clear(ALARM_NAME, () => {}),
      sendProgress: (payload) => {
        chrome.runtime.sendMessage({ type: 'scan-progress', payload }).catch(() => {});
      },
      getNow: () => Date.now(),
      // M3 trash integration: after a fresh rescan, re-apply the soft-delete
      // marker to records whose bookmark is currently tracked, non-restored, in
      // Salvage Trash — so a trashed item is never re-offered and its copy never
      // re-enters duplicate/link detection even though the bookmark remains in
      // the tree under Salvage Trash.
      loadTrashDeletedIds: () => chrome.storage.local
        .get(KEYS.TRASH)
        .then((res) => (res[KEYS.TRASH] || [])
          .filter((e) => e && e.movedAt && !e.restoredAt)
          .map((e) => String(e.id)))
    });
  }
  return controller;
}

function handleResume() {
  return getController().resume().catch((err) => {
    console.error('[bookmark-scan] resume failed:', err);
  });
}

// Permissions-gated, chunked link checker. Lazy-created like the
// scan controller; the check runs only after the popup has obtained the
// optional <all_urls> host permission.
let linkController = null;

function getLinkController() {
  if (!linkController) {
    linkController = createLinkCheckController({
      fetchImpl: (url, opts) => fetch(url, opts),
      storageGet: (keys) => chrome.storage.local.get(keys),
      storageSet: (obj) => chrome.storage.local.set(obj),
      getNow: () => Date.now(),
      // The link check owns a distinct alarm name so its completion never clears
      // the scan alarm and vice versa.
      scheduleWake: () => chrome.alarms.create(LINK_ALARM_NAME, { delayInMinutes: ALARM_MINUTES }),
      clearWake: () => chrome.alarms.clear(LINK_ALARM_NAME, () => {}),
      hasPermission: () => chrome.permissions.contains({ origins: ['<all_urls>'] }),
      sendProgress: (payload) => {
        chrome.runtime.sendMessage({ type: 'link-check-progress', payload }).catch(() => {});
      }
    });
  }
  return linkController;
}

function handleLinkResume() {
  return getLinkController().resume().catch((err) => {
    console.error('[bookmark-links] resume failed:', err);
  });
}

// Safe cleanup / Salvage Trash controller. Lazy-created like the
// others; serialized internally so bulk move / restore / undo / purge never
// overlap on the same real bookmark tree. It uses only the existing
// `bookmarks` permission (no new host permissions).
let trashController = null;

function getTrashController() {
  if (!trashController) {
    trashController = createTrashController({
      bookmarkApi: chrome.bookmarks,
      storageGet: (keys) => chrome.storage.local.get(keys),
      storageSet: (obj) => chrome.storage.local.set(obj),
      getNow: () => Date.now()
    });
  }
  return trashController;
}

// On startup: always read the checkpoint and resume an incomplete scan and any
// in-flight link check. Each controller resumes only from its own persisted
// checkpoint; a terminated worker picks up exactly where it left off.
handleResume();
handleLinkResume();

// Each alarm routes only to the controller that scheduled it, so a scan wake is
// never cleared by link completion and vice versa.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) { handleResume(); return; }
  if (alarm.name === LINK_ALARM_NAME) { handleLinkResume(); }
});

// Start a scan when the extension is installed (or the browser updates).
chrome.runtime.onInstalled.addListener(() => {
  getController().startNewScan().catch((err) => {
    console.error('[bookmark-scan] initial scan failed:', err);
    chrome.storage.local.set({ scriptError: String(err && err.message) }).catch(() => {});
  });
});

// Popup asks for status or requests a (re)scan.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defence in depth: only ever act on messages that originate from this
  // extension. The extension declares no `externally_connectable`, so every
  // legitimate sender carries sender.id === chrome.runtime.id; anything else
  // (a foreign extension, a page without an id) is ignored outright.
  if (!isTrustedSender(sender, chrome.runtime.id)) { return false; }
  if (!message || typeof message.type !== 'string') { return; }

  switch (message.type) {
    case 'scan-status':
      chrome.storage.local
        .get([KEYS.CHECKPOINT, KEYS.REPORT, KEYS.LAST_SCAN])
        .then((res) => sendResponse({
          ok: true,
          checkpoint: res[KEYS.CHECKPOINT] || null,
          report: res[KEYS.REPORT] || null,
          lastScanAt: res[KEYS.LAST_SCAN] || null
        }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'scan-now':
      // Rapid-click safe: requestScan refuses to restart a scan that is already
      // in the SCANNING phase, so repeated/rapid Scan now clicks can never pile
      // up a queue of full rescans (the single-flight serialize already prevents
      // overlapping writes; this layers on dedup so the scan cannot loop).
      getController()
        .requestScan()
        .then((res) => {
          // When every storageSet write in the scan failure path rejected, the
          // controller returns {failed:true, phase:PHASE.FAILED, error} without
          // throwing. Map that to ok:false so the popup displays COPY.scanFailed
          // and re-enables the Scan now button immediately (no storage event
          // needed).
          if (res && res.failed) {
            sendResponse({ ok: false, phase: res.phase || PHASE.FAILED, error: res.error || 'scan failed' });
          } else {
            sendResponse({ ok: true, skipped: !!(res && res.skipped), phase: (res && res.phase) || null });
          }
        })
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'open-list':
      // Lists are read-only and rendered inside the popup; this message is a
      // no-op placeholder kept for forward compatibility.
      sendResponse({ ok: true });
      return false;

    case 'backup-export':
      // Full, never-partial backup export. Grabs the
      // complete bookmark tree and serializes it to a restorable JSON string.
      // The popup downloads it as a file — no extra download permission needed.
      chrome.bookmarks
        .getTree()
        .then((tree) => {
          const backup = buildBackup(tree, Date.now());
          const json = serializeBackup(backup);
          sendResponse({ ok: true, fileName: BRConstants.BACKUP_FILE_NAME, json });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'check-links':
      // Permission-gated opt-in. The controller refuses to run without the
      // optional <all_urls> host permission; the popup obtains it first. This
      // message alone never issues a fetch unless permission is already held.
      getLinkController()
        .start()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message), code: err && err.code }));
      return true; // async response

    case 'link-check-status':
      chrome.storage.local
        .get([KEYS.LINK_REPORT, KEYS.LINK_CHECKPOINT])
        .then((res) => sendResponse({
          ok: true,
          linkReport: res[KEYS.LINK_REPORT] || null,
          linkCheckpoint: res[KEYS.LINK_CHECKPOINT] || null
        }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    // ---- Safe cleanup / Salvage Trash ----------------------------------------

    case 'trash-status':
      getTrashController()
        .status()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'trash-preview':
      // Itemized dry-run preview, no mutation. The popup sends the user's
      // selected (not preselected) items; the reply carries the precise
      // confirmation plus whether the backup gate is still pending.
      getTrashController()
        .preview(message.items || [])
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'cleanup-move':
      // Moves selected items to the Salvage Trash folder (never removes). A
      // gateRequired result means a backup export must be completed first.
      getTrashController()
        .bulkMove(message.items || [])
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'cleanup-record-backup-done':
      // Called by the popup ONLY after the backup download actually initiated.
      // This is the single place `backupExportedAt` is persisted, unblocking
      // the first bulk move.
      getTrashController()
        .recordBackupDone()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'trash-restore':
      getTrashController()
        .restoreSelected(message.ids || [])
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'trash-undo':
      getTrashController()
        .undoLastBatch()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    case 'trash-purge':
      // Explicit, doubly-confirmed permanent purge of tracked trash entries
      // PAST retention only. The popup must have separately confirmed and sent
      // the `'confirmed'` sentinel; without it the destructive path is refused.
      if (!isConfirmedPurge(message)) {
        sendResponse({ ok: false, error: 'unconfirmed', code: 'NEEDS_CONFIRMATION' });
        return false;
      }
      getTrashController()
        .purgeConfirmed(message.ids || [])
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
      return true; // async response

    default:
      return false;
  }
});
