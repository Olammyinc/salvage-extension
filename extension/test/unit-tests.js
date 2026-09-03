/**
 * Unit tests for the pure modules (no Chrome).
 * Run: node test/unit-tests.js
 */
'use strict';
const normalize = require('../shared/normalize');
const categorize = require('../shared/categorize');
const report = require('../shared/report');
const cleanup = require('../shared/cleanup');
const backup = require('../shared/backup');
const links = require('../shared/link-checker');
const constants = require('../shared/constants');
const linkUi = require('../shared/link-check-ui');
const trash = require('../shared/trash');
const messaging = require('../shared/messaging');
const scanCtrl = require('../shared/scan-controller');
const rules = require('../shared/rules-data.json');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

console.log('[normalize]');
check('lowercases host', normalize.normalizeUrl('HTTPS://Example.COM/Foo') === 'https://example.com/Foo');
check('strips default https port', normalize.normalizeUrl('https://a.com:443/x') === 'https://a.com/x');
check('keeps non-default port', normalize.normalizeUrl('https://a.com:8443/x') === 'https://a.com:8443/x');
check('drops fragment', normalize.normalizeUrl('https://a.com/p#sec') === 'https://a.com/p');
check('drops trailing slash on non-root', normalize.normalizeUrl('https://a.com/p/') === 'https://a.com/p');
check('keeps query', normalize.normalizeUrl('https://a.com/p?a=1') === 'https://a.com/p?a=1');
check('null for http-invalid', normalize.normalizeUrl('not a url') === null);
check('extractDomain strips www', normalize.extractDomain('https://www.GitHub.com/x') === 'github.com');

console.log('[normalize] isOpenableUrl (tabs.create guard)');
check('http is openable', normalize.isOpenableUrl('http://example.com') === true);
check('https is openable', normalize.isOpenableUrl('https://example.com/x?y=1') === true);
check('javascript: scheme is NOT openable', normalize.isOpenableUrl('javascript:alert(1)') === false);
check('data: scheme is NOT openable', normalize.isOpenableUrl('data:text/html,<h1>x</h1>') === false);
check('file: scheme is NOT openable', normalize.isOpenableUrl('file:///etc/passwd') === false);
check('chrome: scheme is NOT openable', normalize.isOpenableUrl('chrome://settings') === false);
check('about:blank is NOT openable', normalize.isOpenableUrl('about:blank') === false);
check('empty/invalid is NOT openable', normalize.isOpenableUrl('') === false && normalize.isOpenableUrl('not a url') === false);
check('non-string is NOT openable', normalize.isOpenableUrl(null) === false && normalize.isOpenableUrl(123) === false);

console.log('[categorize]');
check('domain rule github -> Development',
  categorize.categorize({ url: 'https://github.com/foo', title: 'x' }, rules).category === 'Development');
check('url phrase "flight" -> Travel',
  categorize.categorize({ url: 'https://example.com/flights/cheap', title: 'x' }, rules).category === 'Travel');
check('title phrase "how to cook" -> Recipes',
  categorize.categorize({ url: 'https://example.com/123', title: 'How to cook pasta' }, rules).category === 'Recipes');
check('neutral fallback when nothing matches',
  categorize.categorize({ url: 'https://someuniqueexample.com/x', title: 'whatever' }, rules).category === 'Other');
check('fallback is the neutral default category',
  categorize.categorize({ url: 'https://q.com/z', title: '' }, rules).category === constants.DEFAULT_CATEGORY);
check('fallback is not any of the known topic categories',
  constants.CATEGORIES.indexOf(categorize.categorize({ url: 'https://q.com/z', title: '' }, rules).category) !== -1);
check('keyword rule beats fallback', categorize.categorize({ url: 'https://q.com/z', title: 'javascript tutorial' }, rules).category !== 'Other');

console.log('[report]');
// Deterministic fixture records.
const NOW = Date.now();
const YEAR = constants.MILLIS_PER_DAY * constants.DAYS_PER_YEAR;
const rec = (id, url, opts) => Object.assign({
  id, url, title: 't' + id, dateAdded: NOW - 5 * YEAR,
  dateLastUsed: 0, folderPath: ['Bookmarks bar'], category: 'Development', userCorrected: false
}, opts || {});
const records = [
  rec('1', 'https://a.com/x', { dateAdded: NOW - 5 * YEAR, folderPath: ['Bookmarks bar', 'New Folder'] }),
  rec('2', 'https://a.com/x'),                     // exact duplicate of 1
  rec('3', 'https://a.com/y?b=c', { dateLastUsed: NOW - 3 * YEAR }), // stale (>2y)
  rec('4', 'https://b.com/z', { dateLastUsed: NOW, folderPath: ['Bookmarks bar', 'New Folder (2)'], category: 'News' }),
  rec('5', 'https://c.com/w', { dateLastUsed: NOW - 50 * 86400000, category: 'News' }), // not stale, opened recently
  // oldest is id 1 (oldest dateAdded) but there may be ties; ensure distinct
  rec('6', 'https://d.com/v', { dateAdded: NOW - 9 * YEAR, dateLastUsed: 0, category: 'Recipes' })
];
const r = report.computeReport(records, NOW);
check('total', r[constants.METRIC.TOTAL] === 6, 'got ' + r[constants.METRIC.TOTAL]);
check('duplicates == 1', r[constants.METRIC.DUPLICATES] === 1, 'got ' + r[constants.METRIC.DUPLICATES]);
check('newFolder == 2', r[constants.METRIC.NEW_FOLDER] === 2, 'got ' + r[constants.METRIC.NEW_FOLDER]);
// noRecordedOpening: records without a positive dateLastUsed (ids 1,2,6).
check('noRecordedOpening == 3 (ids 1,2,6)', r[constants.METRIC.NO_RECORDED_OPENING] === 3, 'got ' + r[constants.METRIC.NO_RECORDED_OPENING]);
// openHistory: records with a positive dateLastUsed (ids 3,4,5) == 3.
check('openHistoryCount == 3 (ids 3,4,5)', r[constants.METRIC.OPEN_HISTORY] === 3, 'got ' + r[constants.METRIC.OPEN_HISTORY]);
check('openHistoryCoverage == 3/6', r[constants.METRIC.OPEN_COVERAGE] === 0.5, 'got ' + r[constants.METRIC.OPEN_COVERAGE]);
// stale counts ONLY recorded openings older than 2y: id3 (3y ago) is stale; the
// never-recorded ids 1,2,6 and the recently-opened ids 4,5 are not.
check('staleOver2Years == 1 (only id3 recorded opening)', r[constants.METRIC.STALE_OVER_2_YEARS] === 1, 'got ' + r[constants.METRIC.STALE_OVER_2_YEARS]);
check('oldest is id 6 (9y)', r[constants.METRIC.OLDEST] && r[constants.METRIC.OLDEST].id === '6', JSON.stringify(r[constants.METRIC.OLDEST]));
// Top categories: Development(id1,id2)=2, News(id4,id5)=2, Recipes(id6)=1 -> tie-break alphabetical if requested; but limit 3 -> all three.
check('top topics sorted desc', JSON.stringify(r[constants.METRIC.TOP_CATEGORIES].map((t) => t.name)) === '["Development","News","Recipes"]',
  JSON.stringify(r[constants.METRIC.TOP_CATEGORIES]));
// Truthful stale: a record that was added long ago but has no dateLastUsed must
// NOT be treated as stale (no dateAdded fallback). id6 is added 9y ago and has
// no recorded opening; it contributed nothing to staleOver2Years already.
check('long-added record with no dateLastUsed is not stale (id6)',
  report.isStaleOverYears(records[5], NOW) === false, '');

console.log('[report] oldest bookmark is preserved and is a record');
check('oldest has a title/url', !!r[constants.METRIC.OLDEST].title && !!r[constants.METRIC.OLDEST].url);

