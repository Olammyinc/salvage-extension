# Technical Architecture

## Product

**Salvage**

## Overview

Salvage is a browser extension built first for Chrome and Edge using Manifest V3. The architecture should prioritize local-first bookmark processing, fast search, lightweight AI enrichment, and optional cloud-connected modules for discovery, sync, and alerts.

---

## 1. Browser Targets

### Initial browsers
- Google Chrome
- Microsoft Edge
- Brave and other Chromium browsers later

### Future browsers
- Firefox
- Safari

---

## 2. Extension Architecture

### Main parts
- background service worker
- popup UI
- options/settings page
- bookmark processing engine
- local search index
- optional cloud services

---

## 3. Recommended Technology Stack

### Extension Frontend
- HTML
- CSS
- JavaScript or TypeScript

### UI Option
- lightweight vanilla approach for speed
- or React if richer UI is needed

### Local Storage
- chrome.storage.local
- IndexedDB for larger bookmark datasets if needed

### Search Engine
- MiniSearch or Fuse.js for local search

### AI Layer
- local classification rules first
- optional API-based AI summarization and categorization

### Backend for Future Features
- Node.js serverless functions
- database for user sync and preferences
- scheduled workers for alerts and monitoring

---

## 4. Recommended System Design

## A. Background Service Worker

Responsible for:
- reading bookmarks from browser APIs
- watching for bookmark changes
- triggering rescans
- coordinating enrichment tasks
- scheduling cleanup checks

### Browser APIs to use
- bookmarks API
- storage API
- tabs API
- contextMenus API
- notifications API optionally

### ⚠️ Service worker lifecycle — this constrains the whole design

**Chrome terminates an idle service worker after ~30 seconds.** It also terminates workers that block on synchronous JavaScript and fail to respond to a ping within 30 seconds. On termination, all global variables, `setTimeout`/`setInterval` handles, and in-memory caches are destroyed.

A full scan of a 3,000-bookmark library takes minutes. **It cannot run as a single background pass.** Building it that way produces an intermittent, unreproducible bug where scans silently stop partway — the single most likely way to ship a broken v1.

Required pattern:

```
1. Split the scan into chunks (~50–100 bookmarks each).
2. After each chunk, checkpoint progress to chrome.storage:
     { lastProcessedId, processedCount, totalCount, phase }
3. Schedule the next chunk with chrome.alarms — not setTimeout.
4. On worker startup, always read the checkpoint and resume.
5. Surface progress to the UI from persisted state, never from memory.
```

Constraints to design around:
- **Never store scan state in a global variable.** It will not survive.
- **Use `chrome.alarms`, not `setTimeout`/`setInterval`** — alarms wake the worker; timers die with it.
- **`chrome.alarms` are throttled to roughly one wake per minute**, with a 30s minimum period. A chunked scan driven purely by alarms is slow; do as much work as possible within each active window, then checkpoint before yielding.
- **Assume termination at any point.** Every operation must be idempotent on resume — reprocessing a chunk must be harmless.

### Permissions strategy — request narrowly, escalate on use

Host permissions are a conversion cost, not just a manifest entry. Requesting `<all_urls>` at install produces the *"Read and change all your data on all websites"* prompt, which suppresses install conversion and directly contradicts the privacy positioning. It also invites slower Chrome Web Store review.

| Permission | When | Why |
|---|---|---|
| `bookmarks` | At install | Core function; users expect it from a bookmark manager |
| `storage` | At install | Local data; no user-visible warning |
| `activeTab` | At install | No warning, and grants content access on user action — enough to read the current page at save time |
| `alarms` | At install | No warning |
| `<all_urls>` | **Optional, requested at point of use** | Only needed for retroactive backfill and bulk broken-link scanning — both Pro, both opt-in |

Declare broad host permissions under `optional_host_permissions` and request them with `chrome.permissions.request()` at the moment the user opts into a feature that needs them. Explain what it is for in the same interaction.

---

## B. Popup or Main Dashboard UI

Responsible for:
- search experience
- quick actions
- bookmark opening
- list browsing
- list editing
- cleanup review

### Key UI sections
- global search bar
- recent bookmarks
- smart lists
- bookmark results
- cleanup suggestions
- discover area later

---

## C. Options Page

