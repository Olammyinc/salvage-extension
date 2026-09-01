#!/usr/bin/env node
/**
 * Synthetic bookmark-tree generator.
 *
 * Produces a realistic, deterministic bookmark tree (Chrome BookmarkTreeNode
 * shape) for local scanning and the test/verification harness. It is needed
 * to exercise the extension against a 3,000+ item library without a real
 * account, and it is reused by every later milestone.
 *
 * The output is deterministic for a given seed: the same seed always
 * produces the same tree, so report assertions are stable.
 *
 * Realism properties (deterministic under the seed):
 *   - nested folders with depth 0..5;
 *   - exact duplicate URLs (a fixed fraction repeats an earlier URL);
 *   - clusters of "New Folder" style folder names;
 *   - dateAdded spread back as far as configured (default 10 years);
 *   - dateLastUsed recorded for a fraction of items (proxy for "has been
 *     opened"), zero/absent for the rest so the never-opened metric is real.
 *
 * Open-history realism (`opts.realistic`):
 *   Chrome only began persisting dateLastUsed around Chrome 114–117 and only
 *   records it when a bookmark is opened through the bookmark UI. On a real
 *   long-lived library the large majority of older bookmarks therefore carry
 *   no dateLastUsed. In realistic mode the generator models this: records
 *   added before the recording cutoff (default 4 years before `now`) have no
 *   dateLastUsed at all, and only a modest fraction of recent records carry a
 *   positive one. The default (non-realistic) mode keeps the older, generous
 *   70%-positive distribution for backward-compatible test fixtures.
 *
 * CLI: node tools/generator.js [count] [seed] [outFile] [--realistic] [--html]
 *   The --realistic and --html flags may appear in any position and own no
 *   argument values. Without --realistic the generator uses the default
 *   (generous) open-history mode. With --html the tree is written as a
 *   Netscape bookmark HTML file instead of JSON; when outFile is omitted the
 *   HTML is printed to stdout. The --html serializer is a pure, exported
 *   helper (serializeHtml) with a deterministic parser (parseNetscapeHtml)
 *   and stats helpers so tests can prove the output round-trips.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Mulberry32: small deterministic PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_URLS = [
  'https://github.com/example/repo',
  'https://stackoverflow.com/questions/some',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference',
  'https://allrecipes.com/recipe/chicken-soup',
  'https://seriouseats.com/how-to-make-stew',
  'https://tripadvisor.com/Guide-g60763',
  'https://airbnb.com/rooms/12345',
  'https://amazon.com/dp/B00005JPLQ',
  'https://youtube.com/watch?v=XeF_2C1aBqc',
  'https://wikipedia.org/wiki/History',
  'https://udemy.com/course/learn-javascript',
  'https://coursera.org/learn/machine-learning',
  'https://notion.so/workspace/research',
  'https://figma.com/file/design-system',
  'https://bbc.com/news/world',
  'https://www.nytimes.com/2020/01/15/business/economy.html'
];

function makeNode(id, title, parentId, index, url, dateAdded, dateLastUsed) {
  const node = { id: String(id), title, url, parentId: String(parentId), index };
  if (url) {
    node.dateAdded = dateAdded;
    node.dateLastUsed = dateLastUsed;
  } else {
    node.dateAdded = dateAdded;
    node.children = [];
  }
  return node;
}

const FOLDER_NAMES = [
  'Research', 'Recipes', 'Travel', 'Development', 'Shopping',
  'Learning', 'Tools', 'Work', 'News', 'Entertainment', 'Archive',
  'Reading List', 'Inspiration', 'Projects', 'Courses', 'Products'
];

const NEW_FOLDER_NAMES = ['New Folder', 'New Folder (1)', 'New Folder (2)', 'New Folder (3)', 'New Folder (4)'];

/**
 * Build a deterministic bookmark tree.
 * @param {object} opts { seed, count, nowMs, realistic }
 *   - seed: integer RNG seed (default 42)
 *   - count: total leaf (URL) bookmarks desired (default 3000)
 *   - nowMs: "today" in epoch ms (default Date.now())
 *   - realistic: boolean; when true, model real-Chrome open-history sparsity
 *     (most older records lack dateLastUsed). Default false keeps the older,
 *     generous 70%-positive open-history distribution.
 * @returns {{tree: Array, meta: object}} tree is an array of root nodes.
 */