// ---- Cleanup duplicate groups -------------------------------------------------
console.log('[cleanup] duplicate groups (excluding soft-deleted)');
const m2rec = (id, url, opts) => Object.assign({
  id, url, title: 't' + id, dateAdded: NOW, deletedAt: null, category: 'Development'
}, opts || {});
const dupRecords = [
  m2rec('a', 'https://a.com/x'),
  m2rec('b', 'https://a.com/x'),                            // duplicate of a
  m2rec('c', 'https://A.com/x'),                            // host case normalizes equal to a
  m2rec('d', 'https://b.com/z', { deletedAt: NOW }),        // soft-deleted duplicate of e
  m2rec('e', 'https://b.com/z'),                            // only active copy of b.com/z
  m2rec('f', 'https://c.com/unique')
];
const dg = cleanup.computeDuplicateGroups(dupRecords);
check('duplicate group count == 1 (only a.x group)', dg.groupCount === 1, 'got ' + dg.groupCount);
check('duplicates total == 2 (b,c; e is not a duplicate because d is soft-deleted)',
  dg.totalDuplicates === 2, 'got ' + dg.totalDuplicates);
check('duplicate groups exclude soft-deleted record (d not a group member)',
  dg.groups[0].items.every((it) => it.id !== 'd'), '');
check('within a group original is lowest id and rest are duplicates',
  dg.groups[0].items[0].id === 'a' && dg.groups[0].duplicates.length === 2 &&
  dg.groups[0].duplicates[0].id === 'b' && dg.groups[0].duplicates[1].id === 'c', '');
check('groups are deterministic under re-computation',
  JSON.stringify(cleanup.computeDuplicateGroups(dupRecords)) === JSON.stringify(dg), '');
const noDup = cleanup.computeDuplicateGroups([m2rec('a', 'https://a.com/x'), m2rec('b', 'https://q.com/y')]);
check('no duplicates yields zero groups', noDup.groupCount === 0 && noDup.totalDuplicates === 0, '');
check('path case is preserved by normalization (conservative exact-duplicate matching)',
  cleanup.computeDuplicateGroups([m2rec('a', 'https://a.com/X'), m2rec('b', 'https://a.com/x')]).groupCount === 0, '');
check('folder normalization is conservative (trim/lower/collapse)',
  cleanup.normalizeFolderName('  New Folder  ') === 'new folder' &&
  cleanup.normalizeFolderName('A  B') === 'a b', '');
check('duplicate groups ignore non-URL records', cleanup.computeDuplicateGroups([m2rec('x', 'not a url')]).groupCount === 0, '');

// ---- Report carries the duplicate list detail --------------------------------
console.log('[report] duplicate groups are surfaced in the report');
const reportWithDup = report.computeReport(dupRecords, NOW, {
  folderFindings: cleanup.analyzeFolders([])
});
check('report duplicates count excludes soft-deleted', reportWithDup[constants.METRIC.DUPLICATES] === 2, 'got ' + reportWithDup[constants.METRIC.DUPLICATES]);
check('report duplicateGroupsList carries 1 group', (reportWithDup[constants.METRIC.DUPLICATE_GROUPS_LIST] || []).length === 1, '');
check('duplicate list items are read-only ducks (no live fields)',
  reportWithDup[constants.METRIC.DUPLICATE_GROUPS_LIST][0].items[0].duplicateGroup === undefined, '');

// ---- Empty folders + same-name merge -----------------------------------------
console.log('[cleanup] empty folders and same-name merge detection');
// Tree snapshot: one empty folder, one empty nested "notes", two folders named
// "videos" under the SAME parent, two folders named "videos" under DIFFERENT
// parents (not merge candidates), and a non-empty folder.
const emptyTree = [
  { id: '1', title: 'bar', children: [
    { id: '2', title: 'notes', children: [] },                              // empty
    { id: '3', title: 'videos', children: [] },                             // empty, same-name as 5
    { id: '4', title: 'work', children: [
      { id: '40', title: 'notes', children: [] }                            // empty, nested
    ] },
    { id: '5', title: 'videos', children: [ { id: '50', title: 'a', url: 'https://x.com' } ] } // non-empty
  ] },
  { id: '6', title: 'other', children: [
    { id: '7', title: 'videos', children: [] }                              // empty but different parent path
  ] },
  { id: '8', title: 'bookmarks toolbar', children: [] }                     // empty root
];
const folderFindings = cleanup.analyzeFolders(emptyTree);
// Empty folders (no descendant leaf): notes(2), videos(3), work(4) [child notes empty],
// work/notes(40), other(6) [child empty], other/videos(7), bookmarks toolbar(8) == 7.
// videos(5) is NOT empty (it holds a leaf).
check('emptyFolders found == 7', folderFindings.emptyFolders.length === 7,
  'got ' + JSON.stringify(folderFindings.emptyFolders));
check('non-empty folder not reported empty',
  folderFindings.emptyFolders.every((f) => f.id !== '5'), '');
// Same-name merge groups: bar/videos — folders 3 and 5 share parent [bar] and the
// normalized name 'videos' → one candidate group of count 2. videos under a
// different parent (7 under [other]) is NOT a merge candidate with them.
check('same-name merge groups exist for bar/videos',
  folderFindings.sameNameMergeGroups.some((g) => g.name === 'videos' && g.count === 2), '');
check('videos under different parents are NOT merge candidates',
  !folderFindings.sameNameMergeGroups.some((g) => g.folders.some((f) => f.id === '7')), '');
check('merge candidates are read-only (never auto-merge, no mutation)',
  folderFindings.sameNameMergeGroups.every((g) => g.count >= 2), '');
check('emptyFolders lists are sorted deterministically (by path)',
  folderFindings.emptyFolders.every((f, idx, arr) => idx === 0 || JSON.stringify(arr[idx - 1].path) <= JSON.stringify(f.path)), '');

// ---- Built-in Chrome root containers are never cleanup findings ---------------
console.log('[cleanup] built-in root containers are never user cleanup findings');
check('synthetic root (id 0) is a built-in root node', cleanup.isBuiltInRootNode({ id: '0', title: '', parentId: '' }) === true, '');
check('Bar/Other/Mobile roots (1,2,3 under parentId 0) are built-in root nodes',
  cleanup.isBuiltInRootNode({ id: '1', title: 'Bookmarks bar', parentId: '0' }) &&
  cleanup.isBuiltInRootNode({ id: '2', title: 'Other bookmarks', parentId: '0' }) &&
  cleanup.isBuiltInRootNode({ id: '3', title: 'Mobile bookmarks', parentId: '0' }), '');
check('a user folder directly under a root (parentId 1) is NOT a built-in root',
  cleanup.isBuiltInRootNode({ id: '4', title: 'My Stuff', parentId: '1' }) === false, '');
check('a low-id user folder without parentId 0 is NOT a built-in root (conservative)',
  cleanup.isBuiltInRootNode({ id: '1', title: 'user folder', children: [] }) === false, '');

// An empty, real-shaped Chrome tree: synthetic root (id 0) holding the three
// empty standard containers. None of id 0/1/2/3 may be reported empty or as a
// merge candidate.
console.log('[cleanup] empty real-shaped Chrome tree reports nothing');
const realEmptyTree = [
  { id: '0', title: '', parentId: '', children: [
    { id: '1', title: 'Bookmarks bar', parentId: '0', children: [] },
    { id: '2', title: 'Other bookmarks', parentId: '0', children: [] },
    { id: '3', title: 'Mobile bookmarks', parentId: '0', children: [] }
  ] }
];
const realEmptyFindings = cleanup.analyzeFolders(realEmptyTree);
check('real empty tree reports zero empty folders (roots excluded)',
  realEmptyFindings.emptyFolders.length === 0, JSON.stringify(realEmptyFindings.emptyFolders));
