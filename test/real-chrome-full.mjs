// Real-Chrome CDP benchmark for the Bookmark Rescue extension.
//
// This is a TEST tool, deliberately outside the production extension. It talks
// to a live Chrome via the DevTools Protocol (remote debugging on 9222 by
// default), builds a disposable bookmark tree, and measures the extension's
// real scan behaviour: wall-clock median over 3 scans, worker stop/resume,
// SHA-256 of the bookmark tree before/after, and network request accounting.
//
// The extension ID is NEVER hardcoded. It is discovered at runtime from the
// live Chrome CDP targets (the extension service worker or an extension page).
// If it cannot be discovered the tool fails with a clear diagnostic; it never
// falls back to a constant.
//
// MV3 architecture requires TWO CDP sessions (a direct navigation to the
// extension popup URL from a normal page yields chrome-error://chromewebdata
// and no chrome.bookmarks/storage/runtime APIs; extension pages are not
// directly navigable and popups are not web-accessible):
//
//   worker -- attached to the discovered extension service_worker target. All
//             extension-API Runtime.evaluate calls run here (getTree, storage,
//             runtime messages, permissions). Network is enabled here too so the
//             scan's real fetch traffic (to bookmarked URLs) is captured.
//
//   page   -- attached to a normal, non-extension page. Used ONLY for
//             Network.enable/request collection and for navigating
//             chrome://serviceworker-internals to Stop (and later Start) the
//             extension's service worker. No chrome.* calls are made here.
//
// The worker session is reconnected/resumed after the Stop test by a "Start"
// on the service-worker internals page and a fresh discovery of the
// service_worker target, because the previous worker websocket is gone once the
// worker terminates (MV3 workers stop and start lazily).
//
// A separate, strictly opt-in link-check measurement mode (`--check-links`)
// measures a 3,000-record link check AFTER permission is explicitly granted,
// records the exact three-state split, and selects at least 30 unreachable URLs
// for manual confirmation. It never fabricates a false-positive rate.

import { createHash } from 'crypto';

// Product name is only ever a comment or a doc string in this test tool. No
// product name is embedded in code or in any discovered value.

const DEFAULT_PORT = 9222;
const DEFAULT_OUTPUT = 'test/real-chrome-results.json';
const BOOKMARK_COUNT = 3050;
const DISCOVERY_WAIT_MS = 15000;
const POLL_INTERVAL_MS = 1000;
const CDP_TIMEOUT_MS = 300000;

// Known extension resource paths (from the manifest). Used only to recognise a
// live, loaded extension in CDP targets; the extension ID itself is dynamic.
const EXTENSION_PAGE_PATHS = [
  '/ui/popup.html',
  '/background/service-worker.js'
];

const HELP = `
Usage: node real-chrome-full.mjs [options]

Benchmarks the loaded Bookmark Rescue extension against a live Chrome that is
running with remote debugging enabled (e.g. --remote-debugging-port=9222).

The extension must be loaded unpacked (chrome://extensions -> Load unpacked ->
select bookmark/extension/). Because the extension ID is discovered at runtime
from live CDP targets, the extension's service worker (or an extension page,
e.g. an open popup) must be present in the target list; if it is not yet
running, this tool polls briefly and then fails with a clear diagnostic.

Architecture: this tool uses two CDP sessions. A "worker" session is attached to
the discovered extension service_worker target and carries ALL extension-API
Runtime.evaluate calls (chrome.bookmarks, storage, runtime messaging,
permissions). A second, normal "page" session is used only for Network
collection and for navigating chrome://serviceworker-internals to Stop (and
Start) the worker. Direct navigation to an extension popup URL is intentionally
NOT used: it yields chrome-error://chromewebdata and no extension APIs.

Options:
  --output <path>       JSON result artifact path (default: ${DEFAULT_OUTPUT}).
  --port <port>         Chrome remote debugging port (default: ${DEFAULT_PORT}).
  --extension-id <id>   Validate this extension ID is actually loaded and use
                        it. It still must be detected as a live CDP target;
                        it is never assumed silently.
  --check-links         Opt-in: also measure a 3,000-record link check after
                        explicitly requesting the <all_urls> host permission.
  --verify <json>       Path to a manual-verification response file used ONLY
                        with --check-links. Each entry:
                        { "confirmedDead": "true"|"false"|"unknown", "url": "..." }
                        The reported false-positive rate is computed only when
                        every selected unreachable URL is manually marked.
  -h, --help            Show this help.

Exit codes: 0 = pass, 1 = required checks failed or environment error.
`;

// ─── Argument parsing ────────────────────────────────────────
const args = process.argv.slice(2);
const cfg = {
  port: DEFAULT_PORT,
  output: DEFAULT_OUTPUT,
  extensionId: null,       // never a constant; only an explicitly validated value
  checkLinks: false,
  verify: null
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  else if (a === '--output') { cfg.output = args[++i]; }
  else if (a === '--port') { cfg.port = Number(args[++i]); }
  else if (a === '--extension-id') { cfg.extensionId = args[++i]; }
  else if (a === '--check-links') { cfg.checkLinks = true; }
  else if (a === '--verify') { cfg.verify = args[++i]; }
  else {
    console.error('Unrecognised argument: ' + a);
    console.error(HELP);
    process.exit(1);
  }
}

const CDP_ROOT = 'http://localhost:' + cfg.port;

// ─── Result accumulator ──────────────────────────────────────
const RESULTS = {
  tool: 'real-chrome-full',
  browserVersion: '',
  extensionId: null,
  extensionDiscovered: false,
  discoverySource: '',
  // The test profile is disposable: the tool clears and rebuilds a synthetic
  // bookmark tree before benchmarking. Any bookmove mutation here is test
  // SETUP, not scan mutation. The SHA-256 before/after comparison verifies the
  // SCAN does not mutate that disposable tree.
  testProfileDisposable: true,
  bookmarkCount: 0,
  bookmarksHashBefore: '',
  bookmarksHashAfter: '',
  bookmarksUnchanged: false,
  scans: [],
  scanMedianMs: 0,
  workerTest: { terminated: false, resumed: false, finalReportTotal: null, killConfirmed: false },
  networkRequests: { total: 0, toBookmarkedUrls: 0, localExtension: 0, other: [] },
  // ---- opt-in link-check section (only populated with --check-links) ----
  linkCheck: null,
  errors: []
};

