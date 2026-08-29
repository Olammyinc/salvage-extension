# Milestone 1 — Audit

**Audited 2026-08-19** against [BUILD-HANDOFF.md](BUILD-HANDOFF.md). Commit `3378854` "Build Milestone 1 extension scaffold".

Findings were checked against the code and by execution, not taken from the commit message or the README.

---

## Verdict

**Strong build. Three issues must close before Milestone 2.** One is critical to the hero feature's credibility, one is a confirmed bug, one is an unmeasured acceptance criterion.

---

## Verified as done ✅

| Contract item | Status |
|---|---|
| MV3 manifest, Chrome + Edge | ✅ |
| Permissions exactly `bookmarks, storage, alarms, activeTab` | ✅ **No `<all_urls>`** — verified in [manifest.json](extension/manifest.json) |
| No product name in code, manifest, or storage keys | ✅ Name is `__MSG_extensionName__`, resolved from `extension/_locales/en/messages.json`; storage keys are neutral (`checkpoint`, `queue`, `records`). **Rename really is one edit.** |
| Chunked scan (75/chunk), checkpointed every chunk | ✅ |
| `chrome.alarms`, never `setTimeout`/`setInterval` | ✅ |
| No global scan state | ✅ Storage is the only source of truth. The controller-local single-flight tail holds no scan data and is documented. |
| Resume from checkpoint on worker startup | ✅ `handleResume()` at top level |
| Idempotent on replay | ✅ `upsertRecords` merges by id and preserves `userCorrected` |
| Rules-based categorization from a data file | ✅ `extension/shared/rules-data.json` |
| Report renders from the rules pass alone, no page fetches | ✅ |
| Read-only — no writes to the bookmark tree | ✅ No `chrome.bookmarks` mutation anywhere |
| No network to bookmarked URLs | ✅ Only `runtime.getURL` for local rules data |
| Synthetic generator committed | ✅ Seeded, deterministic, 3,000 items |
| Test suite | ✅ **All pass**, including simulated termination boundary, resume, rescan pruning, and concurrent-rescan safety |

The dependency-injection design — the controller takes `storageGet`/`scheduleWake`/`getNow` and the tests drive the same code path with mocks — is better than the handoff asked for and makes the resume logic genuinely verifiable. Credit where due.

---

## Finding 1 — CRITICAL: the "never opened" metric is false on real Chrome data

**The hero screen makes an absolute factual claim it cannot support.**

`extension/shared/report.js:48` treats a `dateLastUsed` that is absent **or zero** as *"never opened, not even once."*

Chrome only began populating `dateLastUsed` around Chrome 114–117, and only records it when a bookmark is opened through the bookmark UI. **On a real decade-old library, most bookmarks will carry no `dateLastUsed` regardless of how often they were actually opened.** The report will therefore tell users that the large majority of their library was "never opened, not even once" — and it will be wrong.

**Why the tests did not catch it:** `extension/tools/generator.js` sets `OPENED_FRACTION = 0.7`, fabricating a friendly distribution where 70% of bookmarks have a real `dateLastUsed`. Real Chrome data is nothing like this. The harness output — *"886 never opened"* out of 3,000 — looks plausible precisely because the mock data is generous.

**The same defect affects the 2-year metric.** `lastActivityMs` falls back to `dateAdded`, so *"not opened in over 2 years"* actually means *"added over 2 years ago"* for any record without `dateLastUsed`.

**This violates two standing rules:**
- [PRD.md](PRD.md) §10.9 — *"Exact counts, never estimates."*
- [MVP.md](MVP.md) — *"Never shame the user."* Telling someone their decade of saved things was never opened, incorrectly, is the worst version of this.

**The README is honest about the proxy** (it calls it "the largest honest limitation") and that is the right instinct — but a disclosure in a README does not repair a definitive claim in the UI. The fix is to the metric or the copy, not to the documentation.

---

## Finding 2 — BUG (confirmed by execution): an empty library hangs forever

A library with zero bookmarks leaves the extension permanently in `phase: scanning` with no report and **no scheduled alarm**, so it never recovers.

`extension/shared/scan-controller.js` guards with `cp.processedCount >= cp.totalCount`. With `totalCount = 0`, `0 >= 0` is true, so it returns before ever reaching `finishScan`.

Reproduced directly against the real controller:

```
checkpoint: {"phase":"scanning","totalCount":0,"processedCount":0,...}
report: null
alarms scheduled: 0
```

