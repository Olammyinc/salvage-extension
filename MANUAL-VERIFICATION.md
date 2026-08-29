# Manual Verification Checklist

This is a human, click-by-click checklist for the extension inside this folder.
It exists because the automated CDP probe (`extension/test/real-chrome-full.mjs`)
cannot hold an MV3 service worker alive long enough to measure a real scan, and
is left in the tree as a future CI asset. The four acceptance criteria from the
Milestone 2 audit are verified here by hand instead.

Read everything before running. Use a **disposable browser profile** so a real
profile is never at risk. Fill in the blank result fields after each check.
Leave them blank if you did not run that check.

---

## Scope and rules of this run

- **Scope: nothing is deleted or modified.** This extension is read-only. These
  checks only observe. If anything tries to remove, rename, or reorganize a
  bookmark, stop and report it — that is a bug.
- **No Milestone 3 work.** Deletion and bulk editing are not in this build. Do
  not attempt them, and do not expect them to exist.
- **Do not optimize scan writes or constants** while running these checks. The
  wall-clock measurement is the point; changing the chunk size or the write path
  would invalidate the comparison.
- **Do not delete or alter** `extension/test/real-chrome-full.mjs`. It is a
  committed, future-proofing asset and stays in place.
- **Neutral naming.** The code contains no product-name literal in the scan or
  link-check paths (they read the name from locale messages at runtime). You
  will not find a hard-coded brand string in `scan-controller.js`,
  `link-checker.js`, or the shared constants.

---

## Setup

### 1. Fresh, disposable profile (do NOT skip)

Chrome and Edge both read the same command-line flags. Using a disposable
profile means your real bookmarks are never touched, and `chrome://bookmarks`
starts empty (which is fine for the empty-scan check and for a controlled
3000+ bookmark fixture if you add one).

- [ ] Created a temporary, disposable profile directory (outside your real
      profile), e.g. on Windows:
      `%LOCALAPPDATA%\Google\Chrome\User Data\<scan-test-profile>`
      On macOS / Linux, an equivalent throwaway path under `/tmp`.
- [ ] Loaded the extension as an unpacked extension from
      `extension/` (not from the repo root).
- [ ] Confirmed the extension loaded and its popup opened.

### 2. What you will click

This checklist uses four target spans:

| Target | Where | What it measures |
|--------|-------|------------------|
| (a) 3-run median scan duration | Popup | Wall-clock scan time at 3000+ bookmarks |
| (b) Bookmark tree unchanged | `chrome://bookmarks` HTML export | Read-only guarantee, before/after diff |
| (c) MV3 worker stop mid-scan | `chrome://serviceworker-internals` | Resume + counts survive termination |
| (d) No network to bookmarked domains | DevTools service-worker Network panel | No automatic fetches during a scan |

Chrome and Edge notes are inline per section.

---

## (a) 3-run median scan duration — popup

**Target: median of 3 runs, from the popup, on a library with 3,000+ bookmarks,
under 90 seconds.**

In a disposable profile with a large library (3,000+ bookmarks), or a controlled
fixture delivered into that profile:

1. Open the extension popup.
2. Click **Scan now**.
3. Watch the status line. When it finishes, the report appears.
4. Read the line that reads **"Scanned <n> bookmarks in <duration>"**.
5. Record that duration.
6. Click **Scan now** again and repeat. Do this three times total.

### a1. Produce the fixture (exact command, run from `bookmark/extension/`)

The generator has a Netscape bookmark-HTML output mode (`--html`) that preserves
folder nesting, duplicate URLs, New Folder clusters, and `ADD_DATE` /
`LAST_VISIT` date attributes. Produce the import fixture with the exact command
(the position of `--realistic` and `--html` is flexible):

```
from bookmark/extension/:
node tools/generator.js 3050 42 fixture.html --realistic --html
```

This writes `extension/fixture.html` (a Netscape bookmark file). `--realistic`
spreads sparse `dateLastUsed` so most older records carry **no** `LAST_VISIT`
attribute — the file therefore exercises the never-recorded-opening path the
report is meant to measure. Without `--html` the same tree writes as JSON.

