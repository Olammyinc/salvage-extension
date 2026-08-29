# Bookmark Rescue — Milestone 1 (+ Milestone 2 detection)

An unpacked, loadable Chromium extension (Chrome + Edge) that imports the
user's bookmark tree, scans it in resumable chunks backed by
`chrome.storage`, and renders a read-only **Library Report**: exact counts of
total bookmarks, library age, exact duplicate URLs, "New Folder" nesting,
never-opened and stale (>2 years) items, top topics, and the oldest bookmark.

**Milestone 2 (detection-only)** adds, all read-only and never mutating the
tree or a record: a full **backup export**, **exact-duplicate groups**,
**empty-folder and same-name-merge detection**, and **opt-in dead-link checking**
with a strict three-state result. There is still **no deletion, trash, or undo
mutation path** anywhere in the extension.

This milestone set is **read-only**. It never modifies the user's bookmark tree,
never writes a page, contains no AI, no API keys, no search, and no payments.
The only network requests it ever makes are the user-initiated, permission-gated
link checks in Milestone 2.

> Product name: the final name is not confirmed. User-facing copy uses a
> single placeholder, `Bookmark Rescue`, sourced from
> `extension/shared/constants.js` (`PRODUCT_NAME`) and the MV3 localization file
> `extension/_locales/en/messages.json` (which the manifest references via
> `__MSG_extensionName__` / `__MSG_extensionDescription__`). Internal
> identifiers (storage keys, alarm name, schema version, CSS prefixes, file
> names) are deliberately neutral and free of any product name, so the rename
> stays a one-line change that never migrates user data. The retired name and
> the current front-runner must not appear anywhere in the codebase.

---

## Load unpacked (Chrome + Edge)

1. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the extension directory
   (`bookmark/extension/`, the folder containing `manifest.json`). The project
   keeps extension implementation and its documentation separate: the loadable
   extension lives entirely under `bookmark/extension/`, while the project
   docs (including this README) stay directly under `bookmark/`.
4. Pin the extension from the puzzle-piece toolbar.
5. Click its icon, then **Scan now**. The scan runs in the background worker
   in 75-link chunks, checkpointing after every chunk.

No host permissions are requested at install (`permissions` in
`extension/manifest.json` is exactly `bookmarks`, `storage`, `alarms`,
`activeTab`). There is no "Read and change all your data on all websites"
prompt at install.

Dead-link checking (Milestone 2) needs host access to the user's bookmarked
pages, so `<all_urls>` is declared only under **`optional_host_permissions`**
in the manifest and is requested **at point of use** — the popup explains that
checking links needs temporary access and calls `chrome.permissions.request`
before any bookmark URL is fetched. Nothing is fetched automatically or during
a scan; a link check runs only after the user opts in and only while that
permission is held.

User-visible manifest fields are localized through the MV3 `_locales`
mechanism: `default_locale: "en"` and `name` / `description` / `default_title`
reference `__MSG_extensionName__` / `__MSG_extensionDescription__`, which ship
in `extension/_locales/en/messages.json`. The placeholder product name therefore exists
in exactly two modules — `extension/shared/constants.js` and `extension/_locales/en/messages.json` —
so a rename is a single mechanical pass with no hardcoded copy in any component.

## How the scan stays safe under the service-worker lifecycle

Chrome terminates an idle MV3 service worker after ~30 s and destroys all
in-memory state. The scanner therefore:

- has **no global scan state** — every wake re-reads the checkpoint from
  `chrome.storage`;
- processes ~75 links per chunk and writes `{ lastProcessedId,
  processedCount, totalCount, phase }` after **every** chunk;
- schedules the next chunk with `chrome.alarms` (never `setTimeout` /
  `setInterval`);
- **bounded active-window budget**: each worker wake may spend at most
  `ACTIVE_WINDOW_MS` (default 20 s) before it stops, schedules the alarm,
  and yields. The budget is tracked with the injected `getNow()` clock and is
  deliberately *not* persisted across wakes — each wake starts a fresh window
  — which is what makes it safe under termination: a killed worker only
  shortens the current window and never corrupts the scan, because every
  resume re-reads the checkpoint from storage;