function generate(opts) {
  opts = Object.assign({}, opts);
  const seed = opts.seed === undefined ? 42 : opts.seed;
  const count = opts.count || 3000;
  const now = opts.nowMs || Date.now();
  const realistic = !!opts.realistic;
  const rng = mulberry32(seed);
  const YEAR = 365.25 * 86400000;
  const oldest = now - 10 * YEAR;

  // Root nodes (Chrome has three roots; we model two non-empty ones).
  const tree = [
    { id: '1', title: 'Bookmarks bar', parentId: '0', index: 0, dateAdded: oldest, children: [] },
    { id: '2', title: 'Other bookmarks', parentId: '0', index: 1, dateAdded: oldest, children: [] }
  ];

  const idCounter = { v: 4 }; // ids 1,2 are roots; 3 reserved as detached root placeholder
  const allLeaves = [];

  // Stack of folder nodes we can drop items into: [folderNode, maxDepth]
  const rootsToPopulate = [tree[0], tree[1]];

  function nextId() { idCounter.v += 1; return idCounter.v; }

  // --- Build nested folder skeleton deterministically -------------------
  // Create a controlled number of folders; a subset are "New Folder".
  const folderCount = Math.max(4, Math.floor(count / 60));
  const rootPick = () => rootsToPopulate[Math.floor(rng() * rootsToPopulate.length)];

  const folders = [];
  for (let i = 0; i < folderCount; i++) {
    const isNewFolder = i < Math.floor(folderCount * 0.12); // ~12% New Folder
    const name = isNewFolder
      ? NEW_FOLDER_NAMES[i % NEW_FOLDER_NAMES.length]
      : FOLDER_NAMES[Math.floor(rng() * FOLDER_NAMES.length)] + (i % 5 === 0 ? ' ' + (i + 1) : '');
    const parent = rootPick();
    const node = {
      id: String(nextId()),
      title: name,
      parentId: parent.id,
      index: parent.children.length,
      dateAdded: oldest + Math.floor(rng() * (now - oldest)),
      children: []
    };
    parent.children.push(node);
    folders.push(node);
  }

  function pickFolder(depth0) {
    // Weight towards shallow so the tree feels realistic, but allow depth.
    let f = folders[Math.floor(rng() * folders.length)];
    // Occasionally nest inside a folder that already exists.
    for (let d = 0; d < depth0 && rng() < 0.5 && f.children.length > 0; d++) {
      f = f.children[Math.floor(rng() * f.children.length)];
    }
    return f;
  }

  function nestedChild(folder, rng, depth0) {
    if (depth0 <= 0) {
      // Add a nested folder one level deep.
      if (rng() < 0.6) {
        const id = nextId();
        const node = {
          id: String(id),
          title: FOLDER_NAMES[Math.floor(rng() * FOLDER_NAMES.length)],
          parentId: folder.id,
          index: folder.children.length,
          dateAdded: oldest + Math.floor(rng() * (now - oldest)),
          children: []
        };
        folder.children.push(node);
        return node;
      }
    }
    return folder;
  }

  // --- Populate with leaf bookmarks ---------------------------------------
  const DUPLICATE_FRACTION = 0.015; // ~1.5% exact duplicates
  const NEWFOLDER_LEAF_FRACTION = 0.07; // ~7% land inside New Folder clusters
  // Open-history distribution. The default keeps the older, generous 70%
  // positive distribution used by existing fixtures. In realistic mode the
  // large majority of older records carry no dateLastUsed (Chrome didn't
  // record it before ~114–117), so we never fabricate a 70%-positive spread.
  const DEFAULT_OPENED_FRACTION = 0.7;
  const STALE_OPEN_FRACTION = 0.55; // of opened ones, how many older than 2y
  // Realistic mode: records added before this cutoff predate dateLastUsed
  // and carry no recorded opening; recent records get one at a modest rate.
  const RECORDING_START_YEARS = 4; // Chrome ~114 (mid-2023) relative to now
  const RECENT_OPENED_FRACTION = 0.6; // of recent records carrying an opening

  const SLUGS = [
    'page', 'notes', 'docs', 'index', 'overview', 'guide', 'reference',
    'readme', 'home', 'starting', 'summary', 'details', 'info', 'manual',
    'introduction', 'getting-started', 'api', 'examples', 'faq', 'changelog'
  ];

  function freshUrl(base, idx) {
    // Deterministic-but-varied per-index URL: same base yields distinct paths
    // so the tree does not collapse into a handful of colliding URLs.
    const slug = SLUGS[idx % SLUGS.length];
    const n = Math.floor(idx / SLUGS.length);
    // Split base into scheme://host[/some/path]
    const m = /^(https?:\/\/[^/]+)(.*)$/.exec(base);
    const hostPart = m ? m[1] : base;
    const uriPath = m && m[2] ? m[2] : '';
    return hostPart + uriPath + '/' + slug + (n > 0 ? '-' + n : '');
  }

  const duplicatePool = [];
  const poolMax = Math.max(8, Math.floor(count * 0.2));

  let i = 0;
  while (i < count) {
    const r = rng();
    let folder;
    // Distribute leaves: some into New Folder clusters, some random.
    if (r < NEWFOLDER_LEAF_FRACTION) {
      folder = folders[Math.floor(rng() * Math.max(1, Math.floor(folderCount * 0.12)))];
    } else {
      folder = pickFolder(0);
      folder = nestedChild(folder, rng, 0);
    }

    const base = BASE_URLS[Math.floor(rng() * BASE_URLS.length)];
    let url;
    if (rng() < DUPLICATE_FRACTION && duplicatePool.length) {
      // Exact duplicate of an earlier bookmark in a way that survives URL
      // normalization (same scheme/host/path).
      url = duplicatePool[Math.floor(rng() * duplicatePool.length)];
    } else {
      url = freshUrl(base, i);
      // Keep a bounded pool of URLs we are willing to duplicate so the
      // duplicate fraction stays controlled rather than the whole tree.
      if (duplicatePool.length < poolMax) { duplicatePool.push(url); }
    }

    const dateAdded = oldest + Math.floor(rng() * (now - oldest));
    let dateLastUsed = 0;
    if (realistic) {
      // Real-Chrome open-history sparsity: only records added within the
      // recording window (dateLastUsed has existed) can carry an opening, and
      // only a modest fraction of those do. Older records always have none.
      if (dateAdded >= now - RECORDING_START_YEARS * YEAR && rng() < RECENT_OPENED_FRACTION) {
        if (rng() < STALE_OPEN_FRACTION) {
          dateLastUsed = now - RECORDING_START_YEARS * YEAR + Math.floor(rng() * (2 * YEAR));
        } else {
          dateLastUsed = now - Math.floor(rng() * (2 * YEAR));
        }
      }
    } else if (rng() < DEFAULT_OPENED_FRACTION) {
      if (rng() < STALE_OPEN_FRACTION) {
        dateLastUsed = oldest + Math.floor(rng() * (2 * YEAR));
      } else {
        dateLastUsed = now - Math.floor(rng() * (2 * YEAR));
      }
    }

    const id = nextId();
    const node = {
      id: String(id),
      title: titleFor(base, i),
      url,
      parentId: folder.id,
      index: folder.children.length,
      dateAdded,
      dateLastUsed
    };
    folder.children.push(node);
    allLeaves.push(node);

    i += 1;
  }

  function titleFor(base, idx) {
    const domain = base.replace(/^https?:\/\//, '').split('/')[0];
    return 'Saved page ' + (idx + 1) + ' from ' + domain;
  }

  return {
    tree,
    meta: {
      seed,
      requestedLeaves: count,
      actualLeaves: allLeaves.length,
      duplicateLeaves: Math.round(count * DUPLICATE_FRACTION),
      rootFolders: tree.length,
      totalNodes: idCounter.v,
      generatedAt: now
    }
  };
}

// --- Netscape bookmark-HTML output modes ------------------------------------
// Pure helpers with no external dependency and no side effects, so they can be
// reused by the deterministic test suite to prove round-trips.

// New Folder cluster naming matches the generator's clusters and the
// extension's New Folder metric (constants.NEW_FOLDER_RE) so a leaf whose path
// contains a cluster counts as a New Folder leaf. Replicated here because the
// generator must not import the shared extension modules.
const NEW_FOLDER_RE = /^New Folder(\s*\(\d+\))?\s*$/i;

// Convert JS epoch milliseconds to integer Unix seconds. Absent/zero values
// become null (the caller emits no attribute rather than fabricating a stamp).
function epochSeconds(ms) {
  return (typeof ms === 'number' && ms > 0) ? Math.floor(ms / 1000) : null;
}

function escapeHtmlAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>')
    .replace(/&amp;|&#38;/gi, '&');
}

/**
 * Serialize a BookmarkTreeNode tree into the Netscape bookmark HTML format
 * used by Chrome/Edge for import ("Import bookmarks"), preserving folder
 * nesting, duplicate URLs, New Folder clusters, and date attributes.
 *
 * Each folder emits <DT><H3 ADD_DATE=...>; each bookmark emits
 * <DT><A HREF=... ADD_DATE=... [LAST_VISIT=...]>. The "Bookmarks bar" root is
 * flagged PERSONAL_TOOLBAR_FOLDER. For absent/zero dateLastUsed (for example
 * the majority of records in realistic mode) LAST_VISIT is omitted, never
 * fabricated. Timestamps are integer Unix seconds.
 *
 * @param {Array} tree array of BookmarkTreeNode roots
 * @param {object} [opts] unused place-holder for future formatting hooks
 * @returns {string} Netscape bookmark HTML
 */
function serializeHtml(tree, opts) {
  opts = opts || {};
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];
  function pad(depth) { return '    '.repeat(depth); }
  function writeFolder(node, depth) {
    const addDate = epochSeconds(node.dateAdded);
    const toolbar = /^Bookmarks bar$/i.test(node.title) ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
    lines.push(pad(depth) + '<DT><H3 ADD_DATE="' + addDate + '"' + toolbar + '>' + escapeHtmlText(node.title) + '</H3>');
    lines.push(pad(depth) + '<DL><p>');
    for (const child of node.children || []) {
      if (child && child.children) { writeFolder(child, depth + 1); }
      else if (child && child.url) { writeLeaf(child, depth + 1); }
    }
    lines.push(pad(depth) + '</DL><p>');
  }
  function writeLeaf(node, depth) {
    const addDate = epochSeconds(node.dateAdded);
    const lastVisit = epochSeconds(node.dateLastUsed);
    const lv = lastVisit ? ' LAST_VISIT="' + lastVisit + '"' : '';
    lines.push(pad(depth) + '<DT><A HREF="' + escapeHtmlAttr(node.url) + '" ADD_DATE="' + addDate + '"' + lv +
      '>' + escapeHtmlText(node.title) + '</A>');
  }
  for (const root of tree || []) {
    if (root && root.children) { writeFolder(root, 1); }
    else if (root && root.url) { writeLeaf(root, 1); }
  }
  lines.push('</DL><p>');
  return lines.join('\n');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1].toUpperCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