// ─── CDP Client ─────────────────────────────────────────────
// A CdpSession owns one websocket to one CDP target. Command responses are
// matched to their promise by `id`; inbound events (`method`) are dispatched to
// per-method listeners registered with `.on()`. Each session installs exactly
// one 'message' handler, and re-attaching is a no-op if one already exists, so
// multiple sessions can route messages independently.
class CdpSession {
  constructor(label) {
    this.label = label;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map(); // method -> Set<handler(params, msg)>
    this.ws = null;
    this._handlerAttached = false;
  }

  async connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error('[' + this.label + '] WebSocket error: ' + (e && e.message ? e.message : 'unknown')));
    });
    this._handlerAttached = false;
    this._attachHandler();
  }

  _attachHandler() {
    if (this._handlerAttached || !this.ws) { return; }
    this._handlerAttached = true;
    this.ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg && typeof msg.id !== 'undefined') {
        const fn = this._pending.get(msg.id);
        if (fn) {
          this._pending.delete(msg.id);
          fn(msg);
        }
        return;
      }
      if (msg && typeof msg.method === 'string') {
        const set = this._listeners.get(msg.method);
        if (set && set.size) {
          for (const handler of [...set]) {
            try { handler(msg.params || {}, msg); } catch (e) { /* listener errors are non-fatal */ }
          }
        }
      }
    });
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const msgId = this._id++;
      const timer = setTimeout(() => { this._pending.delete(msgId); reject(new Error('[' + this.label + '] Timeout: ' + method)); }, timeoutMs);
      this._pending.set(msgId, (msg) => { clearTimeout(timer); resolve(msg); });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  eval(expr, awaitPromise = false, timeoutMs = CDP_TIMEOUT_MS) {
    return this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, timeoutMs);
  }

  on(method, handler) {
    if (!this._listeners.has(method)) { this._listeners.set(method, new Set()); }
    this._listeners.get(method).add(handler);
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Two live sessions, populated in main(). workerSession must be attached to the
// extension's service_worker target; pageSession to a normal, non-extension page.
let workerSession = null;
let pageSession = null;

// ─── CDP Target helpers ─────────────────────────────────────
async function listTargets() {
  const res = await fetch(CDP_ROOT + '/json/list');
  if (!res.ok) { throw new Error('CDP /json/list failed: HTTP ' + res.status); }
  return res.json();
}

function isExtensionTargetUrl(url) {
  return typeof url === 'string' && /^chrome-extension:\/\/([a-z]{32})\//.test(url);
}

async function findWorkerTarget() {
  const targets = await listTargets();
  return targets.find((t) => t.type === 'service_worker' && t.url && t.url.includes(RESULTS.extensionId)) || null;
}

// A normal (non-extension) page is required for the page session so that it can
// navigate chrome://serviceworker-internals (extension pages cannot). If no
// suitable target exists, a fresh tab is created via the CDP /json/new endpoint.
async function getOrCreatePageTarget() {
  let targets = await listTargets();
  let pt = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('chrome-extension://'))
    || targets.find((t) => t.type === 'page');
  if (pt) { return pt; }
  try {
    const res = await fetch(CDP_ROOT + '/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT' });
    if (res.ok) {
      const created = await res.json();
      if (created && created.type === 'page' && created.webSocketDebuggerUrl) { return created; }
    }
  } catch (e) { /* fall through */ }
  throw new Error('No normal page target available and could not create a tab over CDP. Open a normal tab in Chrome.');
}

/**
 * Discover the loaded extension's ID from live CDP targets. Never uses a
 * constant. Returns { extensionId, source } or throws with a clear diagnostic.
 */
async function discoverExtensionId(port, explicitId) {
  const deadline = Date.now() + DISCOVERY_WAIT_MS;
  let lastSeenExtensionIds = null;

  while (Date.now() < deadline) {
    let targets;
    try { targets = await listTargets(); }
    catch (err) { throw new Error('Cannot reach Chrome CDP at ' + CDP_ROOT + ' (' + err.message + '). Start Chrome with --remote-debugging-port=' + port + ' and load the extension unpacked.'); }

    const candidates = new Map(); // id -> { source, sampleUrl }
    for (const t of targets || []) {
      const m = isExtensionTargetUrl(t.url) ? /^chrome-extension:\/\/([a-z]{32})\//.exec(t.url) : null;
      if (!m) { continue; }
      const id = m[1];
      const sampleUrl = t.url.split('/').slice(0, 3).join('/');
      if (!candidates.has(id) || t.type === 'service_worker') {
        candidates.set(id, { source: t.type, url: sampleUrl });
      }
    }

    // Strong identification: a target whose URL is one of our known paths.
    let strong = null;
    for (const t of targets || []) {
      const m = isExtensionTargetUrl(t.url) ? /^chrome-extension:\/\/([a-z]{32})\//.exec(t.url) : null;
      if (!m) { continue; }
      const rest = t.url.slice(m[0].length);
      if (EXTENSION_PAGE_PATHS.some((p) => rest.startsWith(p))) {
        strong = { extensionId: m[1], source: t.type };
        break;
      }
    }

    // If the CLI supplied an explicit ID it must still be validated as a live,
    // loaded extension; it is never assumed silently.
    if (explicitId) {
      if (strong && strong.extensionId === explicitId) {
        return { extensionId: explicitId, source: 'explicit-validated:' + strong.source };
      }
      if (candidates.has(explicitId)) {
        return { extensionId: explicitId, source: 'explicit-validated:' + candidates.get(explicitId).source };
      }
      throw new Error(
        'Extension ID "' + explicitId + '" was supplied but is not detected as a loaded extension in live CDP targets. ' +
        'Candidates: ' + (candidates.size ? [...candidates.keys()].join(', ') : 'none') +
        '. Load the extension unpacked and keep its service worker (or popup) alive, then retry.'
      );
    }

    if (strong) { return strong; }

    if (candidates.size === 1) {
      const only = [...candidates.entries()][0];
      return { extensionId: only[0], source: only[1].source };
    }

    if (candidates.size > 1) {
      // Ambiguous: fail rather than guess.
      throw new Error(
        'Multiple loaded extensions discovered in CDP targets (' + [...candidates.keys()].join(', ') + ') ' +
        'and none matches a known Bookmark Rescue resource path. Close other extensions or pass --extension-id to select one.'
      );
    }

    lastSeenExtensionIds = candidates;
    await sleep(POLL_INTERVAL_MS);
  }

  // Nothing found after the wait. Note: if we saw service-worker/extension
  // targets that weren't clearly ours, keep that diagnostic; otherwise explain
  // how to make the extension discoverable.
  if (lastSeenExtensionIds && lastSeenExtensionIds.size > 0) {
    throw new Error(
      'Saw extension CDP target(s) but none matched a Bookmark Rescue resource path (' +
      [...lastSeenExtensionIds.values()].map((v) => v.url).join(', ') + '). ' +
      'Ensure the unpacked extension from bookmark/extension/ is the loaded one.'
    );
  }
  throw new Error(
    'No loaded extension detected in Chrome CDP targets within ' + (DISCOVERY_WAIT_MS / 1000) + 's. ' +
    'To use this tool: (1) start Chrome with --remote-debugging-port=' + port + ', ' +
    '(2) open chrome://extensions, enable Developer mode, Load unpacked and select bookmark/extension/, ' +
    '(3) open the extension popup once (or let its scan start) so the service worker target appears in the CDP target list. ' +
    'The extension ID is discovered at runtime and is never hardcoded.'
  );
}