Responsible for:
- privacy settings
- AI settings
- discovery module settings
- export/import settings
- notification preferences

---

## D. Bookmark Processing Engine

Responsible for:
- parsing bookmark tree
- normalizing URLs
- extracting domains and titles
- tagging and categorization
- duplicate detection
- near-duplicate detection
- broken-link checks

### Processing steps
1. read all bookmarks
2. flatten bookmark tree into records
3. normalize titles and URLs
4. assign categories and tags **(from title + URL only — no page fetch)**
5. detect duplicate items
6. generate smart list suggestions
7. save to local data store
8. update search index

Steps 3–8 run in chunks with a checkpoint after each, per the service-worker lifecycle constraints in §A.

> **There is deliberately no page-fetch step in this pipeline.** Summaries need the page body, which means an HTTP request per bookmark — 3,000 requests, roughly 1.5 GB of the user's bandwidth, `<all_urls>` permissions, and unavoidable rate-limiting and blocking. Summarization is therefore a **separate, save-time flow** (§6.3), not part of the import scan. This was the largest hole in the v1 architecture: [PRD.md](PRD.md) promised one-line AI summaries while this pipeline had no step that could ever produce one.

---

## E. Search Index

Responsible for:
- indexing title
- indexing URL
- indexing tags
- indexing categories
- optionally indexing summaries

### Requirements
- instant response
- support partial matches
- support filter-based narrowing
- optionally support natural language matching layer

---

## 5. Data Model Suggestion

## Bookmark Record

```json
{
  "id": "bookmark-id",
  "title": "Example Page",
  "url": "https://example.com/page",
  "domain": "example.com",
  "folderPath": ["Bookmarks Bar", "Research"],
  "tags": ["ai", "tools"],
  "category": "Tools",
  "categorySource": "ai",
  "categoryConfidence": 0.87,
  "userCorrected": false,
  "summary": "A tool directory for AI products.",
  "summarySource": "on-device",
  "pageType": "article",
  "duplicateGroup": null,
  "linkStatus": "reachable",
  "linkCheckedAt": 1720000100,
  "deletedAt": null,
  "dateAdded": 1720000000,
  "lastScanned": 1720000100
}
```

Fields added in the 2026-08-16 revision, and why each is load-bearing:

| Field | Values | Why it exists |
|---|---|---|
| `categorySource` | `ai` \| `heuristic` \| `user` | Distinguishes a confident AI call from a domain-rule fallback, and protects user edits from being overwritten on rescan |
| `categoryConfidence` | 0.0–1.0 | Lets low-confidence categories be surfaced for review instead of asserted |
| `userCorrected` | boolean | **A rescan must never overwrite a user's correction.** Without this the product silently undoes people's work. |
| `summarySource` | `on-device` \| `cloud` \| `none` | Needed for cost attribution and for the on-device eligibility metric |
| `linkStatus` | `reachable` \| `uncertain` \| `confirmed_dead` | Replaces the boolean `isBroken`, which could not represent "we couldn't check" — see §8 |
| `linkCheckedAt` | timestamp | Staleness; drives re-check scheduling |
| `deletedAt` | timestamp \| null | **Soft delete.** Required by [PRD.md](PRD.md) FR10 — nothing is hard-deleted for 30 days. |

`isBroken` was removed deliberately: a boolean cannot express uncertainty, and a cleanup tool built on a boolean will delete pages that were merely unreachable at the moment it checked.

## Smart List Record

```json
{
  "id": "list-001",
  "name": "Books to Buy",
  "type": "ai-generated",
  "bookmarkIds": ["1", "2", "3"],
  "createdAt": 1720000000,
  "updatedAt": 1720000100
}
```

---

## 6. AI Architecture Approach

*(Substantially revised 2026-08-16. Costs are worked out in [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md).)*

### 6.1 The two AI jobs have different costs and different homes

| Job | Input | Cost per 3,000-bookmark library | Where it runs |
|---|---|---|---|
| Categorize + tag | Title + URL (~35 tokens) | **~$0.26** (Haiku 4.5 + Batch API) | Cloud, batched — free tier |
| Summarize | Page body (~2,000 tokens) | **$3.23–$19.35** | On-device where possible; cloud is Pro-only |

Treating these as one "AI layer" is what hid the cost problem in the original plan.

### 6.2 Categorization — cloud, batched, free tier

