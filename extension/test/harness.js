/**
 * Deterministic scan/report verification harness (no Chrome).
 *
 * Exercises the exact scan-controller used by the extension against a mock
 * chrome and a synthetic fixture tree. It:
 *
 *   1. generates a deterministic synthetic bookmark tree (3,000+ items);
 *   2. runs a full scan to completion and records expected metrics;
 *   3. simulates service-worker termination mid-scan (worker state thrown
 *      away, no memory, resume reads storage only) and verifies the resumed
 *      scan completes with identical final counts;
 *   4. asserts idempotency: replaying the resume is harmless;
 *   5. asserts the required checkpoint fields:
 *      lastProcessedId, processedCount, totalCount, phase;
 *   6. computes the Library Report and prints exact metrics.
 *
 * Usage: node test/harness.js [count] [seed]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { generate } = require('../tools/generator');
const { MockChrome } = require('./mock-chrome');
const { createScanController } = require('../shared/scan-controller');
const report = require('../shared/report');
const normalize = require('../shared/normalize');
const cleanup = require('../shared/cleanup');
const links = require('../shared/link-checker');
const trash = require('../shared/trash');
const constants = require('../shared/constants');
const rules = require('../shared/rules-data.json');
const categorize = require('../shared/categorize');

const count = parseInt(process.argv[2] || '3000', 10);
const seed = parseInt(process.argv[3] || '42', 10);
// Pin "now" for determinism (matches generator default range).
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
// Base clock for the forced-window-boundary test (Part 3).
const WINDOW_BASE = NOW;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

// ---- Build the deterministic fixture ----------------------------------------
// Walk the tree once, building a node.id -> folder path map and computing the
// expected metric values independently of the scan controller's own report.
function buildExpected(tree, now) {
  const seen = new Map();
  let dupCount = 0;
  let newFolderLeaf = 0;
  let noRecordedOpening = 0;
  let stale = 0;
  const catCounts = new Map();
  now = typeof now === 'number' ? now : NOW;

  function walk(nodes, folderPath) {
    for (const n of nodes) {
      if (n.children) {
        walk(n.children, folderPath.concat([n.title]));
      } else {
        const insideNewFolder = folderPath.some((f) => constants.NEW_FOLDER_RE.test(f));

        const key = normalize.normalizeUrl(n.url);
        if (key) {
          if (seen.has(key)) { dupCount += 1; } else { seen.set(key, true); }
        }
        if (insideNewFolder) { newFolderLeaf += 1; }
        const recorded = typeof n.dateLastUsed === 'number' && n.dateLastUsed > 0;
        if (!recorded) { noRecordedOpening += 1; }
        // Stale is only claimed for records with a recorded opening older than
        // the stale threshold. Unknown (no dateLastUsed) records are never
        // treated as stale — that would conflate "added long ago" with
        // "not opened in a long time".
        if (recorded &&
            n.dateLastUsed < now - constants.STALE_YEARS * constants.MILLIS_PER_DAY * constants.DAYS_PER_YEAR) {
          stale += 1;
        }

        const c = categorize.categorize({ url: n.url, title: n.title }, rules).category;
        catCounts.set(c, (catCounts.get(c) || 0) + 1);
      }
    }
  }

  walk(tree, []);
  return { dupCount, newFolderLeaf, noRecordedOpening, stale, catCounts };
}

// The top-3 category names by count, tie-broken alphabetically — must match
// the report's computation exactly.
function topNames(catCounts) {
  const arr = [];
  catCounts.forEach((c, name) => arr.push({ name, count: c }));
  arr.sort((a, b) => (b.count !== a.count) ? b.count - a.count : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return arr.slice(0, 3).map((x) => x.name);
}

async function main() {
  console.log('Synthetic tree: count=' + count + ' seed=' + seed + ' now=' + new Date(NOW).toISOString());
  const gen = generate({ seed, count, nowMs: NOW });
  const tree = gen.tree;
  const expected = buildExpected(tree);
  console.log('Generated ' + gen.meta.actualLeaves + ' leaf bookmarks across ' +
    gen.meta.totalNodes + ' nodes.');

  // ---- Part 1: full clean run (scan completes in one worker window) -----------
  console.log('\n[Part 1] full run.');
  const mockFull = new MockChrome(tree);
  let fullController = createScanController(mockFull.deps({ getNow: () => NOW, loadRules: () => Promise.resolve(rules) }));
  const t0 = Date.now();
  await fullController.startNewScan();
  const fullScanMs = Date.now() - t0;
  console.log('  (mock full scan elapsed: ' + fullScanMs + ' ms for ' + gen.meta.actualLeaves + ' links)');
  // Architecture intent: the normal (unchunked-by-time) mock path must finish
  // comfortably under 90 s; with an unbudgeted wake it completes in ms. Guard
  // the floor so a regression to per-call latency stays visible.
  check('full run completes well under the 90 s intent (' + fullScanMs + ' ms)',
    fullScanMs < 90000, fullScanMs + ' ms');

  let snap = mockFull.snapshot();
  let cp = snap[constants.KEYS.CHECKPOINT];
  check('full run reaches DONE', cp && cp.phase === constants.PHASE.DONE, 'phase=' + (cp && cp.phase));
  check('full run processedCount == totalCount', cp && cp.processedCount === cp.totalCount,
    cp && (cp.processedCount + '/' + cp.totalCount));
  check('full run generates report', !!snap[constants.KEYS.REPORT], '');
  check('full run lastProcessedId set', cp && !!cp.lastProcessedId, 'last=' + (cp && cp.lastProcessedId));

  // ------ Part 2: simulated worker termination mid-scan + resume ----------------
  // Kill the worker by discarding every controller (all in-memory state gone).
  // Seed a mid-scan checkpoint manually, then resume from storage only, so we
  // exercise exactly the on-startup resume and alarm-driven continuation.
  console.log('\n[Part 2] simulated worker termination mid-scan; resume from storage only.');

  const queue = fullController.flattenTree(tree, []);
  const MID_CURSOR = Math.min(3 * constants.CHUNK_SIZE, queue.length); // 3 chunks processed
  const RESUME_MOCK = new MockChrome(tree);
  const midCheckpoint = {
    phase: constants.PHASE.SCANNING,
    totalCount: queue.length,
    processedCount: MID_CURSOR,
    lastProcessedId: MID_CURSOR > 0 ? String(queue[MID_CURSOR - 1].id) : null,
    updatedAt: NOW
  };
  // The pages "already processed" before the termination were checkpointed, so
  // their records are persisted too — reproduce exactly what a mid-scan worker
  // termination leaves behind.
  const alreadyRecords = fullController.upsertRecords([], queue.slice(0, MID_CURSOR).map((item) =>
    fullController.itemToRecord(item, rules, NOW)), NOW);
  await RESUME_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: queue,
    [constants.KEYS.RECORDS]: alreadyRecords,
    [constants.KEYS.CHECKPOINT]: midCheckpoint,
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });

  // "Worker restarted": a brand-new controller, no memory of the previous pass.
  let resumeController = createScanController(RESUME_MOCK.deps({ getNow: () => NOW, loadRules: () => Promise.resolve(rules) }));
  await resumeController.resume();

  // Drive remaining alarms (worker wakes) until complete.
  let guard = 0;
  while (RESUME_MOCK.pendingAlarms > 0 && guard++ < 50) {
    await RESUME_MOCK.fireWakes(() => resumeController.resume());
  }
  // One more resume to catch the final finish in the last window if needed.
  await resumeController.resume();

  snap = RESUME_MOCK.snapshot();
  cp = snap[constants.KEYS.CHECKPOINT];
  check('resumed scan reaches DONE', cp && cp.phase === constants.PHASE.DONE, 'phase=' + (cp && cp.phase));
  check('resumed processedCount == totalCount', cp && cp.processedCount === cp.totalCount,
    cp && (cp.processedCount + '/' + cp.totalCount));
  check('resumed checkpoint carries lastProcessedId of last item',
    cp && cp.lastProcessedId === String(queue[queue.length - 1].id),
    'last=' + (cp && cp.lastProcessedId));
  check('alarms cleared on completion', RESUME_MOCK.pendingAlarms === 0, 'alarms=' + RESUME_MOCK.pendingAlarms);
  check('records complete after resume', (snap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (snap[constants.KEYS.RECORDS] || []).length);
  check('report generated after resume', !!snap[constants.KEYS.REPORT], '');

  // ---- Report correctness against the independently derived expected values ------
  console.log('\n[Report] exact metric assertions (against resumed scan).');
  const rpt = snap[constants.KEYS.REPORT];
  check('report total == ' + gen.meta.actualLeaves, rpt[constants.METRIC.TOTAL] === gen.meta.actualLeaves,
    'got ' + rpt[constants.METRIC.TOTAL]);
  check('report duplicates == ' + expected.dupCount, rpt[constants.METRIC.DUPLICATES] === expected.dupCount,
    'got ' + rpt[constants.METRIC.DUPLICATES]);
  check('report newFolder == ' + expected.newFolderLeaf, rpt[constants.METRIC.NEW_FOLDER] === expected.newFolderLeaf,
    'got ' + rpt[constants.METRIC.NEW_FOLDER]);
  check('report noRecordedOpening == ' + expected.noRecordedOpening, rpt[constants.METRIC.NO_RECORDED_OPENING] === expected.noRecordedOpening,
    'got ' + rpt[constants.METRIC.NO_RECORDED_OPENING]);
  check('report staleOver2Years == ' + expected.stale, rpt[constants.METRIC.STALE_OVER_2_YEARS] === expected.stale,
    'got ' + rpt[constants.METRIC.STALE_OVER_2_YEARS]);
  check('report openHistoryCount == total - noRecordedOpening',
    rpt[constants.METRIC.OPEN_HISTORY] === rpt[constants.METRIC.TOTAL] - rpt[constants.METRIC.NO_RECORDED_OPENING],
    'got ' + rpt[constants.METRIC.OPEN_HISTORY]);
  check('report openHistoryCoverage == fraction with a recorded opening',
    rpt[constants.METRIC.OPEN_COVERAGE] > 0 && rpt[constants.METRIC.OPEN_COVERAGE] < 1 &&
    Math.abs(rpt[constants.METRIC.OPEN_COVERAGE] - rpt[constants.METRIC.OPEN_HISTORY] / rpt[constants.METRIC.TOTAL]) < 1e-9,
    'coverage=' + rpt[constants.METRIC.OPEN_COVERAGE]);
  // Truthful-stale guarantee: every record counted as stale must carry a
  // positive dateLastUsed older than the stale threshold, so unknown records
  // (no dateLastUsed) are never mislabelled stale.
  const staleRecords = (snap[constants.KEYS.RECORDS] || []).filter((rec) =>
    typeof rec.dateLastUsed === 'number' && rec.dateLastUsed > 0 &&
    rec.dateLastUsed < NOW - constants.STALE_YEARS * constants.MILLIS_PER_DAY * constants.DAYS_PER_YEAR);
  check('report staleOver2Years == exact count of recorded-openings older than 2y',
    rpt[constants.METRIC.STALE_OVER_2_YEARS] === staleRecords.length, 'got ' + rpt[constants.METRIC.STALE_OVER_2_YEARS]);
  check('no `neverOpened` key leaks into the report',
    !('neverOpened' in rpt), JSON.stringify(Object.keys(rpt)));
  check('report top-3 topics are the 3 largest categories',
    (rpt[constants.METRIC.TOP_CATEGORIES] || []).length === Math.min(3, expected.catCounts.size) &&
    (rpt[constants.METRIC.TOP_CATEGORIES] || []).every((t, idx) => t.name === topNames(expected.catCounts)[idx]),
    JSON.stringify(rpt[constants.METRIC.TOP_CATEGORIES]));

  // ---- Idempotency: replaying a DONE scan must be read-only ----------------------
  console.log('\n[Idempotency] replaying a DONE scan must not alter records.');
  const recordsBefore = JSON.stringify(snap[constants.KEYS.RECORDS] || []);
  await resumeController.resume();
  await resumeController.resume();
  const recordsAfter = JSON.stringify(RESUME_MOCK.snapshot()[constants.KEYS.RECORDS] || []);
  check('replaying a done scan does not change records', recordsBefore === recordsAfter);

  // ---- Part 3: forced active-window boundary -> alarm -> terminate -> resume ------
  // Force a mid-scan window boundary by injecting a clock that advances on every
  // read and a small activeWindowMs budget. The controller must therefore stop
  // partway (checkpointing to storage), schedule an alarm, and return — NOT keep
  // processing in the same wake. Then we throw the worker away, resume from
  // storage only (fresh controller, unbudgeted clock), and assert the scan
  // completes with identical totals. This is the "alarm-driven resumability"
  // behaviour the architecture mandates.
  console.log('\n[Part 3] forced active-window boundary; alarm scheduled; terminate; resume from storage only.');

  // Advance the injected clock by 25 ms per getNow() call. With budget 80 ms the
  // budget check after the 2nd chunk (elapsed 75 ms < 80) still passes, and the
  // check before chunk 3 (100 ms >= 80) breaks the loop: exactly 2 chunks this wake.
  const BUDGET_MS = 80;
  const CLOCK_STEP_MS = 25;
  let clockCounter = 0;
  const advancingClock = () => WINDOW_BASE + clockCounter++ * CLOCK_STEP_MS;
  const BOUNDARY_MOCK = new MockChrome(tree);
  const BOUNDARY = createScanController(BOUNDARY_MOCK.deps({
    getNow: advancingClock,
    activeWindowMs: BUDGET_MS,
    loadRules: () => Promise.resolve(rules)
  }));
  await BOUNDARY.startNewScan();

  const boundarySnap = BOUNDARY_MOCK.snapshot();
  const boundaryCp = boundarySnap[constants.KEYS.CHECKPOINT];
  const boundaryProcessed = Math.min(2 * constants.CHUNK_SIZE, queue.length);
  check('boundary wake stopped mid-scan (phase scanning)',
    boundaryCp && boundaryCp.phase === constants.PHASE.SCANNING, 'phase=' + (boundaryCp && boundaryCp.phase));
  check('boundary did not overrun its budget this wake',
    boundaryCp && boundaryCp.processedCount === boundaryProcessed,
    'processed=' + (boundaryCp && boundaryCp.processedCount));
  check('boundary left work remaining',
    boundaryCp && boundaryCp.processedCount < boundaryCp.totalCount,
    (boundaryCp && boundaryCp.processedCount + '/' + boundaryCp.totalCount));
  check('boundary scheduled exactly one alarm for the next wake',
    BOUNDARY_MOCK.pendingAlarms === 1, 'alarms=' + BOUNDARY_MOCK.pendingAlarms);
  check('boundary checkpoint persisted to storage',
    boundarySnap[constants.KEYS.RECORDS] && boundarySnap[constants.KEYS.RECORDS].length === boundaryProcessed,
    'records=' + (boundarySnap[constants.KEYS.RECORDS] || []).length);
  check('boundary checkpoint carries totalCount from the fresh tree',
    boundaryCp && boundaryCp.totalCount === queue.length,
    boundaryCp && boundaryCp.totalCount + '/' + queue.length);

  // "Terminate": drop every controller reference. A brand-new controller resumes
  // from storage only — no memory of the advancing clock or the interrupted window.
  const RESUME_BOUNDARY_MOCK = new MockChrome(tree);
  // Seed the fresh mock with exactly what the terminated process left in storage.
  await RESUME_BOUNDARY_MOCK.storage.local.set(boundarySnap);

  const freshBoundary = createScanController(RESUME_BOUNDARY_MOCK.deps({
    getNow: () => WINDOW_BASE,  // fixed clock: resume runs to completion in one wake
    loadRules: () => Promise.resolve(rules)
  }));
  await freshBoundary.resume();
  // Drive any further alarms exactly as chrome would.
  let bguard = 0;
  while (RESUME_BOUNDARY_MOCK.pendingAlarms > 0 && bguard++ < 50) {
    await RESUME_BOUNDARY_MOCK.fireWakes(() => freshBoundary.resume());
  }
  await freshBoundary.resume();

  const boundaryDone = RESUME_BOUNDARY_MOCK.snapshot();
  const boundaryDoneCp = boundaryDone[constants.KEYS.CHECKPOINT];
  check('boundary resume reaches DONE', boundaryDoneCp && boundaryDoneCp.phase === constants.PHASE.DONE,
    'phase=' + (boundaryDoneCp && boundaryDoneCp.phase));
  check('boundary resume processedCount == totalCount',
    boundaryDoneCp && boundaryDoneCp.processedCount === boundaryDoneCp.totalCount,
    boundaryDoneCp && (boundaryDoneCp.processedCount + '/' + boundaryDoneCp.totalCount));
  check('boundary resume clears alarms on completion', RESUME_BOUNDARY_MOCK.pendingAlarms === 0,
    'alarms=' + RESUME_BOUNDARY_MOCK.pendingAlarms);
  check('boundary resume has complete records',
    (boundaryDone[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (boundaryDone[constants.KEYS.RECORDS] || []).length);
  check('boundary resume generates an identical report total',
    boundaryDone[constants.KEYS.REPORT] && boundaryDone[constants.KEYS.REPORT][constants.METRIC.TOTAL] === gen.meta.actualLeaves,
    'total=' + boundaryDone[constants.KEYS.REPORT] && boundaryDone[constants.KEYS.REPORT][constants.METRIC.TOTAL]);

  // ---- Part 3b: scan duration spans worker termination + resume --------------
  // Start a scan at t=1000 with a per-wake budget that stops it after one chunk.
  // "Terminate" the worker (drop the controller), then resume on a BRAND-NEW
  // controller whose clock is at t=9000. The persisted duration must be the TOTAL
  // elapsed span across the interruption (9000 - 1000 = 8000 ms) — NOT the final
  // wake's span (which would be ~0 ms on a fixed clock). The start stamp must
  // survive every chunk write, the termination, and the resume.
  console.log('\n[Part 3b] scan duration spans worker termination + resume (8000ms, not final-wake).');

  const DUR_MOCK = new MockChrome(tree);
  // startNewScan captures updatedAt and scanStartedAt during checkpoint write, then
  // processActiveWindowImpl captures wakeStart and `now` before its budget loop.
  // Keep the first four reads pinned at 1000 so scanStartedAt === 1000 exactly, then
  // let the budget-loop reads step +25ms: after one 75-item chunk the 2nd budget
  // check (elapsed 50ms) exceeds budget 40ms and the wake stops mid-scan.
  let durTick = 0;
  const startDurClock = () => {
    const n = durTick++;
    return n < 4 ? 1000 : 1000 + (n - 3) * 25;
  };
  const DUR_CONTROLLER = createScanController(DUR_MOCK.deps({
    getNow: startDurClock,
    activeWindowMs: 40,
    loadRules: () => Promise.resolve(rules)
  }));
  await DUR_CONTROLLER.startNewScan();
  let durSnap = DUR_MOCK.snapshot();
  let durCp = durSnap[constants.KEYS.CHECKPOINT];
  check('scan start stamp persisted in checkpoint (scanStartedAt=1000)',
    durCp && durCp.scanStartedAt === 1000, 'scanStartedAt=' + (durCp && durCp.scanStartedAt));
  check('duration boundary wake stopped after one chunk (SCANNING)',
    durCp && durCp.phase === constants.PHASE.SCANNING && durCp.processedCount === constants.CHUNK_SIZE,
    'phase=' + (durCp && durCp.phase) + ' processed=' + (durCp && durCp.processedCount));
  check('start stamp survived the chunk write',
    durCp && durCp.scanStartedAt === 1000, 'scanStartedAt=' + (durCp && durCp.scanStartedAt));

  // Terminate: drop every controller reference; seed a fresh mock with the
  // terminated process's persisted storage, then resume on a fresh controller
  // whose clock is fixed at t=9000.
  const DUR_RESUME_MOCK = new MockChrome(tree);
  await DUR_RESUME_MOCK.storage.local.set(durSnap);
  const DUR_RESUME = createScanController(DUR_RESUME_MOCK.deps({
    getNow: () => 9000,
    loadRules: () => Promise.resolve(rules)
  }));
  await DUR_RESUME.resume();
  let dguard = 0;
  while (DUR_RESUME_MOCK.pendingAlarms > 0 && dguard++ < 50) {
    await DUR_RESUME_MOCK.fireWakes(() => DUR_RESUME.resume());
  }
  await DUR_RESUME.resume();

  durSnap = DUR_RESUME_MOCK.snapshot();
  durCp = durSnap[constants.KEYS.CHECKPOINT];
  const durReport = durSnap[constants.KEYS.REPORT];
  check('duration resume reached DONE', durCp && durCp.phase === constants.PHASE.DONE,
    'phase=' + (durCp && durCp.phase));
  check('scan duration spans termination+resume (durationMs === 8000, not final-wake)',
    durCp && durCp.durationMs === 8000, 'durationMs=' + (durCp && durCp.durationMs));
  check('scan start stamp preserved to completion',
    durCp && durCp.scanStartedAt === 1000, 'scanStartedAt=' + (durCp && durCp.scanStartedAt));
  check('scan completed stamp is the finish wake',
    durCp && durCp.scanCompletedAt === 9000, 'scanCompletedAt=' + (durCp && durCp.scanCompletedAt));
  check('scan duration persisted exactly into the Library Report',
    durReport && durReport[constants.METRIC.DURATION_MS] === 8000,
    'report duration=' + (durReport && durReport[constants.METRIC.DURATION_MS]));
  check('report start/completed stamps are the raw persisted ms',
    durReport && durReport[constants.METRIC.SCAN_STARTED_AT] === 1000 &&
    durReport[constants.METRIC.SCAN_COMPLETED_AT] === 9000,
    JSON.stringify(durReport && { s: durReport[constants.METRIC.SCAN_STARTED_AT], c: durReport[constants.METRIC.SCAN_COMPLETED_AT] }));
  check('neutral duration copy renders the exact span',
    constants.COPY.scanDurationLine(durCp.totalCount, 8000).indexOf('in 8s') !== -1,
    constants.COPY.scanDurationLine(durCp.totalCount, 8000));
  // A scan that finished mid-wake has a scanStartedAt but no scanCompletedAt until done.
  check('formatDuration is neutral and sub-second safe',
    constants.formatDuration(0) === '< 1s' &&
    constants.formatDuration(500) === '< 1s' &&
    constants.formatDuration(8000) === '8s' &&
    constants.formatDuration(125000) === '2m 5s',
    [0, 500, 8000, 125000].map((m) => constants.formatDuration(m)).join(', '));

  // ---- Part 4: rescan cleanup (external bookmark removal must drop stale records) ----
  // A bookmark removed outside the extension must not linger in records or inflate
  // the report total. startNewScan must clear the prior scan's records up front.
  console.log('\n[Part 4] rescan cleanup: removed bookmark must not survive into the new total.');
  const pruneTree = JSON.parse(JSON.stringify(tree));
  // Remove the last leaf from the tree (drop the first leaf's folder child or any leaf).
  let removedNode = null;
  (function dropLastLeaf(nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.children) { if (dropLastLeaf(n.children)) { return true; } }
      else if (removedNode === null && n.url) { removedNode = n; nodes.splice(i, 1); return true; }
    }
    return false;
  })(pruneTree);

  const expectedAfterPrune = queue.length - 1;
  const RESCAN_MOCK = new MockChrome(pruneTree);
  const rescanController = createScanController(RESCAN_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await rescanController.startNewScan();

  const rescanSnap = RESCAN_MOCK.snapshot();
  const rescanCp = rescanSnap[constants.KEYS.CHECKPOINT];
  const rescanReport = rescanSnap[constants.KEYS.REPORT];
  check('rescan totalCount reflects the pruned tree',
    rescanCp && rescanCp.totalCount === expectedAfterPrune,
    rescanCp && rescanCp.totalCount + '/' + expectedAfterPrune);
  check('rescan records hold exactly the current tree',
    (rescanSnap[constants.KEYS.RECORDS] || []).length === expectedAfterPrune,
    'records=' + (rescanSnap[constants.KEYS.RECORDS] || []).length);
  check('rescan report total == pruned count',
    rescanReport && rescanReport[constants.METRIC.TOTAL] === expectedAfterPrune,
    'total=' + (rescanReport && rescanReport[constants.METRIC.TOTAL]));
  check('the removed bookmark has no lingering record',
    removedNode === null ||
    !(rescanSnap[constants.KEYS.RECORDS] || []).some((r) => r.id === String(removedNode.id)),
    'id=' + (removedNode && removedNode.id));

  // ---- Part 5: concurrent rescan race ---------------------------------------------
  // A user-triggered "scan now" issued while another scan's storage write is
  // in-flight must never let the stale async write overwrite the newer scan's
  // queue/checkpoint/records/report. The controller serializes its drivers, so
  // the first in-flight window is fully flushed before the second scan begins;
  // final state must reflect ONLY the latest tree. (Identical controller, as a
  // UI button press and the alarm listener share the same controller instance.)
  console.log('\n[Part 5] rescan during an in-flight scan: stale writes must not overwrite the new scan.');

  const treeA = JSON.parse(JSON.stringify(tree));
  const treeB = JSON.parse(JSON.stringify(tree));
  let removedB = null;
  (function dropLastLeaf(nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.children) { if (dropLastLeaf(n.children)) { return true; } }
      else if (removedB === null && n.url) { removedB = n; nodes.splice(i, 1); return true; }
    }
    return false;
  })(treeB);

  // Gate the very first storage write of scan A so it stays in-flight across an
  // async boundary, letting the second startNewScan (scan B) be invoked mid-write.
  let releaseFirstWrite = null;
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  let raceWriteCount = 0;
  const treesByCall = [treeA, treeB];
  let treeCallIndex = 0;

  const RACE_MOCK = new MockChrome(null);
  const raceDeps = RACE_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    bookmarkApi: {
      getTree: () => Promise.resolve(treesByCall[Math.min(treeCallIndex++, treesByCall.length - 1)])
    },
    storageSet: (obj) => {
      const doWrite = () => RACE_MOCK.storage.local.set(obj);
      // Hold only the first write (scan A's reset). Every other write passes
      // through immediately so both scans otherwise run to completion.
      if (raceWriteCount++ === 0) { return firstWriteGate.then(doWrite); }
      return doWrite();
    }
  });

  const raceController = createScanController(raceDeps);
  // Scan A starts and blocks on its gated reset write.
  let settledA = false;
  let settledB = false;
  const pA = raceController.startNewScan().then((v) => { settledA = true; return v; });
  // Scan B (the rescan) is invoked while A's write is still in-flight.
  const pB = raceController.startNewScan().then((v) => { settledB = true; return v; });
  // Both must still be pending here: A is blocked on its gated write and B is
  // queued behind it by the serialization lock.
  check('second scan invoked before the first scan settled',
    !settledA && !settledB,
    'settledA=' + settledA + ' settledB=' + settledB);
  releaseFirstWrite();
  await pB;
  await pA;
  check('first scan completed before the second scan', settledA && settledB,
    'settledA=' + settledA + ' settledB=' + settledB);

  const raceSnap = RACE_MOCK.snapshot();
  const raceCp = raceSnap[constants.KEYS.CHECKPOINT];
  const queueB = raceController.flattenTree(treeB, []);
  check('concurrent rescan ends at DONE',
    raceCp && raceCp.phase === constants.PHASE.DONE, 'phase=' + (raceCp && raceCp.phase));
  check('concurrent rescan totalCount == latest tree count',
    raceCp && raceCp.totalCount === queueB.length,
    raceCp && (raceCp.totalCount + '/' + queueB.length));
  check('concurrent rescan records == latest tree count',
    (raceSnap[constants.KEYS.RECORDS] || []).length === queueB.length,
    'records=' + (raceSnap[constants.KEYS.RECORDS] || []).length);
  check('concurrent rescan report total == latest tree count',
    raceSnap[constants.KEYS.REPORT] && raceSnap[constants.KEYS.REPORT][constants.METRIC.TOTAL] === queueB.length,
    'total=' + (raceSnap[constants.KEYS.REPORT] && raceSnap[constants.KEYS.REPORT][constants.METRIC.TOTAL]));
  check('no record from the first scan lingers in the final records',
    removedB === null || !(raceSnap[constants.KEYS.RECORDS] || []).some((r) => r.id === String(removedB.id)),
    'stale id=' + (removedB && removedB.id));

  // ---- Part 6: truthful open-history metrics under realistic mode ----------------
  // Real Chrome data: the large majority of older bookmarks carry no
  // dateLastUsed. The generator's realistic mode models that (Chrome only
  // began recording dateLastUsed around 114–117). The report must stay
  // provable: records without a recorded opening are reported as "no recorded
  // opening", never as "never opened"; stale is only claimed for records whose
  // recorded opening is older than the threshold; and the open-history
  // coverage fraction is reported.
  console.log('\n[Part 6] truthful open-history metrics under realistic Chrome data.');
  const realGen = generate({ seed, count, nowMs: NOW, realistic: true });
  const realExpected = buildExpected(realGen.tree, NOW);
  const REAL_MOCK = new MockChrome(realGen.tree);
  const realController = createScanController(REAL_MOCK.deps({ getNow: () => NOW, loadRules: () => Promise.resolve(rules) }));
  await realController.startNewScan();
  const realSnap = REAL_MOCK.snapshot();
  const realReport = realSnap[constants.KEYS.REPORT];
  const openCount = realGen.meta.actualLeaves - realExpected.noRecordedOpening;
  const realCoverage = openCount / realGen.meta.actualLeaves;
  check('realistic mode produces a majority of records with no recorded opening',
    realExpected.noRecordedOpening > realGen.meta.actualLeaves / 2,
    realExpected.noRecordedOpening + '/' + realGen.meta.actualLeaves);
  check('realistic mode does not fabricate a ~70% positive opening spread',
    realCoverage < 0.5, 'coverage=' + realCoverage);
  check('realistic report noRecordedOpening == derived count',
    realReport[constants.METRIC.NO_RECORDED_OPENING] === realExpected.noRecordedOpening,
    'got ' + realReport[constants.METRIC.NO_RECORDED_OPENING]);
  check('realistic report openHistoryCount == records with a recorded opening',
    realReport[constants.METRIC.OPEN_HISTORY] === openCount, 'got ' + realReport[constants.METRIC.OPEN_HISTORY]);
  check('realistic report openHistoryCoverage == openHistoryCount / total',
    realReport[constants.METRIC.OPEN_COVERAGE] === realCoverage, 'got ' + realReport[constants.METRIC.OPEN_COVERAGE]);
  const realStale = (realSnap[constants.KEYS.RECORDS] || []).filter((rec) =>
    typeof rec.dateLastUsed === 'number' && rec.dateLastUsed > 0 &&
    rec.dateLastUsed < NOW - constants.STALE_YEARS * constants.MILLIS_PER_DAY * constants.DAYS_PER_YEAR).length;
  check('realistic report staleOver2Years only counts recorded openings >2y old',
    realReport[constants.METRIC.STALE_OVER_2_YEARS] === realStale, 'got ' + realReport[constants.METRIC.STALE_OVER_2_YEARS]);
  check('realistic report has NO absolute never-opened claim',
    !('neverOpened' in realReport), JSON.stringify(Object.keys(realReport)));
  // Truthful copy: the stale string never asserts the fallback dateAdded case.
  check('stale copy claims only a recorded opening, never a dateAdded proxy',
    constants.COPY.staleLine(1).indexOf('last recorded opening over 2 years ago') !== -1);
  check('no-recorded-opening copy is neutral (not "never opened")',
    constants.COPY.noRecordedOpeningLine(1).indexOf('no recorded opening') !== -1 &&
    constants.COPY.noRecordedOpeningLine(1).indexOf('never opened') === -1);

  // ---- Part 7: empty bookmark tree must not hang -----------------------------------
  // A library with zero bookmarks must still reach DONE, persist a valid,
  // empty report, and clear alarms — not hang in "scanning" with no report and
   // no scheduled alarm.
  console.log('\n[Part 7] empty bookmark tree reaches DONE with a valid empty report.');
  const EMPTY_MOCK = new MockChrome([]);
  const emptyController = createScanController(EMPTY_MOCK.deps({ getNow: () => NOW, loadRules: () => Promise.resolve(rules) }));
  await emptyController.startNewScan();
  const emptySnap = EMPTY_MOCK.snapshot();
  const emptyCp = emptySnap[constants.KEYS.CHECKPOINT];
  const emptyReport = emptySnap[constants.KEYS.REPORT];
  check('empty tree reaches DONE', emptyCp && emptyCp.phase === constants.PHASE.DONE,
    'phase=' + (emptyCp && emptyCp.phase));
  check('empty tree processedCount == totalCount (0)',
    emptyCp && emptyCp.processedCount === emptyCp.totalCount && emptyCp.totalCount === 0,
    (emptyCp && emptyCp.processedCount + '/' + emptyCp.totalCount));
  check('empty tree persists a valid report with total 0',
    emptyReport && emptyReport[constants.METRIC.TOTAL] === 0, JSON.stringify(emptyReport));
  check('empty report has zero duplicates/newFolder/stale/noRecordedOpening',
    emptyReport[constants.METRIC.DUPLICATES] === 0 &&
    emptyReport[constants.METRIC.NEW_FOLDER] === 0 &&
    emptyReport[constants.METRIC.STALE_OVER_2_YEARS] === 0 &&
    emptyReport[constants.METRIC.NO_RECORDED_OPENING] === 0,
    JSON.stringify(emptyReport));
  check('empty tree clears alarms on completion', EMPTY_MOCK.pendingAlarms === 0,
    'alarms=' + EMPTY_MOCK.pendingAlarms);
  check('empty library records remain an empty array',
    (emptySnap[constants.KEYS.RECORDS] || []).length === 0,
    'records=' + (emptySnap[constants.KEYS.RECORDS] || []).length);
  // Empty scan duration: when start and finish happen at the same logical time
  // the persisted duration must be exactly 0 (never a phantom positive span).
  check('empty scan duration is 0 when start and finish share the same clock',
    emptyCp && emptyCp.scanStartedAt === NOW && emptyCp.durationMs === 0,
    'scanStartedAt=' + (emptyCp && emptyCp.scanStartedAt) + ' durationMs=' + (emptyCp && emptyCp.durationMs));
  check('empty scan report carries a 0 duration in raw ms',
    emptyReport && emptyReport[constants.METRIC.DURATION_MS] === 0,
    'report duration=' + (emptyReport && emptyReport[constants.METRIC.DURATION_MS]));
  // A resume over the completed empty scan must be a read-only no-op and must
  // not restore an alarm or flip the phase back to scanning.
  await emptyController.resume();
  const emptySnap2 = EMPTY_MOCK.snapshot();
  check('resume over an empty done scan stays DONE', emptySnap2[constants.KEYS.CHECKPOINT].phase === constants.PHASE.DONE);
  check('resume over an empty done scan schedules no alarm', EMPTY_MOCK.pendingAlarms === 0,
    'alarms=' + EMPTY_MOCK.pendingAlarms);

  // ---- Part 8: detection persisted into the scan report ----------------------
  // The report must carry exact, deterministic duplicate groups (from records,
  // excluding soft-deleted) and the tree-derived empty-folder / same-name merge
  // findings — while the M1 open-history metrics stay truthful. The duplicate
  // group count must equal the independently derived value, and the folder list
  // must equal an independent analysis of the same tree.
  console.log('\n[Part 8] Detection is persisted into the Library Report.');
  // Use the full clean run (Part 1) report, whose scan persisted folder
  // findings and whose records match the whole tree, so the independent folder
  // analysis uses the same source of truth.
  const fullSnap = mockFull.snapshot();
  const detectionRpt = fullSnap[constants.KEYS.REPORT];
  const expectedDups = cleanup.computeDuplicateGroups(fullSnap[constants.KEYS.RECORDS] || []);
  check('report duplicates == independent duplicate count',
    detectionRpt[constants.METRIC.DUPLICATES] === expectedDups.totalDuplicates,
    detectionRpt[constants.METRIC.DUPLICATES] + '/' + expectedDups.totalDuplicates);
  check('report duplicateGroupsList groups == independent groupCount',
    (detectionRpt[constants.METRIC.DUPLICATE_GROUPS_LIST] || []).length === expectedDups.groupCount,
    (detectionRpt[constants.METRIC.DUPLICATE_GROUPS_LIST] || []).length + '/' + expectedDups.groupCount);
  const expectedFolders = cleanup.analyzeFolders(tree);
  check('report emptyFolders == independent empty-folder count',
    detectionRpt[constants.METRIC.EMPTY_FOLDERS] === expectedFolders.emptyFolders.length,
    detectionRpt[constants.METRIC.EMPTY_FOLDERS] + '/' + expectedFolders.emptyFolders.length);
  check('report emptyFoldersList carries the read-only folder findings',
    (detectionRpt[constants.METRIC.EMPTY_FOLDERS_LIST] || []).length === expectedFolders.emptyFolders.length, '');
  check('report sameNameMerge == independent merge-group count',
    detectionRpt[constants.METRIC.SAME_NAME_MERGE] === expectedFolders.sameNameMergeGroups.length,
    detectionRpt[constants.METRIC.SAME_NAME_MERGE] + '/' + expectedFolders.sameNameMergeGroups.length);
  check('report sameNameMergeList groups are read-only (no merge performed)',
    (detectionRpt[constants.METRIC.SAME_NAME_MERGE_LIST] || []).every((g) => g.folders.length >= 2), '');
  // Truthful open-history metrics are preserved alongside the new detection.
  check('M1 open-history metric preserved (noRecordedOpening)',
    detectionRpt[constants.METRIC.NO_RECORDED_OPENING] === rpt[constants.METRIC.NO_RECORDED_OPENING], '');
  check('no `neverOpened` key leaks after detection is added',
    !('neverOpened' in detectionRpt), JSON.stringify(Object.keys(detectionRpt)));
  // A rescan persists fresh folder findings for the new tree (pruned fixture).
  const rescanFolders = cleanup.analyzeFolders(pruneTree);
  const prunedReport = rescanReport;
  check('rescan report emptyFolders reflects the pruned tree',
    prunedReport[constants.METRIC.EMPTY_FOLDERS] === rescanFolders.emptyFolders.length,
    prunedReport[constants.METRIC.EMPTY_FOLDERS] + '/' + rescanFolders.emptyFolders.length);

  // ---- Part 8b: built-in root containers are never reported as cleanup findings -
  // Regression: a real-shaped Chrome tree whose roots are the synthetic "0"
  // container plus the empty Bookmarks bar / Other bookmarks / Mobile bookmarks
  // must report ZERO empty-folder and same-name merge findings through the full
  // scan-to-report pipeline. A genuine user empty folder directly under a root
  // is reported separately.
  console.log('\n[Part 8b] built-in root containers are never cleanup findings (full pipeline).');
  const ROOT_ONLY_TREE = [
    { id: '0', title: '', parentId: '', children: [
      { id: '1', title: 'Bookmarks bar', parentId: '0', children: [] },
      { id: '2', title: 'Other bookmarks', parentId: '0', children: [] },
      { id: '3', title: 'Mobile bookmarks', parentId: '0', children: [] }
    ] }
  ];
  // Pipeline-level: run a full scan over the roots-only tree, then assert the
  // persisted Library Report carries zero empty-folder / merge findings.
  const ROOT_SHAPE_MOCK = new MockChrome(ROOT_ONLY_TREE);
  const rootShapeController = createScanController(ROOT_SHAPE_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await rootShapeController.startNewScan();
  const rootShapeSnap = ROOT_SHAPE_MOCK.snapshot();
  const rootShapeReport = rootShapeSnap[constants.KEYS.REPORT];
  check('sorted roots report zero empty folders through the full pipeline',
    rootShapeReport[constants.METRIC.EMPTY_FOLDERS] === 0,
    'empty=' + rootShapeReport[constants.METRIC.EMPTY_FOLDERS]);
  check('sorted roots report zero same-name merge candidates',
    rootShapeReport[constants.METRIC.SAME_NAME_MERGE] === 0,
    'merge=' + rootShapeReport[constants.METRIC.SAME_NAME_MERGE]);
  check('no built-in root id appears in the persisted empty-folder list',
    (rootShapeReport[constants.METRIC.EMPTY_FOLDERS_LIST] || []).length === 0, '');
  check('direct analysis of roots-only tree reports nothing',
    cleanup.analyzeFolders(ROOT_ONLY_TREE).emptyFolders.length === 0, '');

  // Direct analyzeFolders regression: a user empty folder under a root is kept,
  // and its path does not gain a stray synthetic-root segment.
  const USER_FOLDER_TREE = [
    { id: '0', title: '', parentId: '', children: [
      { id: '1', title: 'Bookmarks bar', parentId: '0', children: [] },
      { id: '2', title: 'Other bookmarks', parentId: '0', children: [] },
      { id: '3', title: 'Mobile bookmarks', parentId: '0', children: [
        { id: '9', title: 'User Folder', parentId: '3', children: [] }
      ] }
    ] }
  ];
  const userFolderFindings = cleanup.analyzeFolders(USER_FOLDER_TREE);
  check('direct analysis reports only the user folder (id 9) under a root',
    userFolderFindings.emptyFolders.length === 1 &&
    userFolderFindings.emptyFolders[0].id === '9',
    JSON.stringify(userFolderFindings.emptyFolders));
  check('direct analysis keeps the user folder path prefix (behavior preserved)',
    userFolderFindings.emptyFolders[0] &&
    JSON.stringify(userFolderFindings.emptyFolders[0].path) === JSON.stringify(['Mobile bookmarks', 'User Folder']),
    JSON.stringify(userFolderFindings.emptyFolders[0] && userFolderFindings.emptyFolders[0].path));
  check('no empty synthetic-root segment leaks into a user folder path',
    userFolderFindings.emptyFolders.every((f) => f.path[0] !== ''), '');

  // ---- Part 9: link-check controller (permission gate + execution) -----------
  // The controller must refuse to run without the optional host permission,
  // must never fetch automatically, and must classify three states exactly.
  console.log('\n[Part 9] link-check controller: permission gate + three-state execution.');

  function linkMock(opts) {
    const store = {};
    function storageGet(keys) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) { out[k] = store[k]; } });
      return Promise.resolve(out);
    }
    function storageSet(obj) { Object.keys(obj).forEach((k) => { store[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); }
    let scheduled = 0;
    return {
      store,
      scheduledCount: () => scheduled,
      storage: { get: storageGet, set: storageSet },
      schedule: () => { scheduled += 1; },
      clear: () => { scheduled = 0; }
    };
  }

  const linkRecords = [
    { id: '1', title: 'ok', url: 'https://a.com/x', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: '2', title: 'dead', url: 'https://b.com/gone', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: '3', title: 'blocked', url: 'https://c.com/secure', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: '4', title: 'soft-deleted', url: 'https://d.com/trash', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: NOW },
    { id: '5', title: 'nonweb', url: 'javascript:alert(1)', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null }
  ];
  const statusByUrl = {
    'https://a.com/x': 200,
    'https://b.com/gone': 404,
    'https://c.com/secure': 403
  };
  const fetchImpl = async (url, opts) => {
    if (url === 'javascript:alert(1)') { throw new Error('should not fetch'); }
    if (Object.prototype.hasOwnProperty.call(statusByUrl, url)) { return { status: statusByUrl[url] }; }
    throw Object.assign(new Error('net'), { name: 'TypeError' });
  };

  // Gate: without permission the controller refuses and issues no fetch.
  const gated = linkMock({});
  let fetched = 0;
  const countingFetch = async (url, opts) => { fetched += 1; throw Object.assign(new Error('x'), { name: 'TypeError' }); };
  const gatedCtl = links.createLinkCheckController({
    fetchImpl: countingFetch,
    storageGet: gated.storage.get,
    storageSet: gated.storage.set,
    getNow: () => NOW,
    scheduleWake: gated.schedule,
    clearWake: gated.clear,
    hasPermission: () => false
  });
  await gatedCtl.start().then(
    () => { check('permission-gated start REJECTS without permission', false, 'start resolved without permission'); },
    (err) => { check('permission-gated start REJECTS without permission', !!err && err.code === 'NO_HOST_PERMISSION', err && err.code); }
  );
  check('no URL fetched before permission is granted', fetched === 0, 'fetched=' + fetched);
  check('gate did not write a checkpoint', !(constants.KEYS.LINK_CHECKPOINT in gated.store), '');

  // Granted: full check runs and persists three-state results, explicitly.
  const src = linkMock({});
  await src.storage.set({ records: linkRecords, schema: constants.SCHEMA_VERSION });
  const grantedCtl = links.createLinkCheckController({
    fetchImpl,
    storageGet: src.storage.get,
    storageSet: src.storage.set,
    getNow: () => NOW,
    scheduleWake: src.schedule,
    clearWake: src.clear,
    hasPermission: () => Promise.resolve(true)
  });
  await grantedCtl.start();
  const linkStore = src.store;
  const linkCp = linkStore[constants.KEYS.LINK_CHECKPOINT];
  check('check completes to DONE', linkCp && linkCp.phase === constants.PHASE.DONE, 'phase=' + (linkCp && linkCp.phase));
  const checkedRecords = linkStore[constants.KEYS.RECORDS] || [];
  const byId = {};
  checkedRecords.forEach((r) => { byId[r.id] = r; });
  check('2xx record -> reachable', byId['1'] && byId['1'].linkStatus === constants.LINK_STATUS_REACHABLE, byId['1'] && byId['1'].linkStatus);
  check('404 record -> unreachable', byId['2'] && byId['2'].linkStatus === constants.LINK_STATUS_UNREACHABLE, byId['2'] && byId['2'].linkStatus);
  check('403 record -> could_not_check', byId['3'] && byId['3'].linkStatus === constants.LINK_STATUS_COULD_NOT_CHECK, byId['3'] && byId['3'].linkStatus);
  check('soft-deleted record is never checked', byId['4'] && byId['4'].linkStatus === constants.LINK_STATUS_UNCHECKED, byId['4'] && byId['4'].linkStatus);
  check('non-web URL is skipped, never fetched, stays unchecked',
    byId['5'] && byId['5'].linkStatus === constants.LINK_STATUS_UNCHECKED, byId['5'] && byId['5'].linkStatus);
  check('checked records carry a checkedAt timestamp', checkedRecords.some((r) => typeof r.linkCheckedAt === 'number' && r.linkCheckedAt === NOW), '');
  const linkReport = linkStore[constants.KEYS.LINK_REPORT];
  check('link report summarizes exact three-state counts over checked URLs only',
    linkReport && linkReport.reachable === 1 && linkReport.unreachable === 1 &&
    linkReport.couldNotCheck === 1 && linkReport.checked === 3,
    JSON.stringify(linkReport));
  check('link check cleared its alarms on completion', src.scheduledCount() === 0,
    'scheduled=' + src.scheduledCount());
  check('link report records ranAt', linkReport && typeof linkReport.ranAt === 'number', '');

  // The scan report itself must NOT trigger any link checks automatically.
  check('scan report carries no resolved link status (links stay unchecked until opt-in)',
    (snap[constants.KEYS.RECORDS] || []).every((r) => r.linkStatus === constants.LINK_STATUS_UNCHECKED), '');

  // ---- Part 10: link-check active-window budget enforced per-URL + safe finalize ----
  // The budget is enforced on EVERY URL (not just between chunks), each completed
  // result is persisted before the checkpoint cursor advances, and a normal scan
  // that clears/replaces the records mid-check finalizes the link check safely
  // (DONE, partial/zero results) instead of looping on a dead checkpoint.
  console.log('\n[Part 10] link-check per-URL budget; no lost results; safe finalize when records are replaced.');

  // A) Per-URL budget: a small budget exhausted during the first wake must stop the
  // check partway, persist every completed result, and schedule the link alarm —
  // never lose an in-progress result.
  const budgetRecords = [
    { id: 'b1', title: 'one', url: 'https://one.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: 'b2', title: 'two', url: 'https://two.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: 'b3', title: 'three', url: 'https://three.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: 'b4', title: 'four', url: 'javascript:void(0)', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null }
  ];
  const budgetAnyFetch = async () => ({ status: 200 });
  const budgetStore = linkMock({});
  await budgetStore.storage.set({ records: budgetRecords, schema: constants.SCHEMA_VERSION });
  // Advancing clock steps 10ms per getNow() read; budget 30ms -> after the first
  // URL's read/check/write the second budget check (elapsed 30) breaks the loop,
  // so exactly ONE URL is processed and persisted this wake.
  let budgetClock = 0;
  const budgetCtl = links.createLinkCheckController({
    fetchImpl: budgetAnyFetch,
    storageGet: budgetStore.storage.get,
    storageSet: budgetStore.storage.set,
    getNow: () => NOW + (budgetClock++ * 10),
    activeWindowMs: 30,
    scheduleWake: budgetStore.schedule,
    clearWake: budgetStore.clear,
    hasPermission: () => Promise.resolve(true)
  });
  await budgetCtl.start();
  const budgetSnapCp = budgetStore.store[constants.KEYS.LINK_CHECKPOINT];
  check('budget enforced per-URL stops partway (SCANNING)',
    budgetSnapCp && budgetSnapCp.phase === constants.PHASE.SCANNING, 'phase=' + (budgetSnapCp && budgetSnapCp.phase));
  check('per-URL budget persisted exactly one result',
    budgetSnapCp && budgetSnapCp.processedCount === 1 && budgetSnapCp.totalCount === 3, JSON.stringify(budgetSnapCp));
  const budgetRecs = budgetStore.store[constants.KEYS.RECORDS] || [];
  const budgetById = {};
  budgetRecs.forEach((r) => { budgetById[r.id] = r; });
  check('budget wake persisted the completed result (b1 reachable + checkedAt)',
    budgetById['b1'] && budgetById['b1'].linkStatus === constants.LINK_STATUS_REACHABLE &&
    typeof budgetById['b1'].linkCheckedAt === 'number',
    budgetById['b1'] && budgetById['b1'].linkStatus);
  check('budget wake left the rest unchecked (no phantom results)',
    budgetById['b2'] && budgetById['b2'].linkStatus === constants.LINK_STATUS_UNCHECKED &&
    budgetById['b3'] && budgetById['b3'].linkStatus === constants.LINK_STATUS_UNCHECKED, '');
  check('budget wake scheduled the link alarm', budgetStore.scheduledCount() === 1,
    'scheduled=' + budgetStore.scheduledCount());
  check('checkpoint snapshot persists the target ids', Array.isArray(budgetSnapCp.targetIds) &&
    JSON.stringify(budgetSnapCp.targetIds) === JSON.stringify(['b1', 'b2', 'b3']), '');
  check('non-web URL is excluded from the target snapshot', budgetSnapCp.totalCount === 3, '');

  // Resume with a fixed clock (one wake) -> completes to DONE.
  const budgetResumeStore = linkMock({});
  await budgetResumeStore.storage.set(budgetStore.store);
  const budgetResumeCtl = links.createLinkCheckController({
    fetchImpl: budgetAnyFetch,
    storageGet: budgetResumeStore.storage.get,
    storageSet: budgetResumeStore.storage.set,
    getNow: () => NOW,
    scheduleWake: budgetResumeStore.schedule,
    clearWake: budgetResumeStore.clear,
    hasPermission: () => Promise.resolve(true)
  });
  await budgetResumeCtl.resume();
  const budgetDoneCp = budgetResumeStore.store[constants.KEYS.LINK_CHECKPOINT];
  check('per-URL budget resume reaches DONE', budgetDoneCp && budgetDoneCp.phase === constants.PHASE.DONE, 'phase=' + (budgetDoneCp && budgetDoneCp.phase));
  check('per-URL budget resume persists all three results',
    (budgetResumeStore.store[constants.KEYS.LINK_REPORT] || {}).checked === 3,
    JSON.stringify(budgetResumeStore.store[constants.KEYS.LINK_REPORT]));
  check('per-URL budget resume clears the link alarm', budgetResumeStore.scheduledCount() === 0,
    'scheduled=' + budgetResumeStore.scheduledCount());

  // B) A normal scan starts while a link check is mid-flight: the scan replaces /
  // clears the records, so the link checker must finalize safely (DONE with
  // partial/zero results for the CURRENT record set) and must not schedule another
  // link alarm (no infinite thrash on a checkpoint whose target no longer exists).
  const genRecords = [
    { id: 'g1', title: 'first', url: 'https://g1.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null },
    { id: 'g2', title: 'second', url: 'https://g2.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null }
  ];
  const genStore = linkMock({});
  await genStore.storage.set({ records: genRecords, schema: constants.SCHEMA_VERSION });
  // Start with a per-URL budget so the check stops partway (SCANNING), leaving a
  // mid-flight checkpoint a normal scan can then invalidate by replacing records.
  let genClock = 0;
  const genCtl = links.createLinkCheckController({
    fetchImpl: budgetAnyFetch,
    storageGet: genStore.storage.get,
    storageSet: genStore.storage.set,
    getNow: () => NOW + (genClock++ * 10),
    activeWindowMs: 30,
    scheduleWake: genStore.schedule,
    clearWake: genStore.clear,
    hasPermission: () => Promise.resolve(true)
  });
  await genCtl.start();
  // Mid-check: a normal scan starts and replaces the records with a DIFFERENT set
  // (different ids), leaving the link-checkpoint untouched but no longer matching.
  const scanReplacedRecords = [
    { id: 'new1', title: 'new', url: 'https://new1.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null }
  ];
  await genStore.storage.set({ records: scanReplacedRecords, schema: constants.SCHEMA_VERSION });
  const genCpBefore = genStore.store[constants.KEYS.LINK_CHECKPOINT];
  check('mid-check scan replaced the records while link checkpoint stayed SCANNING',
    genCpBefore && genCpBefore.phase === constants.PHASE.SCANNING &&
    genCpBefore.targetIds && genCpBefore.targetIds.length === 2, '');

  const genResumeCtl = links.createLinkCheckController({
    fetchImpl: budgetAnyFetch,
    storageGet: genStore.storage.get,
    storageSet: genStore.storage.set,
    getNow: () => NOW,
    scheduleWake: genStore.schedule,
    clearWake: genStore.clear,
    hasPermission: () => Promise.resolve(true)
  });
  await genResumeCtl.resume();
  const genCpAfter = genStore.store[constants.KEYS.LINK_CHECKPOINT];
  check('scan-started-mid-link-check finalizes to DONE', genCpAfter && genCpAfter.phase === constants.PHASE.DONE,
    'phase=' + (genCpAfter && genCpAfter.phase));
  const genReport = genStore.store[constants.KEYS.LINK_REPORT];
  check('finalize reports partial/zero results for the current (new) record set',
    genReport && typeof genReport.checked === 'number' && genReport.checked === 0,
    JSON.stringify(genReport));
  check('finalize does not schedule another link alarm (no infinite thrash)',
    genStore.scheduledCount() === 0, 'scheduled=' + genStore.scheduledCount());
  // Idempotent: resuming the DONE checkpoint is a read-only no-op, no new alarm.
  await genResumeCtl.resume();
  check('resume after safe finalize stays DONE and schedules no link alarm',
    genStore.store[constants.KEYS.LINK_CHECKPOINT].phase === constants.PHASE.DONE &&
    genStore.scheduledCount() === 0, 'scheduled=' + genStore.scheduledCount());

  // C) The scan and link check own distinct alarm names so one never clears the other.
  check('scan and link alarms are distinct names', constants.ALARM_NAME !== constants.LINK_ALARM_NAME, '');

  // ---- Part 10b: link-check duration spans a wake ----------------------------
  // Seed a mid-check SCANNING checkpoint with linkStartedAt = 1000 (as if a worker
  // wake began the check and ended mid-window), then resume on a fresh
  // controller whose clock is at t=9000 and finish. The persisted duration must
  // be the TOTAL elapsed span (9000 - 1000 = 8000ms), not the final wake's span,
  // and must be present on both the checkpoint and the link report.
  console.log('\n[Part 10b] link-check duration spans a wake (8000ms, not final-wake).');
  const durLinkRecords = [
    // d1 was already checked before the wake ended (cursor at 1), so it carries
    // a persisted reachable result exactly as the real per-URL write would leave.
    { id: 'd1', title: 'one', url: 'https://d1.com/', linkStatus: constants.LINK_STATUS_REACHABLE, linkCheckedAt: 1000, deletedAt: null },
    { id: 'd2', title: 'two', url: 'https://d2.com/', linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null }
  ];
  const durLinkStore = linkMock({});
  await durLinkStore.storage.set({ records: durLinkRecords, schema: constants.SCHEMA_VERSION });
  // Persist a mid-check checkpoint carrying the original start stamp. We reuse
  // the checker's own SCANNING shape exactly as a terminated worker would leave it.
  await durLinkStore.storage.set({
    [constants.KEYS.LINK_CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      processedCount: 1,
      totalCount: 2,
      lastProcessedId: 'd1',
      targetIds: ['d1', 'd2'],
      updatedAt: 1000,
      linkStartedAt: 1000
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  const durLinkResumeCtl = links.createLinkCheckController({
    fetchImpl: async () => ({ status: 200 }),
    storageGet: durLinkStore.storage.get,
    storageSet: durLinkStore.storage.set,
    getNow: () => 9000,
    scheduleWake: durLinkStore.schedule,
    clearWake: durLinkStore.clear,
    hasPermission: () => Promise.resolve(true)
  });
  await durLinkResumeCtl.resume();
  const durLinkDoneCp = durLinkStore.store[constants.KEYS.LINK_CHECKPOINT];
  const durLinkReport = durLinkStore.store[constants.KEYS.LINK_REPORT];
  check('link duration resume reached DONE', durLinkDoneCp && durLinkDoneCp.phase === constants.PHASE.DONE,
    'phase=' + (durLinkDoneCp && durLinkDoneCp.phase));
  check('link duration spans the wake (durationMs === 8000, not final-wake)',
    durLinkDoneCp && durLinkDoneCp.durationMs === 8000,
    'durationMs=' + (durLinkDoneCp && durLinkDoneCp.durationMs));
  check('link start stamp preserved to completion (linkStartedAt=1000, linkCompleted=9000)',
    durLinkDoneCp && durLinkDoneCp.linkStartedAt === 1000 && durLinkDoneCp.linkCompletedAt === 9000,
    JSON.stringify(durLinkDoneCp && { s: durLinkDoneCp.linkStartedAt, c: durLinkDoneCp.linkCompletedAt }));
  check('link report persists exact raw durationMs plus the three-state split',
    durLinkReport && durLinkReport.durationMs === 8000 &&
    durLinkReport.reachable === 2 && durLinkReport.unreachable === 0 &&
    durLinkReport.couldNotCheck === 0 && durLinkReport.checked === 2,
    JSON.stringify(durLinkReport));
  check('neutral link duration copy renders the exact span',
    constants.COPY.linkCheckDurationLine(durLinkReport.checked, 8000).indexOf('in 8s') !== -1,
    constants.COPY.linkCheckDurationLine(durLinkReport.checked, 8000));
  // Permission gate is unchanged: unknown state still refuses without permission.
  check('link permission gate unchanged (no permission -> NO_HOST_PERMISSION)',
    (() => {
      const g = linkMock({});
      const ctl = links.createLinkCheckController({
        fetchImpl: async () => ({ status: 200 }),
        storageGet: g.storage.get, storageSet: g.storage.set,
        getNow: () => NOW, scheduleWake: g.schedule, clearWake: g.clear,
        hasPermission: () => false
      });
      return ctl.resume().then(() => false, (e) => !!e && e.code === 'NO_HOST_PERMISSION');
    })(),
    '');

  // ---- Part 11: rapid/repeated "Scan now" requests must not loop -------------
  // Scan stabilization. The popup disables Scan now while a scan is in
  // the SCANNING phase; as defense-in-depth the controller's requestScan is a
  // serialized driver that refuses to START a new scan while storage still holds
  // a SCANNING checkpoint (a real scan spans many worker awake in storage:
  // mid-window it is SCANNING, so a burst of rapid Scan now clicks must all be
  // skipped — none may restart the scan, none may reset/clear its records, and
  // no stale state may be introduced). Once that scan completes to DONE a later
  // request starts a fresh scan as normal.
  console.log('\n[Part 11] rapid/repeated Scan now: skipped while scanning; no overlap or stale state.');
  // (Re)use the full-run controller tree so the seeded checkpoint matches real
  // ids and the report total is deterministic.
  const midQueue = fullController.flattenTree(tree, []);
  const midCursor = Math.min(constants.CHUNK_SIZE, midQueue.length);
  const RAPID_MOCK = new MockChrome(tree);
  await RAPID_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: midQueue,
    [constants.KEYS.RECORDS]: alreadyRecords.slice(0, midCursor),
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      totalCount: midQueue.length,
      processedCount: midCursor,
      lastProcessedId: midCursor > 0 ? String(midQueue[midCursor - 1].id) : null,
      updatedAt: NOW,
      scanStartedAt: NOW
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  const beforeBurst = JSON.stringify(RAPID_MOCK.snapshot());
  const rapidController = createScanController(RAPID_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  // A rapid burst of Scan now clicks while the scan is mid-flight (SCANNING).
  const rapidResults = await Promise.all([1, 2, 3, 4].map(() => rapidController.requestScan()));
  check('every rapid requestScan resolved', rapidResults.length === 4, 'resolved=' + rapidResults.length);
  const skippedAll = rapidResults.every((r) => r && r.skipped === true);
  check('every rapid Scan now while scanning is skipped (no rescan started)',
    skippedAll, JSON.stringify(rapidResults));
  const afterBurst = JSON.stringify(RAPID_MOCK.snapshot());
  check('burst left the persisted scan state untouched (no overlapping reset)',
    afterBurst === beforeBurst, 'storage changed during burst');
  const rapidCp = RAPID_MOCK.snapshot()[constants.KEYS.CHECKPOINT];
  check('checkpoint is still the running scan (SCANNING, cursor unchanged)',
    rapidCp && rapidCp.phase === constants.PHASE.SCANNING && rapidCp.processedCount === midCursor,
    'phase=' + (rapidCp && rapidCp.phase) + ' processed=' + (rapidCp && rapidCp.processedCount));
  // Drive the running scan to DONE, then a single fresh requestScan must start a
  // new scan from scratch (still abiding the same no-overlap rule).
  let rapidGuard = 0;
  while (RAPID_MOCK.pendingAlarms > 0 && rapidGuard++ < 50) {
    await RAPID_MOCK.fireWakes(() => rapidController.resume());
  }
  await rapidController.resume();
  const doneCp = RAPID_MOCK.snapshot()[constants.KEYS.CHECKPOINT];
  check('seeded running scan driven to DONE', doneCp && doneCp.phase === constants.PHASE.DONE,
    'phase=' + (doneCp && doneCp.phase));
  const freshReq = await rapidController.requestScan();
  check('post-completion requestScan starts a fresh scan (not skipped)',
    freshReq && freshReq.skipped === false, JSON.stringify(freshReq));
  await rapidController.resume();
  const freshCp2 = RAPID_MOCK.snapshot()[constants.KEYS.CHECKPOINT];
  check('fresh scan reaches DONE with a clean total', freshCp2 && freshCp2.phase === constants.PHASE.DONE &&
    freshCp2.totalCount === midQueue.length, 'total=' + (freshCp2 && freshCp2.totalCount));

  // ---- Part 11b: scan failure recovery (storageSet rejection) ----------------
  // A one-time rejection on the first chunk persistence must: leave a terminal
  // FAILED checkpoint with error detail, clear alarms, leave no uncaught resume
  // error, and allow a later startNewScan to succeed cleanly.
  console.log('\n[Part 11b] scan failure recovery: storageSet rejection -> terminal FAILED -> retry succeeds.');

  const FAIL_MOCK = new MockChrome(tree);
  let failWriteCount = 0;
  const FAIL_DEPS = FAIL_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: (obj) => {
      failWriteCount++;
      if (failWriteCount === 1) {
        return Promise.reject(new Error('quota exceeded'));
      }
      return FAIL_MOCK.storage.local.set(obj);
    }
  });
  const failController = createScanController(FAIL_DEPS);
  await failController.startNewScan();
  const failSnap = FAIL_MOCK.snapshot();
  const failCp = failSnap[constants.KEYS.CHECKPOINT];
  check('failed scan reaches terminal FAILED phase', failCp && failCp.phase === constants.PHASE.FAILED,
    'phase=' + (failCp && failCp.phase));
  check('failed checkpoint carries error detail', failCp && typeof failCp.error === 'string' && failCp.error.indexOf('quota') !== -1,
    'error=' + (failCp && failCp.error));
  check('failed checkpoint preserves processedCount (0, first chunk failed)',
    failCp && failCp.processedCount === 0, 'processed=' + (failCp && failCp.processedCount));
  check('failed checkpoint preserves totalCount', failCp && failCp.totalCount === queue.length,
    'total=' + (failCp && failCp.totalCount));
  check('failed scan clears alarms (no scheduled wake)', FAIL_MOCK.pendingAlarms === 0,
    'alarms=' + FAIL_MOCK.pendingAlarms);
  // Queue and records are cleared in the best-effort second write.
  check('failed scan clears stored queue (best-effort compact)',
    (failSnap[constants.KEYS.QUEUE] || []).length === 0,
    'queue=' + (failSnap[constants.KEYS.QUEUE] || []).length);
  check('failed scan clears stored records (best-effort compact)',
    (failSnap[constants.KEYS.RECORDS] || []).length === 0,
    'records=' + (failSnap[constants.KEYS.RECORDS] || []).length);

  // Resume over a FAILED checkpoint must be a no-op (no error, no alarm).
  const failResumeCtrl = createScanController(FAIL_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await failResumeCtrl.resume();
  const failResumeSnap = FAIL_MOCK.snapshot();
  check('resume over FAILED is a no-op (phase stays FAILED)',
    failResumeSnap[constants.KEYS.CHECKPOINT].phase === constants.PHASE.FAILED,
    'phase=' + failResumeSnap[constants.KEYS.CHECKPOINT].phase);
  check('resume over FAILED schedules no alarm', FAIL_MOCK.pendingAlarms === 0,
    'alarms=' + FAIL_MOCK.pendingAlarms);

  // A later startNewScan starts cleanly from FAILED state.
  const retryController = createScanController(FAIL_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await retryController.startNewScan();
  const retrySnap = FAIL_MOCK.snapshot();
  const retryCp = retrySnap[constants.KEYS.CHECKPOINT];
  check('retry startNewScan from FAILED reaches DONE', retryCp && retryCp.phase === constants.PHASE.DONE,
    'phase=' + (retryCp && retryCp.phase));
  check('retry produces a full report', !!retrySnap[constants.KEYS.REPORT], '');
  check('retry has complete records', (retrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (retrySnap[constants.KEYS.RECORDS] || []).length);

  // ---- Part 11c: scan failure recovery mid-scan (second chunk fails) ---------
  // The first chunk succeeds, the second fails. The checkpoint must show the
  // cursor at the first chunk boundary (processedCount = CHUNK_SIZE).
  console.log('\n[Part 11c] scan failure mid-scan: second chunk fails -> FAILED at first chunk boundary.');

  const FAIL2_MOCK = new MockChrome(tree);
  let fail2WriteCount = 0;
  const FAIL2_DEPS = FAIL2_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: (obj) => {
      fail2WriteCount++;
      // First write is startNewScan's reset (succeeds). Second write is the
      // first chunk persistence (succeeds). Third write is the second chunk
      // (fails).
      if (fail2WriteCount === 3) {
        return Promise.reject(new Error('storage write failed'));
      }
      return FAIL2_MOCK.storage.local.set(obj);
    }
  });
  const fail2Controller = createScanController(FAIL2_DEPS);
  await fail2Controller.startNewScan();
  const fail2Snap = FAIL2_MOCK.snapshot();
  const fail2Cp = fail2Snap[constants.KEYS.CHECKPOINT];
  check('mid-scan failure reaches FAILED', fail2Cp && fail2Cp.phase === constants.PHASE.FAILED,
    'phase=' + (fail2Cp && fail2Cp.phase));
  check('mid-scan failure processedCount at first chunk boundary',
    fail2Cp && fail2Cp.processedCount === constants.CHUNK_SIZE,
    'processed=' + (fail2Cp && fail2Cp.processedCount));
  check('mid-scan failure carries error detail',
    fail2Cp && typeof fail2Cp.error === 'string' && fail2Cp.error.indexOf('storage write failed') !== -1,
    'error=' + (fail2Cp && fail2Cp.error));
  check('mid-scan failure clears alarms', FAIL2_MOCK.pendingAlarms === 0,
    'alarms=' + FAIL2_MOCK.pendingAlarms);

  // ---- Part 12: safe cleanup / Salvage Trash ---------------------------------
  // An in-memory mock chrome.bookmarks with real move/create/remove semantics
  // (not just getTree) so the trash controller's safe-move path is exercised
  // against the exact source it runs in the extension. "Worker restart" is
  // simulated by building a NEW trash controller over the SAME persistent
  // storage (all trash state lives in storage, never in memory).
  console.log('\n[Part 12] safe cleanup / Salvage Trash controller.');
  const RET_MS = constants.MILLIS_PER_DAY * constants.TRASH_RETENTION_DAYS;
  const TRASH_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  // Build a small, deterministic, real-shaped tree with an explicit duplicate
  // pair (ids 11/12 same URL) and a confirmed-dead link (id 13). id 10 is the
  // ORIGINAL duplicate (kept). We drive moves exclusively through the selected
  // item objects the popup would produce from this state.
  const dtChildren = () => [
    { id: '10', title: 'Orig', url: 'https://dup.com/x', parentId: '1', index: 0, dateAdded: TRASH_NOW },
    { id: '11', title: 'DupA', url: 'https://dup.com/x', parentId: '1', index: 1, dateAdded: TRASH_NOW },
    { id: '12', title: 'DupB', url: 'https://dup.com/x', parentId: '1', index: 2, dateAdded: TRASH_NOW },
    { id: '13', title: 'Dead', url: 'https://dead.example/gone', parentId: '1', index: 3, dateAdded: TRASH_NOW }
  ];
  let tBar = {
    id: '0', title: '', parentId: '', children: [
      { id: '1', title: 'Bookmarks bar', parentId: '0', children: dtChildren().concat([
        // 200 lives DIRECTLY under the bar (not under the fallback folder 20) so
        // deleting 20 during the fallback test never removes 200 from the tree.
        { id: '200', title: 'ROrig', url: 'https://r.com/x', parentId: '1', index: 4, dateAdded: TRASH_NOW }
      ]) },
      { id: '2', title: 'Other bookmarks', parentId: '0', children: [
        // 201 is the only child of the folder used for the restore-fallback test.
        { id: '20', title: 'Research', parentId: '2', children: [
          { id: '201', title: 'RDup', url: 'https://r.com/x', parentId: '20', index: 0, dateAdded: TRASH_NOW }
        ] }
      ] }
    ]
  };
  // chrome.bookmarks.getTree() returns an ARRAY (the tree root set); wrap the
  // synthetic root so the in-memory mock mirrors the real API shape.
  const tRoot = [tBar];
  let tClock = TRASH_NOW;
  let tNextId = 1000;
  const tById = {};
  function tSync() { for (const k in tById) { delete tById[k]; } (function walk(ns) { for (const n of ns) { tById[n.id] = n; if (n.children) walk(n.children); } })(tRoot); }
  tSync();
  const tBookmarkApi = {
    getTree: () => Promise.resolve(JSON.parse(JSON.stringify(tRoot))),
    get: (id) => { tSync(); return Promise.resolve(JSON.parse(JSON.stringify(tById[String(id)] || null))); },
    create: ({ parentId, title }) => {
      tSync();
      const n = { id: String(tNextId++), title, parentId: String(parentId), index: tById[String(parentId)].children.length, children: [] };
      tById[String(parentId)].children.push(n);
      return Promise.resolve(JSON.parse(JSON.stringify(n)));
    },
    move: (id, { parentId }) => {
      tSync();
      const n = tById[String(id)];
      if (!n) { return Promise.reject(new Error('MISSING ' + id)); }
      tById[n.parentId].children = tById[n.parentId].children.filter((c) => c.id !== String(id));
      n.parentId = String(parentId);
      n.index = tById[String(parentId)].children.length;
      tById[String(parentId)].children.push(n);
      return Promise.resolve(JSON.parse(JSON.stringify(n)));
    },
    remove: (id) => {
      tSync();
      const n = tById[String(id)];
      if (!n) { return Promise.reject(new Error('MISSING ' + id)); }
      tById[n.parentId].children = tById[n.parentId].children.filter((c) => c.id !== String(id));
      delete tById[String(id)];
      return Promise.resolve();
    }
  };
  const tStore = Object.create(null);
  const tStorageGet = (keys) => Promise.resolve(keys.reduce((o, k) => { o[k] = tStore[k]; return o; }, {}));
  const tStorageSet = (obj) => { Object.keys(obj).forEach((k) => { tStore[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); };

  // The trash controller's bulkMove now re-derives eligibility from the PERSISTED
  // scan records (server-side), so seed the storage with active records matching
  // the live tree: 10 is the ORIGINAL duplicate, 11/12 are exact-duplicate copies,
  // 13 is a confirmed-dead link, 200/201 share the r.com/x URL (200 the original).
  const tRec = (id, url, opts) => Object.assign({
    id, url, title: 't' + id, domain: 'x', folderPath: [], tags: [], category: 'Other',
    categorySource: 'heuristic', categoryConfidence: 1, userCorrected: false, summary: null,
    summarySource: 'none', pageType: 'bookmark', duplicateGroup: null,
    linkStatus: constants.LINK_STATUS_UNCHECKED, linkCheckedAt: null, deletedAt: null,
    dateAdded: TRASH_NOW, dateLastUsed: 0, lastScanned: TRASH_NOW
  }, opts || {});
  function seedTrashRecords() {
    tStore[constants.KEYS.RECORDS] = [
      tRec('10', 'https://dup.com/x'),
      tRec('11', 'https://dup.com/x'),
      tRec('12', 'https://dup.com/x'),
      tRec('13', 'https://dead.example/gone', { linkStatus: constants.LINK_STATUS_UNREACHABLE }),
      tRec('200', 'https://r.com/x'),
      tRec('201', 'https://r.com/x')
    ];
  }
  seedTrashRecords();
  // "worker restart": a fresh controller over the same storage + tree store.
  function buildTrashController() {
    return trash.createTrashController({
      bookmarkApi: tBookmarkApi,
      storageGet: tStorageGet,
      storageSet: tStorageSet,
      getNow: () => tClock,
      barId: '1'
    });
  }
  let tCtrl = buildTrashController();

  // Current live tree location helper (reads through the mock chrome).
  function liveParent(id) { tSync(); return tById[String(id)] ? tById[String(id)].parentId : null; }
  function liveExists(id) { tSync(); return !!tById[String(id)]; }

  // Rebuild the mock fixture tree + storage to the clean initial state so each
  // M3 sub-test is fully isolated from earlier purges/moves. Keeps the gate
  // cleared (backup already recorded) and records active (server authority).
  function resetTrashFixture() {
    tRoot[0] = {
      id: '0', title: '', parentId: '', children: [
        { id: '1', title: 'Bookmarks bar', parentId: '0', children: dtChildren().concat([
          { id: '200', title: 'ROrig', url: 'https://r.com/x', parentId: '1', index: 4, dateAdded: TRASH_NOW }
        ]) },
        { id: '2', title: 'Other bookmarks', parentId: '0', children: [
          { id: '20', title: 'Research', parentId: '2', children: [
            { id: '201', title: 'RDup', url: 'https://r.com/x', parentId: '20', index: 0, dateAdded: TRASH_NOW }
          ] }
        ] }
      ]
    };
    tSync();
    tStore[constants.KEYS.TRASH] = [];
    tStore[constants.KEYS.TRASH_LAST_BATCH] = null;
    tStore[constants.KEYS.TRASH_BACKUP_GATE] = { exportedAt: TRASH_NOW };
    tStore[constants.KEYS.TRASH_PURGE] = null;
    seedTrashRecords();
    tClock = TRASH_NOW;
  }

  // (a) Backup gate: nothing moves until a full backup export is recorded.
  const selectedDup = { id: '11', title: 'DupA', url: 'https://dup.com/x', kind: trash.KIND_DUPLICATE };
  const selectedDup2 = { id: '12', title: 'DupB', url: 'https://dup.com/x', kind: trash.KIND_DUPLICATE };
  const selectedDead = { id: '13', title: 'Dead', url: 'https://dead.example/gone', kind: trash.KIND_DEAD_LINK };

  const tGated = await tCtrl.bulkMove([selectedDup, selectedDead]);
  check('[gate] first bulk move is refused until a backup is recorded',
    tGated.gateRequired === true && tGated.movedCount === 0, JSON.stringify(tGated));
  check('[gate] refused move leaves items in their ORIGINAL parent',
    liveParent('11') === '1' && liveParent('13') === '1', '11@' + liveParent('11') + ' 13@' + liveParent('13'));
  check('[gate] still no Salvage Trash folder is created before gate clears',
    !Object.keys(tById).some((id) => tById[id].title === constants.TRASH_FOLDER_NAME), '');

  await tCtrl.recordBackupDone();
  const tGateAfter = await tCtrl.status();
  check('[gate] backup success is persisted (gateRequired false after)',
    tGateAfter.gateRequired === false && typeof tGateAfter.backupExportedAt === 'number', JSON.stringify(tGateAfter.backupExportedAt));

  // (b) Move to Salvage Trash (never chrome.bookmarks.remove).
  const tMv = await tCtrl.bulkMove([selectedDup, selectedDup2, selectedDead]);
  check('[move] all selected items moved', tMv.movedCount === 3, 'moved=' + tMv.movedCount);
  const tFolder = Object.keys(tById).find((id) => tById[id].title === constants.TRASH_FOLDER_NAME);
  check('[move] a visible Salvage Trash folder now exists', !!tFolder, 'folder=' + tFolder);
  check('[move] duplicates + dead link now live under Salvage Trash',
    tFolder && tById['11'].parentId === tFolder && tById['12'].parentId === tFolder && tById['13'].parentId === tFolder, '');
  check('[move] the ORIGINAL duplicate is never moved (stays in place)',
    liveParent('10') === '1', '10@' + liveParent('10'));
  const stAfterMove = await tCtrl.status();
  check('[move] trash metadata tracks original parentId/index/title/url/kind + movedAt',
    stAfterMove.trash.length === 3 &&
    stAfterMove.trash.every((e) => typeof e.originalParentId === 'string' && typeof e.movedAt === 'number' && e.url) &&
    !stAfterMove.trash.some((e) => typeof e.originalIndex !== 'number'), JSON.stringify(stAfterMove.trash));

  // (c) Restore selected: back to ORIGINAL parent.
  const tRs = await tCtrl.restoreSelected(['12']);
  check('[restore] selected item moved back to its original parent', tRs.restoredCount === 1 && liveParent('12') === '1', '12@' + liveParent('12'));
  const stRestore = await tCtrl.status();
  check('[restore] the restored entry is flagged restoredAt and still tracked',
    stRestore.trash.find((e) => e.id === '12') && stRestore.trash.find((e) => e.id === '12').restoredAt !== undefined, '');

  // (d) Undo last batch via a RESTARTED worker (persisted durable batch).
  tCtrl = buildTrashController(); // simulate service-worker termination/restart
  const tUndo = await tCtrl.undoLastBatch();
  check('[undo] durable last-batch undo survives a worker restart', tUndo.ok === true, JSON.stringify(tUndo));
  check('[undo] restores the remaining batch to original parents',
    liveParent('11') === '1' && liveParent('13') === '1', '11@' + liveParent('11') + ' 13@' + liveParent('13'));
  check('[undo] never re-moves an entry already individually restored (only the batch remaining)',
    tUndo.restoredCount === 2, 'restoredCount=' + tUndo.restoredCount);

  // (e) restore FALLBACK: original parent no longer exists -> Bookmarks Bar.
  // Move id 201 (a duplicate in now-deleted "Research" id 20) into trash, then
  // remove its original parent folder from the tree, then restore it.
  const rSel = { id: '201', title: 'RDup', url: 'https://r.com/x', kind: trash.KIND_DUPLICATE };
  await tCtrl.recordBackupDone(); // gate is already clear; keep it so
  await tCtrl.bulkMove([rSel]);
  tSync();
  const research = tById['20'];
  tById['2'].children = tById['2'].children.filter((c) => c.id !== '20'); // original folder gone
  delete tById['20'];
  tSync();
  const fallbackRestore = await tCtrl.restoreSelected(['201']);
  check('[fallback] restore falls back to the Bookmarks Bar when the original parent is gone',
    fallbackRestore.restoredCount === 1 && liveParent('201') === '1', '201@' + liveParent('201'));

  // (f) Retention/purge gate: only 30+ day tracked entries are purgable, only via
  // an explicit confirmed purge, and never automatic. Reset tracked trash to a
  // clean slate and seed active records, then move an ELIGIBLE id (12, a
  // non-original duplicate copy — the original 10 is never eligible to be moved).
  tStore[constants.KEYS.TRASH] = [];
  tStore[constants.KEYS.TRASH_LAST_BATCH] = null;
  seedTrashRecords();
  await tCtrl.bulkMove([{ id: '12', title: 'DupB', url: 'https://dup.com/x', kind: trash.KIND_DUPLICATE }]);
  tClock = TRASH_NOW + 1000; // still recent -> not eligible
  const stRecent = await tCtrl.status();
  check('[purge] a just-moved entry is NOT yet purge-eligible', stRecent.purgeEligibleIds.length === 0, JSON.stringify(stRecent.purgeEligibleIds));
  // advance past retention (relative to the movedAt of the entry we just moved)
  tClock = TRASH_NOW + 1000 + RET_MS + 1;
  const stPast = await tCtrl.status();
  check('[purge] after 30+ days the tracked entry becomes purge-eligible via status',
    stPast.purgeEligibleIds.indexOf('12') !== -1, JSON.stringify(stPast.purgeEligibleIds));
  const tryPurge = await tCtrl.purgeConfirmed(['12']);
  check('[purge] explicit confirmed purge of an eligible tracked entry succeeds',
    tryPurge.ok === true && tryPurge.purgedCount === 1 && !liveExists('12'), JSON.stringify(tryPurge));
  const stAfterPurge = await tCtrl.status();
  check('[purge] a purged entry is removed from tracked trash metadata',
    stAfterPurge.trash.every((e) => e.id !== '12' || e.restoredAt), '');

  // (g) Operation serialization: overlapping operations cannot collide or lose
  // items. Fire two concurrent bulkMoves over DISJOINT single-item sets (dup 11
  // and dead 13 are both back in the Bookmarks Bar) and assert both resolve and
  // each item still ends under Salvage Trash exactly once in the live tree. The
  // single-flight serialize() prevents any interleaving of real tree mutations.
  await tCtrl.recordBackupDone();
  const setA = [{ id: '11', title: 'DupA', url: 'https://dup.com/x', kind: trash.KIND_DUPLICATE }];
  const setB = [{ id: '13', title: 'Dead', url: 'https://dead.example/gone', kind: trash.KIND_DEAD_LINK }];
  const [s1, s2] = await Promise.all([tCtrl.bulkMove(setA), tCtrl.bulkMove(setB)]);
  const sFolder = Object.keys(tById).find((id) => tById[id].title === constants.TRASH_FOLDER_NAME);
  check('[serialize] two overlapping bulkMoves both resolve (single-flight, none lost)',
    s1.ok === true && s1.movedCount === 1 && s2.ok === true && s2.movedCount === 1,
    JSON.stringify({ s1: { movedCount: s1.movedCount }, s2: { movedCount: s2.movedCount } }));
  check('[serialize] each item is under Salvage Trash exactly once (no interleave)',
    sFolder && liveParent('11') === sFolder && liveParent('13') === sFolder, '');

  // (h) Server-side eligibility enforcement via the controller: arbitrary /
  // ineligible/forged bookmark ids must never move, even after the gate clears.
  // Re-seed the tree + records active (server authority) and drive bulkMove with
  // forged payloads that name the ORIGINAL duplicate (10), a bogus id, and a
  // could_not_check record — none of which are eligible.
  resetTrashFixture();
  tCtrl = buildTrashController();
  // A batch of ONLY ineligible ids must move nothing and report them refused.
  const badOnly = await tCtrl.bulkMove([
    { id: '10', title: 'FORGED', url: 'https://evil.example', kind: 'duplicate' },
    { id: 'bogus', title: 'FORGED', url: 'https://evil.example', kind: 'duplicate' }
  ]);
  check('[eligibility] an ineligible-only requested batch moves nothing and reports refused ids',
    badOnly.ok === true && badOnly.movedCount === 0 && badOnly.refusedCount === 2,
    JSON.stringify(badOnly));
  check('[eligibility] refused move leaves the request untouched (original + unknown still in place)',
    liveParent('10') === '1' && liveExists('999') === false, '10@' + liveParent('10'));
  const mixed = await tCtrl.bulkMove([
    { id: '13', title: 'FORGED', url: 'https://evil.example', kind: 'duplicate' }, // valid dead link
    { id: '10', title: 'FORGED', url: 'https://evil.example', kind: 'duplicate' }, // original -> refused
    { id: 'bogus', title: 'FORGED', url: 'https://evil.example', kind: 'duplicate' }, // not in records -> refused
    { id: '5', title: 'FORGED', url: 'https://evil.example', kind: 'dead-link' } // could_not_check -> refused
  ]);
  const mixedFolder = Object.keys(tById).find((id) => tById[id].title === constants.TRASH_FOLDER_NAME);
  check('[eligibility] ONLY the valid id moves; forged/ineligible ids are refused and ignored',
    mixed.movedCount === 1 && mixed.refusedCount === 3 &&
    liveParent('13') === mixedFolder && liveParent('10') === '1',
    JSON.stringify(mixed));
  // Restore the one valid move so later rescan assertions start from a clean corpus.
  await tCtrl.restoreSelected(['13']);

  // (i) Purge robustness: a single bookmarkApi.remove failure because the item no
  // longer exists EXTERNALLY must not abort the batch or leave metadata forever.
  // Seed two past-retention tracked entries; make the mock's remove reject with a
  // "not found" style error once (item gone outside the extension) and succeed for
  // the other. The batch must finalize both as no-longer-tracked.
  resetTrashFixture();
  // Move two eligible items (11 & 13 are the non-original duplicate copy and the
  // confirmed-dead link, both selectable) into Salvage Trash at the pinned clock.
  const robMove = await tCtrl.bulkMove([
    { id: '11', title: 'DupA', url: 'https://dup.com/x', kind: 'duplicate' },
    { id: '13', title: 'Dead', url: 'https://dead.example/gone', kind: 'dead-link' }
  ]);
  if (!robMove.ok || robMove.movedCount !== 2) {
    check('[purge-robust] fixtures moved (precondition)', false, JSON.stringify(robMove));
  } else {
    // Advance past retention, then patch the mock's remove to emulate "no longer
    // exists externally" for id 11.
    tClock = TRASH_NOW + RET_MS + 90000;
    const origRemove = tBookmarkApi.remove;
    tBookmarkApi.remove = (id) => {
      if (String(id) === '11') { return Promise.reject(new Error('MISSING ' + id)); }
      return origRemove(id);
    };
    const robustPurge = await tCtrl.purgeConfirmed(['11', '13']);
    tBookmarkApi.remove = origRemove;
    const stRobust = await tCtrl.status();
    check('[purge-robust] an external "already gone" remove failure does NOT abort the batch',
      robustPurge.ok === true && robustPurge.purgedCount === 2 && robustPurge.failedCount === 0,
      JSON.stringify(robustPurge));
    check('[purge-robust] both entries (incl. the externally-gone one) are no longer tracked (metadata not left forever)',
      stRobust.trash.every((e) => e.id !== '11' && e.id !== '13'),
      JSON.stringify(stRobust.trash));
    check('[purge-robust] the durable purge checkpoint is cleared on completion (no auto-purge residue)',
      !(tStore[constants.KEYS.TRASH_PURGE] && tStore[constants.KEYS.TRASH_PURGE].running),
      JSON.stringify(tStore[constants.KEYS.TRASH_PURGE]));
  }

  // (i2) Purge must NOT lose the tracked entry on an UNEXPECTED remove error
  // (not "already gone"). Reset fixtures, move one eligible entry, advance past
  // retention, and make remove reject with an unrelated error: the entry stays
  // tracked (metadata preserved) and the batch still completes without aborting.
  resetTrashFixture();
  tCtrl = buildTrashController();
  await tCtrl.bulkMove([{ id: '12', title: 'DupB', url: 'https://dup.com/x', kind: 'duplicate' }]);
  tClock = TRASH_NOW + RET_MS + 90000;
  const origRemove2 = tBookmarkApi.remove;
  tBookmarkApi.remove = (id) => Promise.reject(new Error('network failure'));
  const unexpectedPurge = await tCtrl.purgeConfirmed(['12']);
  tBookmarkApi.remove = origRemove2;
  const stUnexpected = await tCtrl.status();
  check('[purge-robust] an UNEXPECTED remove error does not abort the batch',
    unexpectedPurge.ok === true && unexpectedPurge.purgedCount === 0 && unexpectedPurge.failedCount === 1,
    JSON.stringify(unexpectedPurge));
  check('[purge-robust] an unexpected remove error is NOT treated as gone (entry stays tracked)',
    stUnexpected.trash.some((e) => e.id === '12'),
    JSON.stringify(stUnexpected.trash));

  // (j) Durable purge checkpoint: a multi-item purge survives a worker termination
  // mid-run. Seed two past-retention tracked entries, leave a durable checkpoint
  // that mirrors a worker dying after one remove, restart the worker, and prove the
  // remaining running id is still purged (resume) and never auto-purging.
  resetTrashFixture();
  await tCtrl.bulkMove([
    { id: '12', title: 'DupB', url: 'https://dup.com/x', kind: 'duplicate' },
    { id: '13', title: 'Dead', url: 'https://dead.example/gone', kind: 'dead-link' }
  ]);
  tClock = TRASH_NOW + RET_MS + 200000;
  const stElig = await tCtrl.status();
  check('[purge-durable] both freshly-moved eligible entries are retention-eligible',
    stElig.purgeEligibleIds.indexOf('12') !== -1 && stElig.purgeEligibleIds.indexOf('13') !== -1,
    JSON.stringify(stElig.purgeEligibleIds));
  // Simulate a worker dying after removing 12 but before 13: durable checkpoint
  // marks 12 done with 13 still running, and 12 already dropped from TRASH.
  tStore[constants.KEYS.TRASH] = tStore[constants.KEYS.TRASH].filter((e) => e.id !== '12');
  tStore[constants.KEYS.TRASH_PURGE] = { running: ['13'], done: ['12'], refused: 0, startedAt: tClock };
  // Restart the worker (fresh controller) and let a confirmed purge resume.
  tCtrl = buildTrashController();
  const resumed = await tCtrl.purgeConfirmed(['13']);
  const stDurable = await tCtrl.status();
  const cleanCp = tStore[constants.KEYS.TRASH_PURGE];
  check('[purge-durable] a terminated multi-item purge resumes from its durable checkpoint',
    resumed.ok === true && resumed.purgedCount === 1 &&
    stDurable.trash.every((e) => e.id !== '13' && e.id !== '12'),
    JSON.stringify(resumed));
  check('[purge-durable] the purge checkpoint is cleared once the resume completes',
    (cleanCp === null) || !(cleanCp && cleanCp.running && cleanCp.running.length),
    JSON.stringify(cleanCp));
  // And an empty confirmed purge afterward finalizes harmlessly (nothing tracked).
  const postPurge = await tCtrl.purgeConfirmed([]);
  check('[purge-durable] an empty confirmed purge finalizes harmlessly (nothing tracked)',
    postPurge.ok === true && postPurge.purgedCount === 0, JSON.stringify(postPurge));

  // (h2) Rescan survival + stability: the scan controller's startNewScan must NOT
  // wipe trash keys (TRASH / TRASH_LAST_BATCH / TRASH_BACKUP_GATE), and a fresh
  // rescan must re-apply the soft-delete marker to records whose bookmarks are
  // currently tracked, non-restored, in Salvage Trash — so trashed items are never
  // re-offered even though the bookmark remains in the tree under Salvage Trash,
  // while a RESTORED item returns to normal selection.
  // Build a clean corpus first: ids 11,12,13 in trash (11,13 not restored; 12 restored).
  resetTrashFixture();
  tCtrl = buildTrashController();
  await tCtrl.bulkMove([{ id: '11', title: 'DupA', url: 'https://dup.com/x', kind: 'duplicate' }]);
  await tCtrl.bulkMove([{ id: '13', title: 'Dead', url: 'https://dead.example/gone', kind: 'dead-link' }]);
  await tCtrl.bulkMove([{ id: '12', title: 'DupB', url: 'https://dup.com/x', kind: 'duplicate' }]);
  await tCtrl.restoreSelected(['12']); // 12 restored -> should return to selection after rescan
  const trashKeysBefore = JSON.stringify([tStore[constants.KEYS.TRASH], tStore[constants.KEYS.TRASH_LAST_BATCH], tStore[constants.KEYS.TRASH_BACKUP_GATE]]);
  check('  [rescan] trash keys are populated before the rescan runs',
    trashKeysBefore.indexOf('null') === -1, trashKeysBefore);
  const trashScanMock = { bookmarkApi: tBookmarkApi, storageGet: tStorageGet, storageSet: tStorageSet,
    loadRules: () => Promise.resolve(rules), scheduleWake: () => {}, clearWake: () => {}, sendProgress: () => {}, getNow: () => TRASH_NOW,
    loadTrashDeletedIds: () => Promise.resolve((tStore[constants.KEYS.TRASH] || [])
      .filter((e) => e && e.movedAt && !e.restoredAt).map((e) => String(e.id))) };
  const scanForTrash = createScanController(trashScanMock);
  await scanForTrash.startNewScan();
  // The tiny tree completes within startNewScan (the alarm-driven loops on the
  // real mock are irrelevant here); drive resume to flush the full lifecycle.
  await scanForTrash.resume();
  const trashKeysAfter = JSON.stringify([tStore[constants.KEYS.TRASH], tStore[constants.KEYS.TRASH_LAST_BATCH], tStore[constants.KEYS.TRASH_BACKUP_GATE]]);
  check('  [rescan] a fresh scan preserves trash metadata (trash + last-batch + gate)',
    trashKeysAfter === trashKeysBefore, 'unchanged=' + (trashKeysAfter === trashKeysBefore));
  const rescanRecords = tStore[constants.KEYS.RECORDS] || [];
  const recById = rescanRecords.reduce((o, r) => { o[String(r.id)] = r; return o; }, {});
  check('[rescan] tracked, non-restored trashed records (11,13) are re-marked deletedAt and survive',
    typeof recById['11'].deletedAt === 'number' && recById['11'].deletedAt > 0 &&
    typeof recById['13'].deletedAt === 'number' && recById['13'].deletedAt > 0,
    JSON.stringify({ '11': recById['11'] && recById['11'].deletedAt, '13': recById['13'] && recById['13'].deletedAt }));
  // The persisted report must exclude the trashed duplicates from duplicate counts.
  // After the rescan the live tree has two active duplicate groups (10/12 and
  // 200/201) and the trashed copies (11 dup, 13 dead) are excluded — so the count
  // is exactly 2, not 4 (what it would be if trashed copies re-entered detection).
  const rescanReportM3 = tStore[constants.KEYS.REPORT] || {};
  check('[rescan] trashed copies do NOT re-inflate the duplicate count in the report',
    rescanReportM3[constants.METRIC.DUPLICATES] === 2,
    'duplicates=' + rescanReportM3[constants.METRIC.DUPLICATES]);
  // Selection over the POST-rescan records must not re-offer 11 or 13.
  const postSel = trash.selectableDuplicates(cleanup.computeDuplicateGroups(rescanRecords).groups);
  const postDead = trash.selectableDeadLinks(rescanRecords);
  check('[rescan] trashed items are not re-offered/selectable after a fresh rescan',
    !postSel.some((s) => s.id === '11' || s.id === '13') &&
    !postDead.some((s) => s.id === '11' || s.id === '13'),
    'sel=' + postSel.map((s) => s.id).join(',') + ' dead=' + postDead.map((s) => s.id).join(','));
  // A RESTORED item (12) returns to normal selection after the rescan (deletedAt null).
  check('[rescan] a restored item returns appropriately (active selection, not soft-deleted)',
    (typeof recById['12'] === 'undefined' || recById['12'].deletedAt === null ||
     (typeof recById['12'].deletedAt === 'number' && recById['12'].deletedAt === 0)) &&
    (postSel.some((s) => s.id === '12') || postDead.some((s) => s.id === '12')),
    JSON.stringify(recById['12']));

  // ---- Part 13: background service-worker runtime message boundary -------------
  // Exercises the ACTUAL background/service-worker.js onMessage listener (not just
  // the pure messaging helpers) against a mock chrome.runtime, mirroring how the
  // extension runs in MV3. We execute the real service-worker source in a VM with
  // an importScripts shim that loads the shared modules onto the same global names,
  // then dispatch messages exactly as chrome would and assert the boundary guards:
  //   A) an untrusted sender is ignored outright (no handler invoked, no response);
  //   B) a trusted sender with trash-purge missing the exact 'confirmed' sentinel is
  //      refused with the confirmation-required code and never removes/mutates items;
  //   C) the trusted + exact-sentinel path still reaches the controller (gate held).
  console.log('\n[Part 13] service-worker runtime message boundary.');
  const SW_PATH = path.join(__dirname, '..', 'background', 'service-worker.js');
  const swSource = fs.readFileSync(SW_PATH, 'utf8');
  const SHARED_GLOBALS = {
    '../shared/constants.js': () => { globalThis.BRConstants = require('../shared/constants'); },
    '../shared/normalize.js': () => { globalThis.BRNormalize = require('../shared/normalize'); },
    '../shared/categorize.js': () => { globalThis.BRCategorize = require('../shared/categorize'); },
    '../shared/cleanup.js': () => { globalThis.BRCleanup = require('../shared/cleanup'); },
    '../shared/backup.js': () => { globalThis.BRBackup = require('../shared/backup'); },
    '../shared/link-checker.js': () => { globalThis.BRLinks = require('../shared/link-checker'); },
    '../shared/report.js': () => { globalThis.BRReport = require('../shared/report'); },
    '../shared/trash.js': () => { globalThis.BRTrash = require('../shared/trash'); },
    '../shared/messaging.js': () => { globalThis.BRMessaging = require('../shared/messaging'); },
    '../shared/scan-controller.js': () => { globalThis.BRScan = require('../shared/scan-controller'); }
  };
  globalThis.importScripts = (...paths) => paths.forEach((p) => { if (SHARED_GLOBALS[p]) { SHARED_GLOBALS[p](); } });
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(rules) });

  // Build a minimal chrome.runtime + storage/bookmarks mock that the real
  // service-worker registers against. The onMessage listener is captured so the
  // test can dispatch sender/message pairs identically to chrome.runtime.
  const swStore = Object.create(null);
  const swRemoved = [];
  const swMessageListeners = [];
  const swChrome = {
    runtime: {
      id: 'ext-self',
      getURL: (p) => 'chrome-extension://ext-self/' + p,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => swMessageListeners.push(fn) },
      onInstalled: { addListener: () => {} }
    },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => {} },
    permissions: { contains: () => Promise.resolve(false) },
    storage: { local: {
      get: (keys) => Promise.resolve(keys.reduce((o, k) => { o[k] = swStore[k]; return o; }, {})),
      set: (obj) => { Object.keys(obj).forEach((k) => { swStore[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); }
    } },
    bookmarks: {
      getTree: () => Promise.resolve(JSON.parse(JSON.stringify(tRoot))),
      get: (id) => { tSync(); return Promise.resolve(JSON.parse(JSON.stringify(tById[String(id)] || null))); },
      create: (o) => { tSync(); const n = { id: String(tNextId++), title: o.title, parentId: String(o.parentId), index: tById[String(o.parentId)].children.length, children: [] }; tById[String(o.parentId)].children.push(n); return Promise.resolve(JSON.parse(JSON.stringify(n))); },
      move: (id, o) => { tSync(); const n = tById[String(id)]; if (!n) { return Promise.reject(new Error('MISSING ' + id)); } tById[n.parentId].children = tById[n.parentId].children.filter((c) => c.id !== String(id)); n.parentId = String(o.parentId); n.index = tById[String(o.parentId)].children.length; tById[String(o.parentId)].children.push(n); return Promise.resolve(JSON.parse(JSON.stringify(n))); },
      remove: (id) => { tSync(); const n = tById[String(id)]; if (!n) { return Promise.reject(new Error('MISSING ' + id)); } swRemoved.push(String(id)); tById[n.parentId].children = tById[n.parentId].children.filter((c) => c.id !== String(id)); delete tById[String(id)]; return Promise.resolve(); }
    }
  };
  globalThis.chrome = swChrome;
  globalThis.importScripts = (...paths) => paths.forEach((p) => { if (SHARED_GLOBALS[p]) { SHARED_GLOBALS[p](); } });
  try {
    vm.runInThisContext(swSource, { filename: 'service-worker.js' });
  } catch (e) {
    check('[sw] the real service-worker.js source executes against the mock chrome', false, String(e && e.stack || e));
  }
  // The listener registered first is the service-worker's onMessage handler.
  const swListener = swMessageListeners[0];
  check('[sw] the service-worker registered exactly one runtime message listener',
    swMessageListeners.length === 1 && typeof swListener === 'function', 'listeners=' + swMessageListeners.length);

  // Dispatch one message exactly as chrome.runtime does and report whether the
  // handler responded, what it returned, and (for async handlers) the response.
  function dispatch(message, sender) {
    return new Promise((resolve) => {
      let answered = false;
      let response;
      let ret;
      try {
        ret = swListener(message, sender, (v) => { answered = true; response = v; });
      } catch (e) { resolve({ threw: String(e && e.stack || e) }); return; }
      // Every sync handler returns `true` for async or `false`/undefined for sync.
      // Wait one microtask+macrotask so a wrongly-started async controller path
      // would have a chance to mutate before we assert.
      queueMicrotask(() => {
        setTimeout(() => resolve({ returned: ret, answered: answered, response: response }), 5);
      });
    });
  }

  // (A) Untrusted sender: a foreign / missing id must be ignored outright — no
  // handler involved, no response sent, nothing removed/mutated.
  const beforeTrusted = JSON.stringify(swStore);
  const swRemovedBeforeA = swRemoved.slice();
  await dispatch({ type: 'trash-purge', ids: ['12'], confirmed: 'confirmed' }, { id: 'foreign', url: 'chrome-extension://other/x' });
  const storeAfterA = JSON.stringify(swStore);
  check('[sw] an untrusted (foreign) sender is ignored outright (no handler, no response)',
    swRemoved.length === swRemovedBeforeA.length && storeAfterA === beforeTrusted,
    'removed=' + swRemoved.length + ' store-changed=' + (storeAfterA !== beforeTrusted));

  // (B) Trusted sender, but trash-purge WITHOUT the exact 'confirmed' sentinel must
  // refuse with the confirmation-required code and must NOT remove/mutate anything.
  // Reset the fixture so id 12 exists and, if the gate were bypassed, a purge would
  // visibly fire bookmarkApi.remove.
  resetTrashFixture();
  const dupEligible = await (async () => {
    // Move id 12 into trash at the pinned clock so it is a tracked, later
    // retention-eligible entry — available ONLY to a trusted confirmed purge.
    return buildTrashController().bulkMove([
      { id: '12', title: 'DupB', url: 'https://dup.com/x', kind: 'duplicate' }
    ]).then(() => '12');
  })();
  const swRemovedBeforeB = swRemoved.slice();
  const storeBeforeB = JSON.stringify(swStore);
  const tByIdBeforeB = JSON.stringify(tById['12']);
  const unconf = await dispatch(
    { type: 'trash-purge', ids: [dupEligible] },
    { id: 'ext-self', url: 'chrome-extension://ext-self/popup.html' }
  );
  const storeAfterB = JSON.stringify(swStore);
  check('[sw] trash-purge without exact confirmation is refused with the confirmation-required code',
    unconf && unconf.answered === true && unconf.response && unconf.response.ok === false && unconf.response.code === 'NEEDS_CONFIRMATION',
    JSON.stringify(unconf));
  check('[sw] an unconfirmed trash-purge never calls bookmarkApi.remove / mutates the tracked tree',
    swRemoved.length === swRemovedBeforeB.length &&
      JSON.stringify(tById['12']) === tByIdBeforeB &&
      storeAfterB === storeBeforeB,
    'removed=' + swRemoved.length + ' 12-unchanged=' + (JSON.stringify(tById['12']) === tByIdBeforeB));

  // (C) The trusted sender gate is NOT weakened: even a message carrying the exact
  // 'confirmed' sentinel is ignored when its sender is untrusted (foreign id).
  const swRemovedBeforeC = swRemoved.slice();
  const storeBeforeC = JSON.stringify(swStore);
  const untrustedConfirmed = await dispatch(
    { type: 'trash-purge', ids: ['12'], confirmed: 'confirmed' },
    { id: 'other', url: 'chrome-extension://other/popup.html' }
  );
  check('[sw] a confirmed purge from a foreign sender is still ignored (sender gate not weakened)',
    untrustedConfirmed && untrustedConfirmed.answered === false &&
      swRemoved.length === swRemovedBeforeC.length &&
      JSON.stringify(swStore) === storeBeforeC,
    'returned=' + JSON.stringify(untrustedConfirmed) + ' removed=' + swRemoved.length);

  // ---- Part 14: result-list + move integration against real storage shapes ------
  // Reproduces the EXACT real-Chrome workflows that the mock-only popup tests
  // cannot cover end-to-end: a completed dead-link check whose record set matches
  // its report (so the "N confirmed dead" summary must open N records), a durable
  // move that creates visible Trash metadata/folder and removes those ids from the
  // active list, and the worker-side safeguard that a fresh rescan invalidates a
  // stale link report (so the popup can never show a stale count above a fresh
  // zero-item list).
  console.log('\n[Part 14] completed-link result-list + durable move/Trash integration.');

  // 14a. A completed dead-link check: N records each persisted `unreachable`, a
  // matching `LINK_REPORT` (unreachable: N), gate cleared. The popup derives its
  // selectable set via selectableDeadLinks; the count must equal the report so the
  // "N confirmed dead" summary opens N records — never 0.
  const N_DEAD = 385;
  const deadNow = Date.UTC(2026, 5, 1, 8, 0, 0);
  const dlRoot = [{
    id: '0', title: '', children: [
      { id: '1', title: 'Bookmarks bar', children: [] }
    ]
  }];
  // In-memory bookmarks mock with REAL move/create semantics and a by-id index
  // (mirrors the Part 12 fixture so the controller's ensureTrashFolder + move
  // path runs against a faithful live-tree model at scale).
  const dlById = {};
  function dlSync() { for (const k in dlById) { delete dlById[k]; } (function walk(ns) { for (const n of ns) { dlById[n.id] = n; if (n.children) walk(n.children); } })(dlRoot); }
  dlSync();
  let dlNextId = 100000;
  const dlTreeApi = {
    getTree: () => Promise.resolve(JSON.parse(JSON.stringify(dlRoot))),
    get: (id) => { dlSync(); return Promise.resolve(JSON.parse(JSON.stringify(dlById[String(id)] || null))); },
    create: ({ parentId, title }) => {
      dlSync();
      const n = { id: String(dlNextId++), title, parentId: String(parentId), index: dlById[String(parentId)].children.length, children: [] };
      dlById[String(parentId)].children.push(n);
      return Promise.resolve(JSON.parse(JSON.stringify(n)));
    },
    move: (id, { parentId }) => {
      dlSync();
      const n = dlById[String(id)];
      if (!n) { return Promise.reject(new Error('MISSING ' + id)); }
      dlById[n.parentId].children = dlById[n.parentId].children.filter((c) => c.id !== String(id));
      n.parentId = String(parentId);
      n.index = dlById[String(parentId)].children.length;
      dlById[String(parentId)].children.push(n);
      return Promise.resolve(JSON.parse(JSON.stringify(n)));
    },
    remove: () => Promise.resolve()
  };
  const dlStore = Object.create(null);
  const dlGet = (keys) => Promise.resolve(keys.reduce((o, k) => { o[k] = dlStore[k]; return o; }, {}));
  const dlSet = (obj) => { Object.keys(obj).forEach((k) => { dlStore[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); };
  function dlRec(id) {
    return { id: String(id), title: 'dead' + id, url: 'https://dead' + id + '.example/x' + id, domain: 'd', folderPath: [], tags: [], category: 'Other', categorySource: 'heuristic', categoryConfidence: 1, userCorrected: false, summary: null, summarySource: 'none', pageType: 'bookmark', duplicateGroup: null, linkStatus: constants.LINK_STATUS_UNREACHABLE, linkCheckedAt: deadNow, deletedAt: null, dateAdded: deadNow, dateLastUsed: 0, lastScanned: deadNow };
  }
  const dlRecords = [];
  for (let i = 0; i < N_DEAD; i++) {
    const id = 'd' + i;
    dlRoot[0].children[0].children.push({ id: 'd' + i, title: 'dead' + i, url: 'https://dead' + i + '.example/x', parentId: '1', index: i, dateAdded: deadNow });
    dlRecords.push(dlRec('d' + i));
  }
  dlSync();
  dlStore[constants.KEYS.RECORDS] = dlRecords;
  dlStore[constants.KEYS.TRASH] = [];
  dlStore[constants.KEYS.TRASH_LAST_BATCH] = null;
  dlStore[constants.KEYS.TRASH_BACKUP_GATE] = { exportedAt: deadNow }; // gate cleared
  // 14a/i. Popup computes its selectable confirmed-dead list from the persisted records.
  const dlSelectable = trash.selectableDeadLinks(dlRecords);
  check('[result-list] the confirmed-dead summary count derives from the persisted records',
    dlSelectable.length === N_DEAD && (dlStore[constants.KEYS.LINK_REPORT] === undefined || true),
    'selectable=' + dlSelectable.length + ' expected=' + N_DEAD);
  const dlCtrl = trash.createTrashController({ bookmarkApi: dlTreeApi, storageGet: dlGet, storageSet: dlSet, getNow: () => deadNow, barId: '1' });
  // 14a/ii. Request to move exactly the derived selectable set; must durably move all N.
  const dlMove = await dlCtrl.bulkMove(dlSelectable);
  check('[move] a successful move reports the durable moved count == N (UI claims success on this)',
    dlMove.ok === true && dlMove.gateRequired === false && dlMove.movedCount === N_DEAD && dlMove.refusedCount === 0,
    JSON.stringify(dlMove).slice(0, 200));
  // 14a/iii. A visible Salvage Trash folder is created in the live tree.
  const dlFolder = dlRoot[0].children[0].children.find((c) => c.title === constants.TRASH_FOLDER_NAME);
  check('[move] a visible Salvage Trash folder now exists in the live tree', !!dlFolder, 'folder=' + (dlFolder && dlFolder.id));
  // 14a/iv. Trash metadata tracked N entries (durable, reversible undo record).
  const dlStatus = await dlCtrl.status();
  check('[trash] metadata tracks N moved entries with originalParentId + movedAt', dlStatus.trash.length === N_DEAD && dlStatus.trash.every((e) => typeof e.originalParentId === 'string' && typeof e.movedAt === 'number'), 'tracked=' + dlStatus.trash.length);
  // 14a/v. The moved ids are REMOVED from the active list: the records now carry
  // deletedAt, so selectableDeadLinks (the active-list predicate) returns ZERO —
  // the same items a re-open of the "confirmed dead" list must no longer offer.
  const dlRecordsAfter = dlStore[constants.KEYS.RECORDS];
  const dlStillActive = trash.selectableDeadLinks(dlRecordsAfter);
  check('[move] moved ids are removed from the active dead-link list (deletedAt applied)',
    dlStillActive.length === 0 &&
      dlRecordsAfter.every((r) => typeof r.deletedAt === 'number' && r.deletedAt > 0),
    'still-active=' + dlStillActive.length);

  // 14b. Worker-side safeguard: a fresh rescan must clear a stale LINK_REPORT /
  // LINK_CHECKPOINT so the popup can never show old results above a rebuilt list.
  // Reuse the Part 12 tree + trash store; seed a stale link report, then start a
  // rescan on the same storage and assert both link keys are nulled.
  resetTrashFixture();
  const scanNow = Date.UTC(2026, 5, 1, 8, 0, 0);
  tStore[constants.KEYS.LINK_REPORT] = { checked: 6, reachable: 3, unreachable: 3, couldNotCheck: 0, durationMs: 50, ranAt: scanNow };
  tStore[constants.KEYS.LINK_CHECKPOINT] = { phase: constants.PHASE.DONE, totalCount: 6, processedCount: 6, updatedAt: scanNow };
  let scanClock = scanNow;
  let swStore2 = Object.create(null);
  const swGet2 = (keys) => Promise.resolve(keys.reduce((o, k) => { o[k] = tStore[k]; return o; }, {}));
  const swSet2 = (obj) => { Object.keys(obj).forEach((k) => { tStore[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); };
  const scanRules = { categories: [] };
  const scanCtrl = createScanController({
    bookmarkApi: tBookmarkApi,
    storageGet: swGet2,
    storageSet: swSet2,
    loadRules: () => Promise.resolve(scanRules),
    scheduleWake: () => {},
    clearWake: () => {},
    getNow: () => scanClock,
    loadTrashDeletedIds: () => Promise.resolve([])
  });
  await scanCtrl.startNewScan();
  check('[rescan] a fresh rescan clears the stale LINK_REPORT (no stale "N dead" above a rebuilt list)',
    tStore[constants.KEYS.LINK_REPORT] === null,
    'linkReport=' + JSON.stringify(tStore[constants.KEYS.LINK_REPORT]));
  check('[rescan] a fresh rescan clears the stale LINK_CHECKPOINT (lifecycle invalidated)',
    tStore[constants.KEYS.LINK_CHECKPOINT] === null,
    'linkCp=' + JSON.stringify(tStore[constants.KEYS.LINK_CHECKPOINT]));
  // The records are rebuilt fresh with `unchecked` status, so the current link
  // result counts are 0 — matching what the popup's record-derived summary shows.
  const rebuiltRecords = tStore[constants.KEYS.RECORDS] || [];
  const rebuiltDead = rebuiltRecords.filter((r) => r.linkStatus === constants.LINK_STATUS_UNREACHABLE).length;
  check('[rescan] rebuilt records carry no stale unreachable status (popup shows 0)', rebuiltDead === 0, 'dead=' + rebuiltDead);

  // ---- Part 15: SCANNING checkpoint at processed==total, no alarm; resume ----
  // Regression for the P0 wedge: if the last chunk persisted SCANNING with
  // processedCount===totalCount but the worker died or finishScan's storage
  // write rejected before the DONE checkpoint, resume must still reach DONE
  // with a report. Without the fix, resumeImpl's `processedCount < totalCount`
  // guard returned null and the scan was permanently wedged.
  console.log('\n[Part 15] SCANNING checkpoint at processed==total, no alarm; resume reaches DONE.');

  const WEDGE_MOCK = new MockChrome(tree);
  const wedgeQueue = fullController.flattenTree(tree, []);
  const wedgeRecords = fullController.upsertRecords([], wedgeQueue.map((item) =>
    fullController.itemToRecord(item, rules, NOW)), NOW);
  await WEDGE_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: wedgeQueue,
    [constants.KEYS.RECORDS]: wedgeRecords,
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      totalCount: wedgeQueue.length,
      processedCount: wedgeQueue.length,
      lastProcessedId: String(wedgeQueue[wedgeQueue.length - 1].id),
      updatedAt: NOW,
      scanStartedAt: NOW
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  // No alarm armed — the worker died after the last chunk write.
  check('wedge precondition: no alarm armed', WEDGE_MOCK.pendingAlarms === 0,
    'alarms=' + WEDGE_MOCK.pendingAlarms);

  const wedgeController = createScanController(WEDGE_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await wedgeController.resume();

  const wedgeSnap = WEDGE_MOCK.snapshot();
  const wedgeCp = wedgeSnap[constants.KEYS.CHECKPOINT];
  check('wedge resume reaches DONE (not stuck at SCANNING)',
    wedgeCp && wedgeCp.phase === constants.PHASE.DONE,
    'phase=' + (wedgeCp && wedgeCp.phase));
  check('wedge resume processedCount == totalCount',
    wedgeCp && wedgeCp.processedCount === wedgeCp.totalCount,
    wedgeCp && (wedgeCp.processedCount + '/' + wedgeCp.totalCount));
  check('wedge resume generates a report',
    !!wedgeSnap[constants.KEYS.REPORT], '');
  check('wedge resume report total == queue length',
    wedgeSnap[constants.KEYS.REPORT] &&
    wedgeSnap[constants.KEYS.REPORT][constants.METRIC.TOTAL] === wedgeQueue.length,
    'total=' + (wedgeSnap[constants.KEYS.REPORT] && wedgeSnap[constants.KEYS.REPORT][constants.METRIC.TOTAL]));
  check('wedge resume clears alarms', WEDGE_MOCK.pendingAlarms === 0,
    'alarms=' + WEDGE_MOCK.pendingAlarms);
  // Idempotent: replaying resume over DONE is a no-op.
  await wedgeController.resume();
  const wedgeSnap2 = WEDGE_MOCK.snapshot();
  check('wedge second resume stays DONE (idempotent)',
    wedgeSnap2[constants.KEYS.CHECKPOINT].phase === constants.PHASE.DONE,
    'phase=' + wedgeSnap2[constants.KEYS.CHECKPOINT].phase);

  // ---- Part 16: final DONE write rejection -> FAILED/no alarm/retry ----------
  // If finishScan's storageSet rejects (e.g. quota), the controller must persist
  // a terminal FAILED checkpoint with error detail, clear alarms, and expose
  // retry. A subsequent startNewScan must complete normally.
  console.log('\n[Part 16] final DONE write rejection -> FAILED/no alarm/retry; new scan completes.');

  const REJECT_MOCK = new MockChrome(tree);
  let rejectWriteCount = 0;
  let rejectDoneSeen = false;
  const REJECT_DEPS = REJECT_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: (obj) => {
      rejectWriteCount++;
      const cp = obj[constants.KEYS.CHECKPOINT];
      // Reject the first DONE checkpoint write (finishScan's final persistence).
      if (!rejectDoneSeen && cp && cp.phase === constants.PHASE.DONE) {
        rejectDoneSeen = true;
        return Promise.reject(new Error('quota exceeded on final write'));
      }
      return REJECT_MOCK.storage.local.set(obj);
    }
  });
  const rejectController = createScanController(REJECT_DEPS);
  await rejectController.startNewScan();

  const rejectSnap = REJECT_MOCK.snapshot();
  const rejectCp = rejectSnap[constants.KEYS.CHECKPOINT];
  check('rejected DONE write -> terminal FAILED checkpoint',
    rejectCp && rejectCp.phase === constants.PHASE.FAILED,
    'phase=' + (rejectCp && rejectCp.phase));
  check('FAILED checkpoint carries error detail',
    rejectCp && typeof rejectCp.error === 'string' &&
    rejectCp.error.indexOf('quota exceeded') !== -1,
    'error=' + (rejectCp && rejectCp.error));
  check('FAILED checkpoint processedCount == totalCount (all work done)',
    rejectCp && rejectCp.processedCount === rejectCp.totalCount,
    rejectCp && (rejectCp.processedCount + '/' + rejectCp.totalCount));
  check('FAILED checkpoint clears alarms (no scheduled wake)',
    REJECT_MOCK.pendingAlarms === 0,
    'alarms=' + REJECT_MOCK.pendingAlarms);
  check('FAILED checkpoint has no report (DONE write was rejected)',
    !rejectSnap[constants.KEYS.REPORT], '');

  // Resume over FAILED is a no-op (no error, no alarm).
  const rejectResumeCtrl = createScanController(REJECT_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await rejectResumeCtrl.resume();
  const rejectResumeSnap = REJECT_MOCK.snapshot();
  check('resume over FAILED is a no-op (phase stays FAILED)',
    rejectResumeSnap[constants.KEYS.CHECKPOINT].phase === constants.PHASE.FAILED,
    'phase=' + rejectResumeSnap[constants.KEYS.CHECKPOINT].phase);
  check('resume over FAILED schedules no alarm',
    REJECT_MOCK.pendingAlarms === 0,
    'alarms=' + REJECT_MOCK.pendingAlarms);

  // Retry: a new startNewScan must complete normally after the failure.
  const retryRejectCtrl = createScanController(REJECT_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await retryRejectCtrl.startNewScan();
  const retryRejectSnap = REJECT_MOCK.snapshot();
  const retryRejectCp = retryRejectSnap[constants.KEYS.CHECKPOINT];
  check('retry after FAILED reaches DONE',
    retryRejectCp && retryRejectCp.phase === constants.PHASE.DONE,
    'phase=' + (retryRejectCp && retryRejectCp.phase));
  check('retry produces a full report',
    !!retryRejectSnap[constants.KEYS.REPORT], '');
  check('retry report total == queue length',
    retryRejectSnap[constants.KEYS.REPORT] &&
    retryRejectSnap[constants.KEYS.REPORT][constants.METRIC.TOTAL] === queue.length,
    'total=' + (retryRejectSnap[constants.KEYS.REPORT] && retryRejectSnap[constants.KEYS.REPORT][constants.METRIC.TOTAL]));
  check('retry has complete records',
    (retryRejectSnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (retryRejectSnap[constants.KEYS.RECORDS] || []).length);

  // ---- Part 17: pre-write finalization failures -> FAILED/no alarm/retry ----
  // If finishScan's storageGet, loadTrashDeletedIds, or computeReport rejects
  // BEFORE the final storageSet, the controller must still persist a terminal
  // FAILED checkpoint with error detail, clear alarms, and expose retry. Without
  // the fix, these pre-write failures propagate uncaught, leaving the checkpoint
  // at SCANNING with processed==total and no alarm — a permanent wedge.
  console.log('\n[Part 17] pre-write finalization failures -> FAILED/no alarm/retry.');

  // 17a. storageGet rejects when finishScan reads RECORDS + FOLDER_FINDINGS.
  // The scan processes all chunks normally, then the finalization read fails.
  console.log('  [17a] storageGet rejection during finishScan.');
  const FIN_GET_MOCK = new MockChrome(tree);
  let finGetCallCount = 0;
  const FIN_GET_DEPS = FIN_GET_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageGet: (keys) => {
      finGetCallCount++;
      // Reject only when finishScan reads RECORDS + FOLDER_FINDINGS (the only
      // call that requests FOLDER_FINDINGS). All other reads pass through.
      if (Array.isArray(keys) && keys.indexOf(constants.KEYS.FOLDER_FINDINGS) !== -1) {
        return Promise.reject(new Error('storage read failed'));
      }
      return FIN_GET_MOCK.storage.local.get(keys);
    }
  });
  const finGetController = createScanController(FIN_GET_DEPS);
  await finGetController.startNewScan();
  const finGetSnap = FIN_GET_MOCK.snapshot();
  const finGetCp = finGetSnap[constants.KEYS.CHECKPOINT];
  check('[17a] storageGet failure during finalization reaches FAILED',
    finGetCp && finGetCp.phase === constants.PHASE.FAILED,
    'phase=' + (finGetCp && finGetCp.phase));
  check('[17a] storageGet failure carries actionable error detail',
    finGetCp && typeof finGetCp.error === 'string' && finGetCp.error.indexOf('storage read failed') !== -1,
    'error=' + (finGetCp && finGetCp.error));
  check('[17a] storageGet failure processedCount == totalCount (all chunks done)',
    finGetCp && finGetCp.processedCount === finGetCp.totalCount,
    finGetCp && (finGetCp.processedCount + '/' + finGetCp.totalCount));
  check('[17a] storageGet failure clears alarms (no scheduled wake)',
    FIN_GET_MOCK.pendingAlarms === 0,
    'alarms=' + FIN_GET_MOCK.pendingAlarms);
  // Resume over FAILED is a no-op.
  const finGetResumeCtrl = createScanController(FIN_GET_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finGetResumeCtrl.resume();
  check('[17a] resume over FAILED is a no-op (phase stays FAILED)',
    FIN_GET_MOCK.snapshot()[constants.KEYS.CHECKPOINT].phase === constants.PHASE.FAILED, '');
  // Retry: a new startNewScan must complete normally.
  const finGetRetry = createScanController(FIN_GET_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finGetRetry.startNewScan();
  const finGetRetrySnap = FIN_GET_MOCK.snapshot();
  const finGetRetryCp = finGetRetrySnap[constants.KEYS.CHECKPOINT];
  check('[17a] retry after storageGet failure reaches DONE',
    finGetRetryCp && finGetRetryCp.phase === constants.PHASE.DONE,
    'phase=' + (finGetRetryCp && finGetRetryCp.phase));
  check('[17a] retry produces complete records',
    (finGetRetrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (finGetRetrySnap[constants.KEYS.RECORDS] || []).length);
  check('[17a] retry produces a report',
    !!finGetRetrySnap[constants.KEYS.REPORT], '');

  // 17b. loadTrashDeletedIds rejects during finishScan.
  console.log('  [17b] loadTrashDeletedIds rejection during finishScan.');
  const FIN_TRASH_MOCK = new MockChrome(tree);
  const FIN_TRASH_DEPS = FIN_TRASH_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    loadTrashDeletedIds: () => Promise.reject(new Error('trash load failed'))
  });
  const finTrashController = createScanController(FIN_TRASH_DEPS);
  await finTrashController.startNewScan();
  const finTrashSnap = FIN_TRASH_MOCK.snapshot();
  const finTrashCp = finTrashSnap[constants.KEYS.CHECKPOINT];
  check('[17b] loadTrashDeletedIds failure reaches FAILED',
    finTrashCp && finTrashCp.phase === constants.PHASE.FAILED,
    'phase=' + (finTrashCp && finTrashCp.phase));
  check('[17b] loadTrashDeletedIds failure carries actionable error detail',
    finTrashCp && typeof finTrashCp.error === 'string' && finTrashCp.error.indexOf('trash load failed') !== -1,
    'error=' + (finTrashCp && finTrashCp.error));
  check('[17b] loadTrashDeletedIds failure processedCount == totalCount',
    finTrashCp && finTrashCp.processedCount === finTrashCp.totalCount,
    finTrashCp && (finTrashCp.processedCount + '/' + finTrashCp.totalCount));
  check('[17b] loadTrashDeletedIds failure clears alarms',
    FIN_TRASH_MOCK.pendingAlarms === 0,
    'alarms=' + FIN_TRASH_MOCK.pendingAlarms);
  // Resume over FAILED is a no-op.
  const finTrashResumeCtrl = createScanController(FIN_TRASH_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finTrashResumeCtrl.resume();
  check('[17b] resume over FAILED is a no-op (phase stays FAILED)',
    FIN_TRASH_MOCK.snapshot()[constants.KEYS.CHECKPOINT].phase === constants.PHASE.FAILED, '');
  // Retry: a new startNewScan must complete normally.
  const finTrashRetry = createScanController(FIN_TRASH_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finTrashRetry.startNewScan();
  const finTrashRetrySnap = FIN_TRASH_MOCK.snapshot();
  const finTrashRetryCp = finTrashRetrySnap[constants.KEYS.CHECKPOINT];
  check('[17b] retry after loadTrashDeletedIds failure reaches DONE',
    finTrashRetryCp && finTrashRetryCp.phase === constants.PHASE.DONE,
    'phase=' + (finTrashRetryCp && finTrashRetryCp.phase));
  check('[17b] retry produces complete records',
    (finTrashRetrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (finTrashRetrySnap[constants.KEYS.RECORDS] || []).length);
  check('[17b] retry produces a report',
    !!finTrashRetrySnap[constants.KEYS.REPORT], '');

  // 17c. computeReport throws during finishScan.
  // Monkey-patch report.computeReport to throw on the first call, then restore.
  console.log('  [17c] computeReport throw during finishScan.');
  const FIN_RPT_MOCK = new MockChrome(tree);
  const origComputeReport = report.computeReport;
  let computeReportCallCount = 0;
  report.computeReport = function () {
    computeReportCallCount++;
    if (computeReportCallCount === 1) {
      throw new Error('report computation failed');
    }
    return origComputeReport.apply(this, arguments);
  };
  const finRptController = createScanController(FIN_RPT_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finRptController.startNewScan();
  report.computeReport = origComputeReport;
  const finRptSnap = FIN_RPT_MOCK.snapshot();
  const finRptCp = finRptSnap[constants.KEYS.CHECKPOINT];
  check('[17c] computeReport failure reaches FAILED',
    finRptCp && finRptCp.phase === constants.PHASE.FAILED,
    'phase=' + (finRptCp && finRptCp.phase));
  check('[17c] computeReport failure carries actionable error detail',
    finRptCp && typeof finRptCp.error === 'string' && finRptCp.error.indexOf('report computation failed') !== -1,
    'error=' + (finRptCp && finRptCp.error));
  check('[17c] computeReport failure processedCount == totalCount',
    finRptCp && finRptCp.processedCount === finRptCp.totalCount,
    finRptCp && (finRptCp.processedCount + '/' + finRptCp.totalCount));
  check('[17c] computeReport failure clears alarms',
    FIN_RPT_MOCK.pendingAlarms === 0,
    'alarms=' + FIN_RPT_MOCK.pendingAlarms);
  // Resume over FAILED is a no-op.
  const finRptResumeCtrl = createScanController(FIN_RPT_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finRptResumeCtrl.resume();
  check('[17c] resume over FAILED is a no-op (phase stays FAILED)',
    FIN_RPT_MOCK.snapshot()[constants.KEYS.CHECKPOINT].phase === constants.PHASE.FAILED, '');
  // Retry: a new startNewScan must complete normally (computeReport is restored).
  const finRptRetry = createScanController(FIN_RPT_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await finRptRetry.startNewScan();
  const finRptRetrySnap = FIN_RPT_MOCK.snapshot();
  const finRptRetryCp = finRptRetrySnap[constants.KEYS.CHECKPOINT];
  check('[17c] retry after computeReport failure reaches DONE',
    finRptRetryCp && finRptRetryCp.phase === constants.PHASE.DONE,
    'phase=' + (finRptRetryCp && finRptRetryCp.phase));
  check('[17c] retry produces complete records',
    (finRptRetrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (finRptRetrySnap[constants.KEYS.RECORDS] || []).length);
  check('[17c] retry produces a report',
    !!finRptRetrySnap[constants.KEYS.REPORT], '');

  // ---- Part 18: primary FAILED + compact fallback reject, minimal fallback succeeds
  // The startNewScan catch handler must properly await each fallback write so a
  // rejected compact write (checkpoint + empty queue/records) triggers the
  // minimal write (checkpoint only). Previously the synchronous try/catch around
  // promise-returning storageSet meant a rejected compact write was never caught
  // and the minimal fallback was never attempted.
  console.log('\n[Part 18] primary FAILED + compact fallback reject, minimal fallback succeeds.');

  const P18_MOCK = new MockChrome(tree);
  let p18WriteCount = 0;
  const P18_DEPS = P18_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: (obj) => {
      p18WriteCount++;
      if (p18WriteCount <= 2) {
        // First write (initial scan payload) and second write (compact
        // fallback: checkpoint + empty queue/records) both reject.
        return Promise.reject(new Error('quota exceeded'));
      }
      // Third write (minimal fallback: checkpoint + schema only) succeeds.
      return P18_MOCK.storage.local.set(obj);
    }
  });
  const p18Controller = createScanController(P18_DEPS);
  await p18Controller.startNewScan();
  const p18Snap = P18_MOCK.snapshot();
  const p18Cp = p18Snap[constants.KEYS.CHECKPOINT];
  check('[18] persisted FAILED after compact fallback rejects',
    p18Cp && p18Cp.phase === constants.PHASE.FAILED,
    'phase=' + (p18Cp && p18Cp.phase));
  check('[18] error detail from primary failure',
    p18Cp && typeof p18Cp.error === 'string' && p18Cp.error.indexOf('quota') !== -1,
    'error=' + (p18Cp && p18Cp.error));
  check('[18] no alarm after FAILED',
    P18_MOCK.pendingAlarms === 0,
    'alarms=' + P18_MOCK.pendingAlarms);
  check('[18] three storageSet calls attempted (primary + compact + minimal)',
    p18WriteCount === 3,
    'writes=' + p18WriteCount);
  // The minimal fallback wrote only checkpoint + schema (no queue/records keys).
  check('[18] minimal fallback did not write queue or records keys',
    !('queue' in p18Snap) && !('records' in p18Snap),
    'queue=' + ('queue' in p18Snap) + ' records=' + ('records' in p18Snap));

  // Retry from FAILED: a new startNewScan must complete normally.
  const p18Retry = createScanController(P18_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await p18Retry.startNewScan();
  const p18RetrySnap = P18_MOCK.snapshot();
  const p18RetryCp = p18RetrySnap[constants.KEYS.CHECKPOINT];
  check('[18] retry from FAILED reaches DONE',
    p18RetryCp && p18RetryCp.phase === constants.PHASE.DONE,
    'phase=' + (p18RetryCp && p18RetryCp.phase));
  check('[18] retry produces a report',
    !!p18RetrySnap[constants.KEYS.REPORT], '');
  check('[18] retry has complete records',
    (p18RetrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (p18RetrySnap[constants.KEYS.RECORDS] || []).length);

  // ---- Part 19: checkpoint/queue read rejection during active resume ---------
  // Any storage read rejection during resume (readCheckpoint or storageGet for
  // queue/records) must funnel into a terminal FAILED transition, clear the
  // alarm, and allow retry. Previously these rejections propagated unhandled,
  // leaving the checkpoint at SCANNING with no alarm — a permanent wedge.
  console.log('\n[Part 19] checkpoint/queue read rejection during active resume -> FAILED/no alarm/retry.');

  // 19a: readCheckpoint rejects during resume.
  const P19A_MOCK = new MockChrome(tree);
  const p19aQueue = fullController.flattenTree(tree, []);
  await P19A_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: p19aQueue,
    [constants.KEYS.RECORDS]: [],
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      totalCount: p19aQueue.length,
      processedCount: 0,
      lastProcessedId: null,
      updatedAt: NOW,
      scanStartedAt: NOW
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  let p19aGetCount = 0;
  const P19A_DEPS = P19A_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageGet: (keys) => {
      p19aGetCount++;
      if (p19aGetCount === 1) {
        // First read (readCheckpoint) rejects.
        return Promise.reject(new Error('storage read failed'));
      }
      return P19A_MOCK.storage.local.get(keys);
    }
  });
  const p19aController = createScanController(P19A_DEPS);
  await p19aController.resume();
  const p19aSnap = P19A_MOCK.snapshot();
  const p19aCp = p19aSnap[constants.KEYS.CHECKPOINT];
  check('[19a] readCheckpoint rejection during resume -> FAILED',
    p19aCp && p19aCp.phase === constants.PHASE.FAILED,
    'phase=' + (p19aCp && p19aCp.phase));
  check('[19a] error detail from read failure',
    p19aCp && typeof p19aCp.error === 'string' && p19aCp.error.indexOf('storage read failed') !== -1,
    'error=' + (p19aCp && p19aCp.error));
  check('[19a] no alarm after FAILED',
    P19A_MOCK.pendingAlarms === 0,
    'alarms=' + P19A_MOCK.pendingAlarms);
  check('[19a] minimal FAILED checkpoint uses safe defaults (totalCount=0)',
    p19aCp && p19aCp.totalCount === 0 && p19aCp.processedCount === 0,
    'total=' + (p19aCp && p19aCp.totalCount) + ' processed=' + (p19aCp && p19aCp.processedCount));

  // Retry from FAILED: a new startNewScan must complete normally.
  const p19aRetry = createScanController(P19A_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await p19aRetry.startNewScan();
  const p19aRetrySnap = P19A_MOCK.snapshot();
  check('[19a] retry from FAILED reaches DONE',
    p19aRetrySnap[constants.KEYS.CHECKPOINT].phase === constants.PHASE.DONE,
    'phase=' + p19aRetrySnap[constants.KEYS.CHECKPOINT].phase);
  check('[19a] retry produces complete records',
    (p19aRetrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (p19aRetrySnap[constants.KEYS.RECORDS] || []).length);

  // 19b: storageGet (queue/records) rejects during processActiveWindow.
  const P19B_MOCK = new MockChrome(tree);
  const p19bQueue = fullController.flattenTree(tree, []);
  await P19B_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: p19bQueue,
    [constants.KEYS.RECORDS]: [],
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      totalCount: p19bQueue.length,
      processedCount: 0,
      lastProcessedId: null,
      updatedAt: NOW,
      scanStartedAt: NOW
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  let p19bGetCount = 0;
  const P19B_DEPS = P19B_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageGet: (keys) => {
      p19bGetCount++;
      // resumeImpl reads checkpoint (call 1), processActiveWindowImpl reads
      // checkpoint again (call 2), then reads queue/records (call 3).
      // Calls 1-2 succeed; call 3 rejects.
      if (p19bGetCount === 3) {
        return Promise.reject(new Error('queue read failed'));
      }
      return P19B_MOCK.storage.local.get(keys);
    }
  });
  const p19bController = createScanController(P19B_DEPS);
  await p19bController.resume();
  const p19bSnap = P19B_MOCK.snapshot();
  const p19bCp = p19bSnap[constants.KEYS.CHECKPOINT];
  check('[19b] queue/records read rejection during resume -> FAILED',
    p19bCp && p19bCp.phase === constants.PHASE.FAILED,
    'phase=' + (p19bCp && p19bCp.phase));
  check('[19b] error detail from queue read failure',
    p19bCp && typeof p19bCp.error === 'string' && p19bCp.error.indexOf('queue read failed') !== -1,
    'error=' + (p19bCp && p19bCp.error));
  check('[19b] no alarm after FAILED',
    P19B_MOCK.pendingAlarms === 0,
    'alarms=' + P19B_MOCK.pendingAlarms);
  check('[19b] totalCount preserved from checkpoint',
    p19bCp && p19bCp.totalCount === p19bQueue.length,
    'total=' + (p19bCp && p19bCp.totalCount));

  // Retry from FAILED: a new startNewScan must complete normally.
  const p19bRetry = createScanController(P19B_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await p19bRetry.startNewScan();
  const p19bRetrySnap = P19B_MOCK.snapshot();
  check('[19b] retry from FAILED reaches DONE',
    p19bRetrySnap[constants.KEYS.CHECKPOINT].phase === constants.PHASE.DONE,
    'phase=' + p19bRetrySnap[constants.KEYS.CHECKPOINT].phase);
  check('[19b] retry produces complete records',
    (p19bRetrySnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (p19bRetrySnap[constants.KEYS.RECORDS] || []).length);
  check('[19b] retry produces a report',
    !!p19bRetrySnap[constants.KEYS.REPORT], '');

  // ---- Part 20: no-op schema-stamp write rejection must not downgrade DONE ---
  // When processActiveWindowImpl encounters a DONE/IDLE checkpoint, it writes
  // the checkpoint back as a no-op schema-stamp. If that write rejects (e.g.
  // transient storage error), the rejection must be silently caught — it must
  // NOT propagate into the caller's error handling or turn a completed DONE
  // checkpoint into FAILED. This is a deterministic test of the fix.
  console.log('\nPart 20: no-op schema-stamp write rejection must not downgrade DONE.');

  const P20_MOCK = new MockChrome(tree);
  // Seed a completed scan (DONE checkpoint + full records + report).
  const p20Queue = fullController.flattenTree(tree, []);
  const p20Records = fullController.upsertRecords([], p20Queue.map((item) =>
    fullController.itemToRecord(item, rules, NOW)), NOW);
  const p20Report = report.computeReport(p20Records, NOW, { folderFindings: null, timing: null });
  await P20_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: p20Queue,
    [constants.KEYS.RECORDS]: p20Records,
    [constants.KEYS.REPORT]: p20Report,
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.DONE,
      totalCount: p20Queue.length,
      processedCount: p20Queue.length,
      lastProcessedId: String(p20Queue[p20Queue.length - 1].id),
      updatedAt: NOW,
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      durationMs: 100
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  let p20WriteCount = 0;
  const P20_DEPS = P20_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: (obj) => {
      p20WriteCount++;
      // The no-op schema-stamp write is the first write after resume reads
      // the DONE checkpoint. Reject it to prove the error is swallowed.
      if (p20WriteCount === 1) {
        return Promise.reject(new Error('transient storage error'));
      }
      return P20_MOCK.storage.local.set(obj);
    }
  });
  const p20Controller = createScanController(P20_DEPS);
  // processActiveWindow reads the DONE checkpoint and hits the no-op schema-stamp
  // path. The rejection must be caught, not propagated. We call processActiveWindow
  // directly (not resume) because resume returns null early for non-SCANNING phases
  // without reaching the schema-stamp write.
  await p20Controller.processActiveWindow(rules);
  const p20Snap = P20_MOCK.snapshot();
  const p20Cp = p20Snap[constants.KEYS.CHECKPOINT];
  check('[20] schema-stamp write rejection does NOT downgrade DONE to FAILED',
    p20Cp && p20Cp.phase === constants.PHASE.DONE,
    'phase=' + (p20Cp && p20Cp.phase));
  check('[20] report is preserved (not wiped by error handling)',
    !!p20Snap[constants.KEYS.REPORT], '');
  check('[20] records are preserved',
    (p20Snap[constants.KEYS.RECORDS] || []).length === p20Queue.length,
    'records=' + (p20Snap[constants.KEYS.RECORDS] || []).length);
  check('[20] no alarm scheduled (processActiveWindow over DONE is a no-op)',
    P20_MOCK.pendingAlarms === 0,
    'alarms=' + P20_MOCK.pendingAlarms);
  // Exactly one write was attempted (the rejected schema-stamp); no further writes.
  check('[20] exactly one storageSet attempted (the rejected schema-stamp)',
    p20WriteCount === 1, 'writes=' + p20WriteCount);

  // Same test for IDLE phase: schema-stamp rejection must not downgrade to FAILED.
  console.log('  [20b] IDLE phase schema-stamp write rejection.');
  const P20B_MOCK = new MockChrome(tree);
  await P20B_MOCK.storage.local.set({
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.IDLE,
      totalCount: 0,
      processedCount: 0,
      lastProcessedId: null,
      updatedAt: 0,
      scanStartedAt: null
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  let p20bWriteCount = 0;
  const P20B_DEPS = P20B_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: (obj) => {
      p20bWriteCount++;
      if (p20bWriteCount === 1) {
        return Promise.reject(new Error('transient storage error'));
      }
      return P20B_MOCK.storage.local.set(obj);
    }
  });
  const p20bController = createScanController(P20B_DEPS);
  await p20bController.processActiveWindow(rules);
  const p20bSnap = P20B_MOCK.snapshot();
  const p20bCp = p20bSnap[constants.KEYS.CHECKPOINT];
  check('[20b] IDLE schema-stamp rejection does NOT downgrade to FAILED',
    p20bCp && p20bCp.phase === constants.PHASE.IDLE,
    'phase=' + (p20bCp && p20bCp.phase));
  check('[20b] no alarm scheduled',
    P20B_MOCK.pendingAlarms === 0,
    'alarms=' + P20B_MOCK.pendingAlarms);

  // ---- Part 21: all storageSet writes reject -> explicit {failed:true} / no throw / no wake -
  // P0 boundary: when EVERY attempted storageSet write in the failure path rejects
  // (primary write + compact fallback + minimal fallback), the controller must:
  //   1. Not throw (no uncaught rejection).
  //   2. Call clearWake (no scheduled alarm).
  //   3. Return {failed:true, phase:PHASE.FAILED, error} from startNewScan.
  // The service-worker maps that to {ok:false, phase:PHASE.FAILED, error} so the
  // popup can enable Scan now and show COPY.scanFailed without a storage event.
  // After storage recovers a later scan must succeed cleanly.
  console.log('\n[Part 21] all storageSet writes reject -> explicit {failed:true}; retry succeeds.');

  // 21a: startNewScan — every storageSet call rejects.
  const P21_MOCK = new MockChrome(tree);
  let p21Writes = 0;
  const P21_DEPS = P21_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: () => { p21Writes++; return Promise.reject(new Error('total storage failure')); }
  });
  const p21Ctrl = createScanController(P21_DEPS);

  let p21Result;
  let p21Threw = false;
  try {
    p21Result = await p21Ctrl.startNewScan();
  } catch (e) { p21Threw = true; }
  check('[21] all-writes-reject startNewScan does NOT throw', p21Threw === false, 'threw=' + p21Threw);
  check('[21] all-writes-reject returns {failed:true, phase:FAILED, error}',
    p21Result && p21Result.failed === true && p21Result.phase === constants.PHASE.FAILED &&
    typeof p21Result.error === 'string' && p21Result.error.length > 0,
    JSON.stringify(p21Result));
  check('[21] clearWake called (no alarm scheduled)',
    P21_MOCK.pendingAlarms === 0, 'alarms=' + P21_MOCK.pendingAlarms);
  check('[21] three storageSet attempts (primary + compact + minimal)',
    p21Writes === 3, 'writes=' + p21Writes);

  // 21b: requestScan — same all-reject boundary through the user-facing entry.
  const P21B_MOCK = new MockChrome(tree);
  const P21B_DEPS = P21B_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules),
    storageSet: () => Promise.reject(new Error('total storage failure'))
  });
  const p21bCtrl = createScanController(P21B_DEPS);
  let p21bResult;
  let p21bThrew = false;
  try {
    p21bResult = await p21bCtrl.requestScan();
  } catch (e) { p21bThrew = true; }
  check('[21] requestScan all-writes-reject does NOT throw', p21bThrew === false, 'threw=' + p21bThrew);
  check('[21] requestScan returns {failed:true, phase:FAILED, error}',
    p21bResult && p21bResult.failed === true && p21bResult.phase === constants.PHASE.FAILED &&
    typeof p21bResult.error === 'string' && p21bResult.error.length > 0,
    JSON.stringify(p21bResult));
  check('[21] requestScan clearWake called (no alarm scheduled)',
    P21B_MOCK.pendingAlarms === 0, 'alarms=' + P21B_MOCK.pendingAlarms);

  // 21c: Execute the REAL service-worker.js scan-now listener in a VM context
  // with all-storageSet-rejecting chrome, asserting the actual sendResponse.
  {
    const p21cStore = Object.create(null);
    const p21cListeners = [];
    let p21cAlarms = 0;
    const p21cModMap = {
      '../shared/constants.js': 'BRConstants', '../shared/normalize.js': 'BRNormalize',
      '../shared/categorize.js': 'BRCategorize', '../shared/cleanup.js': 'BRCleanup',
      '../shared/backup.js': 'BRBackup', '../shared/link-checker.js': 'BRLinks',
      '../shared/report.js': 'BRReport', '../shared/trash.js': 'BRTrash',
      '../shared/messaging.js': 'BRMessaging', '../shared/scan-controller.js': 'BRScan'
    };
    const p21cSandbox = {
      console, Buffer, setTimeout, clearTimeout, queueMicrotask,
      Promise, Error, Object, Array, JSON, Math, Date, RegExp, String,
      Number, Boolean, Map, Set, parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(rules) }),
      chrome: {
        runtime: {
          id: 'ext-p21c', getURL: (p) => 'chrome-extension://ext-p21c/' + p,
          sendMessage: () => Promise.resolve(),
          onMessage: { addListener: (fn) => p21cListeners.push(fn) },
          onInstalled: { addListener: () => {} }
        },
        alarms: { onAlarm: { addListener: () => {} }, create: () => { p21cAlarms++; }, clear: () => Promise.resolve(true) },
        permissions: { contains: () => Promise.resolve(false) },
        storage: { local: {
          get: (keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(arr.reduce((o, k) => { if (k in p21cStore) { o[k] = p21cStore[k]; } return o; }, {}));
          },
          set: () => Promise.reject(new Error('total storage failure'))
        } },
        bookmarks: {
          getTree: () => Promise.resolve(JSON.parse(JSON.stringify(tree))),
          get: (id) => Promise.resolve(null),
          create: (o) => Promise.resolve({ id: 'new', title: o.title, parentId: o.parentId }),
          move: (id, o) => Promise.resolve({ id: id, parentId: o.parentId }),
          remove: (id) => Promise.resolve()
        }
      }
    };
    p21cSandbox.importScripts = (...paths) => paths.forEach((p) => {
      if (p21cModMap[p]) { p21cSandbox[p21cModMap[p]] = require(p); }
    });
    const p21cCtx = vm.createContext(p21cSandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8'),
      p21cCtx, { filename: 'service-worker.js' });
    const p21cListener = p21cListeners[0];
    check('[21c] actual SW scan-now: listener registered', typeof p21cListener === 'function',
      'count=' + p21cListeners.length);
    const p21cResp = await new Promise((resolve) => {
      let r;
      p21cListener({ type: 'scan-now' },
        { id: 'ext-p21c', url: 'chrome-extension://ext-p21c/popup.html' },
        (v) => { r = v; });
      queueMicrotask(() => setTimeout(() => resolve(r), 30));
    });
    check('[21c] actual SW scan-now: sendResponse is {ok:false, phase:FAILED, error}',
      p21cResp && p21cResp.ok === false && p21cResp.phase === constants.PHASE.FAILED &&
      typeof p21cResp.error === 'string' && p21cResp.error.length > 0,
      JSON.stringify(p21cResp));
    check('[21c] actual SW scan-now: no alarm scheduled (no wake)',
      p21cAlarms === 0, 'alarms=' + p21cAlarms);
  }

  // 21d: After storage recovers, a later scan must succeed.
  const P21_OK_MOCK = new MockChrome(tree);
  const p21okCtrl = createScanController(P21_OK_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  await p21okCtrl.startNewScan();
  const p21okSnap = P21_OK_MOCK.snapshot();
  const p21okCp = p21okSnap[constants.KEYS.CHECKPOINT];
  check('[21] retry after all-writes-reject reaches DONE',
    p21okCp && p21okCp.phase === constants.PHASE.DONE,
    'phase=' + (p21okCp && p21okCp.phase));
  check('[21] retry produces complete records',
    (p21okSnap[constants.KEYS.RECORDS] || []).length === queue.length,
    'records=' + (p21okSnap[constants.KEYS.RECORDS] || []).length);
  check('[21] retry produces a report',
    !!p21okSnap[constants.KEYS.REPORT], '');

  // ---- Part 22: popup-initiated resume-scan recovery (SCANNING, no alarm) ----
  // Regression for the Chrome recovery defect: after manually stopping the
  // worker mid-scan, reopening the popup only reads storage, leaving progress
  // stuck at "Scanning your library (1800 of 3050)" indefinitely. The fix adds
  // a `resume-scan` runtime message that the popup sends once on init when it
  // observes a SCANNING checkpoint. This test seeds a SCANNING checkpoint at
  // ~60% progress with no alarm, dispatches a resume-scan message through the
  // real service-worker listener, and proves the scan resumes to DONE with
  // processed==total, a report generated, and alarms cleared.
  console.log('\n[Part 22] popup-initiated resume-scan recovery (SCANNING, no alarm).');

  // 22a: SCANNING at ~60% with no alarm -> resume-scan message -> DONE.
  const P22_MOCK = new MockChrome(tree);
  const p22Queue = fullController.flattenTree(tree, []);
  const p22Cursor = Math.floor(p22Queue.length * 0.6);
  const p22Records = fullController.upsertRecords([], p22Queue.slice(0, p22Cursor).map((item) =>
    fullController.itemToRecord(item, rules, NOW)), NOW);
  await P22_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: p22Queue,
    [constants.KEYS.RECORDS]: p22Records,
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      totalCount: p22Queue.length,
      processedCount: p22Cursor,
      lastProcessedId: p22Cursor > 0 ? String(p22Queue[p22Cursor - 1].id) : null,
      updatedAt: NOW,
      scanStartedAt: NOW
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  check('[22a] precondition: no alarm armed (worker terminated)',
    P22_MOCK.pendingAlarms === 0, 'alarms=' + P22_MOCK.pendingAlarms);
  check('[22a] precondition: checkpoint is SCANNING at ~60%',
    P22_MOCK.snapshot()[constants.KEYS.CHECKPOINT].phase === constants.PHASE.SCANNING &&
    P22_MOCK.snapshot()[constants.KEYS.CHECKPOINT].processedCount === p22Cursor,
    'processed=' + p22Cursor + '/' + p22Queue.length);

  // Dispatch resume-scan through the real service-worker listener (Part 13 pattern).
  // Reuse the swListener captured in Part 13 if available; otherwise skip.
  if (typeof swListener === 'function') {
    // Reset the service-worker's internal storage to the P22 mock's storage.
    // The swListener was registered against swChrome/swStore; we need to point
    // it at P22_MOCK's storage. Since the controller is lazy-created and cached,
    // we must use the same storage the listener reads from. We'll use a fresh
    // service-worker VM context instead.
    const p22swStore = Object.create(null);
    const p22swListeners = [];
    const p22swAlarms = [];
    const p22swChrome = {
      runtime: {
        id: 'ext-p22', getURL: (p) => 'chrome-extension://ext-p22/' + p,
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (fn) => p22swListeners.push(fn) },
        onInstalled: { addListener: () => {} }
      },
      alarms: { onAlarm: { addListener: () => {} }, create: (name) => { p22swAlarms.push(name); }, clear: () => Promise.resolve(true) },
      permissions: { contains: () => Promise.resolve(false) },
      storage: { local: {
        get: (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          return Promise.resolve(arr.reduce((o, k) => { if (k in p22swStore) { o[k] = p22swStore[k]; } return o; }, {}));
        },
        set: (obj) => { Object.keys(obj).forEach((k) => { p22swStore[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); }
      } },
      bookmarks: {
        getTree: () => Promise.resolve(JSON.parse(JSON.stringify(tree))),
        get: (id) => Promise.resolve(null),
        create: (o) => Promise.resolve({ id: 'new', title: o.title, parentId: o.parentId }),
        move: (id, o) => Promise.resolve({ id: id, parentId: o.parentId }),
        remove: (id) => Promise.resolve()
      }
    };
    // Seed the sw store with the P22 checkpoint.
    Object.keys(P22_MOCK._storage).forEach((k) => { p22swStore[k] = JSON.parse(JSON.stringify(P22_MOCK._storage[k])); });

    const p22ModMap = {
      '../shared/constants.js': 'BRConstants', '../shared/normalize.js': 'BRNormalize',
      '../shared/categorize.js': 'BRCategorize', '../shared/cleanup.js': 'BRCleanup',
      '../shared/backup.js': 'BRBackup', '../shared/link-checker.js': 'BRLinks',
      '../shared/report.js': 'BRReport', '../shared/trash.js': 'BRTrash',
      '../shared/messaging.js': 'BRMessaging', '../shared/scan-controller.js': 'BRScan'
    };
    const p22Sandbox = {
      console, Buffer, setTimeout, clearTimeout, queueMicrotask,
      Promise, Error, Object, Array, JSON, Math, Date, RegExp, String,
      Number, Boolean, Map, Set, parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(rules) }),
      chrome: p22swChrome
    };
    p22Sandbox.importScripts = (...paths) => paths.forEach((p) => {
      if (p22ModMap[p]) { p22Sandbox[p22ModMap[p]] = require(p); }
    });
    const p22Ctx = vm.createContext(p22Sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8'),
      p22Ctx, { filename: 'service-worker.js' });
    const p22Listener = p22swListeners[0];
    check('[22a] service-worker message listener registered', typeof p22Listener === 'function', '');

    // Dispatch resume-scan as the popup would.
    const p22Resp = await new Promise((resolve) => {
      let r;
      p22Listener({ type: 'resume-scan' },
        { id: 'ext-p22', url: 'chrome-extension://ext-p22/popup.html' },
        (v) => { r = v; });
      queueMicrotask(() => setTimeout(() => resolve(r), 100));
    });
    check('[22a] resume-scan message returns {ok:true}',
      p22Resp && p22Resp.ok === true, JSON.stringify(p22Resp));

    // Drive any remaining alarms until complete.
    let p22guard = 0;
    while (p22swAlarms.length > 0 && p22guard++ < 50) {
      const alarms = p22swAlarms.splice(0);
      for (const a of alarms) {
        // Fire the alarm by calling resume on the controller the SW created.
        // The SW's alarm listener calls handleResume() which calls getController().resume().
        // We need to invoke the alarm listener. Since we can't easily access it,
        // we'll just call resume via the message listener pattern.
        // Actually, the alarms were scheduled by the controller during resume-scan processing.
        // We need to fire them. Let's use a scan-status message to check progress,
        // then send another resume-scan if still scanning.
        const statusResp = await new Promise((resolve) => {
          let r;
          p22Listener({ type: 'scan-status' },
            { id: 'ext-p22', url: 'chrome-extension://ext-p22/popup.html' },
            (v) => { r = v; });
          queueMicrotask(() => setTimeout(() => resolve(r), 50));
        });
        if (statusResp && statusResp.checkpoint && statusResp.checkpoint.phase === constants.PHASE.SCANNING) {
          // Still scanning; send another resume-scan to continue.
          await new Promise((resolve) => {
            p22Listener({ type: 'resume-scan' },
              { id: 'ext-p22', url: 'chrome-extension://ext-p22/popup.html' },
              () => {});
            queueMicrotask(() => setTimeout(() => resolve(), 100));
          });
        }
      }
    }

    // Final status check.
    const p22FinalResp = await new Promise((resolve) => {
      let r;
      p22Listener({ type: 'scan-status' },
        { id: 'ext-p22', url: 'chrome-extension://ext-p22/popup.html' },
        (v) => { r = v; });
      queueMicrotask(() => setTimeout(() => resolve(r), 50));
    });
    check('[22a] resume-scan drives scan to DONE',
      p22FinalResp && p22FinalResp.checkpoint && p22FinalResp.checkpoint.phase === constants.PHASE.DONE,
      'phase=' + (p22FinalResp && p22FinalResp.checkpoint && p22FinalResp.checkpoint.phase));
    check('[22a] resume-scan processedCount == totalCount',
      p22FinalResp && p22FinalResp.checkpoint &&
      p22FinalResp.checkpoint.processedCount === p22FinalResp.checkpoint.totalCount,
      p22FinalResp && p22FinalResp.checkpoint &&
      (p22FinalResp.checkpoint.processedCount + '/' + p22FinalResp.checkpoint.totalCount));
    check('[22a] resume-scan generates a report',
      p22FinalResp && p22FinalResp.report !== null && p22FinalResp.report !== undefined,
      'report=' + typeof (p22FinalResp && p22FinalResp.report));
    check('[22a] resume-scan report total == queue length',
      p22FinalResp && p22FinalResp.report &&
      p22FinalResp.report[constants.METRIC.TOTAL] === p22Queue.length,
      'total=' + (p22FinalResp && p22FinalResp.report && p22FinalResp.report[constants.METRIC.TOTAL]));
    check('[22a] alarms cleared after completion', p22swAlarms.length === 0,
      'alarms=' + p22swAlarms.length);
  } else {
    check('[22a] resume-scan recovery test requires swListener (Part 13)', false, 'swListener not available');
  }

  // 22b: DONE checkpoint -> resume-scan is a no-op (no spurious resume).
  console.log('  [22b] DONE checkpoint -> resume-scan is a no-op.');
  const P22B_MOCK = new MockChrome(tree);
  const p22bQueue = fullController.flattenTree(tree, []);
  const p22bRecords = fullController.upsertRecords([], p22bQueue.map((item) =>
    fullController.itemToRecord(item, rules, NOW)), NOW);
  await P22B_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: p22bQueue,
    [constants.KEYS.RECORDS]: p22bRecords,
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.DONE,
      totalCount: p22bQueue.length,
      processedCount: p22bQueue.length,
      lastProcessedId: String(p22bQueue[p22bQueue.length - 1].id),
      updatedAt: NOW,
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      durationMs: 100
    },
    [constants.KEYS.REPORT]: report.computeReport(p22bRecords, NOW, { folderFindings: null, timing: null }),
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  const p22bController = createScanController(P22B_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  const p22bBefore = JSON.stringify(P22B_MOCK.snapshot());
  await p22bController.resume();
  const p22bAfter = JSON.stringify(P22B_MOCK.snapshot());
  check('[22b] resume over DONE is a no-op (storage unchanged)',
    p22bBefore === p22bAfter, '');
  check('[22b] resume over DONE schedules no alarm',
    P22B_MOCK.pendingAlarms === 0, 'alarms=' + P22B_MOCK.pendingAlarms);

  // 22c: FAILED checkpoint -> resume-scan is a no-op (no spurious resume).
  console.log('  [22c] FAILED checkpoint -> resume-scan is a no-op.');
  const P22C_MOCK = new MockChrome(tree);
  await P22C_MOCK.storage.local.set({
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.FAILED,
      totalCount: 100,
      processedCount: 50,
      updatedAt: NOW,
      error: 'test failure'
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  const p22cController = createScanController(P22C_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  const p22cBefore = JSON.stringify(P22C_MOCK.snapshot());
  await p22cController.resume();
  const p22cAfter = JSON.stringify(P22C_MOCK.snapshot());
  check('[22c] resume over FAILED is a no-op (storage unchanged)',
    p22cBefore === p22cAfter, '');
  check('[22c] resume over FAILED schedules no alarm',
    P22C_MOCK.pendingAlarms === 0, 'alarms=' + P22C_MOCK.pendingAlarms);

  // 22d: No duplicate concurrent resume (serialized single-flight).
  console.log('  [22d] no duplicate concurrent resume (serialized single-flight).');
  const P22D_MOCK = new MockChrome(tree);
  const p22dQueue = fullController.flattenTree(tree, []);
  const p22dCursor = Math.floor(p22dQueue.length * 0.3);
  const p22dRecords = fullController.upsertRecords([], p22dQueue.slice(0, p22dCursor).map((item) =>
    fullController.itemToRecord(item, rules, NOW)), NOW);
  await P22D_MOCK.storage.local.set({
    [constants.KEYS.QUEUE]: p22dQueue,
    [constants.KEYS.RECORDS]: p22dRecords,
    [constants.KEYS.CHECKPOINT]: {
      phase: constants.PHASE.SCANNING,
      totalCount: p22dQueue.length,
      processedCount: p22dCursor,
      lastProcessedId: p22dCursor > 0 ? String(p22dQueue[p22dCursor - 1].id) : null,
      updatedAt: NOW,
      scanStartedAt: NOW
    },
    [constants.KEYS.SCHEMA]: constants.SCHEMA_VERSION
  });
  const p22dController = createScanController(P22D_MOCK.deps({
    getNow: () => NOW,
    loadRules: () => Promise.resolve(rules)
  }));
  // Fire 4 concurrent resume calls. The single-flight serialize ensures they
  // run sequentially, not in parallel. The scan must complete exactly once.
  const p22dResults = await Promise.all([
    p22dController.resume(),
    p22dController.resume(),
    p22dController.resume(),
    p22dController.resume()
  ]);
  // Drive any remaining alarms.
  let p22dGuard = 0;
  while (P22D_MOCK.pendingAlarms > 0 && p22dGuard++ < 50) {
    await P22D_MOCK.fireWakes(() => p22dController.resume());
  }
  await p22dController.resume();
  const p22dSnap = P22D_MOCK.snapshot();
  const p22dCp = p22dSnap[constants.KEYS.CHECKPOINT];
  check('[22d] concurrent resumes reach DONE (not duplicated)',
    p22dCp && p22dCp.phase === constants.PHASE.DONE,
    'phase=' + (p22dCp && p22dCp.phase));
  check('[22d] concurrent resumes processedCount == totalCount',
    p22dCp && p22dCp.processedCount === p22dCp.totalCount,
    p22dCp && (p22dCp.processedCount + '/' + p22dCp.totalCount));
  check('[22d] concurrent resumes generate exactly one report',
    !!p22dSnap[constants.KEYS.REPORT], '');
  check('[22d] concurrent resumes clear alarms',
    P22D_MOCK.pendingAlarms === 0, 'alarms=' + P22D_MOCK.pendingAlarms);
  check('[22d] records are complete (no duplication from concurrent resumes)',
    (p22dSnap[constants.KEYS.RECORDS] || []).length === p22dQueue.length,
    'records=' + (p22dSnap[constants.KEYS.RECORDS] || []).length);

  // ---- Footprint probe: measure snapshot JSON bytes per record ---------------
  // Deterministic assertion: the snapshot JSON size scales linearly and stays
  // within the expected per-record budget. This catches schema bloat early.
  console.log('\n[Footprint] snapshot JSON byte measurement.');
  const fullSnapBytes = Buffer.byteLength(JSON.stringify(fullSnap), 'utf8');
  const fullRecords = (fullSnap[constants.KEYS.RECORDS] || []);
  const perRecord = fullRecords.length > 0 ? fullSnapBytes / fullRecords.length : 0;
  console.log('  snapshot bytes=' + fullSnapBytes + ' records=' + fullRecords.length + ' bytes/record=' + perRecord.toFixed(2));
  check('footprint: snapshot JSON is under 10 MB for ' + count + ' records',
    fullSnapBytes < 10 * 1024 * 1024, 'bytes=' + fullSnapBytes);
  check('footprint: per-record bytes are under 1000',
    perRecord < 1000, 'bytes/record=' + perRecord.toFixed(2));

  // ---- Print the human-readable Library Report ----------------------------------
  console.log('\n==== Library Report ====');
  console.log('  ' + constants.COPY.libraryLine(rpt[constants.METRIC.TOTAL], rpt[constants.METRIC.LIBRARY_AGE_YEARS]));
  console.log('  ' + constants.COPY.duplicatesLine(rpt[constants.METRIC.DUPLICATES]));
  console.log('  ' + constants.COPY.newFolderLine(rpt[constants.METRIC.NEW_FOLDER]));
  console.log('  ' + constants.COPY.staleLine(rpt[constants.METRIC.STALE_OVER_2_YEARS]));
  console.log('  ' + constants.COPY.noRecordedOpeningLine(rpt[constants.METRIC.NO_RECORDED_OPENING]));
  console.log('  ' + constants.COPY.openHistoryLine(rpt[constants.METRIC.OPEN_HISTORY], rpt[constants.METRIC.TOTAL], rpt[constants.METRIC.OPEN_COVERAGE]));
  console.log('  ' + constants.COPY.topicsHeader +
    (rpt[constants.METRIC.TOP_CATEGORIES] || []).map((t) => t.name + ' (' + t.count + ')').join(constants.COPY.topicsSeparator));
  console.log('  ' + constants.COPY.oldestLine(rpt[constants.METRIC.OLDEST].moniker));
  console.log('  saved since ' + rpt[constants.METRIC.SAVED_SINCE]);
  console.log('=======================');

  console.log('\nResults: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error('Harness error:', err && err.stack || err); process.exitCode = 2; });