// ─── Network Collector ──────────────────────────────────────
const allNetworkRequests = [];
const bookmarkUrls = new Set();

// Installed on both sessions. The worker session carries the scan's actual
// fetch traffic to bookmarked URLs; the page session (per the two-session
// design) is the Network collection surface too.
function installNetworkCollector(session) {
  session.on('Network.requestWillBeSent', (params) => {
    const url = params?.request?.url || '';
    allNetworkRequests.push({ url, timestamp: params?.timestamp || 0 });
  });
}

async function enableNetworkOn(session) {
  await session.send('Network.enable');
  installNetworkCollector(session);
}

// ─── Session plumbing (all extension APIs go through the worker session) ──
async function connectWorkerSession(wsUrl) {
  const s = new CdpSession('worker');
  await s.connect(wsUrl);
  await s.send('Runtime.enable');
  await enableNetworkOn(s);
  return s;
}

async function connectPageSession() {
  const target = await getOrCreatePageTarget();
  const s = new CdpSession('page');
  await s.connect(target.webSocketDebuggerUrl);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await enableNetworkOn(s);
  return { session: s, target };
}

async function waitForWorkerTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await findWorkerTarget().catch(() => null);
    if (t) { return t; }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

// Reconnect the worker session to a freshly (re)spawned service_worker target.
// Closes any previous worker websocket first; harmless if it is already dead
// (worker was stopped). Returns true on success.
async function reconnectWorkerSession() {
  if (workerSession) { workerSession.close(); workerSession = null; }
  const target = await waitForWorkerTarget(10000);
  if (!target) { return false; }
  workerSession = await connectWorkerSession(target.webSocketDebuggerUrl);
  return true;
}

// Best-effort wake of a stopped/idle MV3 service worker using the service-worker
// internals page on the page session ("Start"/"Update" button). This stays
// within the page session's role (navigating chrome://serviceworker-internals).
async function wakeWorkerViaInternalsPage() {
  if (!pageSession) { return; }
  try {
    await pageSession.send('Page.navigate', { url: 'chrome://serviceworker-internals' });
    await sleep(2000);
    await pageSession.eval(`
      (function() {
        const id = '${RESULTS.extensionId}';
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
          const text = row.textContent || '';
          if (text.includes(id)) {
            const buttons = row.querySelectorAll('button');
            for (const btn of buttons) {
              const t = (btn.textContent || '').toLowerCase();
              if ((t === 'start' || t.includes('start')) || (t === 'update' || t.includes('update'))) {
                btn.click();
                return 'Clicked wake: ' + btn.textContent;
              }
            }
            return 'Row found but no start/update button. Buttons: ' + Array.from(buttons).map(b => b.textContent).join(', ');
          }
        }
        return 'Not found by id on internals page. Total rows: ' + rows.length;
      })()
    `);
  } catch (e) { return; }
}

// ─── Bookmark Helpers (run inside the extension service-worker context) ────
async function getBookmarkCount() {
  const r = await workerSession.eval(`
    new Promise(async (resolve) => {
      const tree = await chrome.bookmarks.getTree();
      let count = 0;
      (function walk(nodes) {
        for (const n of nodes) { if (n.children) walk(n.children); else count++; }
      })(tree);
      resolve(count);
    })
  `, true);
  return r.result?.result?.value ?? 0;
}

async function getBookmarkTreeJSON() {
  const r = await workerSession.eval(`
    new Promise(async (resolve) => {
      const tree = await chrome.bookmarks.getTree();
      resolve(JSON.stringify(tree));
    })
  `, true);
  return r.result?.result?.value || '';
}

async function clearAllBookmarks() {
  await workerSession.eval(`
    new Promise(async (resolve) => {
      const tree = await chrome.bookmarks.getTree();
      for (const root of tree[0].children || []) {
        if (root.children) {
          for (const child of [...root.children]) {
            await chrome.bookmarks.removeTree(child.id);
          }
        }
      }
      resolve('cleared');
    })
  `, true);
}

async function clearStorage() {
  await workerSession.eval(`
    new Promise(resolve => chrome.storage.local.clear(() => resolve('done')))
  `, true);
}

async function createBookmarks(count) {
  console.log(`  Creating ${count} bookmarks in batches of 100...`);
  const result = await workerSession.eval(`
    new Promise(async (resolve) => {
      const root = await chrome.bookmarks.create({ title: 'Test Tree' });
      const domains = [
        'example.com','test.org','demo.net','sample.io','archive.com',
        'docs.dev','code.run','app.cloud','web.page','site.info',
        'blog.com','news.org','shop.net','data.io','api.dev',
        'cache.com','mirror.org','proxy.net','link.io','url.dev',
        'ref.com','src.org','hub.net','lab.io','tool.dev',
        'util.com','base.org','core.net','next.io','fast.dev'
      ];
      const paths = [
        '/page','/article','/post','/entry','/item',
        '/resource','/content','/document','/file','/data',
        '/info','/details','/overview','/index','/list',
        '/view','/browse','/search','/archive','/collection'
      ];
      let created = 0;
      const BATCH = 100;
      for (let b = 0; b < Math.ceil(${count} / BATCH); b++) {
        const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Folder ' + b });
        const n = Math.min(BATCH, ${count} - b * BATCH);
        for (let i = 0; i < n; i++) {
          const idx = b * BATCH + i;
          await chrome.bookmarks.create({
            parentId: folder.id,
            title: 'Bookmark ' + idx,
            url: 'https://' + domains[idx % domains.length] + paths[idx % paths.length] + '/' + idx
          });
          created++;
        }
      }
      const tree = await chrome.bookmarks.getTree();
      let total = 0;
      (function walk(nodes) {
        for (const n of nodes) { if (n.children) walk(n.children); else total++; }
      })(tree);
      resolve(JSON.stringify({ created, total }));
    })
  `, true);
  return JSON.parse(result.result?.result?.value || '{"created":0,"total":0}');
}

