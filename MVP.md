# MVP Plan

## Product

**Salvage**

## Status

Revised 2026-08-16. Scope tightened; summaries and broken-link detection moved out. See [PRD.md](PRD.md) §15, [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md), and [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md).

**Revised again 2026-08-19 following live Chrome Web Store verification ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A). Three changes:**

1. **Broken-link detection moved back INTO the MVP.** Every cleanup tool with meaningful installs leads with dead links alongside duplicates. Shipping without it means shipping something weaker than a free extension abandoned in 2024.
2. **AI categorization repositioned** — still in the MVP, no longer the headline, and now rules-first with AI as an accuracy upgrade. Every AI-first organizer verified is under 1,000 users; the two with enough users to be rated scored 1.0★ and 1.8★.
3. **Parity features added** from the 200,000-user incumbent's own reviews: show folder location, edit a bookmark, select-all-duplicates.

## What this product is

**A bookmark rescue tool, not a bookmark manager.** Every competitor is a better place to save things from now on; this one fixes the decade of mess you already have. That positioning is settled — see [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6.

## Purpose of the MVP

The MVP exists to test **one assumption**:

> Showing someone the true state of the bookmark library they gave up on is compelling enough that they will act on it — and then keep the tool.

Everything not required to test that assumption is out of scope. The previous version of this plan was a 3–6 month solo build, which is a v1, not an MVP.

---

## MVP Goal

Build a browser extension for Chrome and Edge that, within about a minute of install:

1. **Shows the user the true state of their bookmark library** — the Library Report ⭐
2. **Safely removes exact duplicates, dead links, and empty folders** — the proven-demand job
3. Makes every bookmark **instantly searchable**
4. Groups the library by topic — rules first, AI as the accuracy upgrade

*(Reordered 2026-08-19. Cleanup moved from 4th to 2nd and AI from 3rd to 4th, to match where verified install demand actually is — [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A.)*

**Target: shippable in weeks, not months.** If the assumption above is wrong, that needs to be discovered cheaply.

---

## 0. The Library Report ⭐ — the hero feature

**Build this first. If it is not excellent, nothing else matters.**

Full specification in [PRD.md](PRD.md) §10.9. In short: immediately after the first scan, one screen showing exactly what is in the library and what is wrong with it —

```
Your library: 3,142 bookmarks, saved over 9 years

  47      exact duplicates                      →  Review
  218     in folders named "New Folder"         →  Sort these
  1,104   not opened in over 2 years            →  Review
  891     never opened, not even once           →  Review

  Your biggest topics:  Development (612) · Recipes (388) · Travel (204)
  Oldest bookmark:      March 2017
```

### Why it is P0

- It is **the demo** — the Chrome Web Store screenshot, the Reddit post, the 20-second video
- It is **the differentiator** — no competitor does this; they all open on an empty state
- It **drives activation** — every line is a button, so install-to-first-action collapses to one click
- It **proves value before asking for anything** — no setup, no configuration, no account

### Non-negotiables

- Generated from the scan alone — **no page fetches**. It has to be fast.
- Every number clickable through to the real bookmarks
- Every remedial action routes through [PRD.md](PRD.md) **FR10** — nothing pre-selected, everything previewed, everything undoable
- Exact counts, never estimates
- **Never shame the user.** This is someone's decade of saved things. Report neutrally; no "junk", no "clutter".

### Success measure

Report shown → at least one remedial action taken: **≥ 40%**.

---

---

## Core MVP Features

## 1. Bookmark Import

### Included
- import bookmarks from Chrome and Edge
- read bookmark folders and links
- preserve source folder information
- rescan bookmarks on demand

### Why it matters
Without import, the product has no foundation.

---

## 2. Categorization and Tagging — rules first, AI as the upgrade

*(Repositioned 2026-08-19. Still in the MVP. No longer the headline, and no longer AI-first by default.)*

### Why it stays in the MVP

Categorization is **load-bearing for the hero feature**. The Library Report's topic line — *"Your biggest topics: Development (612) · Recipes (388) · Travel (204)"* — cannot exist without it. It is a dependency of the Report, not a feature competing with it.

### Why it is no longer the headline

Verified installs ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A): no AI-first bookmark organizer has cleared 1,000 users, and the two rated ones scored 1.0★ and 1.8★. Their reviews blame bring-your-own-API-key friction and categories that felt generic rather than derived from the user's actual bookmarks.

### Required architecture — two tiers

This is the layering [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) §3 already specified ("local classification rules first, optional API-based AI"), now mandatory rather than optional.

| Tier | Mechanism | Cost | Latency | Coverage |
|---|---|---|---|---|
| **1 — Rules** | Domain-map + URL/title keywords (`github.com` → Development, `allrecipes.com` → Recipes) | $0 | instant | the bulk of a typical library |
| **2 — AI** | Classify only what tier 1 could not, on-device where eligible, cloud otherwise | ~$0.26/user ([UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §4) | async | the ambiguous remainder |

**Non-negotiables:**
- **Never require the user's own API key.** This is the single clearest failure mode in the verified competitor set.
- **The Report must render fully from tier 1 alone.** AI classification arrives asynchronously and refines it. A user whose device is ineligible for on-device AI, or who is offline, still gets the complete hero moment.
- Ship the domain map as data, not code, so it can be corrected without a release.

### Included
- classify bookmarks by topic
- auto-assign tags
- suggest categories like Work, Shopping, Travel, Books, Movies, Learning, Tools, Research, Events

### Why it matters
It makes the Report legible and search filterable. It is **not** the reason anyone will install — that is §5.

---

## 3. Smart Lists — deferred to Phase 2

Moved out of the MVP on 2026-08-16. Smart lists are a layer built on top of tags: if the tags are wrong, the lists are wrong, and shipping both at once makes it impossible to tell which one failed. Prove tagging quality first (target: ≥80% category acceptance, [PRD.md](PRD.md) §19.3), then build lists on a foundation that works.

Users can still create manual lists in the MVP if it is cheap to do so; **auto-generation** is what waits.

### Included (Phase 2)
- auto-create lists from related bookmarks
- allow user to rename lists
- allow user to add or remove bookmarks from lists
- allow creation of custom lists

### Example lists
- Books to Buy
- Weekend Movies
- Trip Planning
- Research for Later
- Tech Tools
- Gift Ideas

### Why it matters
This makes bookmarks more actionable and easier to reuse.

---

## 4. Search

### Included
- instant search by title
- search by URL
- search by tag
- search by category

### Not included
- ~~basic natural language search if feasible~~ — deferred to Phase 4. It is the hardest capability in the product and the least proven to be necessary; keyword-plus-tag search over 3,000 bookmarks already beats Chrome's built-in search, which is the bar that matters.

### Why it matters
Fast retrieval is the biggest user pain point — and it is **acute** rather than chronic. "Where is that link I saved" happens at a specific moment with real friction, which is when someone actually installs something. This is the wedge; see [PRD.md](PRD.md) §25.

---

## 5. Cleanup Tools — the acquisition engine

*(Elevated 2026-08-19. This section, not §2, is why anyone installs.)*

Verified demand ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A): Bookmarks clean up has **200,000 users at 4.4★ and has not shipped an update since August 2024**. Bookmark Dupes holds 20,000 users while abandoned since 2022. This is the job people actually go looking for.

### Included
- **exact duplicate detection**
- **broken/dead link detection** — *moved back into the MVP 2026-08-19*
- **empty folder detection** — *moved back into the MVP 2026-08-19*
- same-name folder merging within the same path
- manual cleanup actions, with the full data-safety flow
- **select-all-duplicates** bulk action — a direct request in the incumbent's reviews from users with 1,000+ duplicates
- **show each bookmark's folder location** — the top complaint on the incumbent
- **edit an existing bookmark** (title/URL) — the second complaint on the incumbent

### Why broken-link detection came back

The 2026-08-16 revision deferred it as "the most dangerous to ship half-finished, because it deletes things." **The danger is real and the conclusion was wrong.** Dead-link detection is co-equal with duplicate detection in every high-install cleanup tool verified. Deferring it does not make the product safer; it makes it strictly worse than a free, abandoned, two-year-old extension — while competing for the same keywords.

Solve the danger with the UX, not by omission:

- **Three states, never two:** `Reachable` / `Unreachable` / **`Could not check`**. CORS failures, Cloudflare challenges, 403s, and timeouts go in the third bucket — never the second.
- **Nothing in "Could not check" is ever selectable for deletion in a bulk action.**
- Measure the false-positive rate on a real library before the deletion path ships at all. The <5% bar from the previous revision stands — it is a gate on *bulk delete*, not on shipping detection.
- Detection can ship before bulk deletion. Showing someone their 300 dead links is most of the value and carries none of the risk.

### Still deferred to Phase 2
- **near-duplicate detection** (fuzzy URL/title matching) — genuinely ambiguous, genuinely destructive, no verified demand signal distinct from exact duplicates
- scheduled/recurring re-checks — this is the plausible Pro hook ([MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §3)

### Data safety is not optional
Every cleanup action must satisfy [PRD.md](PRD.md) **FR10**: soft-delete with 30-day recovery, undo on every destructive action, a dry-run preview before any bulk operation, a backup-export prompt before the first bulk delete, and **never** an automatic deletion.

This is reinforced by the competitor research: cleanup extensions routinely warn that *Chrome itself cannot restore a deleted bookmark*. Our recovery guarantee is therefore a genuine, checkable differentiator against the 200,000-user incumbent — it belongs in the store listing copy, not just the engineering spec.

### Why it matters
Users often have cluttered bookmark libraries and need cleanup help. But one wrongly deleted bookmark ends the user relationship permanently — so the safety rails ship with the feature, not after it.

---

## 6. Bookmark Metadata

### Included
- title
- URL
- favicon
- detected category (with source and confidence)
- source folder
- last scanned timestamp

### Summaries — conditional, not baseline
- **On-device summary at save time**, where the device supports Chrome's Summarizer API. Free, private, $0 marginal cost.
- **Cloud summaries are Pro-only.** Generating them for a 3,000-bookmark library costs $3.23–$19.35 per user against roughly $0.72/year blended revenue — see [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §4.
- **No retroactive backfill in the MVP.** Summaries apply to newly saved bookmarks only.

*(Corrected 2026-08-16: this section previously listed "AI summary" as unconditional MVP metadata, contradicting both [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md), which had it as Pro, and [ROADMAP.md](ROADMAP.md), which had it in Phase 2.)*

### Why it matters
Metadata makes search, sorting, and rediscovery much better.

---

## 7. Basic Extension Dashboard

### Included
- search bar
- recent bookmarks
- smart lists area
- cleanup panel
- quick actions

### Why it matters
The dashboard becomes the extension’s home screen and main value surface.

---

## Not Included in MVP

- investment opportunity suggestions
- complex affiliate systems
- full web dashboard
- social sharing network
- team collaboration
- advanced page monitoring
- price-drop alerts
- event deadline alerts
- cross-browser cloud sync
- Firefox and Safari support

---

## Nice-to-Have If Time Allows

- save-now-organize-later button
- read-later list
- archive folder suggestions
- recently forgotten bookmarks section
- export selected lists to Markdown or CSV

---

## MVP Success Criteria

*(Rewritten 2026-08-16 — the previous criteria were unmeasurable. "Feel that bookmarks have become more useful" cannot be observed, so it cannot tell you whether to continue.)*

Measured over the first 500 installs. Full definitions in [PRD.md](PRD.md) §19.

| Criterion | Target |
|---|---|
| Install → bookmark permission granted | ≥ 70% |
| Permission → scan completed | ≥ 85% |
| Scan completed → first search performed | ≥ 50% |
| Median scan time for 3,000 bookmarks | < 90 seconds |
| AI category accepted without correction | ≥ 80% |
| D7 retention | ≥ 30% |
| D30 retention | ≥ 15% |

### Kill criteria

Decided in advance, so the decision is not made emotionally after seeing the data. **Stop or fundamentally rethink if, after 500 installs:**

- D30 retention is below **10%** — it is a novelty, not a habit
- Permission-grant rate is below **50%** — the pitch or the trust model is broken at the front door
- AI category acceptance is below **60%** — the differentiator does not work, and everything else is commodity

See [PRD.md](PRD.md) §19.4.

---

## Suggested MVP User Flow

### First Use
1. Install extension
2. Grant bookmark permission
3. Scan bookmarks
4. Wait for AI organization
5. Review generated categories and lists
6. Search and open bookmarks

### Ongoing Use
1. Save new bookmarks quickly
2. Let AI classify them
3. Search or browse smart lists later
4. Clean duplicates, dead links and empty folders periodically (scheduled re-checks from Phase 2)

---

## MVP Risks

**Build risks**

- **Service-worker termination breaks the scan.** Manifest V3 kills an idle service worker after ~30 seconds and destroys all in-memory state. A multi-minute scan written as a single background pass will fail intermittently and unreproducibly. Chunk and checkpoint from the first commit — see [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) §A.
- AI categorization may feel inaccurate without tuning.
- Large bookmark libraries may slow down scanning.
- Privacy concerns may reduce adoption if not explained clearly.

**Product risks**

- **Nobody installs it.** Messy bookmarks are a chronic, low-intensity pain. Mitigation: lead with retrieval, not organization ([PRD.md](PRD.md) §25).
- **No differentiation from Raindrop.io** — 400,000 installs, $3/mo, shipping AI assistant. The one-sentence answer to "why this instead" is still open and is blocking ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6).
- **Nobody finds it.** Chrome Web Store search favours incumbents with hundreds of thousands of installs ([PRD.md](PRD.md) §24).
- Too many features could distract from core usability — which is why this scope was cut.

---

## MVP Recommendation

The MVP should be local-first, lightweight, and highly practical. The main promise should be:

**Save anything. Find it instantly. Keep bookmarks useful.**