- reads the checkpoint and **resumes on worker startup** and on alarm;
- uses idempotent record upserts, so reprocessing a chunk is harmless and a
  user's category correction (`userCorrected`) is never overwritten on rescan;
- **clears the previous scan's `records`/`report` when a scan starts**, so a
  rescan reflects exactly the current bookmark tree. A bookmark removed
  outside the extension never lingers in `records` and never inflates the
  report total;
- **validates every URL before it can be opened**: only `http:`/`https:` are
  ever handed to `chrome.tabs.create`. `javascript:`, `data:`, `file:`,
  `chrome:`, `about:` and any other scheme found in an imported bookmark are
  rendered inert and never opened (see `normalize.isOpenableUrl`). Records
  stay read-only — validation never mutates them;
- computes the Library Report **from the scan alone** (no page fetches).

The popup never polls with timers either. It subscribes to
`chrome.storage.onChanged` and re-renders from the persisted checkpoint /
report / records whenever the worker writes progress, so progress always
reflects storage (never worker memory).

The only `fetch` in the extension targets its own packaged, versioned rules
map at `chrome.runtime.getURL('shared/rules-data.json')`. That is a local,
off-the-network extension-resource read used to ship the categorization rules
as data; it is **not** a request to any bookmarked URL and is outside the
Milestone 1 no-network-to-bookmarks rule (which is about not *checking*
bookmarked pages).

## Run the deterministic test suite (no Chrome)

Requires Node.js (any recent LTS). The suite computes its working root from
`extension/test/run-tests.js`, so you can run it from either the extension
directory or the project root (`bookmark/`):

```
# from bookmark/extension/
node test/run-tests.js 3000 42

# from bookmark/  (equivalent — the extension dir is implied by the path)
node extension/test/run-tests.js 3000 42
```

The suite:

- **`test/unit-tests.js`** — pure-module tests for URL normalization, rules
  categorization, report metric computation, and the Milestone 2 modules:
  duplicate-group detection (with soft-delete exclusion), empty-folder and
  same-name-merge detection, backup export shape/serialization, and the
  three-state link-check classifier / `checkUrl` behaviour.
- **`test/harness.js`** — integration harness. It generates a realistic
  3,000+ bookmark tree with `tools/generator.js`, runs the exact
  scan-controller used by the extension against a deterministic **mock
  chrome** (`test/mock-chrome.js`), and verifies: checkpoint fields are
  persisted per chunk; a **simulated worker termination mid-scan resumes
  correctly** from storage only and finishes with identical final counts;
  a **forced active-window boundary** stops the wake partway, schedules an
  alarm, and resumes from storage to completion with identical totals;
  a **rescan after a bookmark is removed** starts from a clean slate so the
  final total is exact; a **concurrent rescan race** cannot let a stale write
  overwrite the newer scan; **truthful open-history metrics** under the
  generator's realistic sparse-`dateLastUsed` mode (majority of records with
  no recorded opening, provable stale count, coverage fraction); and an
  **empty bookmark tree** reaches `DONE` with a valid empty report and cleared
  alarms instead of hanging. Replaying a completed scan is idempotent; and
  every reported metric equals an independently derived expected value. The
  normal (unbudgeted-by-time) mock run is also asserted to finish well under
  the 90-second architecture intent. Milestone 2 harness parts cover the
  persisted cleanup findings in the report (`[Part 8]`) and the permission
  gate + three-state link-check execution (`[Part 9]`).

The synthetic generator is committed as source (`tools/generator.js`) and can
emit a tree to JSON **or** to Netscape bookmark HTML. It accepts the positional
args `[count] [seed] [outFile]` plus optional `--realistic` and `--html` flags
that may appear in any position and own no argument values. Run it from the
extension directory or the project root:

```
# from bookmark/extension/
node tools/generator.js 3000 42 output.json
node tools/generator.js 3000 42 output.json --realistic
node tools/generator.js --realistic 3000 42 output.json
node tools/generator.js 3050 42 fixture.html --realistic --html
node tools/generator.js --realistic --html 3050 42 fixture.html

# from bookmark/  (equivalent — the extension dir is implied by the path)
node extension/tools/generator.js 3000 42 output.json
node extension/tools/generator.js 3000 42 output.json --realistic
node extension/tools/generator.js --realistic 3000 42 output.json
```