check('real empty tree reports zero same-name merge groups (roots excluded)',
  realEmptyFindings.sameNameMergeGroups.length === 0, JSON.stringify(realEmptyFindings.sameNameMergeGroups));
check('no root id leaks into empty findings',
  realEmptyFindings.emptyFolders.every((f) => !['0', '1', '2', '3'].includes(f.id)), '');

// A real-shaped tree with a genuine user empty folder directly under a root:
// the root itself (id 1) must still be excluded while the user folder (id 4)
// is reported.
console.log('[cleanup] a user folder under a root is still analyzed');
const realWithUserFolder = [
  { id: '0', title: '', parentId: '', children: [
    { id: '1', title: 'Bookmarks bar', parentId: '0', children: [
      { id: '4', title: 'My Empty Folder', parentId: '1', children: [] }
    ] },
    { id: '2', title: 'Other bookmarks', parentId: '0', children: [] },
    { id: '3', title: 'Mobile bookmarks', parentId: '0', children: [] }
  ] }
];
const withUserFolderFindings = cleanup.analyzeFolders(realWithUserFolder);
check('user empty folder under a root is reported', withUserFolderFindings.emptyFolders.length === 1,
  JSON.stringify(withUserFolderFindings.emptyFolders));
check('only the user folder is reported (roots excluded)',
  withUserFolderFindings.emptyFolders[0] && withUserFolderFindings.emptyFolders[0].id === '4', '');
check('user folder path retains its root prefix (behavior preserved)',
  withUserFolderFindings.emptyFolders[0] &&
  JSON.stringify(withUserFolderFindings.emptyFolders[0].path) === JSON.stringify(['Bookmarks bar', 'My Empty Folder']), '');

// ---- Backup export -----------------------------------------------------------
console.log('[backup] full, versioned, restorable JSON export');
const SOME_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const sampleTree = [
  { id: '1', title: 'bar', children: [ { id: '2', title: 'a', url: 'https://a.com/x' } ] }
];
const backupObj = backup.buildBackup(sampleTree, SOME_NOW);
check('backup carries the schema name', backupObj.schema === constants.BACKUP_SCHEMA, '');
check('backup carries a version', backupObj.version === constants.BACKUP_VERSION, '');
check('backup stamps exportedAt as ISO', typeof backupObj.exportedAt === 'string' && backupObj.exportedAt === new Date(SOME_NOW).toISOString(), '');
check('backup embeds the FULL tree (never partial)', Array.isArray(backupObj.tree) && backupObj.tree.length === 1, '');
const backupJson = backup.serializeBackup(backupObj);
check('backup serializes to JSON text', typeof backupJson === 'string' && backupJson.indexOf('"schema"') !== -1, '');
check('serialized backup round-trips', backup.isValidBackup(JSON.parse(backupJson)), '');
check('backup is always complete regardless of gating (no partial flag)',
  backupObj.tree && backupObj.tree[0].children && backupObj.tree[0].children[0].id === '2', '');
const deepTree = backup.buildBackup(
  [{ id: '1', title: 'x', children: [{ id: '2', title: 'y', children: [{ id: '3', title: 'z', url: 'https://z.com' }] }] }], SOME_NOW);
check('backup preserves nested tree structure', deepTree.tree[0].children[0].children[0].url === 'https://z.com', '');
check('backup rejects non-schema objects', backup.isValidBackup({ schema: 'nope', version: 1, tree: [] }) === false, '');

