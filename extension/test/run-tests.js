#!/usr/bin/env node
/**
 * Runs the full deterministic verification suite:
 *   1. unit tests for pure modules (normalize, categorize, report);
 *   2. branding split tests (manifest + locales + PRODUCT_NAME copy);
 *   3. integration harness (chunked scan + checkpoint/resume/idempotency +
 *      report) against a synthetic tree with mock chrome.
 *
 * Usage: node test/run-tests.js [count] [seed]
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const count = process.argv[2] || '3000';
const seed = process.argv[3] || '42';

const root = path.join(__dirname, '..');
const node = process.execPath;

function run(label, args) {
  console.log('\n=== ' + label + ' ===');
  const res = spawnSync(node, args, { cwd: root, encoding: 'utf8' });
  process.stdout.write(res.stdout || '');
  if (res.stderr) { process.stderr.write(res.stderr); }
  if (res.status !== 0) {
    console.error(label + ' FAILED (exit ' + res.status + ')');
    process.exitCode = 1;
  } else {
    console.log(label + ' OK');
  }
}

// Tally leaf bookmarks with/without a recorded opening in a generated tree.
function openHistoryCounts(tree) {
  let withOpening = 0;
  let withoutOpening = 0;
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.children) { walk(n.children); }
      else if (n.url) {
        const o = typeof n.dateLastUsed === 'number' && n.dateLastUsed > 0;
        if (o) { withOpening += 1; } else { withoutOpening += 1; }
      }
    }
  })(tree);
  return { withOpening, withoutOpening };
}

// CLI smoke check: the --realistic flag is accepted in any documented position,
// the default CLI behavior is unchanged, and both modes are deterministic.
function generatorCli() {
  let failures = 0;
  function check(name, cond, detail) {
    if (cond) { console.log('  ok   ' + name); }
    else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
  }

  function runGen(args) {
    const res = spawnSync(node, ['tools/generator.js'].concat(args), { cwd: root, encoding: 'utf8' });
    if (res.status !== 0) { throw new Error('generator.js exited ' + res.status + ': ' + (res.stderr || res.stdout)); }
    return JSON.parse(res.stdout);
  }

  const CLI_COUNT = '300';
  const CLI_SEED = '42';
  console.log('\n=== generator CLI (' + CLI_COUNT + ' items, seed ' + CLI_SEED + ') ===');

  // Flag trailing the positionals: the documented example form. The CLI pins
  // nothing and uses Date.now() as "today", so absolute timestamps shift across
  // invocations; what is stable across runs is the open-history distribution
  // (whether a leaf carries a recorded opening), which we assert explicitly.
  const trailing = runGen([CLI_COUNT, CLI_SEED, '--realistic']);
  const trailingHist = openHistoryCounts(trailing.tree);
  console.log('  (--realistic trailing: with=' + trailingHist.withOpening + ' without=' + trailingHist.withoutOpening + ')');
  check('--realistic (trailing) yields a majority with no recorded opening',
    trailingHist.withoutOpening > trailingHist.withOpening,
    trailingHist.withOpening + '/' + trailingHist.withoutOpening);

  // Flag leading the positionals: any position is accepted. Because the tree
  // is drawn from the same seeded RNG stream with only the "now" clock shifting,
  // the realistic mode produces the identical stable distribution either way.
  const leading = runGen(['--realistic', CLI_COUNT, CLI_SEED]);
  const leadingHist = openHistoryCounts(leading.tree);
  check('--realistic (leading) yields the identical distribution (deterministic)',
    leadingHist.withOpening === trailingHist.withOpening &&
    leadingHist.withoutOpening === trailingHist.withoutOpening,
    'with=' + leadingHist.withOpening + ' without=' + leadingHist.withoutOpening);
  check('--realistic (leading) still yields a majority with no recorded opening',
    leadingHist.withoutOpening > leadingHist.withOpening,
    leadingHist.withOpening + '/' + leadingHist.withoutOpening);

  // Default (no flag) must keep the documented generous ~70%-positive mode.
  const def = runGen([CLI_COUNT, CLI_SEED]);
  const defHist = openHistoryCounts(def.tree);
  console.log('  (default no-flag: with=' + defHist.withOpening + ' without=' + defHist.withoutOpening + ')');
  check('default (no flag) keeps a majority with a recorded opening',
    defHist.withOpening > defHist.withoutOpening,
    defHist.withOpening + '/' + defHist.withoutOpening);
  check('default (no flag) differs from realistic mode in distribution',
    defHist.withOpening !== trailingHist.withOpening ||
    defHist.withoutOpening !== trailingHist.withoutOpening, '');
  check('flag-free tree is distribution-stable across runs',
    (() => { const h = openHistoryCounts(runGen([CLI_COUNT, CLI_SEED]).tree);
      return h.withOpening === defHist.withOpening && h.withoutOpening === defHist.withoutOpening; })(),
    'with=' + defHist.withOpening + ' without=' + defHist.withoutOpening);

  // Round-trip through an outFile to prove the write path still carries the flag.
  const tmpOut = path.join(root, '.generator-cli-out.json');
  const writeRes = spawnSync(node, ['tools/generator.js', CLI_COUNT, CLI_SEED, tmpOut, '--realistic'],
    { cwd: root, encoding: 'utf8' });
  const wroteClean = writeRes.status === 0 && /realistic open-history mode/.test(writeRes.stdout || '');
  if (fs.existsSync(tmpOut)) {
    const parsed = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
    const hist = openHistoryCounts(parsed.tree);
    fs.unlinkSync(tmpOut);
    check('--realistic writes a realistic tree via outFile', hist.withoutOpening > hist.withOpening,
      hist.withOpening + '/' + hist.withoutOpening);
    check('--realistic announces mode on the outFile write', wroteClean, 'stdout=' + (writeRes.stdout || '').trim());
  } else {
    check('--realistic writes a realistic tree via outFile', false, 'outFile not created');
  }

  console.log((failures === 0 ? 'generator CLI OK' : 'generator CLI FAILED (' + failures + ')'));
  return failures;
}

const cliFailures = generatorCli();

// Netscape bookmark-HTML output: prove the serializer round-trips and that
// realistic mode emits a sparse LAST_VISIT set (it does NOT, by itself, prove
  // the browser will import or honor LAST_VISIT).
function generatorHtml() {
  const path = require('path');
  const generator = require('../tools/generator.js');
  let failures = 0;
  function check(name, cond, detail) {
    if (cond) { console.log('  ok   ' + name); }
    else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
  }

  // Compare every structural/origin statistic between the SOURCE tree and the
  // HTML round-tripped through the serializer + parser.
  function sourceLastVisitCount(tree) {
    let n = 0;
    (function walk(nodes) {
      for (const node of nodes) {
        if (node.children) { walk(node.children); }
        else if (node.url && typeof node.dateLastUsed === 'number' && node.dateLastUsed > 0) { n += 1; }
      }
    })(tree);
    return n;
  }

  function assertRoundTrip(label, realistic) {
    const out = generator.generate({ seed: 42, count: 1000, nowMs: Date.now(), realistic });
    const html = generator.serializeHtml(out.tree);
    const parsed = generator.parseNetscapeHtml(html);
    const sourceStats = generator.bookmarkStats(generator.toUniformItem(out.tree));
    const parsedStats = generator.bookmarkStats(parsed);
    const expectedLastVisit = sourceLastVisitCount(out.tree);
    check(label + ' leaf count preserved', parsedStats.leafCount === sourceStats.leafCount,
      'source=' + sourceStats.leafCount + ' parsed=' + parsedStats.leafCount);
    check(label + ' duplicate count preserved', parsedStats.duplicateCount === sourceStats.duplicateCount,
      'source=' + sourceStats.duplicateCount + ' parsed=' + parsedStats.duplicateCount);
    check(label + ' New Folder leaf count preserved', parsedStats.newFolderLeafCount === sourceStats.newFolderLeafCount,
      'source=' + sourceStats.newFolderLeafCount + ' parsed=' + parsedStats.newFolderLeafCount);
    check(label + ' folder nesting/depth preserved', parsedStats.maxFolderDepth === sourceStats.maxFolderDepth,
      'source=' + sourceStats.maxFolderDepth + ' parsed=' + parsedStats.maxFolderDepth);
    check(label + ' ADD_DATE attribute count preserved',
      parsedStats.addDateCount === sourceStats.addDateCount && parsedStats.addDateCount > 0,
      'source=' + sourceStats.addDateCount + ' parsed=' + parsedStats.addDateCount);
    check(label + ' LAST_VISIT attribute count preserved',
      parsedStats.lastVisitCount === sourceStats.lastVisitCount &&
      parsedStats.lastVisitCount === expectedLastVisit,
      'expected=' + expectedLastVisit + ' source=' + sourceStats.lastVisitCount + ' parsed=' + parsedStats.lastVisitCount);
    return parsedStats.lastVisitCount;
  }

  const defaultLastVisit = assertRoundTrip('html round-trip (default mode)', false);
  const realisticLastVisit = assertRoundTrip('html round-trip (realistic mode)', true);

  check('realistic mode emits FEWER LAST_VISIT attributes than default (sparse dateLastUsed)',
    realisticLastVisit < defaultLastVisit,
    'default=' + defaultLastVisit + ' realistic=' + realisticLastVisit);
  check('realistic mode emits a strict minority of LAST_VISIT (majority absent)',
    realisticLastVisit < 1000 * 0.5, 'lastVisit=' + realisticLastVisit);

  console.log((realisticLastVisit) + ' LAST_VISIT attributes in realistic mode; ' +
    'sparse dateLastUsed yields fewer LAST_VISIT. This proves attributes are ' +
    'EMITTED and the parser round-trips; it does not prove Chrome will import ' +
    'or honor LAST_VISIT (that must be observed after a real import).');

  // CLI: the documented --html example writes a Netscape HTML fixture file.
  const tmpOut = path.join(root, '.generator-cli-out.html');
  const writeRes = spawnSync(node, ['tools/generator.js', '80', '42', tmpOut, '--realistic', '--html'],
    { cwd: root, encoding: 'utf8' });
  const wrote = writeRes.status === 0 && /Netscape HTML/.test(writeRes.stdout || '');
  if (fs.existsSync(tmpOut)) {
    const text = fs.readFileSync(tmpOut, 'utf8');
    let cliOracleOk = false;
    try {
      const parsed = generator.parseNetscapeHtml(text);
      // Verify the file re-parses to the exact CLI tree.
      const src = generator.generate({ seed: 42, count: 80, nowMs: Date.now(), realistic: true });
      const sourceStats = generator.bookmarkStats(generator.toUniformItem(src.tree));
      const parsedStats = generator.bookmarkStats(parsed);
      cliOracleOk = parsedStats.leafCount === sourceStats.leafCount &&
        parsedStats.duplicateCount === sourceStats.duplicateCount &&
        parsedStats.newFolderLeafCount === sourceStats.newFolderLeafCount &&
        parsedStats.lastVisitCount === sourceStats.lastVisitCount;
    } catch (e) { /* fallthrough to FAIL */ }
    check('--html writes a reusable Netscape HTML fixture file', wrote,
      'stdout=' + (writeRes.stdout || '').trim());
    check('generated fixture file re-parses to the same source tree', cliOracleOk, '');
    fs.unlinkSync(tmpOut);
  } else {
    check('--html writes a reusable Netscape HTML fixture file', false, 'outFile not created');
  }

  console.log((failures === 0 ? 'generator HTML OK' : 'generator HTML FAILED (' + failures + ')'));
  return failures;
}

// Helper exposed on the generator result for the LAST_VISIT oracle assertion.
const htmlFailures = generatorHtml();
if (htmlFailures > 0) { process.exitCode = 1; }
run('unit-tests', ['test/unit-tests.js']);
run('branding-tests', ['test/branding-tests.js']);
run('firefox-tests', ['test/firefox-tests.js']);
run('popup-tests', ['test/popup-tests.js']);
run('harness (' + count + ' items, seed ' + seed + ')', ['test/harness.js', count, seed]);