// Deterministic tokenizer for the Netscape bookmark format (handles the
// conventional structure, with or without explicit </DT> closers).
function tokenize(html) {
  const tokens = [];
  const lower = html.toLowerCase();
  let pos = 0;
  while (pos < html.length) {
    const iDT = lower.indexOf('<dt', pos);
    const iDL = lower.indexOf('<dl', pos);
    const iDLC = lower.indexOf('</dl', pos);

    let idx = -1;
    let kind = null;
    if (iDT !== -1 && (idx === -1 || iDT < idx)) { idx = iDT; kind = 'dt'; }
    if (iDL !== -1 && (idx === -1 || iDL < idx)) { idx = iDL; kind = 'dl'; }
    if (iDLC !== -1 && (idx === -1 || iDLC < idx)) { idx = iDLC; kind = 'dlc'; }
    if (idx === -1) { break; }

    if (kind === 'dl' || kind === 'dlc') {
      const end = html.indexOf('>', idx);
      tokens.push({ type: kind === 'dl' ? 'dlOpen' : 'dlClose' });
      pos = end === -1 ? idx + (kind === 'dlc' ? 4 : 3) : end + 1;
    } else {
      // <DT> element. Its content runs until an explicit </DT>, or until the
      // next <DT>/<DL>/</DL> markup (Netscape does not always close <DT>).
      const gt = html.indexOf('>', idx);
      let segEnd;
      const nextMarkup = (function () {
        let n = html.length;
        const ndt = lower.indexOf('<dt', idx + 1);
        if (ndt !== -1) { n = Math.min(n, ndt); }
        if (iDL !== -1) { n = Math.min(n, iDL); }
        if (iDLC !== -1) { n = Math.min(n, iDLC); }
        return n;
      })();
      const endDT = lower.indexOf('</dt', idx);
      if (endDT !== -1 && endDT < nextMarkup) {
        const endClose = html.indexOf('>', endDT);
        segEnd = endClose === -1 ? endDT + 5 : endClose + 1;
      } else {
        segEnd = nextMarkup;
      }
      const segFrom = gt + 1;
      const segment = html.slice(segFrom, segEnd);

      const h3 = /<H3\b([^>]*)>([\s\S]*?)<\/H3>/i.exec(segment);
      if (h3) {
        tokens.push({ type: 'folder', attrs: parseAttrs(h3[1] || ''), text: decodeEntities(h3[2]) });
      } else {
        const a = /<A\b([^>]*)>([\s\S]*?)<\/A>/i.exec(segment);
        if (a) {
          tokens.push({ type: 'bookmark', attrs: parseAttrs(a[1] || ''), text: decodeEntities(a[2]) });
        }
      }
      pos = segEnd;
    }
  }
  return tokens;
}