- Batch ~50 bookmarks per request against a shared taxonomy prompt
- Use the **Batch API** (50% discount); a first-run scan is not latency-sensitive
- Use **Claude Haiku 4.5** — classification from a title and URL is a Haiku-class task
- **Do not model prompt-caching savings.** Haiku 4.5's minimum cacheable prefix is 4,096 tokens; a taxonomy prompt is far shorter and will silently fail to cache
- Fall back to heuristics (domain-based rules, URL patterns, title keywords) when offline or when the API errors — a bookmark with a rule-derived category beats one with none

### 6.3 Summarization — on-device first, at save time

**The key architectural decision in the product.** Summaries happen when the user saves a bookmark, while they are on the page — not retroactively across the library.

```
User saves a bookmark
   └─ content script (activeTab) extracts page text
       ├─ Chrome Summarizer API available?  → on-device        ($0, private, all tiers)
       ├─ Pro user, no on-device support?   → cloud API        (per token)
       └─ Neither?                          → no summary; category + tags still work
```

This eliminates the `<all_urls>` permission from the default install, eliminates the 3,000-request backfill, and makes the privacy claim literally true for most users.

**Chrome built-in Summarizer API — requirements to feature-detect against:**

| Requirement | Value |
|---|---|
| Chrome version | 138+ (documented stable for web; **verify current stable status for extensions**) |
| Free disk | ~22 GB on the Chrome profile volume |
| RAM / GPU | 16 GB RAM with 4+ CPU cores, **or** GPU with >4 GB VRAM |
| OS | Windows 10/11, macOS 13+, Linux, ChromeOS (Chromebook Plus) |
| Languages | English, Japanese, Spanish, German, French |

**Always feature-detect at runtime and instrument the result.** The eligible share of the user base is unknown and determines how much cloud fallback ever needs funding. Model download is multi-gigabyte and happens on first use — surface progress via the `downloadprogress` event rather than appearing to hang.

### 6.4 Retroactive backfill — Pro, opt-in, warned

Summarizing an existing library is offered only to Pro users, only on explicit opt-in, and only behind a clear warning covering:
- approximate time (tens of minutes, realistically longer)
- approximate bandwidth (~1.5 GB for 3,000 bookmarks)
- the `<all_urls>` permission request, requested at that moment via `chrome.permissions.request()`
- that some pages will fail (rate limits, blocks, dead links) and that this is expected

Run it chunked and resumable, exactly like the import scan (§A).

### 6.5 Semantic search — evaluate local embeddings before paying for it

If semantic/natural-language search ships (Phase 4), evaluate a small local embedding model running in the extension before reaching for a hosted embedding API. Local embeddings would keep marginal cost at zero and preserve the local-first claim. Treat this as an option to test, not a settled plan — measure index size, memory footprint, and search quality on a 3,000-bookmark library first.

### Privacy Recommendation
Use local-first processing by default.
If cloud AI is used:
- ask permission,
- explain exactly what is sent (for categorization: title and URL only — **never page content**),
- allow opt-out, with heuristic classification as the fallback,
- state it in the Chrome Web Store listing and the privacy policy, not only in-app.

---

## 7. Duplicate Detection Strategy

### Exact duplicates
- same normalized URL

### Near-duplicates
- same domain plus highly similar title
- same product or article path with tracking parameter differences

### URL normalization examples
- remove tracking parameters
- normalize protocol if needed
- trim fragments where appropriate

---

## 8. Broken Link Detection Strategy

### Methods
- lightweight HEAD or GET check through allowed process
- retry failed links
- mark uncertain results separately from confirmed broken links

### Important note
This should be rate-limited to avoid performance issues and remote blocking.

### Three-state results are mandatory, not optional

Link checking from a browser extension is **unreliable by nature**, and treating an unreliable signal as authoritative is how a cleanup tool deletes something a user cared about.

| Cause | What it looks like | Actually dead? |
|---|---|---|
| CORS restrictions | Opaque response, no readable status | Unknown |
| Bot protection | 403 to non-browser-shaped requests | **No** |
| Cloudflare / captcha | Challenge page, often a 503 | **No** |
| Rate limiting | 429 after a burst of our own requests | **No** |
| Redirect chains | 301/302 to a valid new home | **No** |
| Genuinely dead | Consistent 404/410, or DNS failure | Yes |