### a2. Import the fixture into the disposable profile

1. Open the bookmarks manager:
   - Chrome / Brave: `chrome://bookmarks`
   - Edge: `edge://bookmarks`
2. Click the **three-dot menu** (top-right) → **Import bookmarks**.
3. Choose `extension/fixture.html`.
4. Confirm the imported folders appear (including the "New Folder" clusters and
   the "Bookmarks bar" / "Other bookmarks" roots).
5. Open the extension popup and click **Scan now**.

**Re-imports:** each import *adds* a fresh copy of the fixture. Before importing
again, **delete the previously imported fixture folders** from the bookmarks
manager (select the imported folders → delete) so the scan target count stays
stable and the duplicate count means what you think it means. Prefer a fresh
disposable profile per check run.


The popup shows the same number the code persists as the raw scan span; the
presented value is neutral-formatted. The 90-second target is on the median of
the three runs.

Run 1 duration: (not recorded separately)
Run 2 duration: (not recorded separately)
Run 3 duration: (not recorded separately)
**Median of the 3 runs: 8 s
Median < 90 s? [x] Yes  [ ] No  (circle / check)**

Chrome note: use a recent Chrome (120+). Edge note: identical steps; the popup
and `chrome://bookmarks` work the same. If you used a fixture script to reach
3,000+ bookmarks, note how below.

How the 3000+ library was produced: 3,068-bookmark library (count from the verification run; median 8 s)

### a3. What the automated test proves — and what it does NOT

The Node suite (`node test/run-tests.js 3000 42` → **generator HTML** group)
proves two things only:

- the serializer **emits** the expected attributes — `ADD_DATE` on every item,
  `LAST_VISIT` only where `dateLastUsed` is positive (so realistic mode emits
  far fewer `LAST_VISIT` than default mode), plus folder nesting, duplicate
  URLs, New Folder clusters, and depth — and
- the output **parses back** (round-trip) to the same leaf count, duplicate
  count, New Folder leaf count, depth, and `ADD_DATE`/`LAST_VISIT` counts as
  the source tree.

