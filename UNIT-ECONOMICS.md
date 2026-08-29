# Unit Economics

## Product

**Salvage**

## Status

Modelled 2026-08-16 against published Anthropic API pricing. Re-run the formulas in §7 whenever pricing or the token assumptions change.

---

## 1. Why this document exists

The AI layer is both the entire differentiator and the entire variable cost, and no version of the plan priced it. [PRD.md](PRD.md) §15 and [MVP.md](MVP.md) §6 both put AI summaries in the free MVP. This document works out what that costs.

The short answer: **AI categorization is nearly free. AI summaries are not, and cannot be free-tier.**

---

## 2. The two AI jobs are not the same cost

| Job | Input needed | Cost driver |
|---|---|---|
| **Categorize + tag** | Title + URL only (~35 tokens) | Trivial |
| **Summarize** | The page's actual body text (~2,000 tokens) | ~50× more input per bookmark |

This distinction is the single most important fact in the plan's economics, and the current docs do not make it. A summary cannot be generated from a title and a URL — the page has to be fetched and its text sent to a model. That is 50× the tokens, plus 3,000 HTTP requests.

---

## 3. Reference prices (Anthropic API, as of 2026-06-24)

| Model | Input / 1M | Output / 1M |
|---|---|---|
| Claude Haiku 4.5 | $1.00 | $5.00 |
| Claude Sonnet 5 | $3.00 ($2.00 intro through 2026-08-31) | $15.00 ($10.00 intro) |
| Claude Opus 5 | $5.00 | $25.00 |

**Batch API: 50% discount on all token usage**, results within 24h (usually <1h). A first-run bookmark scan is not latency-sensitive, so batch is the correct choice and all figures below assume it where noted.

**Prompt caching does not help here.** Cache reads are ~0.1× input price, but the minimum cacheable prefix on Haiku 4.5 is **4,096 tokens** — a classification system prompt is far shorter, so it will silently not cache. Each page body is unique and uncacheable by definition. Do not model caching savings into this workload.

---

## 4. Cost per user: the two scenarios

Modelled on a **3,000-bookmark library** (the stated early-adopter profile in [PRD.md](PRD.md) §6).

### Scenario A — Categorize + tag (title + URL only)

Assumptions: 50 bookmarks batched per request; ~400-token shared taxonomy prompt amortized across the batch; ~45 input tokens and ~25 output tokens per bookmark.

```
Input:  3,000 × 45 tokens = 135,000 tokens = 0.135M
Output: 3,000 × 25 tokens =  75,000 tokens = 0.075M

Haiku 4.5 standard:  (0.135 × $1.00) + (0.075 × $5.00) = $0.51
Haiku 4.5 + Batch:                                       $0.26
```

**≈ $0.26 per user, one time.** This is affordable on a free tier.

### Scenario B — One-line summaries (requires page fetch)

Assumptions: ~2,000 tokens of extracted body text per page after boilerplate stripping; ~30 output tokens per summary.

```
Input:  3,000 × 2,000 tokens = 6,000,000 tokens = 6.0M
Output: 3,000 ×    30 tokens =    90,000 tokens = 0.09M

Haiku 4.5 + Batch:   (3.00 × $1.00) + (0.045 × $5.00)  = $3.23
Haiku 4.5 standard:  (6.00 × $1.00) + (0.090 × $5.00)  = $6.45
Sonnet 5 + Batch (intro):                                $6.45
Sonnet 5 standard (list):                               $19.35
```

**$3.23 – $19.35 per user, one time, depending on model and batching.**

### The gap

Summaries cost **12× to 75× more than categorization**. They are a fundamentally different economic proposition and must be treated as one.

---

## 5. What the revenue side can support

