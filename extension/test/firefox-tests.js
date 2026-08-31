/**
 * Firefox 121+ background.scripts tests (no Chrome).
 *
 * Validates:
 *   1. manifest.json declares background.scripts with the exact ordered list
 *      of shared modules followed by the service-worker entrypoint;
 *   2. the service-worker entrypoint guards importScripts so it does not
 *      re-import when globals are already present (Firefox classic-script
 *      loading path);
 *   3. simulating the Firefox classic-script load order (shared modules first,
 *      then the entrypoint) registers the expected listeners and handles a
 *      scan-now request through MockChrome.
 *
 * Run: node test/firefox-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
let pending = 0;
let finished = false;

function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

function finish() {
  if (finished) return;
  finished = true;
  console.log(failures === 0 ? 'firefox tests OK' : 'firefox tests FAILED (' + failures + ')');
  process.exitCode = failures > 0 ? 1 : 0;
}

function trackAsync() {
  pending++;
  return function settle() {
    pending--;
    if (pending === 0) finish();
  };
}

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// ---- Part 1: manifest background.scripts declaration -----------------------
console.log('[Part 1] manifest background.scripts');

const expectedScripts = [
  'shared/constants.js',
  'shared/normalize.js',
  'shared/categorize.js',
  'shared/cleanup.js',
  'shared/backup.js',
  'shared/link-checker.js',
  'shared/report.js',
  'shared/trash.js',
  'shared/messaging.js',
  'shared/scan-controller.js',
  'background/service-worker.js'
];

check('manifest has background.scripts array',
  Array.isArray(manifest.background && manifest.background.scripts),
  'type=' + typeof (manifest.background && manifest.background.scripts));

check('background.scripts length matches expected (' + expectedScripts.length + ')',
  manifest.background.scripts && manifest.background.scripts.length === expectedScripts.length,
  'got=' + (manifest.background.scripts && manifest.background.scripts.length));

check('background.service_worker is still present for Chromium',
  manifest.background && manifest.background.service_worker === 'background/service-worker.js',
  'got=' + (manifest.background && manifest.background.service_worker));

for (let i = 0; i < expectedScripts.length; i++) {
  check('background.scripts[' + i + '] === ' + expectedScripts[i],
    manifest.background.scripts[i] === expectedScripts[i],
    'got=' + JSON.stringify(manifest.background.scripts[i]));
}

// Verify every file in the scripts array actually exists on disk.
for (const rel of manifest.background.scripts) {
  check('file exists: ' + rel, fs.existsSync(path.join(root, rel)), '');
}

// ---- Part 2: importScripts guard in service-worker.js ----------------------
console.log('[Part 2] importScripts guard');

const swSource = fs.readFileSync(path.join(root, 'background', 'service-worker.js'), 'utf8');
check('service-worker.js contains typeof BRConstants guard',
  /typeof\s+BRConstants\s*===\s*['"]undefined['"]/.test(swSource),
  '');
check('service-worker.js still has importScripts call inside the guard',
  /importScripts\(/.test(swSource),
  '');

// ---- Part 3: simulated Firefox classic-script loading ----------------------
// In Firefox, background.scripts loads each file as a classic script in order.
// The shared modules set globals (BRConstants, BRScan, etc.) on self/globalThis.
// Then service-worker.js runs and sees those globals, skipping importScripts.
// We simulate this by evaluating each shared module in a vm.Context that
// accumulates globals, then evaluating the entrypoint and verifying listeners.
console.log('[Part 3] simulated Firefox classic-script loading');

// Build a sandbox that mimics the Firefox background-script global scope.
const listeners = { alarms: [], installed: [], message: [] };
const sandbox = {
  self: undefined, // filled below
  globalThis: undefined, // filled below
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  URL: URL,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Object: Object,
  Array: Array,
  Promise: Promise,
  Error: Error,
  RegExp: RegExp,
  String: String,
  Number: Number,
  Boolean: Boolean,
  Map: Map,
  Set: Set,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  isFinite: isFinite,
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
  Infinity: Infinity,
  NaN: NaN,
  undefined: undefined
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

// Mock chrome APIs for the entrypoint.
const mockStorage = {};
sandbox.chrome = {
  bookmarks: {
    getTree: function () { return Promise.resolve([{ id: '0', title: '', children: [] }]); }
  },
  storage: {
    local: {
      get: function (keys) {
        if (keys === null || keys === undefined) { return Promise.resolve(Object.assign({}, mockStorage)); }
        var arr = Array.isArray(keys) ? keys : [keys];
        var out = {};
        arr.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(mockStorage, k)) { out[k] = mockStorage[k]; }
        });
        return Promise.resolve(out);
      },
      set: function (obj) {
        Object.keys(obj).forEach(function (k) { mockStorage[k] = JSON.parse(JSON.stringify(obj[k])); });
        return Promise.resolve();
      }
    }
  },
  alarms: {
    create: function (name) { listeners.alarms.push({ action: 'create', name: name }); },
    clear: function (name, cb) { listeners.alarms.push({ action: 'clear', name: name }); if (cb) { cb(); } },
    onAlarm: {
      addListener: function (fn) { listeners.alarms.push({ action: 'register', fn: fn }); }
    }
  },
  runtime: {
    id: 'test-extension-id',
    getURL: function (p) { return 'moz-extension://test/' + p; },
    sendMessage: function () { return Promise.resolve(); },
    onInstalled: {
      addListener: function (fn) { listeners.installed.push({ action: 'register', fn: fn }); }
    },
    onMessage: {
      addListener: function (fn) { listeners.message.push({ action: 'register', fn: fn }); }
    }
  },
  i18n: {
    getMessage: function (key) {
      if (key === 'extensionName') { return 'Salvage'; }
      return '';
    }
  },
  permissions: {
    contains: function () { return Promise.resolve(false); }
  }
};

const ctx = vm.createContext(sandbox);

// Load shared modules in order (simulating Firefox background.scripts loading).
const sharedModules = expectedScripts.slice(0, -1); // all except service-worker.js
for (const mod of sharedModules) {
  const src = fs.readFileSync(path.join(root, mod), 'utf8');
  vm.runInContext(src, ctx, { filename: mod });
}

// Verify globals are set after shared module loading.
check('BRConstants is defined after shared module loading',
  vm.runInContext('typeof BRConstants', ctx) === 'object', '');
check('BRScan is defined after shared module loading',
  vm.runInContext('typeof BRScan', ctx) === 'object', '');
check('BRBackup is defined after shared module loading',
  vm.runInContext('typeof BRBackup', ctx) === 'object', '');
check('BRLinks is defined after shared module loading',
  vm.runInContext('typeof BRLinks', ctx) === 'object', '');
check('BRTrash is defined after shared module loading',
  vm.runInContext('typeof BRTrash', ctx) === 'object', '');
check('BRMessaging is defined after shared module loading',
  vm.runInContext('typeof BRMessaging', ctx) === 'object', '');

// Now load the entrypoint. Because BRConstants is already defined, the
// importScripts guard should skip re-importing.
const swSrc = fs.readFileSync(path.join(root, 'background', 'service-worker.js'), 'utf8');
vm.runInContext(swSrc, ctx, { filename: 'background/service-worker.js' });

// Verify listeners were registered.
check('chrome.alarms.onAlarm listener registered',
  listeners.alarms.some(function (e) { return e.action === 'register'; }),
  'alarms entries=' + listeners.alarms.length);
check('chrome.runtime.onInstalled listener registered',
  listeners.installed.some(function (e) { return e.action === 'register'; }),
  'installed entries=' + listeners.installed.length);
check('chrome.runtime.onMessage listener registered',
  listeners.message.some(function (e) { return e.action === 'register'; }),
  'message entries=' + listeners.message.length);

// ---- Part 4: scan-now message through the Firefox-loaded entrypoint --------
console.log('[Part 4] scan-now message handling');

// Find the onMessage listener and invoke it with a scan-now message.
var messageListener = listeners.message.find(function (e) { return e.action === 'register'; });
check('message listener found', !!messageListener, '');

if (messageListener) {
  var settle4 = trackAsync();
  var scanResponse = null;
  var scanDone = false;
  var sender = { id: 'test-extension-id' };
  var sendResponse = function (resp) {
    scanResponse = resp;
    scanDone = true;
  };

  // The listener returns true for async responses; we need to wait.
  var returned = messageListener.fn(
    { type: 'scan-now' },
    sender,
    sendResponse
  );
  check('scan-now listener returns true (async response)', returned === true, 'returned=' + returned);

  // Wait for the async scan to complete.
  var waitStart = Date.now();
  var waitMs = 5000;
  function pollScan() {
    if (scanDone) {
      check('scan-now received a response', scanResponse != null, '');
      if (scanResponse != null) {
        check('scan-now response ok is true (empty tree succeeds)',
          scanResponse.ok === true,
          'ok=' + scanResponse.ok);
      }
      settle4();
      return;
    }
    if (Date.now() - waitStart > waitMs) {
      check('scan-now response received within timeout', false,
        'timed out after ' + waitMs + 'ms');
      settle4();
      return;
    }
    setTimeout(pollScan, 50);
  }
  // Give the microtask queue a tick before polling.
  setTimeout(pollScan, 10);
}

// ---- Part 5: scan-status message through Firefox-loaded entrypoint ---------
console.log('[Part 5] scan-status message handling');

if (messageListener) {
  var settle5 = trackAsync();
  var statusResponse = null;
  var statusDone = false;
  var statusSender = { id: 'test-extension-id' };
  var statusSendResponse = function (resp) {
    statusResponse = resp;
    statusDone = true;
  };

  var statusReturned = messageListener.fn(
    { type: 'scan-status' },
    statusSender,
    statusSendResponse
  );
  check('scan-status listener returns true (async response)', statusReturned === true,
    'returned=' + statusReturned);

  var statusWaitStart = Date.now();
  function pollStatus() {
    if (statusDone) {
      check('scan-status received a response', statusResponse != null, '');
      if (statusResponse != null) {
        check('scan-status response ok is true', statusResponse.ok === true,
          'ok=' + statusResponse.ok);
      }
      settle5();
      return;
    }
    if (Date.now() - statusWaitStart > 3000) {
      check('scan-status response received within timeout', false, 'timed out');
      settle5();
      return;
    }
    setTimeout(pollStatus, 50);
  }
  setTimeout(pollStatus, 10);
}

// ---- Summary ---------------------------------------------------------------
// If no async work was scheduled (messageListener missing), finish immediately.
// Otherwise finish() is called by the last settle callback.
if (pending === 0) finish();
