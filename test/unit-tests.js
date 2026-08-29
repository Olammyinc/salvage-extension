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
const rules = require('../shared/rules-data.json');

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
  constants.CATEGORIES_THIS_MILESTONE.indexOf(categorize.categorize({ url: 'https://q.com/z', title: '' }, rules).category) !== -1);
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

// ---- Milestone 2: cleanup duplicate groups ----------------------------------
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

// ---- Milestone 2: report carries the duplicate list detail --------------------
console.log('[report] duplicate groups are surfaced in the report');
const reportWithDup = report.computeReport(dupRecords, NOW, {
  folderFindings: cleanup.analyzeFolders([])
});
check('report duplicates count excludes soft-deleted', reportWithDup[constants.METRIC.DUPLICATES] === 2, 'got ' + reportWithDup[constants.METRIC.DUPLICATES]);
check('report duplicateGroupsList carries 1 group', (reportWithDup[constants.METRIC.DUPLICATE_GROUPS_LIST] || []).length === 1, '');
check('duplicate list items are read-only ducks (no live fields)',
  reportWithDup[constants.METRIC.DUPLICATE_GROUPS_LIST][0].items[0].duplicateGroup === undefined, '');

// ---- Milestone 2: empty folders + same-name merge ----------------------------
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

// ---- Milestone 2: built-in Chrome root containers are never cleanup findings -
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

// ---- Milestone 2: backup export ----------------------------------------------
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

// ---- Milestone 2: link-check classification ----------------------------------
console.log('[link-checker] three-state classification (FR5)');
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

// ---- Milestone 3: safe-cleanup eligibility (pure) -------------------------
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

// ---- Milestone 3: itemized dry-run (pure) ---------------------------------
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

// ---- Milestone 3: backup gate (pure) --------------------------------------
console.log('[trash] backup gate');
check('gate required until a backup export is recorded',
  trash.backupGateRequired(undefined) === true &&
  trash.backupGateRequired(null) === true &&
  trash.backupGateRequired(0) === true, '');
check('gate cleared once backupExportedAt > 0 persisted',
  trash.backupGateRequired(T_NOW) === false, '');

// ---- Milestone 3: restore target fallback (pure) --------------------------
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

// ---- Milestone 3: retention/purge gate (pure) -----------------------------
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

// ---- Milestone 3: server-side eligibility re-derivation (pure) -------------
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

// ---- Milestone 3: runtime message-boundary gates (pure) ---------------------
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

// ---- Milestone 2 UI state: the dead-link section renders one state -----------
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
  console.log('\nUnit results: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exitCode = failures === 0 ? 0 : 1;
});
