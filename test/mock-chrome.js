/**
 * Deterministic mock of the subset of the chrome.* APIs the scan uses.
 *
 * Drives the exact scan controller code path (the same code the extension
 * runs in a service worker) with an in-memory store and a fixture bookmark
 * tree, so the chunked/checkpointed/resumable logic can be verified without
 * Chrome.
 */
'use strict';

class MockChrome {
  constructor(fixtureTree) {
    this._tree = fixtureTree;
    this._storage = Object.create(null);   // localStorage-like flat store
    this._pendingAlarms = [];              // list of { name, whenMs } unscheduled wakes
    this._alarmCount = 0;
    this._now = Date.now();
    this.bookmarks = {
      getTree: () => Promise.resolve(this._tree)
    };
    this.storage = {
      local: {
        get: (keys) => {
          if (keys === null || keys === undefined) {
            const out = Object.assign({}, this._storage);
            return Promise.resolve(out);
          }
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          arr.forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(this._storage, k)) { out[k] = this._storage[k]; }
          });
          return Promise.resolve(out);
        },
        set: (obj) => {
          Object.keys(obj).forEach((k) => { this._storage[k] = JSON.parse(JSON.stringify(obj[k])); });
          return Promise.resolve();
        }
      }
    };
    this.runtime = {
      sendMessage: (msg) => Promise.resolve()
    };
  }

  /** chrome.alarms.create — record a wake but do not auto-fire. */
  createAlarm(name) {
    this._alarmCount += 1;
    this._pendingAlarms.push({
      name,
      whenMs: this._now + (1 * 60 * 1000)
    });
  }

  /** chrome.alarms.clear */
  clearAlarm(name) {
    this._pendingAlarms = this._pendingAlarms.filter((a) => a.name !== name);
    return Promise.resolve(true);
  }

  get pendingAlarms() { return this._pendingAlarms.length; }
  get alarmCount() { return this._alarmCount; }

  /** Expose the storage snapshot for assertions. */
  snapshot() {
    return JSON.parse(JSON.stringify(this._storage));
  }

  setNow(ms) { this._now = ms; }

  /** Build an injected `deps` object backed by this mock. */
  deps(extra) {
    return Object.assign({
      bookmarkApi: this.bookmarks,
      storageGet: (keys) => this.storage.local.get(keys),
      storageSet: (obj) => this.storage.local.set(obj),
      loadRules: () => Promise.resolve(require('../shared/rules-data.json')),
      scheduleWake: () => this.createAlarm('scanner-wake'),
      clearWake: () => this.clearAlarm('scanner-wake'),
      sendProgress: () => {},
      getNow: () => this._now
    }, extra || {});
  }

  /**
   * Fire any pending scanner alarms in chronological order, invoking the
   * listener exactly as chrome would. Returns number of alarms fired.
   */
  async fireWakes(onAlarm) {
    let fired = 0;
    while (this._pendingAlarms.length) {
      const alarms = this._pendingAlarms.slice().sort((a, b) => a.whenMs - b.whenMs);
      this._pendingAlarms = [];
      for (const a of alarms) {
        fired += 1;
        if (onAlarm) { await onAlarm(a); }
      }
    }
    return fired;
  }
}

module.exports = { MockChrome };
