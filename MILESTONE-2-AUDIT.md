# Milestone 2 — Audit

**Audited 2026-08-19** against the Milestone 2 brief. Commits `e0607ea` (reorganise + audit fixes) and `b54f66c` (Milestone 2 detection-only cleanup).

Checked against the code and by execution.

---

## Verdict

**The Milestone 2 build is strong and safe. But the Step 1 gate was skipped**, so the one acceptance criterion that has been outstanding since Milestone 1 is still outstanding — and link-checking has now been layered on top of it.

---

## Milestone 2 — verified as done ✅

| Requirement | Status |
|---|---|
| Committed before new work (Step 0) | ✅ Two clean commits |
| Backup export built **first** | ✅ `shared/backup.js` — versioned JSON of the full tree, `exportedAt` stamp, `isValidBackup` validator for a future restore path |
| Export never gated | ✅ `popup.js:274` — "always available, never gated" |
| Exact duplicate detection | ✅ With soft-delete exclusion |
| Empty folder + same-name merge detection | ✅ |
| Three-state link results | ✅ **Correctly conservative** — see below |
| No `<all_urls>` in `permissions` | ✅ Declared under `optional_host_permissions` only |
| Permission requested at point of use | ✅ `popup.js:351–360` via `chrome.permissions.request()` |
| **Still read-only — nothing deletes** | ✅ **Zero** `bookmarks.remove/update/move/create` anywhere in production code |
| Test suite | ✅ All pass, with substantial new link-check coverage |

### The link classifier is right

`link-checker.js` treats **only HTTP 404 and 410** as `unreachable`. CORS failures, timeouts, redirect failures, challenges, and non-web URLs all classify as `could_not_check`. That is the correct direction to be wrong in, and it satisfies FR5 and the MVP §5 requirement precisely.

The link-scan machinery also has its own chunking, its own budget (`LINK_CHUNK_SIZE = 25`, `LINK_ACTIVE_WINDOW_MS = 15000`), a **distinct alarm name** from the main scan, and tested handling for a rescan landing mid-link-check without thrashing. That is careful work.

---

## ❌ The Step 1 gate was skipped

The brief said, explicitly: *"Report these results before writing any Milestone 2 code."* Milestone 2 was built instead.

**What was genuinely attempted:** `test/real-chrome-full.mjs` is a real and well-built CDP probe — it measures wall-clock scan time, hashes the bookmark tree before and after, drives worker termination, and counts network requests by category. It carries a hardcoded real extension ID, so it ran against a live Chrome at least partially.

**What is missing:**

- **No measurements recorded anywhere.** No result artifact, and the README's performance paragraph is unchanged — still citing the Node mock's single-digit milliseconds.
- **Ten uncommitted scratch probes** in `extension/test/`: `cdp-probe.mjs`, `cdp-probe2.mjs`, `real-chrome-test.mjs`, `real-chrome-v2.mjs`, `real-chrome-full.mjs`, `check-sw.mjs`, `check-state.mjs`, `check-popup.mjs`, `check-ext.mjs`, `quick-check.mjs`. The numbered retries are the signature of repeated attempts that did not land.
- **Finding 3 is untouched.** `scan-controller.js:358–371` still runs `upsertRecords` over the whole array and writes `KEYS.RECORDS` entire on every chunk. `ACTIVE_WINDOW_MS = 20000` and `ALARM_MINUTES = 1` are unchanged.

**Why this now matters more than it did:** link-checking adds real network I/O on top of a scan whose wall-clock cost was never established. The unmeasured baseline is now carrying a second, heavier feature.

---

## Still outstanding — unchanged since Milestone 1

| Acceptance criterion | Status |
|---|---|
| Median scan < 90 s on 3,000+ bookmarks, in a browser | ❌ Not measured |
| Real service-worker termination (not the Node simulation) | ❌ Not confirmed |
| `chrome://bookmarks` unchanged before/after | ❌ Not confirmed in a browser |
| Zero network requests to bookmarked URLs during a scan | ❌ Not confirmed in DevTools |

The probe already automates all four. It needs to be finished, run, and its output recorded.

---

## Required before Milestone 3

Milestone 3 is the **deletion** milestone. It must not begin while the layer beneath it has an unverified performance profile and an unrun safety verification.

1. Finish and run `real-chrome-full.mjs`; record the numbers in the README
2. Fix Finding 3 if the median misses 90 s
3. Commit the probe as a real tool; delete the scratch retries

---

# Follow-up — 2026-08-19: CDP measurement abandoned

Commit `135b429` "Add real Chrome verification tool". Scratch retries deleted, probe committed properly. ✅

## The agent reported honestly — credit where due

`real-chrome-full.mjs` ran against Chrome 151 and **failed to obtain a usable extension context**. The recorded artifact does not fake a pass:

```json
"bookmarkCount": 0, "scans": [], "scanMedianMs": 0,
"bookmarksUnchanged": false,
"workerTest": { "terminated": false, "resumed": false, "killConfirmed": false },
"errors": ["extension-apis-unavailable: ... not exposed in discovered context"]
```

`bookmarksUnchanged` is recorded as **`false`**, not defaulted to true. Zero counts are explicitly declared invalid rather than reported as "0 network requests, criterion met." The agent also declined to optimise without a baseline and did not start Milestone 3. All correct.

## The approach is what failed, not the effort

Three consecutive briefs have asked for this measurement and produced no number. The likely cause is mundane and hard to defeat: **an MV3 service worker terminates after ~30 s idle**, so a CDP session that discovers the target and then evaluates against it is racing the very lifecycle this extension is built around. Driving `chrome.*` through an external debugger is the wrong tool here.

## Decision: measure from inside the extension

**Stop automating the browser. Instrument the extension to measure itself.**

The scan controller already takes an injected `getNow()`. Persisting `scanStartedAt` / `scanCompletedAt` alongside the checkpoint gives an exact wall-clock duration that:

- needs no CDP, no headless mode, and no debugger session
- works identically in Chrome, Brave and Edge — all three already confirmed loading
- **survives worker termination**, because it lives in storage like everything else
- carries genuine product value: *"Scanned 3,142 bookmarks in 12s"* is reassuring UX, and it is the same number the ≥90 s acceptance criterion needs

The remaining criteria do not need automation either:

| Criterion | How |
|---|---|
| Median scan time | Read off the popup, 3 runs |
| Tree unchanged | Export bookmarks HTML from `chrome://bookmarks` before and after; diff |
| Worker termination | `chrome://serviceworker-internals` → **Stop** mid-scan; confirm resume |
| No network to bookmarked URLs | DevTools Network panel on the service worker |

`real-chrome-full.mjs` stays in the tree as a future CI asset. It is not the path to a number today.