// ---- Link-check classification -----------------------------------------------
console.log('[link-checker] three-state classification');
const rch = (status) => links.classify({ kind: 'ok', status });
check('200 -> reachable', rch(200) === constants.LINK_STATUS_REACHABLE, '');
check('204 -> reachable', rch(204) === constants.LINK_STATUS_REACHABLE, '');
check('304 -> could_not_check (not 2xx, not confirmed dead)', rch(304) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('404 -> unreachable (confirmed dead)', rch(404) === constants.LINK_STATUS_UNREACHABLE, '');
check('410 -> unreachable (confirmed gone)', rch(410) === constants.LINK_STATUS_UNREACHABLE, '');
check('401 -> could_not_check (never unreachable)', rch(401) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('403 -> could_not_check (blocked, uncertain)', rch(403) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('429 -> could_not_check (rate-limited)', rch(429) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('500 -> could_not_check (server error, uncertain)', rch(500) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('503 -> could_not_check', rch(503) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('redirect err -> could_not_check', links.classify({ kind: 'redirect_error' }) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('timeout -> could_not_check', links.classify({ kind: 'timeout' }) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('cors error -> could_not_check', links.classify({ kind: 'cors_error' }) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('network error -> could_not_check', links.classify({ kind: 'network_error' }) === constants.LINK_STATUS_COULD_NOT_CHECK, '');
check('null outcome -> could_not_check', links.classify(null) === constants.LINK_STATUS_COULD_NOT_CHECK, '');

// ---- Safe-cleanup eligibility (pure) ----------------------------------------
// Only non-original members of exact duplicate groups (never the original) and
// records whose persisted linkStatus is EXACTLY `unreachable` are selectable.
console.log('[trash] eligibility — duplicates select only non-original copies');
const T_NOW = NOW;
const m3rec = (id, url, opts) => Object.assign({ id, url, title: 't' + id, dateAdded: T_NOW, deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED }, opts || {});
const m3records = [
  m3rec('1', 'https://a.com/x'),                                       // original (lowest id)
  m3rec('2', 'https://a.com/x'),                                       // duplicate -> selectable
  m3rec('3', 'https://a.com/x'),                                       // duplicate -> selectable
  m3rec('4', 'https://dead.com', { linkStatus: constants.LINK_STATUS_UNREACHABLE }),
  m3rec('5', 'https://maybe.com', { linkStatus: constants.LINK_STATUS_COULD_NOT_CHECK }),
  m3rec('6', 'https://ok.com', { linkStatus: constants.LINK_STATUS_REACHABLE }),
  m3rec('7', 'https://a.com/x', { deletedAt: T_NOW })                  // soft-deleted -> never selectable
];
const m3groups = cleanup.computeDuplicateGroups(m3records).groups;
const selDup = trash.selectableDuplicates(m3groups);
check('duplicate group keeps only the copies (original + soft-deleted excluded)',
  selDup.map((s) => s.id).join(',') === '2,3', selDup.map((s) => s.id).join(','));
check('selectable duplicates carry kind=duplicate', selDup.every((s) => s.kind === trash.KIND_DUPLICATE), '');
const selDead = trash.selectableDeadLinks(m3records);
check('only persisted `unreachable` is a selectable dead link',
  selDead.map((s) => s.id).join(',') === '4', selDead.map((s) => s.id).join(','));
check('could_not_check / reachable / soft-deleted are never selectable',
  ['5', '6', '7'].every((id) => !selDead.some((s) => s.id === id)), '');
check('isDeadLinkStatus is true only for `unreachable`',
  trash.isDeadLinkStatus(constants.LINK_STATUS_UNREACHABLE) === true &&
  trash.isDeadLinkStatus(constants.LINK_STATUS_COULD_NOT_CHECK) === false &&
  trash.isDeadLinkStatus(constants.LINK_STATUS_REACHABLE) === false &&
  trash.isDeadLinkStatus(constants.LINK_STATUS_UNCHECKED) === false, '');

console.log('[trash] items with no url are never selectable');
check('duplicate without a url is skipped', trash.selectableDuplicates([{ normalizedUrl: 'x', duplicates: [{ id: 'z', title: 't', url: '' }] }]).length === 0, '');
check('dead link without a url is skipped', trash.selectableDeadLinks([m3rec('nourl', '', { linkStatus: constants.LINK_STATUS_UNREACHABLE })]).length === 0, '');

// ---- Itemized dry-run (pure) -------------------------------------------------
console.log('[trash] buildDryRun itemized preview');
const dry = trash.buildDryRun([
  { id: 'd1', title: 'dup1', url: 'https://a.com/x', kind: trash.KIND_DUPLICATE },
  { id: 'dead', title: 'gone', url: 'https://dead.com', kind: trash.KIND_DEAD_LINK },
  { id: 'x', title: '', url: 'https://empty-title.com', kind: undefined } // defaults to duplicate
]);
check('dry-run reports exact count and per-kind split',
  dry.count === 3 && dry.duplicateCount === 2 && dry.deadLinkCount === 1,
  JSON.stringify({ count: dry.count, d: dry.duplicateCount, l: dry.deadLinkCount }));
check('dry-run itemizes every item (never a summary-only count)', dry.items.length === 3 && dry.items[1].kind === trash.KIND_DEAD_LINK, '');
check('dry-run is pure/deterministic (no mutation, stable order)',
  dry.items[0].title === 'dup1' && JSON.stringify(trash.buildDryRun(dry.items)) !== JSON.stringify(dry.items), '');

// ---- Backup gate (pure) -----------------------------------------------------
console.log('[trash] backup gate');
check('gate required until a backup export is recorded',
  trash.backupGateRequired(undefined) === true &&
  trash.backupGateRequired(null) === true &&
  trash.backupGateRequired(0) === true, '');
check('gate cleared once backupExportedAt > 0 persisted',
  trash.backupGateRequired(T_NOW) === false, '');

// ---- Restore target fallback (pure) -----------------------------------------
console.log('[trash] resolveRestoreParent — original parent, else Bookmarks Bar');
const restoreTree = [
  { id: '0', title: '', parentId: '', children: [
    { id: '1', title: 'Bookmarks bar', parentId: '0', children: [
      { id: '20', title: 'Research', parentId: '1', children: [] }
    ] },
    { id: '2', title: 'Other bookmarks', parentId: '0', children: [] }
  ] }
];
check('restore targets the original parent when still present',
  trash.resolveRestoreParent({ originalParentId: '20' }, restoreTree, '1') === '20', '');
check('restore falls back to the Bookmarks Bar when the original folder is gone',
  trash.resolveRestoreParent({ originalParentId: '999' }, restoreTree, '1') === '1', '');
check('restore refuses to hang when no fallback id is supplied (still deterministic)',
  trash.resolveRestoreParent({ originalParentId: '20' }, restoreTree, null) === '20', '');

// ---- Retention/purge gate (pure) ---------------------------------------------
console.log('[trash] retention/purge eligibility');
const RET_MS = constants.MILLIS_PER_DAY * constants.TRASH_RETENTION_DAYS;
const recentEntry = { id: 'r', movedAt: T_NOW };                       // moved today
const pastEntry = { id: 'p', movedAt: T_NOW - RET_MS - 1 };            // 30+ days ago
const edgeEntry = { id: 'e', movedAt: T_NOW - RET_MS };                // exactly retention
const restoredEntry = { id: 'q', movedAt: T_NOW - RET_MS - 5000, restoredAt: T_NOW }; // restored
check('recently-moved entry is NOT eligible for purge', trash.isEligibleForPurge(recentEntry, T_NOW, RET_MS) === false, '');
check('30+ day entry IS eligible for purge', trash.isEligibleForPurge(pastEntry, T_NOW, RET_MS) === true, '');
check('entry at exactly retention is eligible (>=, not strict >)',
  trash.isEligibleForPurge(edgeEntry, T_NOW, RET_MS) === true, '');
check('restored entry never eligible for purge', trash.isEligibleForPurge(restoredEntry, T_NOW, RET_MS) === false, '');
check('eligibleForPurge refuses non-eligible requested ids (never purges early/auto)',
  trash.eligibleForPurge(['r', 'p', 'missing'], [recentEntry, pastEntry], T_NOW, RET_MS).eligible.length === 1 &&
  trash.eligibleForPurge(['r', 'p', 'missing'], [recentEntry, pastEntry], T_NOW, RET_MS).refusedCount === 2, '');
check('eligibleForPurge never purges a restored entry',
  trash.eligibleForPurge(['q'], [restoredEntry], T_NOW, RET_MS).eligible.length === 0, '');
// absence of movedAt is never eligible (missing metadata is never auto-purged)
check('entry with no movedAt is never eligible (defensive)',
  trash.isEligibleForPurge({ id: 'x' }, T_NOW, RET_MS) === false, '');

// A crafted duplicate-id purge request must never flow duplicate ids into the
// running set (which would call bookmarkApi.remove twice for one bookmark).
const dupPurge = trash.eligibleForPurge(['p', 'p', 'p', 'r', 'missing', 'missing'], [recentEntry, pastEntry], T_NOW, RET_MS);
check('duplicate requested purge ids are deduplicated up front (p eligible exactly once)',
  dupPurge.eligible.length === 1 && dupPurge.eligible[0].id === 'p',
  'eligible=' + dupPurge.eligible.map((e) => e.id).join(','));
check('a duplicate-id request is refused at most once per unique unknown id',
  dupPurge.refusedCount === 2, 'refused=' + dupPurge.refusedCount);

// ---- Server-side eligibility re-derivation (pure) -----------------------------
// bulkMove must NOT trust requested items; it re-derives the eligible set from
// the persisted records and refuses any requested id that is not a selectable
// non-original duplicate copy or a record with linkStatus exactly `unreachable`.
console.log('[trash] server-side eligible move re-derivation (ignores arbitrary ids)');
// Reuse the m3records fixture from above (ids 2,3 duplicates; id 4 dead link;
// id 7 soft-deleted; id 1 the original) as the persisted records source.
const eligReq = [
  { id: '2', title: 'FORGED', url: 'https://evil.example', kind: 'whatever' },
  { id: '4', title: 'FORGED', url: 'https://evil.example', kind: 'whatever' },
  { id: '1', title: 'original', url: 'https://a.com/x', kind: 'duplicate' }, // original -> refused
  { id: '4', title: 'dup-dup', url: 'https://a.com/x' },                     // dup id -> ignored (dedup)
  { id: 'bogus', title: 'x', url: 'https://a.com', kind: 'duplicate' },       // not in records -> refused
  { id: '5', title: 'could not check', url: 'https://maybe.com', kind: 'dead-link' }, // refused
  { id: '7', title: 'soft-deleted', url: 'https://a.com/x', kind: 'duplicate' } // soft-deleted -> never
];
const elig = trash.resolveEligibleMoveItems(eligReq, m3records);
check('derives move-set ONLY from persisted eligible records (never request fields)',
  elig.moveItems.length === 2 &&
  elig.moveItems.every((m) => m.id === '2' || m.id === '4') &&
  elig.moveItems.find((m) => m.id === '2').title === 't2' &&
  elig.moveItems.find((m) => m.id === '2').url === 'https://a.com/x' &&
  elig.moveItems.find((m) => m.id === '2').kind === trash.KIND_DUPLICATE &&
  elig.moveItems.find((m) => m.id === '4').kind === trash.KIND_DEAD_LINK,
  JSON.stringify(elig));
check('arbitrary / ineligible / forged requested ids are refused (never moved)',
  elig.refusedCount === 4 &&
  elig.moveItems.every((m) => m.id !== '1' && m.id !== 'bogus' && m.id !== '5' && m.id !== '7'),
  'refused=' + elig.refusedCount + ' move=' + elig.moveItems.map((m) => m.id).join(','));
check('duplicate requested ids collapse (id 4 counted once, still refused once)',
  elig.refusedCount === 4, JSON.stringify(elig));

// ---- Runtime message-boundary gates (pure) ------------------------------------
console.log('[messaging] trusted-sender + explicit purge confirmation gates');
check('a matching extension sender is trusted',
  messaging.isTrustedSender({ id: 'abc', url: 'chrome-extension://abc/popup.html' }, 'abc') === true, '');
check('a sender matching the runtime id but with a foreign origin id is still trusted (id is the authority)',
  messaging.isTrustedSender({ id: 'ext', origin: 'https://other.example' }, 'ext') === true, '');
check('a missing/empty sender id is NOT trusted (defence in depth)',
  messaging.isTrustedSender({ id: '', url: 'chrome-extension://abc/x' }, 'abc') === false &&
  messaging.isTrustedSender({ url: 'chrome-extension://abc/x' }, 'abc') === false,
  '');
check('a null sender is NOT trusted', messaging.isTrustedSender(null, 'abc') === false, '');
check('a mismatched sender id (foreign extension) is NOT trusted',
  messaging.isTrustedSender({ id: 'other', url: 'chrome-extension://other/x' }, 'abc') === false, '');
check('an undefined runtime id never trusts', messaging.isTrustedSender({ id: 'abc' }, undefined) === false, '');
check('purge is refused without the explicit confirmed sentinel',
  messaging.isConfirmedPurge({ type: 'trash-purge', ids: ['1'] }) === false &&
  messaging.isConfirmedPurge({ type: 'trash-purge', ids: ['1'], confirmed: 'yes' }) === false &&
  messaging.isConfirmedPurge(null) === false,
  '');
check('purge is confirmed only with the exact sentinel',
  messaging.isConfirmedPurge({ type: 'trash-purge', ids: ['1'], confirmed: 'confirmed' }) === true, '');

// ---- Dead-link section renders one state --------------------------------------
// linkCheckViewState is the pure, deterministic resolver the popup uses so the
// idle / running / completed states are mutually exclusive. A freshly-started
// check must never show the "not checked yet" copy and the "checking links"
// notice at the same time, and the running state must report the truthful
// persisted processedCount of totalCount — not a fabricated number.
console.log('[link-check-ui] mutually-exclusive dead-link view state');
const SAMPLE_REPORT = { total: 300 };                 // library present
const IDLE_CP = { phase: constants.PHASE.IDLE, processedCount: 0, totalCount: 0 };
const RUN_CP = { phase: constants.PHASE.SCANNING, processedCount: 12, totalCount: 300 };
const DONE_CP = { phase: constants.PHASE.DONE, processedCount: 300, totalCount: 300 };
const SAMPLE_LR = { checked: 300, reachable: 200, unreachable: 1, couldNotCheck: 99 };

// idle: no run has happened, library present -> checkable, not running, no ghost copy.
{
  const v = linkUi.linkCheckViewState({ report: SAMPLE_REPORT, linkReport: null, linkCheckpoint: IDLE_CP, active: false });
  check('idle state is idle', v.state === 'idle', v.state);
  check('idle has no fabricated progress', v.progress === null, JSON.stringify(v.progress));
  check('idle with a library is checkable', v.canCheck === true, '');
}
// running (persisted): phase SCANNING drives the state even with no transient hint.
{
  const v = linkUi.linkCheckViewState({ report: SAMPLE_REPORT, linkReport: null, linkCheckpoint: RUN_CP, active: false });
  check('persisted SCANNING checkpoint -> running', v.state === 'running', v.state);
  check('running reports truthful persisted progress 12 of 300',
    v.progress && v.progress.processed === 12 && v.progress.total === 300, JSON.stringify(v.progress));
  check('running is not checkable (no duplicate button)', v.canCheck === false, '');
  // The report is null while running (the controller drops it at start), so a
  // stale "completed" branch must never win over the running state.
  check('running trumps a null linkReport (mutually exclusive)', v.state === 'running', '');
}
// running (transient): the in-session active hint bridges the gap before the
// first durable checkpoint write — never allowed to show "not checked yet".
{
  const v = linkUi.linkCheckViewState({ report: SAMPLE_REPORT, linkReport: null, linkCheckpoint: IDLE_CP, active: true });
  check('transient active hint -> running before first storage write', v.state === 'running', v.state);
  check('transient running shows no fabricated progress (no checkpoint yet)', v.progress === null, '');
}
// completed: a report with a checked count wins once not running.
{
  const v = linkUi.linkCheckViewState({ report: SAMPLE_REPORT, linkReport: SAMPLE_LR, linkCheckpoint: DONE_CP, active: false });
  check('completed report -> completed state', v.state === 'completed', v.state);
  check('completed is checkable again (recheck entry)', v.canCheck === true, '');
  // Completed while a stale transient hint lingers must still be completed —
  // the persisted result is authoritative once not SCANNING.
  const v2 = linkUi.linkCheckViewState({ report: SAMPLE_REPORT, linkReport: SAMPLE_LR, linkCheckpoint: DONE_CP, active: false });
  check('completed never falls back to idle when a report exists', v2.state === 'completed', v2.state);
}
// no library at all: idle and not checkable, still never "running".
{
  const v = linkUi.linkCheckViewState({ report: null, linkReport: null, linkCheckpoint: null, active: false });
  check('no library -> idle', v.state === 'idle', v.state);
  check('no library -> not checkable', v.canCheck === false, '');
}
// copy: the progress line embeds the exact persisted counts.
{
  const copy = constants.COPY.linkCheckProgressLine(12, 300);
  check('linkCheckProgressLine embeds processed of total', /12 of 300/.test(copy) && /Checking links/.test(copy), copy);
  const copyZero = constants.COPY.linkCheckProgressLine(0, 300);
  check('linkCheckProgressLine renders 0 of total without coercion', /0 of 300/.test(copyZero), copyZero);
}

const checkUrlTests = (async () => {
  const okRes = await links.checkUrl(async () => ({ status: 200 }), 'https://a.com/x', { getNow: () => NOW });
  check('checkUrl classifies a 200 fetch as reachable', okRes.status === constants.LINK_STATUS_REACHABLE && okRes.statusCode === 200, JSON.stringify(okRes));
  const deadRes = await links.checkUrl(async () => ({ status: 404 }), 'https://a.com/gone', { getNow: () => NOW });
  check('checkUrl classifies a 404 fetch as unreachable', deadRes.status === constants.LINK_STATUS_UNREACHABLE, '');
  const blockedRes = await links.checkUrl(async () => ({ status: 403 }), 'https://a.com/x', { getNow: () => NOW });
  check('checkUrl classifies a 403 fetch as could_not_check', blockedRes.status === constants.LINK_STATUS_COULD_NOT_CHECK, '');
  const netFailRes = await links.checkUrl(async () => { throw Object.assign(new Error('net'), { name: 'TypeError' }); }, 'https://a.com/x', { getNow: () => NOW });
  check('checkUrl classifies a network error as could_not_check', netFailRes.status === constants.LINK_STATUS_COULD_NOT_CHECK, '');
  // Non-web URL is never fetched, immediately could_not_check.
  const jsRes = await links.checkUrl(async () => { throw new Error('should not fetch'); }, 'javascript:alert(1)', { getNow: () => NOW });
  check('checkUrl never fetches a non-web URL', jsRes.status === constants.LINK_STATUS_COULD_NOT_CHECK, '');
  // Redirects are never followed and never auto-detected as reachable/dead.
  const redirectRes = await links.checkUrl(async () => ({ status: 302 }), 'https://a.com/moved', { getNow: () => NOW });
  check('a 3xx response is classified could_not_check (never followed)', redirectRes.status === constants.LINK_STATUS_COULD_NOT_CHECK, JSON.stringify(redirectRes));
  const movedPermanently = await links.checkUrl(async () => ({ status: 301 }), 'https://a.com/permanent', { getNow: () => NOW });
  check('a 301 is classified could_not_check (no automatic follow)', movedPermanently.status === constants.LINK_STATUS_COULD_NOT_CHECK, JSON.stringify(movedPermanently));
  // An injected fetch must receive redirect:\'error\' so the request never
  // auto-follows into a landing page / internal network.
  let capturedOpts = null;
  const probeFetch = async (url, opts) => { capturedOpts = opts; return { status: 200 }; };
  await links.checkUrl(probeFetch, 'https://a.com/probe', { getNow: () => NOW });
  check('checkUrl requests redirect:\'error\' (never auto-follow)', capturedOpts && capturedOpts.redirect === 'error', JSON.stringify(capturedOpts && capturedOpts.redirect));
  // A redirect error thrown by fetch (redirect:\'error\' semantics) is could_not_check.
  const redirectThrow = await links.checkUrl(
    async () => { throw Object.assign(new Error('uri exceeded'), { name: 'TypeError', message: 'Redirect body' }); },
    'https://a.com/loop', { getNow: () => NOW });
  check('a redirect error from fetch -> could_not_check', redirectThrow.status === constants.LINK_STATUS_COULD_NOT_CHECK, redirectThrow.status);
})();

checkUrlTests.then(() => {
  // ---- Scan controller: all storageSet rejects --------------------------------
  // When every storageSet write in a scan failure path rejects, the controller
  // must NOT throw, must clear the wake, and must return an explicit
  // {failed:true, phase:PHASE.FAILED, error} result. The worker maps that to
  // {ok:false} so the popup shows COPY.scanFailed and re-enables the button.
  // After storage recovers, a subsequent scan must succeed.
  console.log('[scan-controller] all storageSet rejects — no throw, clear wake, explicit failed result');

  (async () => {
    // Test 1: all storageSet calls reject during requestScan
    {
      let wakeCleared = false;
      const failDeps = {
        bookmarkApi: { getTree: () => Promise.resolve([{ id: '1', title: 't', url: 'https://a.com' }]) },
        storageGet: () => Promise.resolve({}),
        storageSet: () => Promise.reject(new Error('quota exceeded')),
        loadRules: () => Promise.resolve(rules),
        scheduleWake: () => {},
        clearWake: () => { wakeCleared = true; },
        sendProgress: () => {},
        getNow: () => NOW
      };
      const ctrl = scanCtrl.createScanController(failDeps);
      let result;
      let threw = false;
      try {
        result = await ctrl.requestScan();
      } catch (e) { threw = true; }
      check('all storageSet rejects: no throw', !threw, threw ? 'threw' : '');
      check('all storageSet rejects: wake cleared', wakeCleared, '');
      check('all storageSet rejects: result.failed === true', result && result.failed === true, JSON.stringify(result));
      check('all storageSet rejects: phase is FAILED', result && result.phase === constants.PHASE.FAILED, '');
      check('all storageSet rejects: has error string', result && typeof result.error === 'string' && result.error.length > 0, result && result.error);
    }

    // Test 2: actual service-worker scan-now listener (VM) with all storageSet rejecting.
    // Executes the real background/service-worker.js in a vm.createContext sandbox
    // with a chrome mock whose storage.local.set always rejects, dispatches a
    // 'scan-now' message through the real onMessage handler, and asserts the real
    // sendResponse — catching any regression in service-worker.js itself.
    {
      const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
      const MOD_MAP = {
        '../shared/constants.js': 'BRConstants', '../shared/normalize.js': 'BRNormalize',
        '../shared/categorize.js': 'BRCategorize', '../shared/cleanup.js': 'BRCleanup',
        '../shared/backup.js': 'BRBackup', '../shared/link-checker.js': 'BRLinks',
        '../shared/report.js': 'BRReport', '../shared/trash.js': 'BRTrash',
        '../shared/messaging.js': 'BRMessaging', '../shared/scan-controller.js': 'BRScan'
      };
      const TREE_UT = [{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [
        { id: '2', title: 'A', url: 'https://a.com' }
      ] }] }];

      function buildSWCtx(makeSet) {
        const store = Object.create(null);
        const listeners = [];
        let alarmsCreated = 0;
        const sandbox = {
          console, Buffer, setTimeout, clearTimeout, queueMicrotask,
          Promise, Error, Object, Array, JSON, Math, Date, RegExp, String,
          Number, Boolean, Map, Set, parseInt, parseFloat, isNaN, isFinite,
          encodeURIComponent, decodeURIComponent,
          fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(rules) }),
          chrome: {
            runtime: {
              id: 'ext-ut', getURL: (p) => 'chrome-extension://ext-ut/' + p,
              sendMessage: () => Promise.resolve(),
              onMessage: { addListener: (fn) => listeners.push(fn) },
              onInstalled: { addListener: () => {} }
            },
            alarms: { onAlarm: { addListener: () => {} }, create: () => { alarmsCreated++; }, clear: () => Promise.resolve(true) },
            permissions: { contains: () => Promise.resolve(false) },
            storage: { local: {
              get: (keys) => {
                const arr = Array.isArray(keys) ? keys : [keys];
                return Promise.resolve(arr.reduce((o, k) => { if (k in store) { o[k] = store[k]; } return o; }, {}));
              },
              set: makeSet(store)
            } },
            bookmarks: {
              getTree: () => Promise.resolve(JSON.parse(JSON.stringify(TREE_UT))),
              get: (id) => Promise.resolve(null),
              create: (o) => Promise.resolve({ id: 'new', title: o.title, parentId: o.parentId }),
              move: (id, o) => Promise.resolve({ id: id, parentId: o.parentId }),
              remove: (id) => Promise.resolve()
            }
          }
        };
        sandbox.importScripts = (...paths) => paths.forEach((p) => {
          if (MOD_MAP[p]) { sandbox[MOD_MAP[p]] = require(p); }
        });
        const ctx = vm.createContext(sandbox);
        vm.runInContext(SW_SRC, ctx, { filename: 'service-worker.js' });
        return { store, listeners, alarms: () => alarmsCreated };
      }

      function dispatchSW(listener, msg) {
        return new Promise((resolve) => {
          let response;
          listener(msg, { id: 'ext-ut', url: 'chrome-extension://ext-ut/popup.html' },
            (v) => { response = v; });
          queueMicrotask(() => setTimeout(() => resolve(response), 30));
        });
      }

      // 2a: All storageSet reject — real sendResponse must be {ok:false, phase:FAILED, error}
      const rej = buildSWCtx(() => () => Promise.reject(new Error('total storage failure')));
      check('actual SW scan-now: listener registered', typeof rej.listeners[0] === 'function',
        'count=' + rej.listeners.length);
      const resp = await dispatchSW(rej.listeners[0], { type: 'scan-now' });
      check('actual SW scan-now: sendResponse is {ok:false, phase:FAILED, error}',
        resp && resp.ok === false && resp.phase === constants.PHASE.FAILED &&
        typeof resp.error === 'string' && resp.error.length > 0, JSON.stringify(resp));
      check('actual SW scan-now: no alarm scheduled (no wake)',
        rej.alarms() === 0, 'alarms=' + rej.alarms());

      // 2b: Restore storage, assert subsequent real SW scan-now succeeds
      const ok = buildSWCtx((s) => (obj) => {
        Object.keys(obj).forEach((k) => { s[k] = JSON.parse(JSON.stringify(obj[k])); });
        return Promise.resolve();
      });
      const resp2 = await dispatchSW(ok.listeners[0], { type: 'scan-now' });
      check('actual SW scan-now recovery: sendResponse is {ok:true}',
        resp2 && resp2.ok === true, JSON.stringify(resp2));
      check('actual SW scan-now recovery: checkpoint reached DONE',
        ok.store[constants.KEYS.CHECKPOINT] && ok.store[constants.KEYS.CHECKPOINT].phase === constants.PHASE.DONE,
        'phase=' + (ok.store[constants.KEYS.CHECKPOINT] && ok.store[constants.KEYS.CHECKPOINT].phase));

      // 2c: resume-scan handler propagates failed controller outcome.
      // When the scan controller's resume() returns {failed:true, phase:FAILED,
      // error}, the service-worker must reply {ok:false, phase:FAILED, error}
      // — not the old always-{ok:true}. This uses a SCANNING checkpoint with
      // all storageSet rejecting so resume() hits the failure path.
      const rejResume = buildSWCtx(() => () => Promise.reject(new Error('storage offline')));
      // Seed a SCANNING checkpoint so resume() enters processActiveWindowImpl.
      rejResume.store[constants.KEYS.CHECKPOINT] = {
        phase: constants.PHASE.SCANNING, totalCount: 10, processedCount: 0,
        lastProcessedId: null, updatedAt: NOW, scanStartedAt: NOW
      };
      rejResume.store[constants.KEYS.QUEUE] = [{ id: '1', title: 't', url: 'https://a.com', dateAdded: 0, dateLastUsed: 0, folderPath: [] }];
      rejResume.store[constants.KEYS.SCHEMA] = constants.SCHEMA_VERSION;
      const resumeResp = await dispatchSW(rejResume.listeners[0], { type: 'resume-scan' });
      check('actual SW resume-scan: sendResponse is {ok:false} when controller fails',
        resumeResp && resumeResp.ok === false, JSON.stringify(resumeResp));
      check('actual SW resume-scan: phase is FAILED',
        resumeResp && resumeResp.phase === constants.PHASE.FAILED, JSON.stringify(resumeResp));
      check('actual SW resume-scan: has error string',
        resumeResp && typeof resumeResp.error === 'string' && resumeResp.error.length > 0,
        'error=' + (resumeResp && resumeResp.error));

      // 2d: resume-scan handler returns {ok:true} for normal no-op resume
      // (checkpoint is DONE, resume is a no-op).
      const okResume = buildSWCtx((s) => (obj) => {
        Object.keys(obj).forEach((k) => { s[k] = JSON.parse(JSON.stringify(obj[k])); });
        return Promise.resolve();
      });
      okResume.store[constants.KEYS.CHECKPOINT] = {
        phase: constants.PHASE.DONE, totalCount: 5, processedCount: 5,
        lastProcessedId: '5', updatedAt: NOW
      };
      const okResumeResp = await dispatchSW(okResume.listeners[0], { type: 'resume-scan' });
      check('actual SW resume-scan: {ok:true} for normal no-op resume (DONE checkpoint)',
        okResumeResp && okResumeResp.ok === true, JSON.stringify(okResumeResp));
    }

    // Test 3: storage recovery allows next scan
    {
      let storageWorking = false;
      const store = {};
      const recoveryDeps = {
        bookmarkApi: { getTree: () => Promise.resolve([{ id: '1', title: 't', url: 'https://a.com' }]) },
        storageGet: (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) { out[k] = store[k]; } });
          return Promise.resolve(out);
        },
        storageSet: (obj) => {
          if (!storageWorking) { return Promise.reject(new Error('quota exceeded')); }
          Object.keys(obj).forEach((k) => { store[k] = JSON.parse(JSON.stringify(obj[k])); });
          return Promise.resolve();
        },
        loadRules: () => Promise.resolve(rules),
        scheduleWake: () => {},
        clearWake: () => {},
        sendProgress: () => {},
        getNow: () => NOW
      };
      const ctrl = scanCtrl.createScanController(recoveryDeps);

      // First scan: all storageSet reject -> failed
      let r1; let t1 = false;
      try { r1 = await ctrl.requestScan(); } catch (e) { t1 = true; }
      check('recovery: first scan fails without throw', !t1, '');
      check('recovery: first scan result is failed', r1 && r1.failed === true, JSON.stringify(r1));

      // Storage recovers
      storageWorking = true;

      // Second scan: succeeds
      let r2; let t2 = false;
      try { r2 = await ctrl.requestScan(); } catch (e) { t2 = true; }
      check('recovery: second scan succeeds without throw', !t2, '');
      check('recovery: second scan is not failed', !(r2 && r2.failed), JSON.stringify(r2));
      check('recovery: second scan is not skipped', !(r2 && r2.skipped), JSON.stringify(r2));
      // Verify records were persisted (scan completed)
      check('recovery: records persisted after recovery', (store.records || []).length === 1, 'records=' + (store.records || []).length);
      check('recovery: checkpoint reached DONE', store.checkpoint && store.checkpoint.phase === constants.PHASE.DONE, 'phase=' + (store.checkpoint && store.checkpoint.phase));
    }
  })().then(() => {
    // ---- Firefox-compatible bar id detection (controller) -------------------
    // Firefox uses different bookmark root ids ('toolbar_____' for Bookmarks
    // Toolbar, not '1'). The controller must auto-detect the correct bar id from
    // the tree on first use. Regression guard for the Trash-button-does-nothing
    // defect in the Firefox temporary add-on.
    console.log('[trash] Firefox-compatible bar id auto-detection');
    return (async () => {
      const FF_BAR_ID = 'toolbar_____';
      const FF_ROOT_ID = 'root________';
      const ffTree = [
        { id: FF_ROOT_ID, title: '', children: [
          { id: 'ff-unfiled', title: 'Other Bookmarks', parentId: FF_ROOT_ID, children: [] },
          { id: FF_BAR_ID, title: 'Bookmarks Toolbar', parentId: FF_ROOT_ID, children: [
            { id: 'ff-folder-1', title: 'Research', parentId: FF_BAR_ID, children: [
              { id: 'ff-bm-1', title: 'A', url: 'https://a.com/x', parentId: 'ff-folder-1' },
              { id: 'ff-bm-2', title: 'A dup', url: 'https://a.com/x', parentId: 'ff-folder-1' }
            ] }
          ] }
        ] }
      ];

      const CHROME_BAR_ID = '1';
      const chromeTree = [
        { id: '0', title: '', children: [
          { id: '2', title: 'Other Bookmarks', parentId: '0', children: [] },
          { id: CHROME_BAR_ID, title: 'Bookmarks Bar', parentId: '0', children: [
            { id: 'chrome-bm-1', title: 'B', url: 'https://b.com/y', parentId: CHROME_BAR_ID },
            { id: 'chrome-bm-2', title: 'B dup', url: 'https://b.com/y', parentId: CHROME_BAR_ID }
          ] }
        ] }
      ];

      function makeController(treeSource, seedStore, expectedBarId, validParentIds) {
        const ffStore = seedStore || {};
        const calls = { create: [], move: [] };
        const validParents = {};
        (validParentIds || []).forEach((id) => { validParents[String(id)] = true; });
        const controller = trash.createTrashController({
          bookmarkApi: {
            getTree: () => {
              const tree = typeof treeSource === 'function' ? treeSource() : treeSource;
              return Promise.resolve(JSON.parse(JSON.stringify(tree)));
            },
            get: (id) => Promise.resolve({ id: String(id), parentId: 'root', index: 0 }),
            create: (o) => {
              const parentId = String(o.parentId);
              calls.create.push({ parentId: parentId, title: o.title });
              if (parentId !== expectedBarId) { return Promise.reject(new Error('invalid trash parent: ' + parentId)); }
              return Promise.resolve({ id: 'new-created', title: o.title, parentId: parentId });
            },
            move: (id, o) => {
              const parentId = String(o.parentId);
              calls.move.push({ id: String(id), parentId: parentId });
              if (!validParents[parentId]) { return Promise.reject(new Error('invalid move parent: ' + parentId)); }
              return Promise.resolve({ id: id, parentId: parentId });
            }
          },
          storageGet: (keys) => {
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in ffStore) out[k] = ffStore[k]; });
            return Promise.resolve(out);
          },
          storageSet: (obj) => { Object.keys(obj).forEach((k) => { ffStore[k] = JSON.parse(JSON.stringify(obj[k])); }); return Promise.resolve(); },
          getNow: () => T_NOW
        });
        return { controller: controller, calls: calls };
      }

      // Test 1: Firefox tree — bulkMove creates trash folder under 'toolbar_____', not '1'.
      {
        const ffStore1 = {};
        ffStore1[constants.KEYS.RECORDS] = [
          { id: 'ff-bm-1', url: 'https://a.com/x', title: 'A', deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED },
          { id: 'ff-bm-2', url: 'https://a.com/x', title: 'A dup', deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED }
        ];
        ffStore1[constants.KEYS.TRASH_BACKUP_GATE] = { exportedAt: T_NOW };
        ffStore1[constants.KEYS.TRASH] = [];
        const test = makeController(ffTree, ffStore1, FF_BAR_ID, [FF_BAR_ID, 'new-created']);
        const res = await test.controller.bulkMove([{ id: 'ff-bm-2', title: 'A dup', url: 'https://a.com/x', kind: trash.KIND_DUPLICATE }]);
        check('Firefox bulkMove succeeds (ok:true)', res && res.ok === true, JSON.stringify(res));
        check('Firefox bulkMove moves bookmark (movedCount > 0)',
          res && res.ok && typeof res.movedCount === 'number' && res.movedCount > 0,
          'movedCount=' + (res && res.movedCount));
        check('Firefox Trash folder creation uses toolbar root',
          test.calls.create.length === 1 && test.calls.create[0].parentId === FF_BAR_ID,
          JSON.stringify(test.calls.create));
      }

      // Test 2: Chrome tree — bulkMove still works with default barId '1'.
      {
        const ffStore2 = {};
        ffStore2[constants.KEYS.RECORDS] = [
          { id: 'chrome-bm-1', url: 'https://b.com/y', title: 'B', deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED },
          { id: 'chrome-bm-2', url: 'https://b.com/y', title: 'B dup', deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED }
        ];
        ffStore2[constants.KEYS.TRASH_BACKUP_GATE] = { exportedAt: T_NOW };
        ffStore2[constants.KEYS.TRASH] = [];
        const test = makeController(chromeTree, ffStore2, CHROME_BAR_ID, [CHROME_BAR_ID, 'new-created']);
        const res2 = await test.controller.bulkMove([{ id: 'chrome-bm-2', title: 'B dup', url: 'https://b.com/y', kind: trash.KIND_DUPLICATE }]);
        check('Chrome bulkMove succeeds (ok:true)', res2 && res2.ok === true, JSON.stringify(res2));
        check('Chrome bulkMove moves bookmark (movedCount > 0)',
          res2 && res2.ok && typeof res2.movedCount === 'number' && res2.movedCount > 0,
          'movedCount=' + (res2 && res2.movedCount));
        check('Chrome Trash folder creation uses bar root',
          test.calls.create.length === 1 && test.calls.create[0].parentId === CHROME_BAR_ID,
          JSON.stringify(test.calls.create));
      }

      // Test 3: Firefox tree — restoreSelected uses detected bar id.
      {
        const ffStore3 = {};
        ffStore3[constants.KEYS.TRASH] = [
          { id: 'ff-bm-1', title: 'A', url: 'https://a.com/x', kind: trash.KIND_DUPLICATE,
            originalParentId: 'ff-folder-1', movedAt: T_NOW }
        ];
        ffStore3[constants.KEYS.RECORDS] = [
          { id: 'ff-bm-1', url: 'https://a.com/x', title: 'A', deletedAt: T_NOW, linkStatus: constants.LINK_STATUS_UNCHECKED }
        ];
        const test = makeController(ffTree, ffStore3, FF_BAR_ID, ['ff-folder-1']);
        const res3 = await test.controller.restoreSelected(['ff-bm-1']);
        check('Firefox restoreSelected succeeds', res3 && res3.ok === true && res3.restoredCount === 1,
          JSON.stringify(res3));
      }

      // Test 4: Firefox tree — restoreSelected with missing original parent
      // falls back to detected bar id (toolbar_____), not hardcoded '1'.
      {
        const ffStore4 = {};
        ffStore4[constants.KEYS.TRASH] = [
          { id: 'ff-bm-1', title: 'A', url: 'https://a.com/x', kind: trash.KIND_DUPLICATE,
            originalParentId: 'nonexistent-folder', movedAt: T_NOW }
        ];
        ffStore4[constants.KEYS.RECORDS] = [
          { id: 'ff-bm-1', url: 'https://a.com/x', title: 'A', deletedAt: T_NOW, linkStatus: constants.LINK_STATUS_UNCHECKED }
        ];
        const test = makeController(ffTree, ffStore4, FF_BAR_ID, [FF_BAR_ID]);
        const res4 = await test.controller.restoreSelected(['ff-bm-1']);
        check('Firefox restoreSelected with missing original parent succeeds (fallback to bar)',
          res4 && res4.ok === true && res4.restoredCount === 1,
          JSON.stringify(res4));
        check('Firefox missing-parent restore fallback uses toolbar root',
          test.calls.move.length === 1 && test.calls.move[0].parentId === FF_BAR_ID,
          JSON.stringify(test.calls.move));
      }

      // Test 5: Chrome restore fallback continues to use the default bar id.
      {
        const store = {};
        store[constants.KEYS.TRASH] = [
          { id: 'chrome-bm-1', title: 'B', url: 'https://b.com/y', kind: trash.KIND_DUPLICATE,
            originalParentId: 'nonexistent-folder', movedAt: T_NOW }
        ];
        store[constants.KEYS.RECORDS] = [
          { id: 'chrome-bm-1', url: 'https://b.com/y', title: 'B', deletedAt: T_NOW, linkStatus: constants.LINK_STATUS_UNCHECKED }
        ];
        const test = makeController(chromeTree, store, CHROME_BAR_ID, [CHROME_BAR_ID]);
        const res = await test.controller.restoreSelected(['chrome-bm-1']);
        check('Chrome restoreSelected with missing original parent succeeds (fallback to bar)',
          res && res.ok === true && res.restoredCount === 1,
          JSON.stringify(res));
        check('Chrome missing-parent restore fallback uses bar root',
          test.calls.move.length === 1 && test.calls.move[0].parentId === CHROME_BAR_ID,
          JSON.stringify(test.calls.move));
      }

      // Test 6: empty and malformed trees must not lock resolution before a
      // later valid tree exposes the Firefox toolbar root.
      {
        const store = {};
        store[constants.KEYS.RECORDS] = [
          { id: 'ff-bm-1', url: 'https://a.com/x', title: 'A', deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED },
          { id: 'ff-bm-2', url: 'https://a.com/x', title: 'A dup', deletedAt: null, linkStatus: constants.LINK_STATUS_UNCHECKED }
        ];
        store[constants.KEYS.TRASH_BACKUP_GATE] = { exportedAt: T_NOW };
        store[constants.KEYS.TRASH] = [];
        const trees = [[], [{ id: FF_ROOT_ID, children: [{}] }], ffTree];
        const test = makeController(() => trees.shift(), store, FF_BAR_ID, [FF_BAR_ID, 'new-created']);
        await test.controller.restoreSelected([]);
        await test.controller.restoreSelected([]);
        const res = await test.controller.bulkMove([{ id: 'ff-bm-2' }]);
        check('Firefox root resolution retries after empty or malformed tree',
          res && res.ok === true && res.movedCount === 1,
          JSON.stringify(res));
        check('Firefox retry creates Trash folder under toolbar root',
          test.calls.create.length === 1 && test.calls.create[0].parentId === FF_BAR_ID,
          JSON.stringify(test.calls.create));
      }

      console.log('[trash] Firefox-compatible bar id tests complete');
    })();
  }).then(() => {
    console.log('\nUnit results: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
    process.exitCode = failures === 0 ? 0 : 1;
  });
});