/**
 * Parse Netscape bookmark HTML into a nested item tree (same structural shape
 * the serializer emits), carrying title/url, addDate (seconds), lastVisit, and
 * children. This is the deterministic inverse of serializeHtml and is used by
 * the test suite to prove the output round-trips.
 *
 * @param {string} html
 * @returns {Array} root items: { title, url?, addDate, lastVisit?, children? }
 */
function parseNetscapeHtml(html) {
  const tokens = tokenize(html);
  // A <DL> container whose top-level open (immediately after <H1>) holds the
  // root folders. The first null-pending dlOpen becomes this root container;
  // every leaf is pushed into the current (deepest) open container's children.
  const rootContainer = { title: '(root)', addDate: null, children: [] };
  const containers = [rootContainer]; // stack; top is the current container
  let pendingFolder = null;
  for (const t of tokens) {
    if (t.type === 'dlOpen') {
      containers.push(pendingFolder || containers[0]);
      pendingFolder = null;
    } else if (t.type === 'dlClose') {
      if (containers.length > 1) { containers.pop(); }
    } else if (t.type === 'folder') {
      const folder = { title: t.text, addDate: t.attrs.ADD_DATE ? Number(t.attrs.ADD_DATE) : null, children: [] };
      containers[containers.length - 1].children.push(folder);
      pendingFolder = folder;
    } else if (t.type === 'bookmark') {
      containers[containers.length - 1].children.push({
        title: t.text,
        url: t.attrs.HREF || null,
        addDate: t.attrs.ADD_DATE ? Number(t.attrs.ADD_DATE) : null,
        lastVisit: t.attrs.LAST_VISIT ? Number(t.attrs.LAST_VISIT) : null
      });
    }
  }
  return rootContainer.children;
}