// ─── Scan Runner ────────────────────────────────────────────
async function triggerScan() {
  return workerSession.eval(`
    new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'scan-now' }, resp => resolve(JSON.stringify(resp)));
    })
  `, true);
}

async function getScanStatus() {
  const r = await workerSession.eval(`
    new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'scan-status' }, resp => resolve(JSON.stringify(resp)));
    })
  `, true);
  return JSON.parse(r.result?.result?.value || '{}');
}

async function runScan(num, { killWorker = false } = {}) {
  console.log(`\n--- Scan ${num}${killWorker ? ' (WITH WORKER STOP)' : ''} ---`);

  await clearStorage();
  await sleep(500);

  const startMs = Date.now();
  console.log(`  Started: ${new Date(startMs).toISOString()}`);

  const trig = await triggerScan();
  console.log(`  Trigger response: ${trig.result?.result?.value}`);

  if (killWorker) {
    console.log('  Waiting 5s for scan to begin...');
    await sleep(5000);

    const pre = await getScanStatus();
    console.log(`  Pre-stop: phase=${pre.checkpoint?.phase} processed=${pre.checkpoint?.processedCount}/${pre.checkpoint?.totalCount}`);

    // Best-effort Stop via the service-worker internals page (page session --
    // this is the ONLY thing the page session is used for besides Network). The
    // row lookup uses the runtime-discovered extension ID (dynamic, never a
    // constant). Note: "unregister" is intentionally avoided -- it would remove
    // the real extension's service worker registration permanently.
    await pageSession.send('Page.navigate', { url: 'chrome://serviceworker-internals' });
    await sleep(2000);

    let killResult;
    try {
      killResult = await pageSession.eval(`
        (function() {
          const id = '${RESULTS.extensionId}';
          const rows = document.querySelectorAll('tr');
          for (const row of rows) {
            const text = row.textContent || '';
            if (text.includes(id)) {
              const buttons = row.querySelectorAll('button');
              for (const btn of buttons) {
                if ((btn.textContent || '').toLowerCase().includes('stop')) {
                  btn.click();
                  return 'Clicked: ' + btn.textContent;
                }
              }
              return 'Row found but no stop button. Buttons: ' + Array.from(buttons).map(b => b.textContent).join(', ');
            }
          }
          return 'Not found by id. Total rows: ' + rows.length;
        })()
      `);
    } catch (e) {
      killResult = { result: { value: 'eval-failed: ' + e.message } };
    }
    console.log('  Stop attempt:', killResult?.result?.result?.value);

    // Verify the worker target actually disappeared before weighing in on the
    // termination/resume claim. If it cannot be confirmed stopped, we still
    // attempt the resume check but mark the kill as unconfirmed.
    await sleep(3000);
    let workerGone = false;
    try {
      const targets = await listTargets();
      workerGone = !targets.some((t) => t.type === 'service_worker' && t.url && t.url.includes(RESULTS.extensionId));
    } catch (e) { /* non-fatal */ }
    RESULTS.workerTest.terminated = true;
    RESULTS.workerTest.killConfirmed = workerGone;
    console.log(`  Worker target after stop attempt: ${workerGone ? 'GONE (confirmed)' : 'STILL PRESENT (not confirmed)'}`);

    // Resume: start the worker again from the internals page and reconnect the
    // worker session to the freshly spawned service_worker target. The previous
    // worker websocket died with the worker and cannot be reused.
    if (workerGone) {
      console.log('  Resuming worker via internals Start...');
      await pageSession.eval(`
        (function() {
          const id = '${RESULTS.extensionId}';
          const rows = document.querySelectorAll('tr');
          for (const row of rows) {
            const text = row.textContent || '';
            if (text.includes(id)) {
              const buttons = row.querySelectorAll('button');
              for (const btn of buttons) {
                const t = (btn.textContent || '').toLowerCase();
                if ((t === 'start' || t.includes('start')) || (t === 'update' || t.includes('update'))) {
                  btn.click();
                  return 'Clicked resume: ' + btn.textContent;
                }
              }
              return 'Row found but no start/update button. Buttons: ' + Array.from(buttons).map(b => b.textContent).join(', ');
            }
          }
          return 'Row not found for resume. Total rows: ' + rows.length;
        })()
      `).catch(() => {});
      await sleep(2000);

      const resumed = await reconnectWorkerSession();
      if (resumed) {
        console.log('  Worker resumed + worker session reconnected.');
      } else {
        console.log('  Worker target did not reappear within timeout; scan may not resume.');
      }
    }
  }

  const POLL_MAX = 300;
  let lastLog = '';
  for (let sec = 0; sec < POLL_MAX; sec++) {
    await sleep(1000);
    let status;
    try {
      status = await getScanStatus();
    } catch (e) {
      // The worker session may have dropped (e.g. worker stopped by the browser
      // or the resume above failed). Try to reconnect it and continue polling.
      if (workerSession) { workerSession.close(); workerSession = null; }
      const reconnected = await reconnectWorkerSession();
      console.log(`  [${sec + 1}s] worker session lost; reconnected=${reconnected}`);
      if (!reconnected) {
        return {
          scanNumber: num, wallClockMs: Date.now() - startMs,
          wallClockSec: ((Date.now() - startMs) / 1000).toFixed(2),
          completed: false, reportTotal: null, recordCount: null, workerKilled: killWorker
        };
      }
      continue;
    }
    const phase = status.checkpoint?.phase || 'unknown';
    const processed = status.checkpoint?.processedCount || 0;
    const total = status.checkpoint?.totalCount || 0;

    if (sec % 5 === 0 || phase === 'done') {
      const line = `  [${sec + 1}s] phase=${phase} processed=${processed}/${total}`;
      if (line !== lastLog) { console.log(line); lastLog = line; }
    }

    if (phase === 'done' || status.report) {
      const elapsed = Date.now() - startMs;
      console.log(`  DONE in ${(elapsed / 1000).toFixed(2)}s`);

      const state = await workerSession.eval(`
        new Promise(resolve => {
          chrome.storage.local.get(null, data => {
            resolve(JSON.stringify({ report: data.report, checkpoint: data.checkpoint, recordCount: data.records?.length }));
          });
        })
      `, true);
      const stateData = JSON.parse(state.result?.result?.value || '{}');

      const scanResult = {
        scanNumber: num,
        wallClockMs: elapsed,
        wallClockSec: (elapsed / 1000).toFixed(2),
        completed: true,
        reportTotal: stateData.report?.total,
        report: stateData.report,
        recordCount: stateData.recordCount,
        workerKilled: killWorker
      };

      if (killWorker) {
        RESULTS.workerTest.resumed = true;
        RESULTS.workerTest.finalReportTotal = stateData.report?.total;
      }

      return scanResult;
    }
  }

  const elapsed = Date.now() - startMs;
  console.log(`  TIMEOUT after ${(elapsed / 1000).toFixed(2)}s`);
  return {
    scanNumber: num, wallClockMs: elapsed,
    wallClockSec: (elapsed / 1000).toFixed(2),
    completed: false, reportTotal: null, recordCount: null, workerKilled: killWorker
  };
}

