/**
 * Branding split tests (no Chrome).
 *
 * Verifies the Step 2 branding split, per BRAND-PACK.md §12: the SHORT product
 * name ("Salvage") stays the single, user-visible product name in the UI and
 * report copy — read through chrome.i18n.getMessage('extensionName') — while a
 * separate, keyword-bearing extensionListingTitle ("Salvage — Clean Up
 * Duplicate & Broken Bookmarks") is carried ONLY by the manifest `name` field
 * for the Chrome Web Store listing surface.
 *
 * Run: node test/branding-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

// ---- Load facts once --------------------------------------------------------
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const messages = JSON.parse(
  fs.readFileSync(path.join(root, '_locales', 'en', 'messages.json'), 'utf8'));

const SHORT = 'Salvage';
// Em dash (U+2014) exactly as written in BRAND-PACK.md §12.
const LISTING = 'Salvage \u2014 Clean Up Duplicate & Broken Bookmarks';

console.log('[manifest] branding split');
check('manifest name references the listing title key',
  manifest.name === '__MSG_extensionListingTitle__', 'name=' + manifest.name);
check('manifest action.default_title references the short name key',
  manifest.action && manifest.action.default_title === '__MSG_extensionName__',
  'default_title=' + (manifest.action && manifest.action.default_title));
check('manifest name key differs from the action title key',
  manifest.name !== (manifest.action && manifest.action.default_title),
  'name=' + manifest.name + ' default_title=' + (manifest.action && manifest.action.default_title));

console.log('[messages] localization keys exist');
check('extensionName key exists', messages.extensionName && typeof messages.extensionName.message === 'string', '');
check('extensionListingTitle key exists', messages.extensionListingTitle && typeof messages.extensionListingTitle.message === 'string', '');
check('extensionDescription key exists', messages.extensionDescription && typeof messages.extensionDescription.message === 'string', '');

console.log('[messages] short vs listing title exactness + distinctness');
check('extensionName message is exactly the short name', messages.extensionName.message === SHORT,
  JSON.stringify(messages.extensionName.message));
check('extensionListingTitle message is exactly the listing title', messages.extensionListingTitle.message === LISTING,
  JSON.stringify(messages.extensionListingTitle.message));
check('short and listing title are distinct',
  messages.extensionName.message !== messages.extensionListingTitle.message, '');
check('listing title embeds the short name as its prefix',
  messages.extensionListingTitle.message.indexOf(SHORT) === 0, '');

// ---- Mocked chrome.i18n: PRODUCT_NAME resolves to the SHORT name -------------
// constants.js reads the literal through chrome.i18n.getMessage('extensionName')
// when the runtime exposes chrome.i18n (the extension path). Load a fresh copy
// under a mocked chrome so the Node fallback is never taken, then assert
// PRODUCT_NAME and the report/UI copy use the SHORT name, never the title.
console.log('[constants] PRODUCT_NAME resolves to the short name (mocked chrome.i18n)');
function loadConstantsWithMock(getMessageImpl) {
  const cjs = path.join(root, 'shared', 'constants.js');
  const resolved = require.resolve(cjs);
  delete require.cache[resolved];
  const prev = global.chrome;
  global.chrome = { i18n: { getMessage: getMessageImpl } };
  try {
    return require(cjs);
  } finally {
    if (prev === undefined) { delete global.chrome; } else { global.chrome = prev; }
  }
}

const requested = [];
const mockGetMessage = (key) => {
  requested.push(key);
  // Only the short name is ever requested by constants.js; the listing title is
  // a store-surface concern that in-UI/report copy never reads.
  if (key === 'extensionName') { return SHORT; }
  return undefined;
};
const c = loadConstantsWithMock(mockGetMessage);
check('PRODUCT_NAME === short name export', c.PRODUCT_NAME === SHORT, 'got ' + c.PRODUCT_NAME);
check('COPY.appName === short name', c.COPY.appName === SHORT, 'got ' + c.COPY.appName);
check('COPY.pageTitle === short name', c.COPY.pageTitle === SHORT, 'got ' + c.COPY.pageTitle);
check('constants requested ONLY the short key (never the listing title)',
  requested.indexOf('extensionName') !== -1 && requested.indexOf('extensionListingTitle') === -1,
  'calls=' + JSON.stringify(requested));

console.log('[report copy] popup/report copy uses the short name, not the listing title');
const line = c.COPY.libraryLine(3142, 9);
check('libraryLine embeds the short name', line.indexOf(SHORT) !== -1, line);
check('libraryLine never embeds the listing title',
  line.indexOf(LISTING) === -1 && line.indexOf('Clean Up Duplicate') === -1, line);
check('anonymousPageTitle prefixes the short name',
  c.COPY.anonymousPageTitle === 'Bookmarks for ' + SHORT, c.COPY.anonymousPageTitle);
check('popup title line uses the short name, not the listing title',
  c.COPY.appName + ' \u2014 ' + 'Filtered list' === SHORT + ' \u2014 ' + 'Filtered list', '');

console.log('[report copy] the listing title is not a report/UI copy value');
const leaked = Object.keys(c.COPY).filter(
  (k) => typeof c.COPY[k] === 'string' && c.COPY[k] === LISTING);
check('no string copy value equals the listing title', leaked.length === 0,
  'keys=' + JSON.stringify(leaked));

// ---- Firefox cross-browser compatibility ------------------------------------
// MDN recommends specifying both "scripts" and "service_worker" in the
// background key for cross-browser MV3 support. Chrome uses service_worker;
// Firefox (121+) ignores service_worker and uses scripts. A single manifest
// works in both browsers without a separate build path.
console.log('[manifest] Firefox cross-browser background support');
check('manifest_version is 3', manifest.manifest_version === 3, 'got ' + manifest.manifest_version);
check('background.scripts is present (for Firefox)',
  Array.isArray(manifest.background && manifest.background.scripts) &&
  manifest.background.scripts.length > 0, '');
check('background.service_worker is present (for Chrome)',
  typeof (manifest.background && manifest.background.service_worker) === 'string' &&
  manifest.background.service_worker.length > 0, '');
check('background.scripts and service_worker point to the same file',
  manifest.background.scripts[0] === manifest.background.service_worker,
  'scripts=' + (manifest.background && manifest.background.scripts && manifest.background.scripts[0]) +
  ' service_worker=' + (manifest.background && manifest.background.service_worker));
check('browser_specific_settings.gecko.id is set (AMO requirement)',
  typeof (manifest.browser_specific_settings && manifest.browser_specific_settings.gecko &&
    manifest.browser_specific_settings.gecko.id) === 'string' &&
  manifest.browser_specific_settings.gecko.id.length > 0,
  'id=' + (manifest.browser_specific_settings && manifest.browser_specific_settings.gecko &&
    manifest.browser_specific_settings.gecko.id));
check('gecko strict_min_version >= 121 (service_worker ignored from 121)',
  (() => {
    const raw = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko &&
      manifest.browser_specific_settings.gecko.strict_min_version;
    if (typeof raw !== 'string') { return false; }
    const major = parseInt(raw.split('.')[0], 10);
    return Number.isFinite(major) && major >= 121;
  })(),
  'min=' + (manifest.browser_specific_settings && manifest.browser_specific_settings.gecko &&
    manifest.browser_specific_settings.gecko.strict_min_version));
check('all required permissions are declared',
  Array.isArray(manifest.permissions) &&
  ['bookmarks', 'storage', 'alarms', 'activeTab'].every((p) => manifest.permissions.indexOf(p) !== -1),
  'permissions=' + JSON.stringify(manifest.permissions));
check('optional_host_permissions is present for link checking',
  Array.isArray(manifest.optional_host_permissions) &&
  manifest.optional_host_permissions.indexOf('<all_urls>') !== -1, '');

// Verify the background script file exists and uses importScripts (works in both
// service worker and Firefox event page contexts).
const bgPath = path.join(root, 'background', 'service-worker.js');
const bgSrc = fs.readFileSync(bgPath, 'utf8');
check('background script uses importScripts (works in both Chrome SW and Firefox event page)',
  /importScripts\s*\(/.test(bgSrc), '');

// ---- Firefox event-page compatibility assertions ----------------------------
// Firefox MV3 (121+) runs background.scripts as an event page, not a service
// worker. The code must avoid service-worker-only APIs and lifecycle
// assumptions. These assertions guard against accidental introduction of
// incompatible patterns.
console.log('[background] Firefox event-page compatibility');

// Collect source of all modules loaded by importScripts so we can scan them
// for incompatible patterns.
const importScriptModules = [];
const importMatch = bgSrc.match(/importScripts\s*\(([\s\S]*?)\)/);
if (importMatch) {
  const entries = importMatch[1].split(',');
  for (const entry of entries) {
    const trimmed = entry.trim().replace(/['"]/g, '');
    if (trimmed) {
      const modPath = path.join(root, 'background', trimmed);
      if (fs.existsSync(modPath)) {
        importScriptModules.push({ rel: trimmed, src: fs.readFileSync(modPath, 'utf8') });
      } else {
        // ../shared/... relative to background/
        const altPath = path.join(root, trimmed);
        if (fs.existsSync(altPath)) {
          importScriptModules.push({ rel: trimmed, src: fs.readFileSync(altPath, 'utf8') });
        }
      }
    }
  }
}

const allBgSrc = bgSrc + '\n' + importScriptModules.map((m) => m.src).join('\n');

// 1. No service-worker-only global APIs
check('no self.skipWaiting (SW-only)', !/\bself\.skipWaiting\b/.test(allBgSrc), '');
check('no self.clients (SW-only)', !/\bself\.clients\b/.test(allBgSrc), '');
check('no self.registration (SW-only)', !/\bself\.registration\b/.test(allBgSrc), '');

// 2. No service-worker lifecycle event listeners
check('no addEventListener("activate"', !/addEventListener\s*\(\s*['"]activate['"]/.test(allBgSrc), '');
check('no addEventListener("install"', !/addEventListener\s*\(\s*['"]install['"]/.test(allBgSrc), '');
check('no addEventListener("fetch"', !/addEventListener\s*\(\s*['"]fetch['"]/.test(allBgSrc), '');

// 3. State is persisted in chrome.storage (not relying on SW global scope survival)
check('background uses chrome.storage for persistence',
  /chrome\.storage\.local\.(get|set)\b/.test(allBgSrc), '');

// 4. Alarms are used for wake/scheduling (event-page-compatible keepalive pattern)
check('background uses chrome.alarms for scheduling (event-page wake pattern)',
  /chrome\.alarms\.(create|clear|onAlarm)\b/.test(allBgSrc), '');

// 5. Event listeners use chrome.runtime.on* (available in both SW and event page)
check('background registers onInstalled listener',
  /chrome\.runtime\.onInstalled\.addListener/.test(bgSrc), '');
check('background registers onMessage listener',
  /chrome\.runtime\.onMessage\.addListener/.test(bgSrc), '');
check('background registers onAlarm listener',
  /chrome\.alarms\.onAlarm\.addListener/.test(bgSrc), '');

console.log(failures === 0 ? 'branding OK' : 'branding FAILED (' + failures + ')');
process.exitCode = failures > 0 ? 1 : 0;