Using the realistic price ceiling from [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §3:

```
Pro price:                      $3/mo  = $36/yr per paying user
Free→paid conversion (assumed):  2%     (freemium extension norm is ~1–5%)
Blended revenue per install:    $36 × 0.02 = $0.72 / user / year
```

| Scenario | One-time AI cost/user | Payback against $0.72/yr blended |
|---|---|---|
| A — categorization only | $0.26 | **~4 months** ✅ |
| B — summaries, Haiku + batch | $3.23 | **~4.5 years** ❌ |
| B — summaries, Sonnet standard | $19.35 | **~27 years** ❌ |

At 10,000 free installs, Scenario B costs **$32,300 in one-time inference** before a single subscription is sold.

**Conclusion: free-tier AI summaries are not viable at any plausible conversion rate.** This resolves the cross-doc contradiction in favour of [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) — summaries are Pro-only. The PRD, MVP, and Roadmap have been corrected to match.

---

## 6. The on-device option changes the picture

Chrome ships a built-in **Summarizer API** backed by Gemini Nano, running entirely on-device. Marginal inference cost is **$0** and no page content leaves the machine — which serves the privacy positioning at the same time.

**Status — verified 2026-08-19:** the Summarizer API is stable from **Chrome 138+**, and **extensions can use the Prompt API with Gemini Nano**. Four APIs are now stable (Prompt, Summarizer, Translator, Language Detector); Writer, Rewriter and Proofreader remain in origin trial. The Prompt API additionally reached stable for *web pages* in Chrome 148. The earlier caveat about origin trials and the Early Preview Program no longer blocks extension use of Summarizer or Prompt.

**This does not remove the hardware gate below — it makes measuring it more urgent.** The APIs being stable means eligibility is now the *only* thing standing between us and free inference.

**Hardware and language gate — this is the catch:**

| Requirement | Value |
|---|---|
| Free disk space | **22 GB** on the Chrome profile volume |
| RAM / GPU | 16 GB RAM with 4+ CPU cores, **or** a GPU with >4 GB VRAM |
| OS | Windows 10/11, macOS 13+, Linux, ChromeOS (Chromebook Plus) |
| Languages | English, Japanese, Spanish, German, French |

The 22 GB free-disk requirement in particular will exclude a meaningful share of users, and we have no measured eligibility rate. **Feature-detect at runtime and instrument it** — the observed eligible percentage is a metric worth having before Phase 2 planning.

### Recommended architecture

```
Summaries:
  ├─ Device eligible?  → on-device Summarizer API        ($0, private, any tier)
  └─ Not eligible?     → cloud API, Pro tier only        ($ per §4)
```

This gives free users summaries where the hardware allows, keeps cloud cost bounded to paying users, and makes the privacy claim literally true for most of the base.

---

## 7. The bigger hidden cost: fetching 3,000 pages

Independent of which model runs, summaries require the page body. Retroactively summarizing an existing library means **3,000 HTTP requests from the user's browser**:

- **Bandwidth:** ~500 KB/page average → **~1.5 GB** downloaded on the user's connection
- **Time:** at 5 concurrent requests and ~1s latency, ~10 minutes *best case*; realistically far longer with retries, timeouts, and rate limiting
- **Blocking:** sites will rate-limit or 403 a client making thousands of rapid requests; Cloudflare challenges will fail outright
- **Permissions:** fetching arbitrary URLs requires `<all_urls>` host permissions — the "Read and change all your data on all websites" install prompt, which directly undercuts both install conversion and the privacy positioning

### The architectural answer: summarize at save time, not retroactively

| Flow | Mechanism | Cost |
|---|---|---|
| **New saves** | User is already on the page; a content script under `activeTab` reads the text on user action. One page, on-device inference. | ~$0, no broad permissions |
| **Existing library backfill** | Opt-in only, Pro-only, explicitly warned about time and bandwidth | Bounded to paying users |

This removes the `<all_urls>` requirement from the default install, removes the 3,000-page backfill from the free tier, and removes the largest single line item from §4. **It is the highest-leverage decision in the whole plan.**

---

## 8. Re-run the model yourself

```
categorization_cost = ( (N × 45  / 1e6) × input_price )
                    + ( (N × 25  / 1e6) × output_price )

summary_cost        = ( (N × 2000 / 1e6) × input_price )
                    + ( (N × 30   / 1e6) × output_price )

# Multiply by 0.5 if using the Batch API.
# N = bookmarks per user. Defaults above assume N = 3,000.
```

Validate the token assumptions before relying on them: run `messages.count_tokens` against ~50 real bookmark titles/URLs and ~20 real extracted page bodies. Do not estimate Claude tokens with `tiktoken` — it is OpenAI's tokenizer and undercounts.

---

## 9. What is still unpriced

These are real costs the plan has not touched, listed so they are not discovered late:

- **Backend/hosting** if cloud sync ships (Phase 5)
- **Broken-link checking at scale** — bandwidth and rate-limit handling
- **Payment processing** — ~3% + fixed fee per transaction, material at a $3/mo price point. **Now specified: see [MONETIZATION-PLAN.md](MONETIZATION-PLAN.md) §14.** Google killed Chrome Web Store in-app payments in 2021, so the billing stack is unplanned build work. Stripe's fixed **$0.30 is 10% of a $3 monthly charge** — a strong argument for annual or one-time pricing.
- **Chrome Web Store developer fee** — one-time registration
- **Support cost per user** — a cleanup tool that deletes bookmarks generates support load
- **Customer acquisition cost** — currently assumed to be zero, which is only true if organic CWS search works (see [COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) §5)

---

## 10. Decisions this document forces

1. **AI summaries are Pro-only** when they run in the cloud. Non-negotiable at $3/mo pricing.
2. **On-device inference is the default path** for summaries, with cloud as the Pro fallback.
3. **Summarize at save time.** Retroactive whole-library summarization is opt-in and Pro-only, if it ships at all.
4. **Categorization stays free** — at $0.26/user it is affordable and it is the actual product promise.
5. **Instrument on-device eligibility from day one.** The eligible percentage determines how much cloud fallback we ever have to fund.

---

## Sources

- Anthropic model pricing and Batch API discount — Anthropic API documentation (cached 2026-06-24)
- [Summarizer API — Chrome for Developers](https://developer.chrome.com/docs/ai/summarizer-api)
- [Built-in AI — Chrome for Developers](https://developer.chrome.com/docs/ai/built-in)
- [The Prompt API — Chrome for Developers](https://developer.chrome.com/docs/ai/prompt-api)