// ─── Opt-in link-check measurement ──────────────────────────
// Runs ONLY when --check-links is passed. Grants <all_urls> explicitly (the
// same permission-gated path the extension uses), measures a real link check of
// the existing 3,000+ records, records the exact three-state split and wall
// clock, and selects >= 30 unreachable URLs for manual confirmation. If the
// permission/network cannot be obtained it records a blocked status + reason
// instead of fabricating numbers.

function readExplicitPermission() {
  // Requesting <all_urls> from the extension context shows Chrome's permission
  // bubble and resolves only once a human accepts/rejects it. This tool cannot
  // click the bubble itself, so the grant is genuinely opt-in and requires
  // interaction. We bound the wait: if no grant happens in 25s we report a
  // blocked status instead of hanging for the CDP timeout or fabricating a
  // grant. The permission bubble must be accepted for a real measurement to
  // run at all.
  const script = `
    new Promise((resolve) => {
      chrome.permissions.request({ origins: ['<all_urls>'] }, (granted) => {
        resolve(JSON.stringify({ granted: !!granted, lastError: chrome.runtime && chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null }));
      });
    })
  `;
  const p = workerSession.eval(script, true, 20000).then((r) => {
    try { return JSON.parse(r.result?.result?.value || '{"granted":false}'); }
    catch { return { granted: false, parseError: true }; }
  }).catch((e) => ({ granted: false, lastError: 'cdp-permission-request-failed: ' + e.message }));
  // Never wait longer than the whole measurement budget would allow; a failed
  // grant is a blocked status, not a fabricated pass.
  return Promise.race([
    p,
    sleep(25000).then(() => ({ granted: false, timeout: true }))
  ]);
}

async function buildManualVerificationFromRecords() {
  // Read records from extension storage; persist each URL as a manual
  // verification entry with status and confirmedDead set to "unknown".
  const r = await workerSession.eval(`
    new Promise(resolve => {
      chrome.storage.local.get(['records'], data => {
        const rows = (data.records || []).map(rec => ({
          url: rec.url,
          status: rec.linkStatus || 'unchecked'
        }));
        resolve(JSON.stringify(rows));
      });
    })
  `, true);
  return JSON.parse(r.result?.result?.value || '[]');
}

