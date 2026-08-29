# Monetization Plan

## Product

**Salvage**

## Monetization Strategy Overview

Salvage should monetize in a way that preserves user trust. The core bookmark organization experience must remain useful on its own. Monetization should feel like an optional enhancement, not the main reason the extension exists.

---

## 1. Core Monetization Model

### Primary model
- freemium subscription
- optional affiliate revenue

### Why this model works
- free tier drives adoption
- paid features serve power users
- affiliate modules create additional upside without blocking usability

---

## 2. Free Plan

Suggested free plan includes:
- bookmark import — **unlimited**
- instant search across all bookmarks — **unlimited**
- AI tags and categories — **unlimited** (costs ~$0.26/user; affordable)
- exact duplicate detection — **unlimited**
- **full backup export** — always available, never gated (required by [PRD.md](PRD.md) FR10)
- on-device AI summaries where the device supports it — **unlimited** (costs $0)
- smart lists — **up to 5**
- ~~cleanup scans — **1 per week**~~ → **cleanup scans and the Library Report are unlimited and free (revised 2026-08-19)**

*(Numbers added 2026-08-16. The previous version said "limited smart lists" and "limited cleanup scans" with no limits defined anywhere in the doc set, which made both the free tier and the upgrade prompt unimplementable.)*

> **Why the cleanup limit was removed (2026-08-19):** cleanup is the acquisition wedge, not an upsell surface ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §2A). The competitors that own this demand — 200,000 and 40,000 users — are free. Rate-limiting the one thing that gets us installed, against free incumbents, throttles the top of the funnel to protect revenue we have not yet proven anyone will pay. If a limit is needed later, put it on *scheduled/recurring* re-checks, which are a genuine ongoing service, rather than on the one-time rescue the product is named for.

### Purpose
The free plan should be useful enough to attract users and demonstrate clear value. The chosen limits gate *volume and convenience*, never *safety or data ownership* — a user must always be able to search everything they saved and export everything they own.

---

## 3. Pro Plan

