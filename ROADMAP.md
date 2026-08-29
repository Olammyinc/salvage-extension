# Product Roadmap

## Product

**Salvage**

## Roadmap Philosophy

The product should be built in layers. The first layer solves bookmark overload. The second layer improves utility and rediscovery. The third layer adds optional monetization and advanced discovery.

---

## Phase 1: Foundation MVP

### Objective
Prove that AI bookmark organization and retrieval solve a real problem — cheaply, in weeks rather than months.

### Features — in build order

*(Reordered 2026-08-19 against verified install data — [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A.)*

1. bookmark import and scan **(chunked, checkpointed, resumable — [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) §A)**
2. bookmark storage model with soft-delete
3. **rules-based categorization** — domain map shipped as data, not code. Cheap, instant, no API key, no hardware gate. Feeds the Report's topic breakdown.
4. ⭐ **the Library Report** ([PRD.md](PRD.md) §10.9) — the hero. Must render completely from step 3 alone.
5. **full backup export** — built *before* any destructive path, because FR10 requires a backup prompt ahead of the first bulk delete
6. **exact duplicate detection**, with full FR10 data-safety handling
7. **broken/dead-link detection**, three-state (`Reachable` / `Unreachable` / `Could not check`) — *moved back from Phase 2*
8. **empty folder detection and same-name folder merging** — *moved back from Phase 2*
9. instant search (keyword, title, URL, tag, category)
10. **AI categorization, tier 2** — async refinement of what rules could not classify; on-device where eligible, cloud otherwise, **never a user-supplied API key**
11. **incumbent-parity items**: show folder location, edit a bookmark, select-all-duplicates ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A)
12. Chrome and Edge packaging, with a **keyword-optimised store listing** targeting *duplicate bookmarks / broken bookmarks / bookmark cleanup* — not "AI bookmark manager"
13. **activation instrumentation** — without it, none of the gates below can be evaluated

### Success outcome
The activation and retention targets in [PRD.md](PRD.md) §19 are met. Kill criteria in §19.4 are not triggered.

*(Scope reduced 2026-08-16: smart lists and broken-link detection moved to Phase 2. Broken-link detection, empty folders and folder merging moved back into Phase 1 on 2026-08-19; smart lists remain deferred. See [MVP.md](MVP.md).)*

---

## Phase 2: Product Usability Upgrade

### Objective
Make the product feel significantly better than normal browser bookmarking.

### Gate to enter this phase
Phase 1 hit its retention targets. If it did not, fix Phase 1 or stop — do not add features to a product nobody returns to.

### Features
- **smart list auto-generation** — moved from Phase 1; requires tag quality ≥80% acceptance first
- **near-duplicate detection** (fuzzy matching) — the genuinely ambiguous half of dedupe; exact duplicates ship in Phase 1
- **scheduled broken-link re-checks** — the one-off scan ships free in Phase 1; recurring monitoring is the plausible Pro hook
- **bookmark summaries** — on-device at save time (free); cloud fallback and retroactive backfill are Pro ([UNIT-ECONOMICS.md](UNIT-ECONOMICS.md))
- **Pro tier launch** at $3–4/mo ([MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §3)
- better filters and sorting
- save-now-organize-later flow
- archive suggestions
- rediscovery feed
- project-based collections
- export to Markdown or CSV (advanced export is Pro; plain backup export stays free)

### Success outcome
Users return regularly, and ≥1% of free users convert to Pro within three months of launch.

---

## Phase 3: Discovery and Monetization

> ⚠️ **This phase is a go/no-go decision, not an assumed step.** Two findings from the 2026-08-16 research have to clear first:
>
> 1. **Chrome Web Store policy** (enforced since 10 June 2025) requires affiliate disclosure on the listing, in the UI, *and* before install; requires explicit user action before any affiliate link is applied; and requires a direct user benefit at that moment. Passive or background affiliate attribution is a removable offence.
> 2. **Amazon Associates appears to ban extensions that inject affiliate tags** — a material breach triggering account closure. Amazon underpins both the shopping and books modules, so those may have no viable partner.
>
> The arithmetic is also unforgiving at beta scale: ~10,000 installs plausibly yields single-digit dollars per month. See [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §12.
>
> **Enter this phase only with tens of thousands of installs, a working subscription business, and written confirmation of partner availability.**

### Objective
Add optional modules that create revenue without weakening trust.

### Features
- shopping deals module
- books module
- travel module
- events and tickets module
- movies and entertainment module
- learning and courses module
- affiliate labels and controls

### Success outcome
A portion of users engage with relevant discovery modules and monetization begins.

---

## Phase 4: Intelligence Layer

### Objective
Make Salvage proactive rather than only reactive.

### Features
- smart alerts
- page change monitoring
- price-drop alerts
- ticket release alerts
- smarter natural language search
- topic maps and bookmark clustering

### Success outcome
The product becomes a more intelligent assistant for saved web content.

---

## Phase 5: Platform Expansion

### Objective
Expand beyond a single-device extension experience.

### Features
- account system
- cross-device sync
- web dashboard
- public or private shared collections
- team or collaborative plans
- support for more browsers

### Success outcome
Salvage evolves from an extension into a broader bookmark productivity platform.

---

## Priority Recommendation

### Highest priority (Phase 1)

*(Revised 2026-08-19. The previous list named search as the acquisition wedge and AI categorization as the differentiator. Verified install data says cleanup is the wedge — [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A.)*

1. import — chunked and resumable
2. **cleanup — duplicates, dead links, empty folders — the acquisition wedge**, with FR10 safety rails
3. **the Library Report** — the demo, the screenshot, the reason it gets shared
4. search — still the strongest *retention* surface, and Raindrop's verified weak point (10–15s searches)
5. categorization — rules first, AI second; a dependency of the Report rather than a headline
6. instrumentation — you cannot evaluate the gates without it

### Medium priority (Phase 2)
7. smart lists, once tagging clears ≥80% acceptance
8. summaries (on-device first)
9. near-duplicate detection, once the false-positive rate is proven
10. scheduled link monitoring
11. Pro tier — **note the open question in [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §3: no cleanup tool at any scale currently charges a subscription**
12. rediscovery feed, advanced export, project collections

### Later priority
11. natural language search
12. sync and accounts
13. discovery modules — **conditional on the Phase 3 gate above**

---

## Main Strategic Rule

Do not let monetization become the main user experience too early. The product should win because it solves bookmark chaos better than anything else.

---

## Suggested Sequence Summary

### Step 1
Build useful bookmark intelligence.

### Step 2
Make it enjoyable and habit-forming.

### Step 3
Add optional monetized discovery.

### Step 4
Expand into a broader personal internet organizer.