async function runLinkCheckMeasurement() {
  RESULTS.linkCheck = {
    mode: 'opt-in',
    permissionGranted: false,
    blocked: false,
    blockedReason: null,
    wallClockMs: 0,
    wallClockSec: '0',
    split: { reachable: 0, unreachable: 0, couldNotCheck: 0, checked: 0 },
    manualVerification: [],
    falsePositiveRate: null,
    falsePositiveRateComputed: false
  };
  console.log('\n--- OPT-IN LINK-CHECK MEASUREMENT ---');

  // 1) Explicitly request the host permission from the extension context.
  console.log('[LINK] Requesting <all_urls> permission explicitly...');
  const perm = await readExplicitPermission();
  if (!perm.granted) {
    RESULTS.linkCheck.permissionGranted = false;
    RESULTS.linkCheck.blocked = true;
    RESULTS.linkCheck.blockedReason = perm.timeout
      ? 'host-permission-grant-timed-out (no user accepted the <all_urls> permission bubble)'
      : 'host-permission-denied: ' + (perm.lastError || 'user declined');
    console.log('[LINK] PERMISSION BLOCKED:', RESULTS.linkCheck.blockedReason);
    console.log('[LINK] No link check was run and no numbers were fabricated. See artifact.linkCheck.blocked.');
    return;
  }
  RESULTS.linkCheck.permissionGranted = true;

  // Confirm the permission is actually held before starting (matches the
  // extension's own gate).
  const contains = await workerSession.eval(`
    new Promise(resolve => chrome.permissions.contains({ origins: ['<all_urls>'] }, resolve))
  `, true);
  if (!contains.result?.result?.value) {
    RESULTS.linkCheck.blocked = true;
    RESULTS.linkCheck.blockedReason = 'permission-contained=false after grant (revoked or not effective)';
    console.log('[LINK] BLOCKED:', RESULTS.linkCheck.blockedReason);
    return;
  }

  // 2) Count checkable records (>= 3000 required for the 3,000-record claim).
  const recs = await buildManualVerificationFromRecords();
  const checkable = recs.filter((r) => r.url && /^https?:/i.test(r.url));
  console.log(`[LINK] Checkable web records: ${checkable.length}`);
  if (checkable.length < 3000) {
    RESULTS.linkCheck.blocked = true;
    RESULTS.linkCheck.blockedReason =
      'only ' + checkable.length + ' checkable web records found (need >= 3000); cannot measure a 3,000-record link check';
    console.log('[LINK] BLOCKED:', RESULTS.linkCheck.blockedReason);
    return;
  }

  // 3) Trigger the check and poll the summary.
  console.log('[LINK] Triggering check-links...');
  await workerSession.eval(`
    new Promise(resolve => chrome.runtime.sendMessage({ type: 'check-links' }, resp => resolve(resp && resp.ok)))
  `, true);

  const startMs = Date.now();
  const LINK_POLL_MAX = 600;
  let linkDone = false;
  let lastLinkLog = '';
  for (let sec = 0; sec < LINK_POLL_MAX; sec++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await workerSession.eval(`
      new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'link-check-status' }, resp => resolve(JSON.stringify(resp)));
      })
    `, true);
    const status = JSON.parse(r.result?.result?.value || '{}');
    const cp = status.linkCheckpoint || {};
    const rep = status.linkReport || null;
    if (sec % 10 === 0) {
      const line = `  [${sec + 1}s] phase=${cp.phase} processed=${cp.processedCount}/${cp.totalCount}`;
      if (line !== lastLinkLog) { console.log(line); lastLinkLog = line; }
    }
    if (rep) {
      const elapsed = Date.now() - startMs;
      RESULTS.linkCheck.wallClockMs = elapsed;
      RESULTS.linkCheck.wallClockSec = (elapsed / 1000).toFixed(2);
      RESULTS.linkCheck.split = {
        reachable: rep.reachable || 0,
        unreachable: rep.unreachable || 0,
        couldNotCheck: rep.couldNotCheck || 0,
        checked: rep.checked || 0
      };
      linkDone = true;
      console.log(`[LINK] DONE in ${(elapsed / 1000).toFixed(2)}s`);
      console.log(`[LINK] reachable=${rep.reachable} unreachable=${rep.unreachable} could_not_check=${rep.couldNotCheck} checked=${rep.checked}`);
      break;
    }
  }

  if (!linkDone) {
    RESULTS.linkCheck.blocked = true;
    RESULTS.linkCheck.blockedReason = 'link check did not complete within the polling window (checkpoint phase=' +
      (lastLinkLog ? lastLinkLog : 'unknown') + ')';
    console.log('[LINK] BLOCKED (incomplete):', RESULTS.linkCheck.blockedReason);
    return;
  }

  // 4) Select >= 30 unreachable URLs for manual confirmation.
  const freshRecs = await buildManualVerificationFromRecords();
  const unreachable = freshRecs.filter((r) => r.status === 'unreachable');
  const selected = unreachable.slice(0, 30);
  console.log(`[LINK] Unreachable records available: ${unreachable.length}; selecting ${selected.length} for manual verification`);
  RESULTS.linkCheck.manualVerification = selected.map((r) => ({
    url: r.url,
    status: r.status,
    confirmedDead: 'unknown'
  }));

  // 5) False-positive rate is only ever computed when every selected URL has
  //    been manually marked (not "unknown"). Load the -verify file if given.
  if (cfg.verify) {
    const fs = await import('fs');
    let manual;
    try { manual = JSON.parse(fs.readFileSync(cfg.verify, 'utf8')); }
    catch (e) {
      RESULTS.linkCheck.falsePositiveRate = null;
      RESULTS.linkCheck.falsePositiveRateComputed = false;
      RESULTS.linkCheck.manualVerificationReason = 'verify file could not be parsed: ' + e.message;
      console.log('[LINK] Could not read verify file:', e.message);
      return;
    }
    const marked = RESULTS.linkCheck.manualVerification.map((entry) => {
      const m = (manual || []).find((x) => x && x.url === entry.url);
      if (m && (m.confirmedDead === true || m.confirmedDead === 'true')) entry.confirmedDead = 'true';
      else if (m && (m.confirmedDead === false || m.confirmedDead === 'false')) entry.confirmedDead = 'false';
      else if (m && m.confirmedDead === 'unknown') entry.confirmedDead = 'unknown';
      else entry.confirmedDead = 'unknown';
      return entry;
    });
    // Only compute the rate when every selected URL is manually confirmed.
    const allMarked = marked.every((m) => m.confirmedDead === 'true' || m.confirmedDead === 'false');
    if (allMarked) {
      const falsePos = marked.filter((m) => m.status === 'unreachable' && m.confirmedDead === 'false').length;
      RESULTS.linkCheck.falsePositiveRate = falsePos / marked.length;
      RESULTS.linkCheck.falsePositiveRateComputed = true;
    } else {
      const pending = marked.filter((m) => m.confirmedDead === 'unknown').length;
      RESULTS.linkCheck.falsePositiveRate = null;
      RESULTS.linkCheck.falsePositiveRateComputed = false;
      RESULTS.linkCheck.manualVerificationReason = 'false-positive rate withheld: ' + pending + ' of ' + marked.length + ' selected URLs are still unconfirmed';
      console.log(`[LINK] Rate withheld: ${pending}/${marked.length} unconfirmed. Manual verification artifact written.`);
    }
  } else {
    RESULTS.linkCheck.falsePositiveRate = null;
    RESULTS.linkCheck.falsePositiveRateComputed = false;
    RESULTS.linkCheck.manualVerificationReason = 'no -verify file supplied; manual verification artifact written; rate withheld until all selected URLs are marked';
    console.log('[LINK] No -verify file supplied. ManualVerification list written; rate withheld until all 30 are manually marked.');
  }
}

