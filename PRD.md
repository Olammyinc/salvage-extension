# Product Requirements Document (PRD)

## Product Name

**Salvage**

## Product Type

AI-powered browser extension for bookmark organization, search, smart list creation, and optional discovery modules.

## Version

PRD v1.1

## Status

Draft — revised 2026-08-16 with competitive, cost, and platform-constraint research.

## Companion documents

- [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) — who we are actually up against, and the differentiation question that must be answered before Phase 1
- [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) — what the AI layer costs per user, and which features that rules out of the free tier

**Read both before treating this PRD as settled.** Several requirements below were revised because of what they found.

---

## 1. Product Summary

**This is a bookmark rescue tool, not a bookmark manager.**

Every competing product is a better place to save things *from now on*. This one fixes the decade of mess you already have. That distinction is the whole strategy — see [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6, where it is settled rather than optional.

Concretely: it is a Chromium extension (Chrome and Edge first) that reads an existing bookmark library — often thousands of items accumulated over a decade — and within about a minute shows the user the true state of it: the duplicates, the dead links, the things buried in folders called "New Folder (3)", the 1,100 pages untouched in two years. It then makes that library searchable, categorizes it with AI, and helps the user safely clear out what is no longer worth keeping.

The **Library Report** (§10.9) is the hero feature and the reason anyone installs. Search and AI categorization are what make the rescued library worth keeping.

Optional discovery modules — deals, books, movies, events, travel, learning — remain a possible later revenue stream, but they are constrained by platform policy and are explicitly gated behind a go/no-go decision. See [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §12.

---

## 2. Problem Statement

Many users save a large number of bookmarks over time but struggle to use them effectively later. Common problems include:

- bookmarks becoming disorganized,
- folders becoming too large or inconsistent,
- difficulty finding previously saved pages,
- duplicate bookmarks,
- broken or outdated links,
- useful pages being forgotten,
- no easy way to turn saved links into organized collections or actionable lists.

Traditional bookmark systems rely too heavily on manual foldering and naming. As bookmark collections grow, they become less useful.

Salvage solves this by making bookmarks searchable, structured, summarized, and automatically organized.

---

## 3. Vision

To turn messy bookmark collections into an intelligent personal internet library that helps users save, organize, rediscover, and act on the content they care about.

---

## 4. Goals

### Primary Goals

- Make bookmarks easy to search and retrieve
- Automatically organize bookmarks with AI
- Generate useful smart lists from saved links
- Improve bookmark cleanup and maintenance
- Make saved web content more useful over time

### Secondary Goals

- Enable discovery of related opportunities from saved interests
- Create monetization through optional affiliate-powered discovery modules
- Build a strong privacy-respecting browser productivity tool

---

## 5. Non-Goals for Version 1

The following are not primary goals for the initial release:

- giving financial or investment advice,
- becoming a full social bookmarking platform,
- replacing all browser-native bookmark functionality,
- supporting every browser from day one,
- building a broad internet crawler for all opportunity types.

---

## 6. Target Users

### Primary User Segments

#### 1. Heavy bookmark users
People who save many links for work, research, shopping, learning, entertainment, or future use.

#### 2. Researchers and learners
Users who save articles, tools, videos, papers, courses, and reference material.

#### 3. Shoppers and planners
Users who bookmark products, travel pages, books, gift ideas, tickets, and comparison pages.

#### 4. Productivity-focused internet users
Users who want a cleaner, smarter, more useful browser experience.

### Early Adopter Profile

The ideal early user is someone with hundreds or thousands of bookmarks who feels that bookmarks are useful in theory but messy in practice.

---

## 7. User Pain Points

- “I save pages but can never find them again.”
- “My bookmark folders are too messy.”
- “I have duplicate links everywhere.”
- “Some of my saved pages are dead or outdated.”
- “I want my bookmarks grouped by actual topic, not just by folder.”
- “I want to search what I saved in plain English.”
- “I want useful recommendations based on what I already save.”

---

## 8. Value Proposition

**The core promise, in one sentence:** *see the true state of the bookmark library you gave up on, and fix it in one sitting — safely.*

In priority order:

1. **Understand what you actually have** — the Library Report (§10.9). Nobody else offers this.
2. **Find any saved page in seconds** — the acute, in-the-moment pain that drives installs.
3. **Clear out what is no longer worth keeping** — safely, reversibly, never automatically.
4. **Keep it from decaying again** — AI categorization on everything, old and new.
5. Rediscover valuable content already saved.
6. *(Later, conditional)* discover related books, deals, events, movies, travel, and learning resources.

**What this product deliberately does not do:** read-later queues, highlights and annotations, tab-session management, team workspaces. Those are Raindrop's, Web Highlights', and Toby's established ground, and competing there means losing on their terms. See [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6.

---

## 9. Core Product Principles

- **Useful first:** organization and retrieval must be more valuable than monetization.
- **Privacy-aware:** bookmark data is personal and should be handled carefully.
- **Low friction:** users should be able to save quickly and organize later.
- **Intelligent but controllable:** AI should help, but users must stay in control.
- **Cross-browser practical:** start with Chromium browsers first.

---

## 10. Core Features

> **Read §10.9 first.** The Library Report is the hero feature and the reason anyone installs this. The features below are what make it possible; it is what makes them matter. It is listed last only to avoid renumbering.

### 10.1 Bookmark Import

The product shall:

- read bookmarks from Chrome and Edge,
- import existing folders and links,
- preserve original folder structure where useful,
- allow rescanning and refreshing imported bookmark data.

### 10.2 AI Bookmark Organization

The product shall:

- analyze bookmark titles and URLs,
- assign tags automatically,
- classify bookmarks into topics,
- generate smart folders or smart lists,
- allow a bookmark to belong to multiple lists.

### 10.3 Search

The product shall provide:

- instant keyword search,
- search by title,
- search by URL,
- search by tags,
- search by category.

The product **may** later provide natural language search. This is deliberately *not* a v1 requirement: it is the hardest capability in the product and the least proven to be necessary. Good keyword-plus-tag search over 3,000 bookmarks already beats Chrome's built-in search, which is the bar that matters for the wedge. Natural language search is scheduled in [ROADMAP.md](ROADMAP.md) Phase 4.

*(Revised in v1.1 — previously listed as a "shall" here while being scheduled for Phase 4 elsewhere.)*

### 10.4 Smart Lists

The product shall:

- generate bookmark collections automatically,
- allow users to edit generated lists,
- allow manual list creation,
- support lists such as shopping, books, research, movies, events, and travel.

### 10.5 Bookmark Summaries and Metadata

The product shall:

- estimate page type,
- show favicon and page title,
- store enrichment metadata such as category and last scanned time.

The product shall generate one-line AI summaries **at save time**, subject to the tiering below.

#### Summary tiering (revised in v1.1)

Summaries require the page's body text, not just its title and URL. That means an HTTP fetch per bookmark and roughly 50× the tokens of categorization — see [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §4. Cloud-generated summaries for a 3,000-bookmark library cost **$3.23–$19.35 per user**, against blended revenue of roughly **$0.72 per user per year**. They therefore cannot be free-tier.

| Path | Availability | Cost |
|---|---|---|
| On-device (Chrome Summarizer API) | All tiers, where the device qualifies | $0 |
| Cloud API fallback | **Pro only** | Per token |
| Retroactive whole-library backfill | **Pro only**, opt-in, with an explicit time/bandwidth warning | Per token |

New bookmarks are summarized at save time, while the user is on the page — a content script under `activeTab` reads the text on user action. This avoids requesting `<all_urls>` host permissions at install and avoids a 3,000-page backfill. See [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) §6 and §8.

### 10.6 Cleanup Tools

The product shall:

- detect duplicate bookmarks,
- detect near-duplicate bookmarks,
- detect broken links,
- detect empty folders,
- help users archive or remove clutter.

### 10.7 Save and Organize Workflow

The product shall:

- allow one-click bookmark capture,
- support later AI organization,
- support quick add to existing list or project.

### 10.8 Optional Discovery Modules

The product may provide discovery modules for:

- shopping deals,
- books,
- movies and shows,
- events and tickets,
- travel,
- learning resources.

These modules should be optional and clearly separated from core bookmark management.

---

### 10.9 The Library Report — hero feature (added in v1.1)

**This is the product.** Everything else is infrastructure for it.

The positioning decision in [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6 is that we are a **bookmark rescue tool**, not a bookmark manager. The Library Report is what makes that concrete: the moment, roughly 60 seconds after install, when a user sees the true state of a library they stopped understanding years ago.

#### What it does

Immediately after the first scan, present a single diagnostic screen:

```
Your library: 3,142 bookmarks, saved over 9 years

  47      exact duplicates                      →  Review
  218     in folders named "New Folder"         →  Sort these
  1,104   not opened in over 2 years            →  Review
  62      point to pages that no longer exist   →  Review
  891     never opened, not even once           →  Review

  Your biggest topics:  Development (612) · Recipes (388) · Travel (204)
  Oldest bookmark:      March 2017
```

#### Why this and not a dashboard

Four things happen on this screen that happen nowhere else in the product:

1. **It proves value before asking for anything.** The user has not organized, searched, or configured — and already knows something true and slightly uncomfortable about their own data. Every competitor's first screen is an empty state asking you to start saving.
2. **It is the demo.** This is the Chrome Web Store screenshot, the Reddit post, and the 20-second video. "Look what it found in my bookmarks" is inherently shareable; "it has AI tagging" is not.
3. **It creates the next action.** Every line is a button. The gap between install and first meaningful action collapses to one click, which is exactly what §19.1 measures.
4. **It is honest about the mess without blaming the user.** Tone matters enormously here — this is someone's decade of saved things. Report findings neutrally, never scold, never use words like "junk", "clutter", or "bad".

#### Requirements

- The report **must** be generated from the scan alone — no page fetches, no network calls beyond categorization. It has to appear fast.
- Every number **must** be clickable through to the actual bookmarks behind it.
- Every remedial action **must** route through **FR10** — nothing is pre-selected for deletion, everything is previewed, everything is undoable.
- The report **must** be re-runnable later, so a user can see progress.
- Counts **must** be exact. A rescue tool that rounds or estimates has already undermined the trust the whole product depends on.
- Copy **must not** shame the user. "1,104 not opened in over 2 years" — never "1,104 forgotten bookmarks you're ignoring".

#### Success measure

Report shown → at least one remedial action taken: **≥ 40%**. If this is low, either the findings are not compelling or the actions are too scary — and both are fixable, which is why this is the most valuable thing to instrument.

---

## 11. Future Features

These are not required for initial MVP but are strong candidates for future releases:

- rediscovery feed,
- project-based collections,
- command palette,
- smart alerts,
- page change monitoring,
- price-drop alerts,
- shared bookmark collections,
- export as Markdown or CSV,
- cross-browser sync,
- topic maps and visual clustering.

---

## 12. User Stories

### Bookmark Organization
- As a user, I want my imported bookmarks automatically grouped by topic so I do not need to clean everything manually.
- As a user, I want one bookmark to appear in multiple relevant lists so I can find it from different contexts.

### Search
- As a user, I want to search my bookmarks instantly so I can find saved pages quickly.
- As a user, I want to search in plain English so I do not need to remember the exact title of the page.

### Cleanup
- As a user, I want duplicate bookmarks identified so I can remove clutter.
- As a user, I want dead links identified so my bookmark collection stays useful.

### Smart Lists
- As a user, I want AI to turn related bookmarks into useful lists like “Books to Buy” or “Trip Planning.”
- As a user, I want to edit AI-generated lists so I remain in control.

### Discovery
- As a user, I want relevant discovery suggestions based on my saved interests so my bookmarks become more actionable.
- As a user, I want discovery suggestions to feel helpful, not spammy.

---

## 13. Functional Requirements

### FR1. Bookmark Access
- The extension must access browser bookmarks with user permission.
- The extension must scan bookmark folders and links.

### FR2. Bookmark Data Storage
- The extension must store imported bookmark metadata locally.
- The system should support optional cloud sync in a future version.

### FR3. Search Indexing
- The system must build a searchable index of bookmarks.
- Search results should appear quickly as the user types.

### FR4. AI Classification
- The system must assign categories and tags to bookmarks.
- The system should generate list suggestions based on semantic similarity.

### FR5. Cleanup Engine
- The system must detect exact duplicate URLs.
- The system should detect likely near-duplicates using title and domain similarity.
- The system should support broken-link checks.
- The system must present broken-link results in **three** states — confirmed dead, uncertain, and reachable — and must never treat "uncertain" as dead. HEAD/GET checks from a browser extension have a high false-positive rate: sites return 403 to non-browser-shaped requests, Cloudflare serves challenges, and CORS yields opaque responses. A false positive here deletes something the user cared about.

### FR10. Data Safety (added in v1.1)

The cleanup tools bulk-delete a user's accumulated bookmarks. These requirements are **hard constraints**, not preferences:

- The system **must never delete a bookmark automatically.** Every removal requires explicit user confirmation of that specific item or batch.
- The system **must soft-delete.** Removed bookmarks go to a recoverable trash for a minimum of 30 days before any permanent deletion.
- The system **must offer undo** on every destructive action, available for the remainder of the session at minimum.
- The system **must prompt for a full backup export** (HTML or JSON) before the first bulk-delete operation, and must make that export available at any time from Settings.
- Bulk operations **must show a dry-run preview** — exactly what will be removed, itemized — before anything is applied.
- The system **must never modify the browser's own bookmark tree** without explicit user action. Reading is permitted on grant; writing is not implied by it.

**Rationale:** the product's headline power feature operates destructively on a decade of a user's saved data, and it acts on AI classifications and network checks that are both fallible. One wrongly deleted bookmark ends the user relationship permanently and generates a review that costs far more than the user. Nothing in this section may be traded away for convenience or a cleaner flow.

### FR6. Smart Lists
- Users must be able to create, rename, edit, and delete lists.
- AI-generated lists must be editable.

### FR7. Bookmark Enrichment
- The system should display page title, URL, favicon, tags, category, and summary where available.

### FR8. Discovery Modules
- Discovery modules must be optional.
- Discovery modules must be clearly labeled when affiliate-based.

### FR9. Settings and Preferences
- Users must be able to enable or disable discovery categories.
- Users must be able to control notifications.
- Users must be able to manage privacy preferences.

---

## 14. Non-Functional Requirements

### Performance
- Search results should return near instantly for normal bookmark volumes.
- Initial scanning should complete in a reasonable amount of time for large bookmark libraries.

### Privacy
- Bookmark data should be processed locally by default where possible.
- Users must be informed when any data is sent to external AI or enrichment services.

### Usability
- The extension should work well for both small and very large bookmark collections.
- The user interface should minimize clutter and support fast actions.

### Compatibility
- Version 1 should support Chrome and Edge.
- Future versions may support Brave and other Chromium browsers.

### Reliability
- The extension must not lose bookmark organization data during routine browser usage.
- All destructive operations must satisfy **FR10 (Data Safety)** without exception.
- Enrichment and scan state must survive service-worker termination. Manifest V3 kills an idle service worker after ~30 seconds and destroys all in-memory state, so any multi-minute scan must be chunked, checkpointed to persistent storage, and resumable. See [TECHNICAL-ARCHITECTURE.md](TECHNICAL-ARCHITECTURE.md) §A.

---

## 15. MVP Scope

*(Scope tightened in v1.1. The previous list was a 3–6 month build for a solo developer, which is not an MVP — it is v1. The point of an MVP is to test the core assumption cheaply.)*

### The assumption being tested

> Showing someone the true state of the bookmark library they gave up on is compelling enough that they will act on it — and then keep the tool.

Everything not required to test that is out.

### Included in MVP

*(Revised 2026-08-19 against verified Chrome Web Store install data — [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A.)*

- Chrome and Edge support
- Bookmark import — chunked, checkpointed, resumable
- **The Library Report (§10.9)** — ⭐ the hero. If only one thing is excellent, it is this.
- **The full cleanup set** — exact duplicates, **dead links (three-state)**, **empty folders**, same-name folder merging — with full FR10 data-safety handling. *This is the acquisition wedge; it is why anyone installs.*
- **Instant search** (keyword, title, URL, tag, category) — the retention surface, and a verified Raindrop weak point (10–15s searches)
- **Categorization — rules first, AI second.** A domain-map pass shipped as data covers the bulk of a library at zero cost and zero latency; AI refines the ambiguous remainder asynchronously. **Never requires a user-supplied API key.** The Report must render fully from the rules pass alone.
- **Incumbent-parity items** — show folder location, edit a bookmark, select-all-duplicates
- Basic settings and a full export — **export ships before any destructive path**
- Activation instrumentation — without it, §19 cannot be evaluated

### Deferred to Phase 2 (not MVP)

- **Smart list generation** — valuable, but it is a layer on top of tags; tags must be good first
- **Bookmark summaries** — cost-gated; see §10.5 and [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md)
- **Near-duplicate detection** — the genuinely ambiguous half of dedupe
- **Scheduled/recurring link re-checks** — the one-off scan is free in the MVP

> **Why broken-link detection and empty folders moved back in (2026-08-19):** they were deferred as too dangerous to ship half-finished. The danger is real; the conclusion was wrong. Dead links are co-equal with duplicates in *every* cleanup tool with meaningful installs, and omitting them ships something weaker than a free extension abandoned in 2024 while competing for the same keywords. The danger is handled by the three-state UX in FR5/FR10 — `Reachable` / `Unreachable` / **`Could not check`**, with nothing in the third bucket ever bulk-selectable — and by shipping *detection* ahead of *bulk deletion*. Showing someone their 300 dead links is most of the value at none of the risk.

### Excluded entirely from v1

- investment opportunity scanning,
- affiliate and discovery modules of any kind,
- natural language search,
- full social sharing ecosystem,
- cloud sync and user accounts,
- deep analytics dashboard,
- broad external web crawling.

---

## 16. Discovery and Monetization Scope

### Allowed Early Monetization Categories

- shopping,
- books,
- travel,
- events,
- movies,
- courses.

### Monetization Rules

- Core bookmark utility comes first.
- Affiliate suggestions must be clearly marked.
- Discovery modules must be optional.
- Recommendations should be relevant to saved interests.

### Restricted Category

Investments should not be treated as a recommendation engine in early versions. If included later, it should focus only on organizing research bookmarks rather than suggesting financial opportunities.

---

## 17. Key Screens

### 1. Dashboard
- global search
- recent bookmarks
- smart lists
- suggested cleanup actions
- optional discovery cards

### 2. All Bookmarks View
- bookmark table or card view
- filters
- sort options
- tag view

### 3. Smart Lists View
- AI-generated lists
- custom lists
- edit controls

### 4. Cleanup View
- duplicates
- broken links
- empty folders
- archive suggestions

### 5. Discover View
- deals
- books
- movies
- events
- travel
- learning

### 6. Settings View
- permissions
- privacy
- discovery toggles
- notification settings

---

## 18. User Flow Summary

### Flow 1: First-Time Setup
1. User installs extension
2. User grants bookmark permissions
3. Extension scans bookmarks
4. AI organizes data into tags and smart lists
5. User lands on dashboard with searchable organized bookmarks

### Flow 2: Search and Retrieval
1. User opens extension
2. User types a keyword, tag, or category (natural language query from Phase 4)
3. Results appear instantly
4. User opens the bookmark or saves it into a list

### Flow 3: Cleanup
1. User opens cleanup tab
2. System shows duplicate and broken bookmarks
3. User reviews suggestions
4. User removes, archives, or keeps items

### Flow 4: Discovery
1. User opens discover tab
2. System shows relevant optional suggestions based on bookmark interests
3. User clicks through to useful pages or offers

---

*(Revised in v1.1. The previous version listed metric names with no targets — those are charts, not success criteria. Every metric below has a number, and §19.4 states what result means stop.)*

### 19.1 Activation — the first-run funnel

The riskiest part of the product is the first ten minutes. Instrument every step.

| Metric | Target | Why this number |
|---|---|---|
| Install → bookmark permission granted | **≥ 70%** | Below this, the permission prompt or the pre-install pitch is the problem |
| Permission granted → scan completed | **≥ 85%** | Below this, the scan is too slow or is failing on large libraries |
| Scan completed → first search performed | **≥ 50%** | This is the core value moment; below this the dashboard is not leading users to it |
| Scan completed → any cleanup action | **≥ 25%** | Tests whether cleanup is a real draw or just a feature list item |
| Median time to complete first scan (3,000 bookmarks) | **< 90 seconds** | Beyond this, users leave the tab |

### 19.2 Retention — does it survive the novelty

| Metric | Target | Why this number |
|---|---|---|
| D7 retention (opened the extension) | **≥ 30%** | The honest bar for a utility extension |
| D30 retention | **≥ 15%** | Below this it is a one-time cleanup tool, not a product — which changes the business model entirely |
| Searches per active user per week | **≥ 3** | Below this it is not a habit |
| Uninstall rate within 7 days | **< 25%** | |

### 19.3 Quality — is the AI actually good

| Metric | Target | How to measure |
|---|---|---|
| AI category accepted (not corrected) by user | **≥ 80%** | Track manual re-categorizations as the inverse signal |
| Search-to-open rate | **≥ 60%** | A search that opens nothing is a failed search |
| Broken-link false-positive rate | **< 5%** | Sample-audit flagged links manually. **Gates the bulk-*deletion* path, not detection** *(clarified 2026-08-19)*. Detection with three-state results ships first — showing someone their 300 dead links is most of the value at none of the risk. Bulk delete unlocks only once this is measured under 5%. |
| On-device AI eligibility rate | *measure, no target* | Determines how much cloud fallback must ever be funded — see [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §6 |

### 19.4 Kill criteria — what result means stop

Stated in advance, because deciding this after seeing the data is how projects limp on for a year.

**Stop, or fundamentally rethink, if after 500 installs:**

- D30 retention is **below 10%** — the product is a novelty, not a habit
- Fewer than **30%** of users who complete a scan ever run a second session
- Permission-grant rate is **below 50%** — the pitch or the trust model is broken at the front door
- AI category acceptance is **below 60%** — the differentiator does not work, and everything else is commodity

**Reconsider the business model (not necessarily the product) if:**

- D30 retention is healthy but free→paid conversion is **below 1%** after 3 months of a Pro tier — the value is real but not priceable at this level

### 19.5 Monetization — deferred

Not measured until Phase 3. Affiliate metrics in particular are premature: see [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §12 for the platform-policy constraints that determine whether affiliate revenue is available to this form factor at all.

---

## 20. Risks and Assumptions

### Risks — ranked by how likely they are to kill the product

1. **Nobody cares enough to install.** The existential risk, and the one the original draft did not name. Messy bookmarks are a *chronic, low-intensity* pain: people complain, but it costs them about two minutes a week. That may not be enough to make anyone install anything. Mitigation: lead with retrieval ("where is that link"), which is acute and in-the-moment, rather than organization, which is chronic and ignorable. See §26.
2. **No distribution.** Chrome Web Store search is effectively the only channel and it is dominated by listings with 200K–400K installs. A new listing ranks nowhere. See [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §5.
3. **No differentiation from Raindrop.io** at $3/mo with 400K installs and a shipping AI assistant. See [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6.
4. **A false-positive delete destroys trust permanently.** The headline feature is destructive and runs on fallible inputs. Mitigated by FR10, which is why FR10 is non-negotiable.
5. **AI cost exceeds revenue** if summaries ship free-tier. Quantified and resolved in [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md).
6. **Permission prompt kills install conversion.** Requesting `<all_urls>` produces "Read and change all your data on all websites". Mitigated by the save-time architecture in §10.5.
7. **Affiliate monetization may not be permitted** in this form factor. See [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §12.
8. AI categorization may be inaccurate in some cases.
9. Large bookmark libraries may affect performance if not indexed well.

### Assumptions — and how to test each

| Assumption | Test |
|---|---|
| Users want help finding and using old bookmarks | Activation funnel §19.1: does scan → first search clear 50%? |
| Users will value AI organization enough to keep using it | D30 retention §19.2 |
| AI categorization is good enough to be trusted | Category acceptance rate §19.3 |
| Chrome and Edge are the best initial targets | Accepted — Chromium is ~70% of desktop browsing and MV3 is a shared surface |
| Users will pay for a Pro tier | Untested until Phase 3; the $3–4 ceiling is set by the market, not by us |
| A meaningful share of devices can run on-device AI | Instrument eligibility from day one — [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §6 |

---

### Resolved in v1.1

| Question | Answer | Source |
|---|---|---|
| Local-first, or cloud enrichment immediately? | **Local-first.** Cloud only as a Pro-tier fallback where on-device AI is unavailable. | [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §6 |
| Should AI summaries run locally, remotely, or both? | **Both, tiered.** On-device by default; cloud is Pro-only. | §10.5 |
| Should discovery modules be visible by default or opt-in only? | **Opt-in only** — Chrome Web Store policy requires affirmative user action before any affiliate link is applied. Not a preference; a platform rule. | [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §12 |
| Should there be user accounts in v1? | **No.** Accounts arrive with sync in Phase 5. | [ROADMAP.md](ROADMAP.md) |

### Still open

- **What is the one-sentence answer to "why this instead of Raindrop"?** Blocking for Phase 1 scoping. Candidates in [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6.
- **What fraction of users' devices can run the on-device Summarizer API?** Determines cloud-fallback exposure. Measure by feature-detecting at runtime.
- Should smart lists be generated only on import, or continuously updated?
- Should the product include a web dashboard later?
- Is the product name available? See [BRAND-PACK.md](BRAND-PACK.md) §12 — there is a known conflict.

---

## 22. Recommended Technical Direction

### Browser APIs
- Manifest V3
- bookmarks API
- storage API
- tabs API
- contextMenus API
- optional history API
- optional notifications API

### Suggested Implementation Approach
- local-first bookmark processing,
- local search index using a lightweight search library,
- AI classification layer for categories, tags, and summaries,
- optional backend for cloud sync, alerts, and discovery feeds.

### Platform constraints that shape the design (added in v1.1)

These are not implementation details — each one changes the product.

**Manifest V3 service-worker lifecycle.** Chrome terminates an idle service worker after ~30 seconds and destroys all global state, timers, and in-memory caches. A multi-minute scan of 3,000 bookmarks therefore *cannot* run as one background pass. It must be chunked, checkpointed to `chrome.storage` after each chunk, and driven by `chrome.alarms` — which are themselves throttled to roughly one wake per minute. Architect for resumability from the start; retrofitting it is a rewrite.

**Host permissions are a conversion cost.** Any feature that fetches arbitrary URLs — page summaries, broken-link checks — needs `<all_urls>`, which produces the *"Read and change all your data on all websites"* install prompt and invites slower Chrome Web Store review. Prefer `activeTab` (granted on user action, no scary prompt) and request broader permissions **optionally at the point of use**, not at install. See §10.5.

**Broken-link checking is unreliable from an extension.** CORS yields opaque responses, many sites 403 non-browser-shaped requests, and Cloudflare serves challenges. This is why FR5 mandates a three-state result and §19.3 gates the feature on a measured false-positive rate.

**On-device AI has a hardware floor.** The Chrome Summarizer API requires ~22 GB free disk and either 16 GB RAM or >4 GB VRAM, and supports five languages. Always feature-detect; never assume availability.

---

## 23. Launch Recommendation

### Best initial launch angle
Position Salvage as:

- an AI bookmark manager,
- a smart bookmark search tool,
- a browser productivity extension,
- a personal internet organizer.

### Launch message
**Save anything. Find it instantly. Turn messy bookmarks into smart lists.**

---

## 24. Go-to-Market and Distribution (added in v1.1)

The doc set previously had no answer to *how anyone finds this*. That is a larger risk than any feature gap.

### The channel problem

Chrome Web Store search is the primary discovery channel for a browser extension, and it is stacked against new entrants: "bookmark manager" surfaces incumbents with 200,000–400,000 installs and thousands of reviews. A listing with zero of each does not appear. Ranking appears to weight install count, rating volume, and recency — all of which a new extension lacks by definition.

### ⭐ The keyword decision (added 2026-08-19) — the highest-leverage GTM choice available

Verified install data ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A) splits the search space in two, and we get to choose which one we compete in:

| Keyword space | Incumbent strength | Verdict |
|---|---|---|
| "bookmark manager", "AI bookmark manager" | Raindrop 400K, Toby 300K — active, well-rated, well-funded | ❌ **Unwinnable. Do not target.** |
| **"duplicate bookmarks", "broken bookmarks", "bookmark cleanup"** | Leader has 200K users but **has not shipped since August 2024**; next has 20K, abandoned since 2022; the actively-maintained one runs ads at 3.7★ | ✅ **Target this. Proven demand, stale incumbents.** |

**Concrete consequences for the listing:**

- The store title and first sentence target *cleanup* terms. The store description is the search index — write it as SEO, with the primary keyword in the title and secondary keywords in the opening line.
- **"AI" does not appear in the extension name.** Nothing in the AI-organizer cohort has cleared 1,000 users; the two rated ones scored 1.0★ and 1.8★. AI belongs in the feature list, not the identity.
- Lead the screenshots with the Library Report and the before/after, not with a chat box.
- Our recovery guarantee (FR10 soft-delete with 30-day restore) is a listing headline. Competing cleanup tools warn that Chrome itself cannot restore a deleted bookmark — that is a checkable advantage over the 200,000-user leader.

**Expectation-setting on organic reach:** listing optimisation alone is reported to move a new extension from roughly 2 to 11 organic installs per week, with a well-documented "dead zone" between 50 and 200 users where most extensions stall. **At 11/week the 500 installs required by §19 take about a year.** Organic CWS search is the floor, not the plan — channels 2–5 below are what make the §19 timeline achievable, and one of them must be actively worked from day one.

### Channels worth testing, in order

1. **Chrome Web Store listing quality** — the one lever fully under our control. Title, keywords, screenshots, and a demo video that shows a messy 3,000-bookmark library becoming searchable in 60 seconds. Cheap, and it compounds.
2. **Reddit** — r/productivity, r/chrome, r/datacurator, r/DataHoarder. The bookmark-hoarder audience genuinely congregates here. Requires participation, not posting.
3. **Product Hunt** — one launch spike, useful for initial review volume more than for sustained installs.
4. **Comparison-content SEO** — "Raindrop alternative", "how to clean up Chrome bookmarks". Slow, but it targets exactly the acute moment of intent.
5. **Hacker News** — only viable if the local-first/privacy angle is genuinely true and technically interesting.

### What to decide before Phase 1 ships

- What does the CWS listing actually say? Write it *before* building, as a forcing function on positioning.
- What is the demo asset? Retroactive cleanup is a visual, screenshot-friendly story. Use it.
- What is the target for first 100 installs, and through which channel?

---

## 25. Positioning — settled

The decision is recorded in [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6. Restated here because it governs everything above:

> **A bookmark rescue tool, not a bookmark manager.** Every competitor is a better place to save things from now on. This one fixes the decade of mess you already have.

### The reasoning in three steps

**1. Organization is the wrong lead.** It is a *chronic* pain — real, but low-intensity and easy to ignore. Nobody installs software on a Tuesday because their folders are untidy. It is also the crowded ground: every competitor's listing already says "AI organizes your bookmarks."

**2. Retrieval is acute.** "Where the hell is that link I saved" happens at a specific moment with real friction. That is when an install happens — so search is the wedge, and good keyword search over 3,000 bookmarks already beats Chrome's built-in with no AI at all.

**3. Rescue is what's actually differentiated.** Every competitor — Raindrop, Toby, MyMind, Recall, Sift — optimizes the *save* flow forward from install. None of them make a decade-old, 3,000-item bookmark tree good. That is the gap, and it is also the most *demonstrable* claim we have: the before/after is a screenshot.

### What changed because of this

This is not just a messaging note. It added a P0 feature that existed nowhere in the plan:

| Area | Change |
|---|---|
| **Product** | §10.9 **Library Report** is now the hero MVP feature — the first-run diagnostic reveal |
| **MVP order** | Build the Report first. If only one thing is excellent, it is that. |
| **Scope discipline** | Explicitly *not* building read-later, highlights, tab sessions, or team features — competitors' ground |
| **Safety** | FR10 is promoted from engineering constraint to headline claim; a rescue tool that loses data is worse than none |
| **Marketing** | The demo is a real messy library and the report that exposes it — [BRAND-PACK.md](BRAND-PACK.md) §16 |
| **Metrics** | Report → remedial action (≥40%) becomes the key activation metric |

### The risk this creates, stated plainly

A rescue is a **one-time job**. Someone could clean up their bookmarks once and leave perfectly happy — great product, no recurring revenue. Two mitigations, both untested:

- **The mess regenerates.** People keep saving. The tool that fixed 3,000 bookmarks is the obvious one to keep the next 300 tidy — rescue as acquisition, ongoing organization as retention.
- **Price the job, not the month.** If D30 comes in low *but satisfaction is high*, that is a signal to sell a one-time cleanup rather than a subscription — not automatic failure. §19.4 must be read with that distinction in mind.

---

## 26. Summary

Salvage is designed to make bookmarks useful again. Instead of forcing users to manage endless folders manually, it uses AI to organize, search, and clean their saved links. Its first priority is utility and trust.

The v1.1 revision sharpens three things the original draft left open:

- **It is a crowded market.** Raindrop.io ships most of this at $3/mo to 400,000 users. The differentiation question is open and blocking.
- **The AI economics only work one way.** Categorization is affordable free-tier; cloud summaries are not. On-device inference and save-time summarization are the architecture that makes the numbers work.
- **The destructive features need hard safety rules.** FR10 exists because one wrongly deleted bookmark is unrecoverable, both technically and reputationally.

Discovery and affiliate monetization remain plausible additions — but they are constrained by platform policy in ways the original plan did not account for, and they come only after the bookmark experience is strong, fast, and trusted.