With `--html` the tree is written as a **Netscape bookmark file** (the format
Chrome/Edge/Brave import via **bookmarks manager → three-dot menu → Import
bookmarks**) instead of JSON, preserving folder nesting, duplicate URLs, New
Folder clusters, and `ADD_DATE`/`LAST_VISIT` attributes. Timestamps are integer
Unix seconds; records with an absent/zero `dateLastUsed` omit `LAST_VISIT`
rather than fabricating one, so realistic mode emits far fewer `LAST_VISIT`
attributes. If `outFile` is omitted in `--html` mode the HTML is printed to
stdout. The serializer (`serializeHtml`) and a deterministic parser
(`parseNetscapeHtml`) plus stats helpers (`bookmarkStats`, `toUniformItem`) are
exported for the test suite, which proves the HTML round-trips (see the
`generator HTML` group in `node test/run-tests.js`, and
`MANUAL-VERIFICATION.md` for what the test does — and does not — prove about
real browser import of `LAST_VISIT`).

Without `--realistic` the generator uses its **default** (generous ~70%-positive
`dateLastUsed`) open-history mode, preserving the existing fixture behavior.
With `--realistic` (equivalent to `generate({ realistic: true })`) it models
real-Chrome sparse open-history — the large majority of older records carry no
`dateLastUsed`, and only a modest fraction of recent records do. The CLI write
path announces the realistic mode in its confirmation line, and the test suite
exercises the flag directly (see the `generator CLI` step in
`node test/run-tests.js`). The resulting tree is deterministic for a given
seed + mode.

## Termination test (real Chrome/Edge)

Definition of done requires proving the scan survives a terminated worker:

1. Load the extension unpacked. Open the popup and click **Scan now**.
2. Open `chrome://serviceworker-internals` (Chrome) / `edge://serviceworker-`
   internals, find the worker for this extension, and click **Stop** (or kill
   it from DevTools) **partway through** the scan — before progress shows
   100%.
3. Wait 30–60 seconds. The worker restarts, reads the checkpoint from storage,
   and resumes the scan automatically.
4. Confirm the popup eventually reports the full report with the same final
   counts and phase `done`. The resume must not restart from zero and must
   produce identical counts.

Bare minimum to approximate this without real termination: run
`node test/run-tests.js` and watch `[Part 2] simulated worker termination
mid-scan` pass — it reproduces the exact storage-only resume path on the mock.

## Performance and verification record (2026-08-19)

The deterministic Node suite is a lower-bound check only. It uses mocked
Chrome APIs and does not establish real-Chrome wall-clock performance or
service-worker behaviour.

From `bookmark/extension/`, the exact verification commands are:

```
node --check test/real-chrome-full.mjs
node test/run-tests.js 3000 42
node test/real-chrome-full.mjs --output test/real-chrome-results.json
```

The real-Chrome run was attempted on Chrome/151. It is recorded in
`extension/test/real-chrome-results.json`, but CDP did not discover a loaded
extension target within the wait period. Therefore there is no valid scan
median and no termination, tree-integrity, network, or link-check measurement
from this run. This is a blocked verification result, not a pass.

Before running the real-Chrome command, start Chrome with remote debugging on
port 9222, load `bookmark/extension/` as an unpacked extension from
`chrome://extensions`, and keep the extension popup open or its service worker
active so that the extension target remains visible to CDP. The tool discovers
the extension ID at runtime and does not use a hardcoded ID. The results JSON
is an uncommitted test artifact.

## Milestone 2 detection (read-only cleanup findings)

### Backup export (always available, never gated)

The header has an always-visible **Back up library** button that exports the
**entire** bookmark tree to a restorable JSON file. The export carries a schema
name and version plus an `exportedAt` ISO stamp, followed by the full
`chrome.bookmarks.getTree()` output — it is never partial and is never gated
behind any permission, tier, or scan state. The popup downloads it as a JSON
file using a Blob URL (`<a download>`) with **no extra download permission**
required. See `extension/shared/backup.js`.