// Normalize a BookmarkTreeNode root (the generator's JSON source shape) into
// the same uniform item shape the parser produces, so one stats function can
// describe both source and serialized trees. Accepts either a single node or
// an array of roots.
function toUniformItem(node) {
  if (Array.isArray(node)) { return node.map(toUniformItem); }
  if (node && node.children) {
    return { title: node.title, addDate: node.dateAdded, children: node.children.map(toUniformItem) };
  }
  return { title: node && node.title, url: node && node.url, addDate: node && node.dateAdded, lastVisit: node && node.dateLastUsed };
}

// Collect raw counts from a uniform item tree. All orderings are preserved so
// the source and the parsed HTML can be compared exactly.
function collectNodeStats(roots) {
  const out = { leaves: [], folderCount: 0, addDateCount: 0, folderDepths: [], leafDepths: [] };
  (function walk(items, path) {
    for (const it of items || []) {
      if (it.children) {
        const p = path.concat(it.title);
        out.folderCount += 1;
        out.folderDepths.push(p.length);
        if (it.addDate) { out.addDateCount += 1; }
        walk(it.children, p);
      } else {
        out.leaves.push({ url: it.url, path: path.concat([]), lastVisit: it.lastVisit || 0 });
        out.leafDepths.push(path.length);
        if (it.addDate) { out.addDateCount += 1; }
      }
    }
  })(roots, []);
  return out;
}