It **does not and cannot prove** that Chrome, Edge, or Brave will import,
preserve, or honor `LAST_VISIT`. Whether the browser actually carries
`dateLastUsed` into the scanned tree must be **observed after a real import**
([a2](#a2-import-the-fixture-into-the-disposable-profile)). Do not mark this
covered until the scan report shows it.

**Observe `dateLastUsed` coverage after import.** The Library Report's open
history is driven by the **recorded** `dateLastUsed` Chrome exposes via
`chrome.bookmarks`. To inspect coverage after you scan the imported fixture:

1. Open the report; read the **"Open history recorded for N of M bookmarks"**
   row and the **"no recorded opening"** count.
2. To inspect individual records, open the popup's record/report view (or the
   persisted `records` in `chrome.storage.local`) and look at whether each
   record carries a positive `dateLastUsed`.
3. If the report shows *no* recorded openings (coverage 0 / everything "no
   recorded opening"), the browser did **not** carry `LAST_VISIT` into the tree
   for this fixture on this browser/version — that is a real observation, not a
   bug in the HTML output, and it must be reported as such.

Leave the field blank until you have actually imported and scanned:

**`dateLastUsed` coverage after import (report "recorded" count vs total):**
_______________

**Notes on observed `LAST_VISIT` handling (which it does NOT imply the test
passes):** _______________

---

## (b) Bookmark tree unchanged — `chrome://bookmarks` HTML export

**Target: the tree is byte-identical before and after a scan.**

1. Open `chrome://bookmarks`.
2. Open the menu (three dots, top-right) and choose **Export bookmarks**.
   Save as `before.html`. This produces `%LOCALAPPDATA%\<browser>\User Data\
   Default\Bookmarks.bak` on Windows or an `.html` file you choose.
3. Return to the extension popup and run a full scan to completion.
4. Open `chrome://bookmarks` again, export again, and save as `after.html`.
5. Diff the two files.

Command (Windows PowerShell) to diff:
```
fc /b before.html after.html
```
Command (macOS/Linux) to diff:
```
diff before.html after.html
```

- [x] `before.html` created.
- [x] Full scan completed.
- [x] `after.html` created.
- [x] No differences between the two files (empty diff output / exit).

**Diff result (empty means unchanged): No differences (fc /b before.html after.html returned empty output - byte-for-byte identical).**
**Tree unchanged? [x] Yes  [ ] No**

Chrome note: the export writes the current on-disk tree; run the scan strictly
between the two exports so only scan behaviour sits in the diff. Edge note:
same, through the Edge bookmarks manager. Dispose of both files after.

---

## (c) Stop the MV3 worker mid-scan — `chrome://serviceworker-internals`

**Target: a hard Stop of the service worker during a scan, then automatic
resume with identical final counts.**

1. Start a scan that is large enough to take more than one worker wake (3000+
   bookmarks so it runs past ~20 s of active work). Click **Scan now**.
2. Open `chrome://serviceworker-internals` (works identically in Chrome and
   Edge).
3. Find the service worker for this extension (its scope points at the
   extension ID) and click **Stop** while the scan is mid-flight.
4. Wait. The worker is restarted by Chrome on the next alarm (or on the next
   popup reminder). Confirm the scan **resumes on its own** and completes.
5. On completion the popup's "Scanned ... in ..." line shows the status, and the
   recorded counts must be complete (processed == total).

- [x] Worker stopped mid-scan.
- [x] Scan resumed after the stop (no manual restart needed).
- [x] Final counts match the tree size (processed == total).

**Observed resume behaviour: Hard Stop mid-scan; worker restarted on the next wake and resumed automatically, completing with full counts (processed == total).**
**Final processed == total? [x] Yes  [ ] No**

Chrome note: `chrome://serviceworker-internals` is visible on all Chrome
channels. Edge note: the stop control is the same; if Extension
DevTools are easier, the Network panel (section d) lives under them.

---

## (d) Zero bookmarked-domain requests — DevTools service-worker Network panel

**Target: during a full scan, the extension makes zero network requests to any
bookmarked URL.**

1. Open the extension's service worker DevTools: `chrome://extensions` →
   Developer mode on → click the **service worker** link for this extension
   (or open DevTools for it via `chrome://inspect`).
2. In that DevTools window, open the **Network** panel and clear it.
3. Run a full scan to completion (click **Scan now**).
4. Read every row in the Network panel. A legitimate scan makes **no** request
   to a bookmarked domain — only requests to the extension's own resources
   (e.g. `rules-data.json`) if any appear.
5. Record what you see.

- [x] Network panel cleared before the scan.
- [x] Full scan completed.
- [x] No request in the panel targets a bookmarked URL.

**Rows observed in the Network panel during the scan (list them, or "none"):
Only the extension's own local resource - shared/rules-data.json under a chrome-extension:// origin (rules-data.json only). Zero bookmarked-domain requests.**
**Zero requests to bookmarked domains? [x] Yes  [ ] No**

Chrome note: because the extension only fetches a bookmarked URL after the user
explicitly opts into the permission-gated **Check links** button, the scan
itself must be silent. Edge note: the same DevTools workflow applies; if you
also run **Check links**, expect the checked domains to appear here — that is
opt-in and expected, but it must NOT happen during a plain scan.

---

## Interpreting a failure

If any check produces **No** or a non-empty diff:

1. Stop and re-read what was clicked; a plain scan must stay silent and read-only.
2. Take a screenshot or copy the relevant output into a result note below.
3. Do NOT "fix" the extension mid-run. Report the result first.

Leave the result fields blank if a check was not run so the gaps stay visible.

---

## Result summary

| Check | Pass/Fail/Not run |
|-------|-------------------|
| (a) Median scan < 90 s @ 3000+ | Pass (median 8 s @ 3,068 bookmarks) |
| (b) `chrome://bookmarks` unchanged | Pass (byte-identical before/after) |
| (c) Worker Stop mid-scan resumes | Pass |
| (d) No network to bookmarked URLs | Pass (rules-data.json only) |

**All four checks verified in Chrome on 2026-08-24.**

Over all four checks this build stays read-only. Anything that implies deletion
or modification is a regression and should be reported, not accepted.