The export is the FR10 "back up before the first bulk delete" guard, shipped
here ahead of any destructive path, and also serves as a manual restore
artifact whenever the user wants one.

### Exact duplicate groups

Exact duplicates are detected from the persisted scan records by normalized
URL (lowercased host, default port stripped, fragment dropped, query
preserved). Groups are deterministic (sorted), and any record that is
soft-deleted (`deletedAt` set) is excluded, so a trash/undo recovery path can
never be the "original" a duplicate group deduplicates against. The Library
Report's **exact duplicates** row shows the total count and opens a read-only
list of the groups. See `extension/shared/cleanup.js`
(`computeDuplicateGroups`).

### Empty folders and same-name merge candidates

Empty folders (no descendant bookmark leaf) and same-name merge candidates
(folders sharing the same parent path and the same normalized folder name) are
detected from a **read-only** snapshot of the real bookmark tree at scan time,
persisted as `folderFindings`, and surfaced as exact counts in the Library
Report with read-only lists. The extension **never auto-merges** and never
moves or deletes a folder — it only reports candidates. See
`extension/shared/cleanup.js` (`analyzeFolders`, `normalizeFolderName`).

Chrome's built-in root containers — the synthetic top-level "bookmarks bar"
container and the standard Bookmarks bar, Other bookmarks, and Mobile
bookmarks roots (typically ids `0`–`3`) — are **never** reported as user empty
folders or same-name merge candidates. Only user-created folders are analyzed,
so a correctly cleared-out default tree "reports nothing" instead of flagging
the empty stock containers the browser ships by default. See
`extension/shared/cleanup.js` (`isBuiltInRootNode`).

### Opt-in dead-link checking (three-state, permission-gated)

Dead-link checking is **explicitly opt-in** and **never automatic** — it is not
part of the scan and it never fetches a bookmarked URL by itself. The popup's
**Check links** action explains that it needs temporary access, calls
`chrome.permissions.request({ origins: ['<all_urls>'] })`, and only then starts
the check (the service worker re-checks the permission before issuing any
fetch).

Results are strictly three-state per [PRD.md](PRD.md) §FR5:

| State | Meaning |
|---|---|
| `reachable` | Confirmed 2xx response (including after normal redirect following) |
| `unreachable` | Confirmed dead — HTTP **404 or 410** only |
| `could_not_check` | Everything uncertain: 401, 403, 429, 5xx, unresolved redirects, challenges, CORS and network errors, and timeouts |

Only a confirmed dead response (404/410) may be `unreachable`; nothing in
`could_not_check` is ever treated as dead. Link checks run in bounded chunks
with a per-request timeout (classified `could_not_check`) and checkpointed
state, resuming safely if the service worker is terminated. Results are written
back to each record's `linkStatus`/`linkCheckedAt` and summarized in the popup.
See `extension/shared/link-checker.js`.

If the optional host permission is later revoked, an in-flight check stops
safely with the already-collected results. No link check can run without that
permission.

### No-deletion guarantee

This milestone is **detection-only**. There is no `chrome.bookmarks.create /
update / remove / move` call anywhere in the extension, and no deletion, trash,
or undo mutation path. Folder merge candidates are only reported — never
merged. Every new read-only list in the popup (duplicates, empty folders,
merge candidates, link results) is informational.

## Metrics and proxies

Because the `chrome.bookmarks` API exposes **no complete open history**, the
open-history metrics report only what is provable from the data Chrome
actually records, using neutral language — never an absolute "never opened"
claim:

- A **recorded opening** is a positive `dateLastUsed` (Chrome 114+ records it
  when a bookmark is opened through the bookmark UI). The report exposes
  `openHistoryCount` (number of bookmarks with a recorded opening) and
  `openHistoryCoverage` (that count over the total), so the user can see how
  much of the library the open-history metrics actually cover.
- **"No recorded opening"** counts bookmarks whose `dateLastUsed` is absent or
  zero. This is distinct from "never opened": on older Chrome (or for any
  bookmark never opened through the bookmark UI) the metadata is simply not
  available, so the report never asserts the bookmark was never opened.
