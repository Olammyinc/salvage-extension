/**
 * Firefox separate-package tests.
 *
 * Validates:
 *   1. Chrome manifest (extension/) has NO background.scripts — only
 *      background.service_worker.
 *   2. Firefox manifest (firefox/) declares background.scripts with the exact
 *      ordered list of shared modules followed by the service-worker
 *      entrypoint; has NO background.service_worker; has NO gecko_id / AMO
 *      config.
 *   3. Every runtime file referenced by the Firefox manifest and popup exists
 *      on disk under firefox/.
 *   4. The service-worker entrypoint guards importScripts so it does not
 *      re-import when globals are already present (Firefox classic-script
 *      loading path).
 *   5. Simulating the Firefox classic-script load order (shared modules first,
 *      then the entrypoint) registers the expected listeners and handles a
 *      scan-now request through MockChrome.
 *   6. Deterministic mirror-sync: every runtime file in firefox/ that is NOT
 *      the manifest must be byte-identical to its extension/ counterpart.
 *      Only the manifest background key difference is permitted.
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

const extensionRoot = path.join(__dirname, '..');
const firefoxRoot = path.join(extensionRoot, '..', 'firefox');

// ---- Part 1: Chrome manifest rejects background.scripts --------------------
console.log('[Part 1] Chrome manifest has no background.scripts');

const chromeManifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));

check('Chrome manifest has background.service_worker',
  chromeManifest.background && chromeManifest.background.service_worker === 'background/service-worker.js',
  'got=' + (chromeManifest.background && chromeManifest.background.service_worker));

check('Chrome manifest has NO background.scripts',
  !chromeManifest.background || !Array.isArray(chromeManifest.background.scripts),
  'got=' + typeof (chromeManifest.background && chromeManifest.background.scripts));

// ---- Part 2: Firefox manifest background.scripts declaration ---------------
console.log('[Part 2] Firefox manifest background.scripts');

const firefoxManifest = JSON.parse(fs.readFileSync(path.join(firefoxRoot, 'manifest.json'), 'utf8'));

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

check('Firefox manifest has background.scripts array',
  Array.isArray(firefoxManifest.background && firefoxManifest.background.scripts),
  'type=' + typeof (firefoxManifest.background && firefoxManifest.background.scripts));

check('Firefox background.scripts length matches expected (' + expectedScripts.length + ')',
  firefoxManifest.background.scripts && firefoxManifest.background.scripts.length === expectedScripts.length,
  'got=' + (firefoxManifest.background.scripts && firefoxManifest.background.scripts.length));

check('Firefox manifest has NO background.service_worker',
  !firefoxManifest.background || firefoxManifest.background.service_worker === undefined,
  'got=' + (firefoxManifest.background && firefoxManifest.background.service_worker));

check('Firefox manifest has NO persistent flag',
  !firefoxManifest.background || firefoxManifest.background.persistent === undefined,
  'got=' + (firefoxManifest.background && firefoxManifest.background.persistent));

check('Firefox manifest has NO browser_specific_settings.gecko',
  !firefoxManifest.browser_specific_settings || !firefoxManifest.browser_specific_settings.gecko,
  'found gecko config');

for (let i = 0; i < expectedScripts.length; i++) {
  check('background.scripts[' + i + '] === ' + expectedScripts[i],
    firefoxManifest.background.scripts[i] === expectedScripts[i],
    'got=' + JSON.stringify(firefoxManifest.background.scripts[i]));
}

// Verify shared fields match Chrome.
check('Firefox version matches Chrome', firefoxManifest.version === chromeManifest.version,
  'firefox=' + firefoxManifest.version + ' chrome=' + chromeManifest.version);
check('Firefox name matches Chrome', firefoxManifest.name === chromeManifest.name,
  'firefox=' + firefoxManifest.name + ' chrome=' + chromeManifest.name);
check('Firefox permissions match Chrome',
  JSON.stringify(firefoxManifest.permissions) === JSON.stringify(chromeManifest.permissions),
  '');
check('Firefox icons match Chrome',
  JSON.stringify(firefoxManifest.icons) === JSON.stringify(chromeManifest.icons),
  '');
check('Firefox action.default_popup matches Chrome',
  firefoxManifest.action && firefoxManifest.action.default_popup === (chromeManifest.action && chromeManifest.action.default_popup),
  '');

// ---- Part 3: Firefox runtime file existence --------------------------------
console.log('[Part 3] Firefox runtime file existence');

// Every script in background.scripts must exist.
for (const rel of firefoxManifest.background.scripts) {
  check('firefox file exists: ' + rel, fs.existsSync(path.join(firefoxRoot, rel)), '');
}

// Popup files must exist.
const popupHtml = firefoxManifest.action && firefoxManifest.action.default_popup;
if (popupHtml) {
  check('firefox popup exists: ' + popupHtml, fs.existsSync(path.join(firefoxRoot, popupHtml)), '');
  // Parse popup HTML for script src references and verify they exist.
  const popupSrc = fs.readFileSync(path.join(firefoxRoot, popupHtml), 'utf8');
  const scriptSrcRe = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  while ((m = scriptSrcRe.exec(popupSrc)) !== null) {
    const scriptRel = m[1];
    check('firefox popup script exists: ' + scriptRel, fs.existsSync(path.join(firefoxRoot, scriptRel)), '');
  }
}

// rules-data.json must exist (loaded at runtime via fetch).
check('firefox shared/rules-data.json exists',
  fs.existsSync(path.join(firefoxRoot, 'shared', 'rules-data.json')), '');

// _locales must exist.
check('firefox _locales/en/messages.json exists',
  fs.existsSync(path.join(firefoxRoot, '_locales', 'en', 'messages.json')), '');

// Assets referenced by icons must exist.
const iconSizes = Object.keys(firefoxManifest.icons || {});
for (const size of iconSizes) {
  const iconPath = firefoxManifest.icons[size];
  check('firefox icon exists: ' + iconPath, fs.existsSync(path.join(firefoxRoot, iconPath)), '');
}

// ---- Part 4: importScripts guard in service-worker.js ----------------------
console.log('[Part 4] importScripts guard');

const swSource = fs.readFileSync(path.join(firefoxRoot, 'background', 'service-worker.js'), 'utf8');
check('service-worker.js contains typeof BRConstants guard',
  /typeof\s+BRConstants\s*===\s*['"]undefined['"]/.test(swSource),
  '');
check('service-worker.js still has importScripts call inside the guard',
  /importScripts\(/.test(swSource),
  '');

// ---- Part 5: simulated Firefox classic-script loading ----------------------
console.log('[Part 5] simulated Firefox classic-script loading');

const listeners = { alarms: [], installed: [], message: [] };
const sandbox = {
  self: undefined,
  globalThis: undefined,
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
  const src = fs.readFileSync(path.join(firefoxRoot, mod), 'utf8');
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

// Now load the entrypoint from firefox/. Because BRConstants is already
// defined, the importScripts guard should skip re-importing.
const swSrc = fs.readFileSync(path.join(firefoxRoot, 'background', 'service-worker.js'), 'utf8');
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

// ---- Part 6: scan-now message through Firefox-loaded entrypoint -------------
console.log('[Part 6] scan-now message handling');

var messageListener = listeners.message.find(function (e) { return e.action === 'register'; });
check('message listener found', !!messageListener, '');

if (messageListener) {
  var settle6 = trackAsync();
  var scanResponse = null;
  var scanDone = false;
  var sender = { id: 'test-extension-id' };
  var sendResponse = function (resp) {
    scanResponse = resp;
    scanDone = true;
  };

  var returned = messageListener.fn(
    { type: 'scan-now' },
    sender,
    sendResponse
  );
  check('scan-now listener returns true (async response)', returned === true, 'returned=' + returned);

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
      settle6();
      return;
    }
    if (Date.now() - waitStart > waitMs) {
      check('scan-now response received within timeout', false,
        'timed out after ' + waitMs + 'ms');
      settle6();
      return;
    }
    setTimeout(pollScan, 50);
  }
  setTimeout(pollScan, 10);
}

// ---- Part 7: scan-status message through Firefox-loaded entrypoint ----------
console.log('[Part 7] scan-status message handling');

if (messageListener) {
  var settle7 = trackAsync();
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
      settle7();
      return;
    }
    if (Date.now() - statusWaitStart > 3000) {
      check('scan-status response received within timeout', false, 'timed out');
      settle7();
      return;
    }
    setTimeout(pollStatus, 50);
  }
  setTimeout(pollStatus, 10);
}

// ---- Part 8: deterministic mirror-sync test --------------------------------
console.log('[Part 8] mirror-sync (firefox/ vs extension/)');

// Walk every file under firefox/ and compare to its extension/ counterpart.
// The ONLY permitted difference is manifest.json (background key).
function walkDir(dir, prefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      files.push.apply(files, walkDir(path.join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

const firefoxFiles = walkDir(firefoxRoot, '');
let mirrorDiverged = 0;

for (const rel of firefoxFiles) {
  const ffPath = path.join(firefoxRoot, rel);
  const extPath = path.join(extensionRoot, rel);

  if (rel === 'manifest.json') {
    // Manifest difference is intentional (background key). Verify the
    // non-background fields still match by comparing a normalized copy.
    const ffNorm = JSON.parse(JSON.stringify(firefoxManifest));
    const extNorm = JSON.parse(JSON.stringify(chromeManifest));
    delete ffNorm.background;
    delete extNorm.background;
    check('manifest non-background fields match',
      JSON.stringify(ffNorm) === JSON.stringify(extNorm),
      '');
    continue;
  }

  if (!fs.existsSync(extPath)) {
    check('mirror: firefox/' + rel + ' has counterpart in extension/', false,
      'missing in extension/');
    mirrorDiverged++;
    continue;
  }

  const ffContent = fs.readFileSync(ffPath);
  const extContent = fs.readFileSync(extPath);
  const identical = Buffer.compare(ffContent, extContent) === 0;
  check('mirror: firefox/' + rel + ' identical to extension/' + rel, identical,
    identical ? '' : 'files differ (' + ffContent.length + ' vs ' + extContent.length + ' bytes)');
  if (!identical) mirrorDiverged++;
}

check('mirror-sync: zero unintentional divergences', mirrorDiverged === 0,
  'diverged=' + mirrorDiverged);

// ---- Summary ---------------------------------------------------------------
if (pending === 0) finish();
