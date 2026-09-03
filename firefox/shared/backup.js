/**
 * Backup export — pure logic.
 *
 * Builds a restorable, versioned JSON export of the full bookmark tree.
 * The export is generated from `chrome.bookmarks.getTree()` output (the tree
 * is supplied by the caller) and is always a complete export — it is never
 * partial and never gated behind any other action or tier.
 *
 * The JSON shape carries a schema name and version plus an exportedAt stamp
 * so a future restore path (and the trash/undo recovery model) can validate
 * and interpret it. This module is pure and chrome-free for testability.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants'));
  } else {
    root.BRBackup = factory(root.BRConstants);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (constants) {
  'use strict';

  var BACKUP_SCHEMA = constants.BACKUP_SCHEMA;
  var BACKUP_VERSION = constants.BACKUP_VERSION;

  /**
   * Build the serializable backup object.
   *
   * @param {Array<object>} tree full chrome.bookmarks.getTree() output
   * @param {number} now epoch ms for the exportedAt stamp (injected for tests)
   * @returns {object} { schema, version, exportedAt, tree }
   */
  function buildBackup(tree, now) {
    return {
      schema: BACKUP_SCHEMA,
      version: BACKUP_VERSION,
      exportedAt: typeof now === 'number' ? new Date(now).toISOString() : new Date().toISOString(),
      tree: tree || []
    };
  }

  /**
   * Serialize a backup object to a JSON string (pretty-printed for humans and
   * diff-ability). Deterministic given the object.
   */
  function serializeBackup(backup) {
    return JSON.stringify(backup, null, 2);
  }

  /**
   * Validate that a parsed backup object has the expected shape (schema +
   * version + a tree array). Used by tests and a future restore path. It does
   * not attempt a full schema validation — it checks the structural contract.
   */
  function isValidBackup(obj) {
    return !!obj &&
      obj.schema === BACKUP_SCHEMA &&
      typeof obj.version === 'number' &&
      Array.isArray(obj.tree);
  }

  return {
    buildBackup: buildBackup,
    serializeBackup: serializeBackup,
    isValidBackup: isValidBackup
  };
});
