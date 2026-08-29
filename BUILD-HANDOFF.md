# Build Handoff — Milestone 1

**Created 2026-08-19.** Read this before writing any code. It is the build contract for the first milestone.

## Roles

- **Building agent (you):** implements Milestone 1 in this repo.
- **Oversight (Claude, separate session):** audits the result against the docs. Claims are checked against code, not accepted from the summary.

Report what actually happened. If something does not work, say so with the output. A milestone reported as done and found broken on audit is worse than one reported as partial.

---

## Product in one line

**A bookmark rescue tool, not a bookmark manager.** Every competitor is a better place to save things from now on; this one fixes the decade of mess the user already has.

## ✅ The product is named **Salvage** (selected 2026-08-20)

Rationale and the full screening record are in [BRAND-PACK.md](BRAND-PACK.md) §12A. The earlier candidates — Linkwise, Cairn, Waypoint, Bindery, Almanac, Reckon — are all superseded and must not reappear.

**The naming discipline that made this rename cheap still applies, unchanged:**

- The literal name lives in **`extension/_locales/en/messages.json`** (`extensionName`) and nowhere else. It is read at runtime via `chrome.i18n.getMessage`.
- Internal identifiers stay neutral: storage keys, alarm names, schema version, CSS prefixes, class names. **Never embed the product name in a storage key** — migrating those later means migrating real user data for no reason.
- Do not inline "Salvage" in components, filenames, or the manifest. The manifest uses `__MSG_extensionName__`.

That discipline is why this rename was one file. Keep it that way — trademark clearance is still outstanding and the name could yet move.

**Still open:** formal USPTO/EUIPO class 9 and 42 clearance before the store listing goes live. Not a build blocker.

## Source of truth

| Doc | Governs |
|---|---|
| [PRD.md](PRD.md) | Requirements. §10.9 Library Report, §15 MVP scope, FR10 data safety, §24 GTM |
| [MVP.md](MVP.md) | Scope in and out |
| [ROADMAP.md](ROADMAP.md) | Build order (Phase 1, items 1–13) |
| [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) | Stack, service-worker lifecycle, permissions |
| [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) | §2A — the verified install data behind these priorities |

**All were revised 2026-08-19.** If code and docs disagree, stop and raise it — do not silently pick one.

---

## Milestone 1 scope

ROADMAP Phase 1, items **1–4 only**.

1. **Extension scaffold** — Manifest V3, Chrome + Edge
2. **Bookmark import and scan** — chunked, checkpointed, resumable
3. **Storage model with soft-delete** — the schema every later feature depends on
4. **Rules-based categorization** — domain map shipped as data
5. **⭐ The Library Report** — the hero screen

### Explicitly NOT in Milestone 1

Do not build these, even if they seem quick:

- ❌ Any deletion or destructive action of any kind
- ❌ Any network request to a bookmarked URL (no dead-link checking yet)
- ❌ Any AI or LLM call, any API key handling
- ❌ Search, smart lists, summaries, settings beyond the minimum
- ❌ Payments or licensing

Milestone 1 is **read-only**. It cannot damage a user's library, which is what makes it safe to ship early and test on a real one.

---

## Non-negotiables

### 1. Service-worker lifecycle — the most likely way to ship a broken v1

Chrome kills an idle MV3 service worker after ~30 seconds and destroys all in-memory state. A 3,000-bookmark scan cannot run as a single background pass. See [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) §A.

- Chunk the scan (~50–100 bookmarks per chunk)
- Checkpoint to `chrome.storage` after every chunk: `{ lastProcessedId, processedCount, totalCount, phase }`
- Use **`chrome.alarms`**, never `setTimeout`/`setInterval`
- On worker startup, always read the checkpoint and resume
- Surface progress to the UI **from persisted state, never from memory**
- **Never** store scan state in a global variable
- Every operation must be idempotent on resume — reprocessing a chunk must be harmless

**This must be right from the first commit.** Retrofitting it means rewriting the scan.

### 2. Permissions — request narrowly

At install, request only: `bookmarks`, `storage`, `alarms`, `activeTab`.

**Do not request `<all_urls>`.** It produces the "Read and change all your data on all websites" prompt, which suppresses install conversion and contradicts the privacy positioning. Broad host permissions are declared under `optional_host_permissions` and requested at point of use in a later milestone.

### 3. Soft-delete from day one

Even though Milestone 1 deletes nothing, the storage model must support FR10: soft-delete with 30-day recovery, and an undo path. Getting the schema right now is why this is Milestone 1 work.

### 4. Categorization is rules-only in this milestone

- Domain map + URL/title keywords: `github.com` → Development, `allrecipes.com` → Recipes
- **Ship the map as a data file, not as code**, so it can be corrected without a release
- **The Library Report must render completely from this pass alone.** AI arrives later as async refinement and must never be a prerequisite for the hero screen.
- **Never require a user-supplied API key** — the single clearest failure mode across every verified competitor

---

## The Library Report — the hero

Full spec in [PRD.md](PRD.md) §10.9. Shape:

```
Your library: 3,142 bookmarks, saved over 9 years

  47      exact duplicates                      →  Review
  218     in folders named "New Folder"         →  Sort these
  1,104   not opened in over 2 years            →  Review
  891     never opened, not even once           →  Review

  Your biggest topics:  Development (612) · Recipes (388) · Travel (204)
  Oldest bookmark:      March 2017
```

Requirements:

- **Generated from the scan alone — no page fetches.** It has to be fast.
- **Exact counts, never estimates.**
- Every number is clickable through to the real bookmarks. In Milestone 1 the destination is a read-only list; the remedial actions come later.
- **Never shame the user.** This is someone's decade of saved things. Report neutrally — no "junk", no "clutter", no emoji-scolding.

This screen is the demo, the store screenshot, and the reason anyone shares the product. If only one thing in Milestone 1 is excellent, it is this.

---

## Definition of done

1. Loads unpacked in Chrome **and** Edge without errors
2. Scans a **3,000+ bookmark library** end to end — **median under 90 seconds** ([PRD.md](PRD.md) §19)
3. **Survives service-worker termination mid-scan and resumes correctly.** Test this explicitly: kill the worker from `chrome://serviceworker-internals` (or DevTools) partway through and confirm the scan completes with correct final counts. **A scan that has not been tested against termination is not done.**
4. Library Report renders with exact, correct counts
5. Zero writes to the user's bookmark tree — verify `chrome://bookmarks` is byte-identical before and after a scan
6. No network requests to bookmarked URLs — verify in the Network panel
7. A README explaining how to load it unpacked and how to run the termination test

### How to test without 3,000 real bookmarks

Write a generator that produces a synthetic bookmark tree — realistic folder nesting, duplicates, "New Folder" clusters, old timestamps. Commit it. It is needed for every later milestone too.

---

## Report back with

- What was built, and what was not
- The measured scan time on 3,000 bookmarks
- **The result of the termination test, specifically**
- Anything in the docs that turned out to be wrong, unclear, or contradictory
- Anything you had to decide that the docs did not cover

Flag disagreements rather than working around them silently.
