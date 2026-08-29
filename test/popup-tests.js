/**
 * Popup list-routing + selection-eligibility tests (no Chrome, deterministic).
 *
 * Loads the REAL ui/popup.js under a minimal DOM + chrome shim backed by an
 * in-memory storage store seeded to look exactly like a COMPLETED link-check
 * run (records each carrying a persisted `linkStatus`, plus the matching
 * `linkReport`, `report`, and a DONE checkpoint). Then simulates the exact user
 * gestures that broke in real Chrome:
 *
 *   1. Clicking the reachable / confirmed-dead / could-not-check summary totals
 *      must open the matching persisted-record list whose displayed count equals
 *      the items shown AND the summary's own count — never an empty / 0 view.
 *   2. In a cleanup-capable (confirmed-dead) selection list, checking rows must
 *      update BOTH the screen-reader announce ("N selected") AND the action
 *      button ("Move N to Salvage Trash"), enabling the action with the checked
 *      count. The action must stay disabled at "Move 0" only when nothing is
 *      checked — never after rows are checked (regression for the stuck M3
 *      button).
 *   3. Eligibility mapping is preserved: only persisted `unreachable` records
 *      are offered with a checkbox; `could_not_check` / reachable / soft-deleted
 *      are never selectable (the popup cannot make uncertain links actionable;
 *      the worker re-derives eligibility authoritatively).
 *
 * Run: node test/popup-tests.js  (also under node test/run-tests.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const constants = require('../shared/constants');
const cleanup = require('../shared/cleanup');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

// ---- Minimal DOM shim (only what popup.js touches) ---------------------------
function makeEl(id) {
  const events = Object.create(null);
  const el = {
    id, hidden: false, children: [], childNodes: [], value: '',
    dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    focus() {},
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    addEventListener(ev, fn) { events[ev] = fn; },
    _events: events,
    fire(ev, arg) { if (events[ev]) events[ev](arg); }
  };
  // Model the real DOM: assigning textContent replaces ALL child nodes (per
  // HTML spec), so a render that sets `el.textContent = ''` must clear the
  // element's children — otherwise stale checkbox/list rows would linger and
  // the fold-list routing regression tests would report false negatives.
  let _text = '';
  Object.defineProperty(el, 'textContent', {
    enumerable: true,
    get() { return _text; },
    set(v) { _text = String(v); el.children.length = 0; el.childNodes.length = 0; }
  });
  return el;
}
const els = {};
const IDS = [
  'app-title', 'scan-btn', 'backup-btn', 'status', 'link-check', 'report', 'list-panel', 'list-title',
  'list-close', 'list-count', 'list-items', 'list-cleanup', 'cleanup-remove-btn', 'list-sel', 'trash-btn',
  'trash-panel', 'trash-title', 'trash-back', 'trash-note', 'trash-restore-btn', 'trash-undo-btn',
  'trash-purge-btn', 'trash-items', 'confirm-panel', 'confirm-title', 'confirm-explain', 'confirm-items',
  'confirm-cancel', 'confirm-ok', 'empty', 'empty-text', 'footer-note'
];
IDS.forEach((id) => { els[id] = makeEl(id); });

const document = {
  title: '',
  getElementById: (id) => els[id],
  createElement: (tag) => {
    const e = makeEl('gen');
    e.tagName = tag;
    e.appendChild = (c) => { e.children.push(c); e.childNodes.push(c); return c; };
    if (tag === 'input' || tag === 'label') {
      e.checked = false;
      // use the makeEl per-element _events storage; fire toggles checked then dispatches
      const change = e.fire;
      e.fire = (ev, arg) => { if (ev === 'change') { e.checked = !e.checked; } change(ev, arg); };
    }
    return e;
  },
  createTextNode: (t) => ({ _text: t })
};

const store = Object.create(null);

// Router for runtime messages: a per-test override can install a handler that
// mirrors the REAL service-worker response for a given message type. This is the
// crux of reproducing the real-Chrome defects: the worker's `cleanup-move`
// returns `{ok:true, movedCount:0}` (not a rejection) when every requested item
// was refused server-side, and the popup must not claim a successful move on it.
let messageHandler = null; // (msg, cb) => void; defaults to {ok:true}
function defaultMessageHandler(msg, cb) { cb({ ok: true }); }

const chrome = {
  i18n: { getMessage: () => 'Test Ext' },
  storage: {
    local: {
      get: (keys, cb) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); cb(o); },
      set: (o, cb) => { Object.keys(o).forEach((k) => { store[k] = JSON.parse(JSON.stringify(o[k])); }); if (cb) cb(); }
    },
    onChanged: { addListener() {} }
  },
  runtime: { sendMessage(msg, cb) { const h = messageHandler || defaultMessageHandler; if (cb) setTimeout(() => h(msg, cb), 0); } },
  tabs: { create() {} },
  permissions: { contains(c, g) { g(false); }, request(o, g) { g(false); } },
  bookmarks: { getTree: () => Promise.resolve([]) },
  alarms: { onAlarm: { addListener() {} } },
  unload: { addListener() {} }
};

// Load popup.js with its shared-module globals resolved the way the extension
// loads them (popup.html includes the shared scripts first).
function loadPopup() {
  const SHARED = {
    '../shared/constants.js': () => { globalThis.BRConstants = constants; },
    '../shared/normalize.js': () => { globalThis.BRNormalize = require('../shared/normalize'); },
    '../shared/cleanup.js': () => { globalThis.BRCleanup = cleanup; },
    '../shared/report.js': () => { globalThis.BRReport = require('../shared/report'); },
    '../shared/backup.js': () => { globalThis.BRBackup = require('../shared/backup'); },
    '../shared/link-check-ui.js': () => { globalThis.BRLinkUI = require('../shared/link-check-ui'); },
    '../shared/trash.js': () => { globalThis.BRTrash = require('../shared/trash'); }
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.window = { addEventListener() {} };
  globalThis.self = globalThis;
  globalThis.importScripts = (...paths) => paths.forEach((p) => { if (SHARED[p]) SHARED[p](); });
  Object.keys(SHARED).forEach((p) => SHARED[p]());
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'popup.js'), 'utf8');
  return vm.runInThisContext(src, { filename: 'popup.js' });
}

// Seed storage as a COMPLETED link-check: records carry linkStatus, and the
// link report counts match the records exactly (reachable=3, unreachable=4,
// couldNotCheck=1, checked=8). Duplicate pair + dead-link pair + one could_not_check.
const NOW = Date.now();
const mkRec = (id, url, status, opts) => Object.assign({
  id: String(id), title: 't' + id, url, domain: 'd', folderPath: [], tags: [],
  category: 'Other', categorySource: 'heuristic', categoryConfidence: 1, userCorrected: false,
  summary: null, summarySource: 'none', pageType: 'bookmark', duplicateGroup: null,
  linkStatus: status, linkCheckedAt: NOW, deletedAt: null, dateAdded: NOW, dateLastUsed: 0, lastScanned: NOW
}, opts || {});
const records = [
  mkRec('1', 'https://a.com/ok', 'reachable'),
  mkRec('2', 'https://a.com/ok', 'reachable'),         // duplicate of 1, reachable
  mkRec('3', 'https://b.com/x', 'reachable'),
  mkRec('4', 'https://dead.com/gone', 'unreachable'),
  mkRec('5', 'https://maybe.com/sec', 'could_not_check'),
  mkRec('6', 'https://dup.com/p', 'unreachable'),
  mkRec('7', 'https://dup.com/p', 'unreachable'),      // duplicate, unreachable
  mkRec('8', 'https://dup.com/p', 'unreachable'),      // duplicate, unreachable
  // a soft-deleted confirmed-dead record must never be offered as selectable
  mkRec('9', 'https://gone-trash.com/x', 'unreachable', { deletedAt: NOW })
];

// Helpers over the shim element tree (mirrors real DOM child semantics).
function allOf(root, pred) { const out = []; (function walk(n) { if (!n || !n.children) return; n.children.forEach((c) => { if (pred(c)) out.push(c); walk(c); }); })(root); return out; }
function countLineText() { return els['list-count'].textContent; }
function itemCount() { return els['list-items'].children.length; }
function btnText() { return els['cleanup-remove-btn'].textContent; }
function btnDisabled() { return els['cleanup-remove-btn'].disabled; }
function announce() { return els['list-sel'].textContent; }
function listCleanupHidden() { return els['list-cleanup'].hidden; }

// Locate the three clickable link-check summary spans in the order they render
// (reachable, unreachable, couldNotCheck) and click the nth one.
function clickLinkTotal(index) {
  const reached = els['link-check'].children[0];
  const spans = allOf(reached, (c) => String(c.className || '').indexOf('br-linkcheck-click') !== -1);
  const box = spans[index];
  if (!box) { throw new Error('link-check span ' + index + ' not found'); }
  if (!box.fire) { throw new Error('no element fire on span ' + index); }
  box.fire('click');
}

// Click a Library Report metric row for the given key (emptyFolders, sameNameMerge,
// duplicates, etc.) — mirroring how a user opens each report line.
function clickReportRow(key) {
  const rows = allOf(els['report'], (c) => c.dataset && c.dataset.key === key);
  const row = rows[rows.length - 1];
  if (!row) { throw new Error('report row ' + key + ' not found'); }
  if (row.dataset.key === key && row.fire) { row.fire('click'); }
}

async function main() {
  console.log('[popup] completed-link-check list routing + selection eligibility');

  // popup.js init() resolves snapshot asynchronously; allow the whole chain to
  // settle (including the store read and the completed render) before asserting.
  const settle = () => new Promise((res) => setTimeout(res, 15));

  // Initial per-test clean store + element state. `overrides` lets a test model
  // a REAL-Chrome storage shape that differs from the default completed-run
  // fixture (e.g. a rescan that wiped record link-statuses but left a stale
  // LINK_REPORT). A null value DELETES the key from the store; any other value is
  // written verbatim — so a test can seed `linkReport:{checked:8,unreachable:385,…}`
  // with records carrying none of those statuses.
  function resetSeed(overrides) {
    Object.keys(store).forEach((k) => delete store[k]);
    IDS.forEach((id) => { const e = els[id]; Object.keys(e).forEach((k) => { if (k !== 'id' && k !== 'children' && k !== 'childNodes' && k !== 'classList' && k !== 'dataset' && k !== '_events') { e[k] = (k === 'textContent') ? '' : (k === 'hidden') ? false : e[k]; } }); e.children.length = 0; e.childNodes.length = 0; });
    messageHandler = null;
    store[constants.KEYS.RECORDS] = records;
    store[constants.KEYS.REPORT] = {
      total: records.length, generatedAt: NOW,
      duplicateGroupsList: cleanup.computeDuplicateGroups(records).groups,
      emptyFoldersList: [{ path: ['Folder One'], title: 'Folder One' }],
      sameNameMergeList: [{ parentPath: ['Parent'], name: 'Untitled', displayName: 'Untitled', folders: ['1', '2'] }]
    };
    store[constants.KEYS.LINK_REPORT] = { checked: 8, reachable: 3, unreachable: 4, couldNotCheck: 1, durationMs: 100, ranAt: NOW };
    store[constants.KEYS.LINK_CHECKPOINT] = { phase: constants.PHASE.DONE, processedCount: 8, totalCount: 8 };
    store[constants.KEYS.CHECKPOINT] = { phase: constants.PHASE.DONE, totalCount: 8, processedCount: 8, lastProcessedId: '9', updatedAt: NOW };
    if (overrides) {
      Object.keys(overrides).forEach((k) => {
        const v = overrides[k];
        if (v === undefined) { delete store[k]; } else { store[k] = JSON.parse(JSON.stringify(v)); }
      });
    }
  }
  function reset() {
    resetSeed();
  }

  function clickCheckbox(n) {
    const boxes = allOf(els['list-items'], (c) => c.tagName === 'input');
    for (let i = 0; i < n && i < boxes.length; i++) { boxes[i].fire('change'); }
  }

  // --- Scenario A: clicking each result total routes to the matching records ----
  reset(); loadPopup(); await settle();
  const linkTotal = { reachable: 0, unreachable: 1, couldNotCheck: 2 };
  const expected = { reachable: 3, unreachable: 4, couldNotCheck: 1 };

  clickLinkTotal(linkTotal.reachable);
  check('reachable total opens a list, not an empty/0 view',
    /reachable/.test(els['list-title'].textContent) === false && itemCount() === expected.reachable &&
    /3 shown/.test(countLineText()), 'count=' + countLineText() + ' items=' + itemCount());
  check('reachable list shows the matching persisted records', itemCount() === expected.reachable);

  reset(); loadPopup(); await settle();
  clickLinkTotal(linkTotal.unreachable);
  check('unreachable total opens the selectable confirmed-dead list with matching count',
    itemCount() === expected.unreachable && /4 shown/.test(countLineText()),
    'count=' + countLineText() + ' items=' + itemCount());
  // --- Scenario B: checking rows enables the action with the exact count ---------
  const checkable = allOf(els['list-items'], (c) => c.tagName === 'input').length;
  check('every confirmed-dead row is offered with a checkbox', checkable === expected.unreachable,
    'checkboxes=' + checkable);
  clickCheckbox(3);
  check('announce updates to "3 selected" when 3 checked', announce() === '3 selected', 'announce=' + announce());
  check('action button now reads "Move 3 to Salvage Trash" enabled',
    btnText() === 'Move 3 to ' + constants.TRASH_FOLDER_NAME && btnDisabled() === false,
    'btn=' + btnText() + ' disabled=' + btnDisabled());
  clickCheckbox(3); // toggle the same 3 off -> back to 0
  check('un-checking all returns the action to "Move 0" disabled',
    btnText() === 'Move 0 to ' + constants.TRASH_FOLDER_NAME && btnDisabled() === true,
    'btn=' + btnText() + ' disabled=' + btnDisabled());

  // --- Scenario C: eligibility mapping (popup cannot make uncertain links actionable)
  reset(); loadPopup(); await settle();
  const selDead = require('../shared/trash').selectableDeadLinks(records);
  check('selectable confirmed-dead mapping is EXACTLY the persisted unreachable set',
    selDead.map((s) => s.id).join(',') === '4,6,7,8', selDead.map((s) => s.id).join(','));
  check('soft-deleted confirmed-dead record is never selectable', !selDead.some((s) => s.id === '9'), '');
  check('reachable / could_not_check are never selectable as dead links',
    !selDead.some((s) => s.url.indexOf('a.com') !== -1 || s.url.indexOf('maybe.com') !== -1), '');

  reset(); loadPopup(); await settle();
  clickLinkTotal(linkTotal.couldNotCheck);
  check('couldNotCheck total opens the read-only list with matching count (never selectable bar)',
    itemCount() === expected.couldNotCheck && /1 shown/.test(countLineText()) && listCleanupHidden() === true,
    'count=' + countLineText() + ' items=' + itemCount() + ' cleanupHidden=' + listCleanupHidden());
  check('couldNotCheck rows are NOT offered as checkboxes',
    allOf(els['list-items'], (c) => c.tagName === 'input').length === 0, '');

  // --- Scenario D: navigating from a Select list back to a read-only list leaves
  //     no stale "Move 0" action bar / broken view --------------------------------
  reset(); loadPopup(); await settle();
  clickLinkTotal(linkTotal.unreachable); // cleanup list (bar visible)
  check('unreachable list shows the selectable action bar',
    listCleanupHidden() === false && btnText() === 'Move 0 to ' + constants.TRASH_FOLDER_NAME, '');
  // Read-only reachable list must hide the stale cleanup bar.
  reset(); loadPopup(); await settle();
  clickLinkTotal(linkTotal.reachable);
  check('read-only list hides any stale cleanup selection bar',
    listCleanupHidden() === true &&
    allOf(els['list-items'], (c) => c.tagName === 'input').length === 0, '');

  // --- Scenario E: navigating from a cleanup-selection list to the read-only
  //     fold lists (emptyFolders / sameNameMerge) leaves NO stale cleanup state --
  //     regression for the conditional-review finding: emptyFolders and
  //     sameNameMerge are read-only (never selectable), so a prior cleanup list
  //     must have its selection, checkboxes, and "Move N" action bar fully reset.

  // emptyFolders fold list, reached from a prior unreachable cleanup list.
  reset(); loadPopup(); await settle();
  clickLinkTotal(linkTotal.unreachable); // cleanup-selection list (bar visible)
  clickCheckbox(2); // check 2+ items so the announce/button are nonzero
  check('unreachable cleanup list shows nonzero announce before fold nav',
    announce() === '2 selected', 'announce=' + announce());
  check('unreachable cleanup list shows the enabled action button before fold nav',
    listCleanupHidden() === false && btnDisabled() === false &&
    /^Move 2 to /.test(btnText()), 'hidden=' + listCleanupHidden() + ' btn=' + btnText() + ' disabled=' + btnDisabled());
  clickReportRow('emptyFolders'); // read-only fold list
  check('unreachable -> emptyFolders: action bar hidden', listCleanupHidden() === true, '');
  check('unreachable -> emptyFolders: no checkboxes remain',
    allOf(els['list-items'], (c) => c.tagName === 'input').length === 0, '');
  check('unreachable -> emptyFolders: selection announce reset to 0',
    announce() === '0 selected', 'announce=' + announce());
  check('unreachable -> emptyFolders: no stale Move action label',
    /^Move 0 to /.test(btnText()), 'btn=' + btnText());

  // sameNameMerge fold list, reached from a prior unreachable cleanup list.
  reset(); loadPopup(); await settle();
  clickLinkTotal(linkTotal.unreachable); // cleanup-selection list (bar visible)
  clickCheckbox(2); // check 2+ items so the announce/button are nonzero
  check('unreachable cleanup list shows nonzero announce before fold nav (2)',
    announce() === '2 selected', 'announce=' + announce());
  check('unreachable cleanup list shows the enabled action button before fold nav (2)',
    listCleanupHidden() === false && btnDisabled() === false &&
    /^Move 2 to /.test(btnText()), 'hidden=' + listCleanupHidden() + ' btn=' + btnText() + ' disabled=' + btnDisabled());
  clickReportRow('sameNameMerge'); // read-only fold list
  check('unreachable -> sameNameMerge: action bar hidden',
    listCleanupHidden() === true && allOf(els['list-items'], (c) => c.tagName === 'input').length === 0 &&
    announce() === '0 selected' && /^Move 0 to /.test(btnText()),
    'hidden=' + listCleanupHidden() + ' checkboxes=' +
    allOf(els['list-items'], (c) => c.tagName === 'input').length +
    ' announce=' + announce() + ' btn=' + btnText());

  // emptyFolders fold list, reached from a prior duplicates cleanup list.
  reset(); loadPopup(); await settle();
  clickReportRow('duplicates'); // cleanup-selection list (bar visible)
  check('duplicates cleanup list shows the selectable action bar before fold nav',
    listCleanupHidden() === false &&
    allOf(els['list-items'], (c) => c.tagName === 'input').length > 0, '');
  clickReportRow('emptyFolders');
  check('duplicates -> emptyFolders: action bar hidden', listCleanupHidden() === true, '');
  check('duplicates -> emptyFolders: no checkboxes remain',
    allOf(els['list-items'], (c) => c.tagName === 'input').length === 0, '');
  check('duplicates -> emptyFolders: selection announce reset to 0',
    announce() === '0 selected', 'announce=' + announce());
  check('duplicates -> emptyFolders: no stale Move action label',
    /^Move 0 to /.test(btnText()), 'btn=' + btnText());

  // sameNameMerge fold list, reached from a prior duplicates cleanup list.
  reset(); loadPopup(); await settle();
  clickReportRow('duplicates');
  clickReportRow('sameNameMerge');
  check('duplicates -> sameNameMerge: action bar hidden',
    listCleanupHidden() === true && allOf(els['list-items'], (c) => c.tagName === 'input').length === 0 &&
    announce() === '0 selected' && /^Move 0 to /.test(btnText()),
    'hidden=' + listCleanupHidden() + ' checkboxes=' +
    allOf(els['list-items'], (c) => c.tagName === 'input').length +
    ' announce=' + announce() + ' btn=' + btnText());

  // --- Scenario F: a POST-RESCAN stale LINK_REPORT must NOT drive the summary ----
  // Real-Chrome defect A: after a fresh rescan the records are rebuilt with
  // `unchecked` statuses (so the selectable/read-only lists open with 0 items),
  // but the historical LINK_REPORT from the previous check still said "N dead".
  // The summary must be derived from the RECORDS (single source of truth the
  // lists are built from), not the stale report — so "N confirmed dead" can never
  // appear above a zero-item list.
  const STALE_LINK_REPORT = { checked: 300, reachable: 280, unreachable: 385, couldNotCheck: 20, durationMs: 100, ranAt: NOW };
  resetSeed({
    [constants.KEYS.RECORDS]: records.map((r) => Object.assign({}, r, { linkStatus: constants.LINK_STATUS_UNCHECKED })),
    [constants.KEYS.LINK_REPORT]: STALE_LINK_REPORT,
    [constants.KEYS.LINK_CHECKPOINT]: { phase: constants.PHASE.DONE, processedCount: 300, totalCount: 300 }
  });
  loadPopup(); await settle();
  const block0 = els['link-check'].children[0];
  const summary = allOf(block0, (c) => String(c.className || '').includes('br-linkcheck-link'))
    .map((c) => c.textContent);
  check('post-rescan: summary "confirmed dead" is derived from records (0), NOT stale report (385)',
    summary.some((s) => /0 confirmed dead/.test(s)),
    'summary=' + JSON.stringify(summary));
  check('post-rescan: summary reachable is 0 (not stale 280)',
    summary.some((s) => /0 reachable/.test(s)), 'summary=' + JSON.stringify(summary));
  // Clicking the now-0 confirmed-dead line must open a matching empty list (0
  // items), consistent with the number shown — never a mismatch.
  clickLinkTotal(1); // index 1 == the "confirmed dead" span
  check('post-rescan: dead-link list opens with 0 items, matching the summary',
    itemCount() === 0 && /0 shown/.test(countLineText()),
    'count=' + countLineText() + ' items=' + itemCount());
  check('post-rescan: no selectable checkboxes are offered on an empty dead list',
    allOf(els['list-items'], (c) => c.tagName === 'input').length === 0, '');

  // --- Scenario G: a cleanup-move that resolves OK but moved ZERO items must NOT
  //     claim a successful move (defect B). The worker returns {ok:true,
  //     movedCount:0} when every requested id is refused server-side. -----------
  resetSeed({
    // Simulate the records ALREADY reset (rescan) so the selection is ineligible:
    // stored records all unchecked -> the recalled dead-link records carry no
    // `unreachable` linkStatus and the server-side eligibility re-derivation
    // refuses the move, returning movedCount 0.
    [constants.KEYS.RECORDS]: records.map((r) => Object.assign({}, r, { linkStatus: constants.LINK_STATUS_UNCHECKED }))
  });
  messageHandler = (msg, cb) => {
    if (msg.type === 'cleanup-move') { cb({ ok: true, gateRequired: false, movedCount: 0, refusedCount: 1, batch: null }); }
    else { cb({ ok: true }); }
  };
  loadPopup(); await settle();
  clickReportRow('duplicates'); // need a selectable list; use duplicates which exists in this fixture
  clickCheckbox(2); // select 2 rows
  // Trigger the confirm flow -> performMove. Use the report row's cleanup button.
  // Fire the cleanup action button (the Move-selected action) to open the confirm,
  // then confirm.
  els['cleanup-remove-btn'].fire('click'); // openCleanupConfirmation -> trash-preview resolved default ok
  await settle();
  els['confirm-ok'].fire('click');         // performMove
  await settle();
  check('movedCount:0 -> popup does NOT claim a successful move',
    els['status'].textContent !== constants.COPY.cleanupMoveDone(0) &&
    /Nothing was moved|no longer eligible/i.test(els['status'].textContent || ''),
    'status=' + els['status'].textContent);

  // --- Scenario H: a durable move (movedCount>0) reports success AND clears the
  //     rendered item rows (defect B "same items remain visible"). --------------
  resetSeed();
  // Mirror the REAL worker here: a $durable$ move writes `deletedAt` back onto
  // the persisted records for the moved ids (trash.js markBatchDeleted), so when
  // the popup reloads its snapshot the moved items leave the active list. The
  // readonly list re-render over the updated records is exactly what removes the
  // stale "still there" rows.
  messageHandler = (msg, cb) => {
    if (msg.type === 'cleanup-move') {
      const movedIds = new Set((msg.items || []).map((it) => String(it.id)));
      const recs = (store[constants.KEYS.RECORDS] || []).map((r) =>
        movedIds.has(String(r.id)) ? Object.assign({}, r, { deletedAt: NOW }) : r);
      store[constants.KEYS.RECORDS] = recs;
      cb({ ok: true, gateRequired: false, movedCount: movedIds.size, refusedCount: 0, batch: { createdAt: NOW, movedCount: movedIds.size } });
    }
    else { cb({ ok: true }); }
  };
  loadPopup(); await settle();
  clickLinkTotal(1); // unreachable selectable list
  clickCheckbox(2);  // select 2
  els['cleanup-remove-btn'].fire('click'); // open confirmation
  await settle();
  els['confirm-ok'].fire('click');         // the move succeeds durably
  await settle();
  check('durable move -> popup reports the exact moved count',
    els['status'].textContent === constants.COPY.cleanupMoveDone(2),
    'status=' + els['status'].textContent);
  check('durable move -> the moved item rows are removed from the list (no stale "still there")',
    itemCount() === 2,
    'items after move (expect 2 remaining, 2 moved): ' + itemCount());
  check('durable move -> the moved-away checkbox rows are gone (remaining rows only)',
    allOf(els['list-items'], (c) => c.tagName === 'input').length === 2, '');
  check('durable move -> the selection announces are reset to 0 after reload',
    announce() === '0 selected', 'announce=' + announce());

  // --- Scenario I: a durable move of duplicate copies must immediately remove
  //     them from the ACTIVE duplicates list, reflecting only current eligible
  //     copies — a regression guard against reading the stale report-derived
  //     DUPLICATE_GROUPS_LIST. The popup now derives the duplicates list from the
  //     persisted RECORDS (cleanup.computeDuplicateGroups, which excludes
  //     soft-deleted entries) exactly like the record-derived unreachable route.
  //     The report's `duplicateGroupsList` is deliberately left STALE after the
  //     move (the real worker never regenerates it for a bulk move), so passing
  //     here proves the popup no longer depends on it.
  resetSeed();
  const trashMod = require('../shared/trash');
  const initialDupIds = trashMod.selectableDuplicates(cleanup.computeDuplicateGroups(records).groups).map((s) => String(s.id));
  messageHandler = (msg, cb) => {
    if (msg.type === 'cleanup-move') {
      const movedIds = new Set((msg.items || []).map((it) => String(it.id)));
      // Durable move: mark moved records soft-deleted IN RECORDS ONLY. The
      // report's duplicateGroupsList remains the pre-move snapshot (untouched),
      // exactly as a real bulk move leaves it.
      store[constants.KEYS.RECORDS] = (store[constants.KEYS.RECORDS] || []).map((r) =>
        movedIds.has(String(r.id)) ? Object.assign({}, r, { deletedAt: NOW }) : r);
      cb({ ok: true, gateRequired: false, movedCount: movedIds.size, refusedCount: 0, batch: { createdAt: NOW, movedCount: movedIds.size } });
    }
    else { cb({ ok: true }); }
  };
  loadPopup(); await settle();
  clickReportRow('duplicates');
  const dupBefore = itemCount();
  const checkableBefore = allOf(els['list-items'], (c) => c.tagName === 'input').length;
  check('duplicates list opens with every current eligible duplicate copy selectable',
    dupBefore === initialDupIds.length && checkableBefore === initialDupIds.length,
    'items=' + dupBefore + ' checkable=' + checkableBefore + ' expected=' + initialDupIds.length);
  // Select 2 duplicate copies and move them durably.
  clickCheckbox(2);
  els['cleanup-remove-btn'].fire('click');
  await settle();
  els['confirm-ok'].fire('click');
  await settle();
  // After the durable move + redraw: moved rows are gone, the count reflects the
  // remaining/current eligible copies, and no stale selectable rows remain.
  const remainingDupIds = trashMod.selectableDuplicates(cleanup.computeDuplicateGroups(store[constants.KEYS.RECORDS]).groups).map((s) => String(s.id));
  check('durable duplicate move -> moved rows are gone from the duplicates list',
    itemCount() === remainingDupIds.length,
    'items after move=' + itemCount() + ' expected remaining=' + remainingDupIds.length);
  check('durable duplicate move -> count line matches the remaining/current copies',
    new RegExp(remainingDupIds.length + ' shown').test(countLineText()),
    'count=' + countLineText());
  check('durable duplicate move -> only current eligible copies are selectable (no stale rows)',
    allOf(els['list-items'], (c) => c.tagName === 'input').length === remainingDupIds.length
    && remainingDupIds.length < initialDupIds.length,
    'checkable=' + allOf(els['list-items'], (c) => c.tagName === 'input').length +
    ' remaining=' + remainingDupIds.length + ' initial=' + initialDupIds.length);

  console.log('\nPopup results: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