// ─── Verification of required checks ────────────────────────
function computePass() {
  const parts = [];
  const ok = {
    bookmarkCount: RESULTS.bookmarkCount >= 3000,
    scanMedian: RESULTS.scanMedianMs > 0 && RESULTS.scanMedianMs <= 90000,
    bookmarksUnchanged: RESULTS.bookmarksUnchanged,
    noNetworkToBookmarks: RESULTS.networkRequests.toBookmarkedUrls === 0,
    workerResumed: RESULTS.workerTest.resumed
  };
  for (const [k, v] of Object.entries(ok)) { if (!v) parts.push(k); }
  // Link-check mode is opt-in; blocking (permission/network) is recorded, not a
  // required pass condition. Fabricated/claimed rates must not appear when not
  // computed.
  if (RESULTS.linkCheck && RESULTS.linkCheck.mode === 'opt-in' && !RESULTS.linkCheck.blocked) {
    if (RESULTS.linkCheck.falsePositiveRateComputed === true && typeof RESULTS.linkCheck.falsePositiveRate !== 'number') {
      parts.push('linkCheckRateClaimedWithoutComputation');
    }
  }
  return { pass: parts.length === 0, failed: parts };
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  const fs = await import('fs');

  // Browser version + target list.
  let browserResp;
  try {
    browserResp = await (await fetch(CDP_ROOT + '/json/version')).json();
  } catch (e) {
    console.error('FATAL: Cannot reach Chrome CDP at ' + CDP_ROOT);
    console.error('Start Chrome with --remote-debugging-port=' + cfg.port + ' first.');
    process.exit(1);
  }
  RESULTS.browserVersion = browserResp.Browser || '';
  console.log('=== Bookmark Rescue — Real Chrome CDP Test ===');
  console.log('Browser: ' + RESULTS.browserVersion);

  // Runtime extension-ID discovery (never a constant).
  console.log('Discovering the loaded extension ID from live CDP targets...');
  let discovered;
  try {
    discovered = await discoverExtensionId(cfg.port, cfg.extensionId);
  } catch (e) {
    console.error('\nFATAL: ' + e.message);
    RESULTS.extensionId = null;
    RESULTS.extensionDiscovered = false;
    RESULTS.errors.push(e.message);
    writeResults(fs);
    process.exit(1);
  }
  RESULTS.extensionId = discovered.extensionId;
  RESULTS.extensionDiscovered = true;
  RESULTS.discoverySource = discovered.source;
  console.log('Discovered extension: ' + RESULTS.extensionId + ' (via ' + discovered.source + ')\n');

  // -- Normal page session. Used ONLY for Network/navigation to
  // chrome://serviceworker-internals. A normal (non-extension) page is required
  // because extension pages cannot navigate to chrome://serviceworker-internals.
  console.log('[SETUP] Connecting the normal page session (Network + service-worker internals)...');
  try {
    const pageConn = await connectPageSession();
    pageSession = pageConn.session;
  } catch (e) {
    console.error('FATAL: ' + e.message);
    RESULTS.errors.push('no-page-target: ' + e.message);
    writeResults(fs);
    process.exit(1);
  }

  // -- Worker session. This is the ONLY context through which extension APIs
  // (chrome.bookmarks/storage/runtime) are reachable. Direct navigation to the
  // extension popup URL fails (chrome-error://chromewebdata); the MV3 service
  // worker target is the reliable context. If the worker is idle/stopped, wake
  // it via the internals page first, then attach.
  console.log('[SETUP] Attaching to the extension service_worker target (all extension APIs run here)...');
  let workerTarget = await findWorkerTarget();
  if (workerTarget) {
    console.log('  Found running service_worker target.');
  } else {
    console.log('  Service worker not running; attempting to wake it via chrome://serviceworker-internals...');
    await wakeWorkerViaInternalsPage();
    workerTarget = await waitForWorkerTarget(DISCOVERY_WAIT_MS);
  }
  if (!workerTarget) {
    const msg = 'No service_worker target present for discovered extension ' + RESULTS.extensionId +
      ' and it could not be woken via chrome://serviceworker-internals. ' +
      'MV3 extension APIs are only reachable through the service worker (direct navigation to the popup URL yields ' +
      'chrome-error://chromewebdata). Open the extension popup once or trigger a scan so the service worker starts, ' +
      'then retry this tool.';
    console.error('FATAL: ' + msg);
    RESULTS.errors.push('no-service-worker-target: ' + msg);
    writeResults(fs);
    if (pageSession) { pageSession.close(); }
    process.exit(1);
  }
  workerSession = await connectWorkerSession(workerTarget.webSocketDebuggerUrl);
  console.log('  Worker session attached: ' + workerTarget.webSocketDebuggerUrl);

  // Live smoke: verify chrome.bookmarks/storage/runtime are exposed in the
  // service-worker context specifically (this is exactly the failure that the
  // old single-page-session navigation could not satisfy).
  const apiCheckResp = await workerSession.eval(`JSON.stringify({
    hasChrome: typeof chrome !== 'undefined',
    hasBookmarks: typeof chrome?.bookmarks !== 'undefined',
    hasStorage: typeof chrome?.storage !== 'undefined',
    hasRuntime: typeof chrome?.runtime !== 'undefined'
  })`, false, 10000);
  const apis = JSON.parse(apiCheckResp.result?.result?.value || '{}');
  console.log('[SETUP] Worker-context extension APIs:', JSON.stringify(apis));
  if (!(apis.hasBookmarks && apis.hasStorage && apis.hasRuntime)) {
    const msg = 'Extension APIs not available in the service-worker context for discovered ID ' + RESULTS.extensionId + '. ' +
      'The discovered/runtime-selected ID is not an unpacked Bookmark Rescue extension that exposes ' +
      'chrome.bookmarks/storage/runtime in its service worker. Close other extensions or pass --extension-id.';
    console.error('FATAL: ' + msg);
    RESULTS.errors.push('extension-apis-unavailable: ' + msg);
    writeResults(fs);
    workerSession.close(); pageSession.close();
    process.exit(1);
  }
  console.log('[SETUP] chrome.bookmarks/storage/runtime OK in the service-worker session.\n');

  // ─── STEP: Build disposable test tree ────────────────────
  // Clear + rebuild is TEST SETUP on a disposable profile, documented in the
  // result artifact (testProfileDisposable: true). The scan's own mutation
  // safety is measured separately by the SHA-256 before/after comparison.
  console.log('\n[STEP] Building disposable test tree...');
  await clearAllBookmarks();
  await sleep(500);
  let existingCount = await getBookmarkCount();
  console.log(`  Existing after clear: ${existingCount}`);
  if (existingCount < BOOKMARK_COUNT) {
    const createResult = await createBookmarks(BOOKMARK_COUNT);
    console.log(`  Created: ${createResult.created}, Total: ${createResult.total}`);
  }
  const finalCount = await getBookmarkCount();
  RESULTS.bookmarkCount = finalCount;
  console.log(`  Verified bookmark count: ${finalCount}`);
  if (finalCount < 3000) {
    console.error(`FATAL: Only ${finalCount} bookmarks, need 3000+`);
    RESULTS.errors.push(`Only ${finalCount} bookmarks created`);
  }

  // ─── STEP: Hash tree before scan ─────────────────────────
  console.log('\n[STEP] Hashing bookmark tree (before scan)...');
  const treeBefore = await getBookmarkTreeJSON();
  RESULTS.bookmarksHashBefore = createHash('sha256').update(treeBefore).digest('hex');
  console.log(`  Hash: ${RESULTS.bookmarksHashBefore.substring(0, 16)}...`);

  // ─── STEP: 3 scans (median) ─────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SCAN PERFORMANCE TESTS');
  console.log('══════════════════════════════════════════════════════════════');

  RESULTS.scans.push(await runScan(1));
  RESULTS.scans.push(await runScan(2));
  RESULTS.scans.push(await runScan(3, { killWorker: true }));

  const completed = RESULTS.scans.filter((s) => s.completed).map((s) => s.wallClockMs).sort((a, b) => a - b);
  if (completed.length > 0) {
    const mid = Math.floor(completed.length / 2);
    RESULTS.scanMedianMs = completed.length % 2 === 1 ? completed[mid] : (completed[mid - 1] + completed[mid]) / 2;
  }

  // ─── STEP: Hash tree after scan ─────────────────────────
  console.log('\n[STEP] Hashing bookmark tree (after scan)...');
  const treeAfter = await getBookmarkTreeJSON();
  RESULTS.bookmarksHashAfter = createHash('sha256').update(treeAfter).digest('hex');
  RESULTS.bookmarksUnchanged = RESULTS.bookmarksHashBefore === RESULTS.bookmarksHashAfter;
  console.log(`  Hash: ${RESULTS.bookmarksHashAfter.substring(0, 16)}...`);
  console.log(`  Unchanged: ${RESULTS.bookmarksUnchanged}`);

  // ─── STEP: Network accounting ───────────────────────────
  console.log('\n[STEP] Analyzing network requests...');
  try {
    const parsed = JSON.parse(treeBefore);
    (function collect(nodes) {
      for (const n of nodes || []) {
        if (n.url) bookmarkUrls.add(n.url);
        if (n.children) collect(n.children);
      }
    })(parsed);
  } catch (e) { /* non-fatal */ }

  for (const req of allNetworkRequests) {
    const url = req.url;
    if (bookmarkUrls.has(url) || [...bookmarkUrls].some((bu) => url.startsWith(bu))) {
      RESULTS.networkRequests.toBookmarkedUrls++;
    } else if (url.includes('rules-data.json') || url.startsWith('chrome-extension://')) {
      RESULTS.networkRequests.localExtension++;
    } else if (url && !url.startsWith('data:') && !url.startsWith('chrome://') && !url.startsWith('about:')) {
      RESULTS.networkRequests.other.push(url);
    }
  }
  RESULTS.networkRequests.total = allNetworkRequests.length;
  console.log(`  Total captured: ${RESULTS.networkRequests.total}`);
  console.log(`  To bookmarked URLs: ${RESULTS.networkRequests.toBookmarkedUrls}`);
  console.log(`  To local extension resources: ${RESULTS.networkRequests.localExtension}`);
  console.log(`  Other: ${RESULTS.networkRequests.other.length}`);

  // ─── OPT-IN: link-check measurement ─────────────────────
  if (cfg.checkLinks) {
    await runLinkCheckMeasurement();
  }

  // ─── FINAL REPORT ────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  FINAL RESULTS');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('Browser: ' + RESULTS.browserVersion);
  console.log('Extension: ' + RESULTS.extensionId + ' (discovered via ' + RESULTS.discoverySource + ')');
  console.log('Disposable test profile: ' + RESULTS.testProfileDisposable);
  console.log('Bookmarks: ' + RESULTS.bookmarkCount);
  for (const s of RESULTS.scans) {
    console.log(`  Scan ${s.scanNumber}: ${s.wallClockSec}s (${s.completed ? 'COMPLETE' : 'INCOMPLETE'})${s.workerKilled ? ' [WORKER STOP]' : ''}`);
  }
  console.log(`  Median: ${(RESULTS.scanMedianMs / 1000).toFixed(2)}s`);
  console.log(`  90s threshold: ${RESULTS.scanMedianMs <= 90000 ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(`Worker stop/resume: terminated=${RESULTS.workerTest.terminated} killConfirmed=${RESULTS.workerTest.killConfirmed} resumed=${RESULTS.workerTest.resumed} total=${RESULTS.workerTest.finalReportTotal}`);
  console.log(`Bookmark integrity: unchanged=${RESULTS.bookmarksUnchanged}`);
  console.log(`Network: toBookmarks=${RESULTS.networkRequests.toBookmarkedUrls} local=${RESULTS.networkRequests.localExtension} other=${RESULTS.networkRequests.other.length}`);
  if (RESULTS.linkCheck) {
    console.log('');
    console.log('Link check (opt-in): permissionGranted=' + RESULTS.linkCheck.permissionGranted +
      ' blocked=' + RESULTS.linkCheck.blocked + (RESULTS.linkCheck.blockedReason ? ' reason=' + RESULTS.linkCheck.blockedReason : ''));
    if (RESULTS.linkCheck.mode === 'opt-in' && !RESULTS.linkCheck.blocked && RESULTS.linkCheck.split.checked > 0) {
      console.log(`  Split: reachable=${RESULTS.linkCheck.split.reachable} unreachable=${RESULTS.linkCheck.split.unreachable} could_not_check=${RESULTS.linkCheck.split.couldNotCheck} checked=${RESULTS.linkCheck.split.checked}`);
      console.log(`  Wall clock: ${RESULTS.linkCheck.wallClockSec}s`);
      console.log(`  Manual verification entries: ${RESULTS.linkCheck.manualVerification.length}`);
      console.log(`  False-positive rate computed: ${RESULTS.linkCheck.falsePositiveRateComputed} (${RESULTS.linkCheck.falsePositiveRate === null ? 'null' : RESULTS.linkCheck.falsePositiveRate})`);
    }
  }
  if (RESULTS.errors.length > 0) { console.log('Errors: ' + RESULTS.errors.join('; ')); }

  writeResults(fs);
  console.log('Results written to: ' + cfg.output);

  const { pass, failed } = computePass();
  console.log('VERDICT: ' + (pass ? 'PASS' : 'FAIL') + (failed.length ? ' (failed: ' + failed.join(', ') + ')' : ''));
  console.log('NOTE: Real benchmark numbers are only valid after this tool is run against a live Chrome. No results were claimed here.');

  workerSession.close();
  pageSession.close();
  process.exit(pass ? 0 : 1);
}

function writeResults(fs) {
  try {
    fs.writeFileSync(cfg.output, JSON.stringify(RESULTS, null, 2));
  } catch (e) {
    console.error('FATAL: Could not write results artifact to ' + cfg.output + ': ' + e.message);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  RESULTS.errors.push(String(e && e.message));
  try { (async () => { const fs = await import('fs'); writeResults(fs); })(); } catch (err) {}
  if (workerSession) { workerSession.close(); }
  if (pageSession) { pageSession.close(); }
  process.exit(1);
});
