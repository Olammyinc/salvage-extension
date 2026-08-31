/**
 * Cleanup detection — pure logic.
 *
 * Detection-only and read-only: this module computes duplicate groups, empty
 * folders, and same-name folder merge candidates. It never mutates a bookmark
 * tree or a record, and it never auto-merges or deletes anything.
 *
 * Two sources feed it:
 *   - duplicate groups come from the persisted `records` (normalized URLs);
 *   - empty-folder and same-name-merge findings come from a read-only snapshot
 *     of the real bookmark tree (`chrome.bookmarks.getTree()` output).
 *
 * No chrome dependencies, so it runs identically under node (tests) and in
 * the service worker.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalize'), require('./constants'));
  } else {
    root.BRCleanup = factory(root.BRNormalize, root.BRConstants);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (normalize, constants) {
  'use strict';

  /**
   * A record is "soft-deleted" when it carries a positive deletedAt timestamp.
   * `deletedAt: null` (the schema default) means active. Soft-deleted records
   * are excluded from duplicate detection so a trash/undo recovery path can
   * never be the first copy a duplicate group deduplicates against.
   */
  function isSoftDeleted(record) {
    return !!(record && typeof record.deletedAt === 'number' && record.deletedAt > 0);
  }

  /**
   * Deterministic duplicate groups from persisted records.
   *
   * Groups bookmarks by normalized URL. Only URLs with more than one active
   * member produce a group; within a group the first member (by id) is the
   * "original" and the rest are the duplicates. Counts are exact and never
   * estimates.
   *
   * @param {Array<object>} records persisted bookmark records
   * @returns {{totalDuplicates:number, groupCount:number, groups:Array<object>}}
   *   groups each shaped:
   *   { normalizedUrl, count, items:[record...], duplicates:[record...] }
   */
  function computeDuplicateGroups(records) {
    records = records || [];
    var byUrl = Object.create(null);
    var urlOrder = [];
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (isSoftDeleted(rec)) { continue; }
      var key = normalize.normalizeUrl(rec.url);
      if (!key) { continue; }
      if (!byUrl[key]) {
        byUrl[key] = [];
        urlOrder.push(key);
      }
      byUrl[key].push(rec);
    }

    var groups = [];
    for (var j = 0; j < urlOrder.length; j++) {
      var norm = urlOrder[j];
      if (byUrl[norm].length < 2) { continue; }
      var members = byUrl[norm].slice();
      members.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      groups.push({
        normalizedUrl: norm,
        count: members.length,
        items: members,
        duplicates: members.slice(1)
      });
    }
    groups.sort(function (a, b) {
      return a.normalizedUrl < b.normalizedUrl ? -1 : a.normalizedUrl > b.normalizedUrl ? 1 : 0;
    });

    var totalDuplicates = 0;
    for (var k = 0; k < groups.length; k++) { totalDuplicates += groups[k].duplicates.length; }

    return { totalDuplicates: totalDuplicates, groupCount: groups.length, groups: groups };
  }

  /**
   * Conservative folder-name normalization used for same-name merge matching.
   * Trims, lowercases, and collapses interior runs of whitespace. It is
   * deliberately conservative so distinct human-intended folder names are not
   * conflated; it never auto-merges (merging is a later, manual action).
   */
  function normalizeFolderName(name) {
    if (typeof name !== 'string') { return ''; }
    return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Conservative predicate: is this node one of Chrome's built-in root
   * containers, which must never be reported as a user cleanup finding?
   *
   * In a real Chrome bookmark tree the top is a synthetic "bookmarks bar"
   * container (id "0", no parent), and directly beneath it live the three
   * standard containers — Bookmarks bar (id "1"), Other bookmarks (id "2"),
   * and Mobile bookmarks (id "3") — each with parentId "0". User-created
   * folders are never children of the synthetic root; they live under one of
   * the standard containers (parentId "1"/"2"/"3") and carry their own higher
   * numeric ids.
   *
   * The check is deliberately anchored to BOTH id and parent so a user folder
   * that happens to carry a low numeric id is never dropped from analysis: a
   * folder with id "1" is only a built-in root when it also sits directly
   * under the synthetic root (parentId "0"), which is exactly how real Chrome
   * shapes it. The synthetic root (id "0") is unique and always excluded.
   *
   * @param {object|null} node a bookmark tree node
   * @returns {boolean} true when `node` is a built-in root container
   */
  function isBuiltInRootNode(node) {
    if (!node) { return false; }
    var id = String(node.id);
    if (id === '0') { return true; }
    if ((id === '1' || id === '2' || id === '3') && node.parentId === '0') {
      return true;
    }
    return false;
  }

  /**
   * Analyze a (read-only) bookmark tree for empty folders and same-name merge
   * candidates. Pure and deterministic.
   *
   *  - empty foldfer: a folder with no descendant bookmark (URL) leaf.
   *  - same-name merge candidate: two or more folders that share the same
   *    parent path AND the same normalized folder name. Candidates are only
   *    reported; merging is a later, explicitly user-controlled action and is
   *    never performed here.
   *
   * @param {Array<object>} tree chrome.bookmarks.getTree() output
   * @returns {{emptyFolders:Array<object>, sameNameMergeGroups:Array<object>}}
   *   emptyFolders:  [{ id, title, path:Array<string> }] sorted by path
   *   sameNameMergeGroups: [{ parentPath:Array<string>, name:string,
   *                            count:number, folders:[{id,title,path}] }]
   */
  function analyzeFolders(tree) {
    tree = tree || [];
    var emptyFolders = [];
    var mergeBuckets = Object.create(null);
    var bucketOrder = [];

    function walk(nodes, parentPath) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node) { continue; }
        var hasChildren = Object.prototype.hasOwnProperty.call(node, 'children');
        if (!hasChildren) {
          // A bookmark leaf does not create a folder finding.
          continue;
        }
        var path = parentPath.concat([node.title || '']);

        // A built-in root container (Chrome's synthetic root, Bookmarks bar,
        // Other bookmarks, Mobile bookmarks) is never a user cleanup finding:
        // it is not reported empty and is never a same-name merge candidate.
        // Its children are still analyzed normally (recursion below), so a
        // user-created folder directly under a root is not skipped.
        if (!isBuiltInRootNode(node)) {
          var hasDescendantLeaf = scanForLeaf(node);

          if (!hasDescendantLeaf) {
            emptyFolders.push({ id: String(node.id), title: node.title || '', path: path });
          }

          // Same-name merge bucket: parent path (exclude own name) + normalized name.
          var parentKey = JSON.stringify(parentPath);
          var normName = normalizeFolderName(path[path.length - 1]);
          if (normName) {
            var bucketKey = parentKey + '\u0000' + normName;
            if (!mergeBuckets[bucketKey]) {
              mergeBuckets[bucketKey] = {
                key: bucketKey,
                parentPath: parentPath.slice(),
                name: normName,
                folders: []
              };
              bucketOrder.push(bucketKey);
            }
            var b = mergeBuckets[bucketKey];
            // Track both the raw title (for display) and the folder id/path.
            b.__rawName = node.title || '';
            b.folders.push({
              id: String(node.id),
              title: node.title || '',
              path: path
            });
          }
        }

        // Recurse into children. The synthetic root (id "0") is a transparent
        // container whose own (empty) title is not a real path segment, so its
        // children's paths begin at the shared parent path; standard root
        // containers (1/2/3) still contribute their title as a path segment.
        if (node.children && node.children.length) {
          walk(node.children, String(node.id) === '0' ? parentPath : path);
        }
      }
    }

    function scanForLeaf(node) {
      if (!node.children) { return false; }
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (!c) { continue; }
        if (typeof c.url === 'string' && c.url) { return true; }
        if (Object.prototype.hasOwnProperty.call(c, 'children') && scanForLeaf(c)) { return true; }
      }
      return false;
    }

    walk(tree, []);

    // Only keep merge buckets with more than one folder (a real merge candidate).
    var sameNameMergeGroups = [];
    for (var j = 0; j < bucketOrder.length; j++) {
      var bk = mergeBuckets[bucketOrder[j]];
      bk.folders.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      if (bk.folders.length < 2) { continue; }
      sameNameMergeGroups.push({
        parentPath: bk.parentPath,
        name: bk.name,
        count: bk.folders.length,
        displayName: bk.__rawName,
        folders: bk.folders
      });
    }
    sameNameMergeGroups.sort(function (a, b) {
      return JSON.stringify(a.parentPath) < JSON.stringify(b.parentPath) ? -1 :
        JSON.stringify(a.parentPath) > JSON.stringify(b.parentPath) ? 1 :
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });

    emptyFolders.sort(function (a, b) {
      return JSON.stringify(a.path) < JSON.stringify(b.path) ? -1 :
        JSON.stringify(a.path) > JSON.stringify(b.path) ? 1 :
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

    return {
      emptyFolders: emptyFolders,
      sameNameMergeGroups: sameNameMergeGroups
    };
  }

  return {
    isSoftDeleted: isSoftDeleted,
    normalizeFolderName: normalizeFolderName,
    isBuiltInRootNode: isBuiltInRootNode,
    computeDuplicateGroups: computeDuplicateGroups,
    analyzeFolders: analyzeFolders
  };
});