Hits any user with an empty or near-empty bookmark tree, and any fresh test profile.

---

## Finding 3 — UNMEASURED: the <90 second acceptance criterion

The handoff requires a median scan under 90 seconds for 3,000+ bookmarks. **This has not been measured in a real browser**, and two design choices put it at risk:

1. **`ACTIVE_WINDOW_MS = 20000` with `ALARM_MINUTES = 1`.** Any scan needing more than one active window pays a **full minute** of dead time per additional window. Two windows already breaches 90 seconds.
2. **`upsertRecords` rewrites the entire records array to storage on every chunk.** At 3,000 bookmarks and 75 per chunk that is ~40 writes of a growing array — roughly 60,000 record-serializations, i.e. **O(n²) storage I/O**.

The test harness uses mocked storage and injected time, so it proves the resume logic is correct but says nothing about wall-clock performance. **Correctness is verified; speed is unknown.**

Related: the README documents the real-Chrome termination procedure, but the evidence suggests only the Node simulation was run. The handoff called an untested-against-real-termination scan "not done."

---

## Required before Milestone 2

1. Make the open-history metrics truthful — change the metric, the copy, or both
2. Fix the empty-library hang
3. Measure a real 3,000-bookmark scan in Chrome, and run the real termination test

Milestone 2 (cleanup: duplicates, dead links, empty folders) is the first milestone that **deletes things**. It should not start on top of an unresolved correctness issue in the layer beneath it.

---

# Re-audit — 2026-08-19 (second pass)

Code has since been reorganised under `extension/`. **The work is uncommitted; `3378854` is still HEAD.** Findings re-checked against the code and by execution.

## Finding 1 — ✅ FIXED, thoroughly

`isNeverOpened` is replaced by `hasRecordedOpening`, which asserts only what the data supports. The `dateAdded` fallback in the stale metric is gone — `isStaleOverYears` now counts only records with a genuine recorded opening older than the threshold, so it no longer misreads "added long ago" as "not opened".

The user-visible copy is now truthful:

| Was | Now |
|---|---|
| "886 never opened, not even once" | **"886 with no recorded opening"** |
| "1,868 not opened in over 2 years" | **"1,173 last recorded opening over 2 years ago"** |

The requested instrumentation counter was added *and surfaced in the UI*: **"Open history recorded for 2,114 of 3,000 bookmarks (70%)."** That is a better answer than asked for — it makes the limitation visible to the user rather than only to us.

`tools/generator.js` gained a `--realistic` mode modelling Chrome's actual recording behaviour, and **Part 6** of the harness tests truthfulness under it — including an explicit assertion that the report carries **no absolute never-opened claim**. That is a real regression guard on the exact defect.

## Finding 2 — ✅ FIXED, verified by execution

Re-ran the original repro against the current controller:

```
phase: done
report present: true
report total: 0
```

**Part 7** of the harness now covers the empty tree: reaches DONE, persists a valid zero report, clears alarms, and stays DONE on resume.

## Finding 3 — ⚠️ STILL OPEN (but honestly reported)

Not fixed, and not claimed to be. Unchanged:

- `ACTIVE_WINDOW_MS = 20000`, `ALARM_MINUTES = 1` — a second window still costs a full minute
- `scan-controller.js:347–360` still calls `upsertRecords` over the whole array and writes `KEYS.RECORDS` entire on every chunk — **O(n²) storage I/O is unchanged**

**Credit for the disclosure:** the README states the Node figure "is a lower bound on real-Chrome wall time, not a substitute for the Chrome-device termination test." That is exactly the right framing and the opposite of overclaiming.

**But it remains unmeasured.** Single-digit milliseconds against a mocked in-memory store says nothing about `chrome.storage.local` under 40 growing-array writes.

## Milestone 1 status

| Definition-of-done item | Status |
|---|---|
| Loads unpacked in Chrome and Edge | ✅ **Confirmed by owner** — also Brave |
| Survives real service-worker termination mid-scan | ❌ Node simulation only |
| Median scan < 90 s on 3,000+ bookmarks | ❌ Not measured in a browser |
| Report counts exact and truthful | ✅ |
| `chrome://bookmarks` unchanged after a scan | ❌ Not verified in a browser |
| Zero network requests to bookmarked URLs | ✅ In code; ❌ not verified in DevTools |
| Empty-library handling | ✅ |

**Milestone 1 is functionally complete and correct. What remains is browser-side verification, not building** — plus committing the work, which is currently at risk sitting uncommitted.