Required model:

```
confirmed_dead  → 404/410 or DNS failure, on ≥2 attempts, ≥1 hour apart
uncertain       → everything else that isn't a clean 200
reachable       → 200, or a redirect resolving to 200
```

Hard rules:
- **Only `confirmed_dead` may be offered for bulk removal.** `uncertain` is shown separately, described as "couldn't check", and is never pre-selected.
- Every removal still passes through [PRD.md](PRD.md) FR10 — soft-delete, undo, dry-run preview, backup prompt.
- Never auto-delete on any state.
- Rate-limit aggressively: cap concurrency (~5), back off on 429, and cap total checks per session.
- Per [PRD.md](PRD.md) §19.3, this feature ships only once the measured false-positive rate is **under 5%** on a manually audited sample.

---

## 9. Discovery Module Architecture

These should be separate from core bookmark management.

### Discovery input sources
- saved bookmark categories
- user opt-in preferences
- affiliate feed data
- curated partner APIs

### Discovery categories
- shopping deals
- books
- movies
- travel
- events
- learning

### Rules
- optional only
- clearly labeled
- not intrusive
- relevance-based

---

## 10. Security and Privacy

### Principles
- collect as little data as possible
- store bookmark data locally where possible
- no hidden data sharing
- clear permission requests

### User Controls
- disable cloud enrichment
- disable discovery modules
- clear stored data
- export user data

---

## 11. Performance Considerations

- large libraries may include thousands of bookmarks
- indexing should be incremental where possible
- rescans should only process changed bookmarks when feasible
- search should be memory-efficient and fast

---

## 12. Folder Structure

All extension implementation lives under `bookmark/extension/` (the folder that contains `manifest.json`); the project docs — this file, the README, PRD, and the rest — stay directly under `bookmark/`. Layout as implemented (paths relative to `bookmark/`):

```text
extension/                      # loadable extension root (contains manifest.json)
  manifest.json
  _locales/
    en/
      messages.json           # MV3 localization (extensionName / extensionDescription)
  background/
    service-worker.js
  shared/
    constants.js
    normalize.js
    categorize.js
    report.js
    scan-controller.js
    rules-data.json           # categorization rules, shipped as data
  test/
    run-tests.js
    harness.js
    unit-tests.js
    mock-chrome.js
  tools/
    generator.js
  ui/
    popup.html
    popup.js
    popup.css
```

---

## 13. Development Phases

### Phase 1
- basic extension shell
- bookmark import
- local storage
- search index
- duplicate detection

### Phase 2
- AI tagging
- smart lists
- summaries
- cleanup dashboard

### Phase 3
- discovery modules
- alerts
- optional backend sync

---

## 14. Technical Recommendation

Build the first version as a lean local-first Chromium extension with minimal backend dependency. Focus on performance, search quality, and reliable bookmark organization before layering in affiliate and discovery systems.

### The four decisions that matter most (added 2026-08-16)

1. **Chunk and checkpoint everything from commit one.** MV3 service-worker termination is not an edge case; it is the normal operating condition. Retrofitting resumability is a rewrite.
2. **Summarize at save time, not retroactively.** This single decision removes the `<all_urls>` install prompt, the 3,000-request backfill, ~1.5 GB of user bandwidth, and the largest line item in the cost model.
3. **On-device AI first, cloud as the Pro fallback.** Makes the privacy claim literally true and keeps marginal cost at zero for most users.
4. **Soft-delete, always.** `deletedAt`, 30-day recovery, undo, dry-run. The product's headline feature destroys user data based on fallible signals.

---

## Sources

- [The extension service worker lifecycle — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [What are the execution time limits for the service worker in Manifest V3? — chromium-extensions](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/L3EbiNMjIGI)
- [Summarizer API — Chrome for Developers](https://developer.chrome.com/docs/ai/summarizer-api)
- [Built-in AI — Chrome for Developers](https://developer.chrome.com/docs/ai/built-in)
- [The Prompt API — Chrome for Developers](https://developer.chrome.com/docs/ai/prompt-api)
- [AI in Chrome Extensions — Chrome for Developers](https://developer.chrome.com/docs/extensions/ai)
- Anthropic API pricing and Batch API discount — Anthropic API documentation (cached 2026-06-24)