- **"Last recorded opening over 2 years ago"** counts only bookmarks with a
  positive `dateLastUsed` older than the 2-year threshold. Records with no
  recorded opening are **never** treated as stale — that would conflate
  "added a long time ago" with "not opened in a long time", which is not
  provable. There is no `dateAdded` fallback.

All other metrics are exact and computed from the scan alone: total, library
age (oldest→newest `dateAdded` span), exact-duplicate URL count, "New Folder"
nesting, top categories, and oldest bookmark.

The synthetic generator has two open-history modes. The **default** mode keeps
the older, generous ~70%-positive `dateLastUsed` spread for backward-compatible
fixtures. The **realistic** mode (`{ realistic: true }`, exercised as harness
`[Part 6]`) models real Chrome data where the large majority of older bookmarks
carry no `dateLastUsed` (Chrome didn't record it before ~114–117): records
added before a recording cutoff have none, and only a modest fraction of recent
records carry a positive one. Realistic mode exists so the report is exercised
against the sparse-open-history shape it will actually see, rather than
fabricating a friendly 70%-positive distribution.

## Categorization

Tier-1 rules only. The domain + URL/title keyword map ships as data
(`extension/shared/rules-data.json`) so it can be corrected without a release. Matching
is deterministic: exact domain, then URL phrase, then title phrase. Items
with no match fall back to a single neutral category (`Other`). No API key is
required and none is used.

## Storage schema

Records persist under the neutral key `records` in `chrome.storage.local`,
with the architecture's bookmark schema held on each record, including
`deletedAt: null` (soft-delete readiness for FR10) and `userCorrected`
(preserved across rescans). Milestone-1-out-of-scope fields carry honest,
neutral placeholders (e.g. `linkStatus: "unchecked"`, `summary: null`). See
`extension/shared/scan-controller.js` (`itemToRecord`).

Milestone 2 adds neutral storage:
- `folderFindings` — the read-only tree analysis (empty folders + same-name
  merge candidates) persisted at scan start;
- `linkStatus` / `linkCheckedAt` on each record — written only by the opt-in
  link checker, and only after the host permission is granted;
- `linkCheckpoint` / `linkReport` — the link checker's resumable progress and
  its exact three-state summary.

## Limitations and doc disagreements

- **Open-history reality gap**: the `chrome.bookmarks` API exposes no complete
  open history, so `dateLastUsed` is sparse on real libraries (Chrome only
  records it from ~114–117 and only for bookmark-UI opens). The report never
  claims "never opened"; it reports a neutral **no recorded opening** count, a
  provable stale count (only positive `dateLastUsed` older than 2 years), and
  the open-history coverage fraction so the provenance of those numbers is
  visible in the UI itself.
- **Link status nomenclature**: Milestone 2 aligns the schema with
  `TECHNICAL-ARCHITECTURE.md` §5. The three FR5 states are `reachable`,
  `unreachable`, `could_not_check` (the architecture's `confirmed_dead` /
  `uncertain` are expressed as these exact states). Before any opt-in check the
  schema holds `"unchecked"`, which is never presented as a reachability
  result.
- **Library age definition**: PRD's example "saved over 9 years" is taken as
  the span between the oldest and newest `dateAdded` (floor of years). A
  single-bookmark library therefore reports age 0.
- **Rules coverage is deliberately small** (a representative domain/keyword
  map). Production needs a much larger shipped map; the mechanism and
  neutral fallback are in place.
- **`mock-chrome` intentionally does not auto-fire timers**; it only records
  pending wakes, so the harness drives them explicitly.
- **Scan pacing**: within one active worker window the scanner processes
  chunks until its `ACTIVE_WINDOW_MS` budget is spent, then checkpoints,
  schedules the alarm for the next wake, and yields (per architecture §A).
  The Node mock is a lower-bound correctness/performance check only; no
  real-Chrome scan median has been established. The harness separately forces
  a real window boundary and drives the alarm/resume path deterministically.
- **UI**: the report surface is a popup (not a tab dashboard); filtered
  lists are read-only and rendered in-place, which satisfies the milestone's
  "popup or dashboard" allowance.