Suggested paid features:
- unlimited smart lists
- advanced AI categorization
- **cloud AI summaries** — the fallback when a device cannot run on-device inference, and retroactive whole-library backfill ([UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §4)
- broken-link monitoring (scheduled re-checks; a one-off scan is free)
- rediscovery feed
- project collections
- **advanced export** — Markdown, CSV, per-list selective export. *(Plain full-library backup export stays free — required by [PRD.md](PRD.md) FR10.)*
- advanced filters
- optional sync across devices later
- premium cleanup tools

> **Note on summaries:** this document was already correct that summaries belong in Pro; [PRD.md](PRD.md) and [MVP.md](MVP.md) previously contradicted it by listing them in the free MVP. Those have been corrected to match. On-device summaries are free because they cost nothing to serve.

### Pricing direction — revised 2026-08-16

Possible starting options:
- monthly plan
- yearly plan
- low-friction intro pricing

**Price ceiling: $3–$4 per month.** Not a preference — a market constraint.

Raindrop.io, with roughly 400,000 Chrome installs, seven years of development, apps across Mac/iOS/Android/Chrome/Safari/Firefox/Edge, a conversational AI assistant, full-text search of page contents, permanent snapshots, and a duplicate finder, charges **$3/mo (~$28/yr)**.

The original $5–$12 range was 1.7×–4× the market leader for a strictly smaller product. Any revenue model built on it is not grounded. See [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §3.

| Plan | Price |
|---|---|
| Free | $0 |
| Pro monthly | $3–4 |
| Pro annual | ~$30 (two months free) |

**What $3/mo has to cover:** at an assumed 2% free→paid conversion, blended revenue is about **$0.72 per install per year**. Every free-tier feature has to cost less than that. This is precisely why cloud AI summaries cannot be free — see [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §5.

---

## 4. Affiliate Revenue Opportunities

### Best categories
- books
- shopping
- travel
- courses
- ticketing
- movies or streaming referrals where appropriate

### How to use affiliate monetization well
- only show relevant suggestions
- clearly label affiliate links
- keep recommendations optional
- avoid cluttering the main bookmark experience

---

## 5. Monetizable Discovery Modules

## A. Shopping Deals
- detect product bookmarks
- show price comparisons
- show discount alerts
- link to affiliate merchants

## B. Books
- detect book-related bookmarks
- recommend buying options
- show bestseller or review links
- link to affiliate bookstores

## C. Travel
- detect travel planning bookmarks
- surface hotel or flight deals
- suggest itinerary-related links
- link to affiliate travel platforms

## D. Events and Tickets
- detect venue, event, or performer pages
- show ticket availability or related events
- use partner or affiliate ticket links

## E. Learning and Courses
- detect saved educational content
- recommend premium courses or books
- use affiliate platforms where useful

---

## 6. Monetization Rules

To protect trust:

- do not overwhelm users with promotions
- never hide affiliate intent
- keep monetization separate from search results when possible
- do not make recommendations in sensitive areas like investments early on
- ensure recommendations are genuinely relevant to the user’s saved interests

---

## 7. Premium Upsell Strategy

### Natural upgrade moments
- when user hits smart list limit
- when user wants advanced summaries
- when user wants ongoing monitoring
- when user wants exports or advanced search
- when user wants project-based collections

### Good upsell message style
- practical
- non-pushy
- focused on saved time and utility

---

## 8. Business Expansion Options

### Later monetization opportunities
- team or shared workspace plan
- web dashboard subscription
- white-label curation tools
- premium research workflows
- sponsored but relevant discovery placements

---

## 9. Avoid These Early Mistakes

- building around affiliate revenue before user value exists
- making discovery feel spammy
- pushing financial offers or risky categories too early
- locking too much core functionality behind paywalls
- collecting personal data in a way that reduces trust

---

## 10. Recommended Monetization Sequence

### Phase 1
- launch free core utility
- validate user demand

### Phase 2
- add Pro plan for AI and cleanup power features

### Phase 3
- add optional affiliate discovery modules for shopping, books, travel, and learning

### Phase 4
- expand to alerts, sync, and advanced productivity features

---

## 11. Revenue Positioning

The product should be sold as a premium productivity and internet organization tool first, with optional monetized discovery features second.

### Core message
**Salvage helps people get more value from what they already save online.**

---

## 12. Platform policy constraints on affiliate revenue (added 2026-08-16)

**This section changes the viability of the affiliate half of this plan.** The original draft assumed affiliate monetization was a design choice. For browser extensions specifically, it is heavily regulated by both Google and the affiliate networks — and one major network appears to prohibit the form factor outright.

### 12.1 Chrome Web Store policy

Google tightened its extension affiliate rules following the Honey controversy, with enforcement beginning **10 June 2025**. Extensions found in violation are subject to removal.

An extension must not add, modify, or replace affiliate links unless **all** of the following hold:

| Requirement | What it means for us |
|---|---|
| The affiliate program is **clearly disclosed** — on the Chrome Web Store listing, in the extension UI, *and* before installation | Disclosure goes in the store listing itself, not buried in a privacy policy |
| **User action is required** before any affiliate link, code, or cookie is applied | No background injection, no automatic application. The user must click. |
| The link is tied to a **direct and transparent benefit to the user at that moment** | A discovery card the user did not ask for and gains nothing from is a violation |

Automatically including affiliate codes without direct, related user interaction is explicitly a violation.

**Verdict: workable, but only in the exact shape this plan already proposed** — opt-in modules, clearly labeled, user-initiated, offering real value at the moment of the click. The "optional and clearly separated" rule in §6 was right, and is now a compliance requirement rather than a preference. What is *not* available is any form of passive or background affiliate attribution.

**Action:** the opt-in requirement is no longer a product decision. Remove "should discovery modules be visible by default?" from the open-questions list — the platform has answered it. *(Done — see [PRD.md](PRD.md) §21.)*

### 12.2 Amazon Associates — status downgraded to UNVERIFIED (2026-08-19)

> ⚠️ **Correction.** The 2026-08-16 draft stated as fact that Amazon's Associates requirements *"ban browser extensions that inject affiliate tags."* A 2026-08-19 re-check **could not confirm a blanket extension ban.** The Associates Operating Agreement changes effective 14 April 2026 concern a 180-day commission qualification window and the disqualification of paid-advertisement traffic — not extensions as a form factor.
>
> What *is* confirmed is adjacent and still relevant: Chrome Web Store's post-Honey rules (§12.1) explicitly target affiliate hijacking, and extensions caught covertly replacing affiliate tags have been removed and publicly reported.
>
> **Treat "Amazon is unavailable" as an open question, not a finding.** The practical conclusion is unchanged — do not build against an assumption either way — but this claim must not be repeated as fact in any downstream document or decision.

The original concern stands as a risk rather than a fact: if extension-based participation is prohibited, violations would be a material breach of the Operating Agreement and could trigger account closure.

This matters disproportionately: Amazon is the default assumption behind "shopping deals" and "books" — two of the six proposed modules in §5, and the two with the most obvious inventory.

**Action before building any shopping or books module:** read the current Associates Operating Agreement in full and confirm in writing whether *any* extension-based participation is permitted. Do not build against an assumption here. If Amazon is out, the shopping and books modules need entirely different partners, and their revenue projections need rebuilding from scratch.

### 12.3 Revenue realism

Even where affiliate is permitted, the arithmetic is unforgiving at small scale:

```
10,000 installs
×  20% opt into a discovery module   =  2,000 users
×   2% click an affiliate link/month =     40 clicks
×   5% convert                       =      2 sales
×  $50 average order × 4% commission =     $4 / month
```

**Affiliate revenue is a scale business.** At beta scale it is a rounding error, and the engineering and compliance cost of building it — disclosure flows, partner integrations, policy review, ongoing audits — vastly exceeds the return.

**Recommendation: subscription first, affiliate much later or not at all.** Phase 3 in §10 should not begin until the subscription business is demonstrably working, and should be re-justified at that point rather than assumed.

---

## 13. Revised monetization sequence

Replaces the sequence in §10.

| Phase | Focus | Gate to proceed |
|---|---|---|
| **1** | Free core utility. No monetization. | Hit the retention targets in [PRD.md](PRD.md) §19.2 |
| **2** | Pro tier at $3–4/mo — cloud summaries, unlimited lists, monitoring, advanced export | ≥1% free→paid conversion within 3 months |

### ⚠️ Subscription may be the wrong model — decide with data, not by default

> **Strengthened 2026-08-19.** This was written as a hedge. Verified market data now makes it the *leading* hypothesis rather than the fallback:
>
> - **No cleanup tool at any scale charges a subscription.** Not the 200,000-user leader (free, Patreon), not the 20,000-user one (free), not the 40,000-user one (ad-supported). The segment with proven demand has **zero** subscription precedent — [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §3.
> - **Monthly billing fits the payment economics badly** — a fixed $0.30 per transaction is 10% of a $3 charge (§14).
> - **Monthly billing fits the job badly** — the job completes.
>
> Plan the Pro tier, but hold it loosely, and do not build billing infrastructure around a monthly assumption before the Phase 1 data arrives.

The positioning is now settled as **bookmark rescue** ([COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §6), and a rescue is a **one-time job**. Someone can clean up nine years of bookmarks in one satisfying session and leave genuinely happy. That is a good product outcome and a bad subscription outcome, and the two are easy to confuse.

Before defaulting to monthly recurring, run the Phase 1 numbers against this fork:

| What the data shows | What it means | Model to use |
|---|---|---|
| D30 retention healthy, regular searches | The library keeps being useful; the mess regenerates as people keep saving | **Subscription** — as planned above |
| D30 low **but** satisfaction/NPS high, few complaints | It worked. They finished. There is nothing left to pay for monthly. | **One-time purchase** (~$15–25) for the deep clean, or a free scan with a paid fix |
| D30 low **and** satisfaction low | The product did not work | Neither — go back to §19.4 kill criteria |

**Do not read low D30 as automatic failure.** For a rescue tool it may simply mean the job is done. The distinguishing signal is satisfaction, so instrument a post-cleanup prompt from day one — without it, the two cases are indistinguishable and the wrong conclusion is likely.

A hybrid is also viable and worth modelling: **free scan and report, paid fix.** The Library Report costs nearly nothing to produce (~$0.26/user), delivers the full "wow", and creates the exact moment of motivation at which someone will pay to act on what they have just been shown.
| **3** | Re-evaluate affiliate **only if** installs are in the tens of thousands *and* §12.2 confirms partner availability | Explicit go/no-go decision, not an assumed step |
| **4** | Sync, accounts, and platform expansion | Pro revenue covers hosting |

---

## 14. Payment infrastructure — unplanned build work (added 2026-08-19)

**Google shut down Chrome Web Store in-app payments in 2021 and never replaced them.** Nothing in this doc set accounted for that. Charging for anything means building or buying the entire billing stack: checkout, subscription state, license validation inside the extension, refunds, tax, and reconciliation.

| Option | What it gives | Cost |
|---|---|---|
| **ExtensionPay** | Purpose-built Stripe wrapper for extensions; handles auth and payment gating with minimal code and often no backend of our own | Stripe's 2.9% + $0.30, plus ExtensionPay's cut |
| **Direct Stripe** | Full control, no wrapper margin, Checkout or a custom flow in the side panel | 2.9% + $0.30, plus our own backend and maintenance |

**Recommendation: ExtensionPay for the first paid release.** At the volumes in §12.3 the wrapper's margin is immaterial, and it removes a backend from a plan whose entire advantage is being local-first. Revisit if paid volume ever makes the margin matter.

**Two things this forces:**

1. **License state must be checked offline-tolerantly.** A local-first extension that stops working when the billing API is unreachable will be rated 1★ for it.
2. **Payment processing is now a priced line item.** [UNIT-ECONOMICS.md](UNIT-ECONOMICS.md) §9 lists it as unpriced; at a $3/mo price point the fixed $0.30 per transaction is **10% of a monthly charge**, which is a strong argument for annual billing or a single one-time purchase over monthly.

That last point compounds the §13 fork: monthly billing is the worst-fitting model both for the product (a rescue is a one-time job) and for the payment economics (a fixed fee against a small recurring charge).

---

## Sources

- [ExtensionPay — the Chrome Web Store payments replacement](https://extensionpay.com/articles/extensionpay-is-the-chrome-web-store-payments-replacement)
- [How to collect payments for your Chrome extension in 2026 — ExtensionFast](https://www.extensionfast.com/blog/how-to-collect-payments-for-your-chrome-extension-in-2026)
- [Affiliate Ads — Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/affiliate-ads)
- [Affiliate Ads FAQ — Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/affiliate-ads-faq)
- [Strengthening our policies on affiliate programs in Chrome Extensions — Chrome for Developers](https://developer.chrome.com/blog/cws-policy-update-affiliate-ads-2025)
- [Amazon Associates Program Operating Agreement](https://affiliate-program.amazon.com/help/operating/agreement)
- [Amazon Associates Requirements: Compliance Made Practical — Geniuslink](https://geniuslink.com/blog/amazon-associates-requirements/)
- [Navigating Google's New Affiliate Disclosure Requirements for Chrome Extensions — Wildfire](https://www.wildfire-corp.com/blog/google-new-affiliate-disclosure-requirements-chrome-extensions)