/**
 * Deterministic summary of a uniform item tree, used to prove that serialized
 * HTML parses back to the same shape as the source tree.
 * @returns {{leafCount:number, duplicateCount:number, newFolderLeafCount:number,
 *            maxFolderDepth:number, addDateCount:number, lastVisitCount:number}}
 */
function bookmarkStats(roots) {
  const col = collectNodeStats(roots);
  const seen = new Set();
  let duplicateCount = 0;
  const dupKeys = [];
  for (const l of col.leaves) {
    const key = l.url;
    if (seen.has(key)) { duplicateCount += 1; dupKeys.push(key); } else { seen.add(key); }
  }
  const newFolderLeafCount = col.leaves.filter((l) => l.path.some((name) => NEW_FOLDER_RE.test(name))).length;
  const maxLeafDepth = col.leafDepths.length ? Math.max.apply(null, col.leafDepths) : 0;
  const maxFolderDepth = col.folderDepths.length ? Math.max.apply(null, col.folderDepths) : 0;
  const lastVisitCount = col.leaves.filter((l) => l.lastVisit > 0).length;
  return {
    leafCount: col.leaves.length,
    duplicateCount,
    newFolderLeafCount,
    maxFolderDepth: Math.max(maxLeafDepth, maxFolderDepth),
    addDateCount: col.addDateCount,
    lastVisitCount
  };
}

// CLI: node tools/generator.js [count] [seed] [outFile] [--realistic] [--html]
// The flags may appear in any position (before/after the positional args) and
// own no argument values. Positional args are mapped left-to-right to count,
// seed, outFile. Without --realistic the generator uses the default (generous
// ~70%-positive) open-history mode, preserving existing fixture behavior. With
// --html the tree is emitted as Netscape bookmark HTML (to outFile if given,
// else stdout) instead of JSON.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const positional = [];
  let realistic = false;
  let html = false;
  for (const arg of argv) {
    if (arg === '--realistic') { realistic = true; }
    else if (arg === '--html') { html = true; }
    else { positional.push(arg); }
  }
  const count = parseInt(positional[0] || '3000', 10);
  const seed = parseInt(positional[1] || '42', 10);
  const outFile = positional[2];
  const out = generate({ seed, count, nowMs: Date.now(), realistic });

  if (html) {
    const htmlText = serializeHtml(out.tree);
    if (outFile) {
      fs.writeFileSync(path.resolve(outFile), htmlText);
      console.log('Wrote ' + out.meta.actualLeaves + ' leaves (' + out.meta.totalNodes + ' nodes) as Netscape HTML to ' + outFile +
        (realistic ? ' (realistic open-history mode)' : ''));
    } else {
      process.stdout.write(htmlText + '\n');
    }
  } else {
    const json = JSON.stringify(out, null, 2);
    if (outFile) {
      fs.writeFileSync(path.resolve(outFile), json);
      console.log('Wrote ' + out.meta.actualLeaves + ' leaves (' + out.meta.totalNodes + ' nodes) to ' + outFile +
        (realistic ? ' (realistic open-history mode)' : ''));
    } else {
      console.log(json);
    }
  }
}

module.exports = {
  generate,
  mulberry32,
  serializeHtml,
  parseNetscapeHtml,
  bookmarkStats,
  toUniformItem
};
