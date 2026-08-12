# Copilot Pricing Tab — Design Spec

**Date:** 2026-08-12
**Branch:** vNext
**Scope:** A new read-only dashboard tab that mirrors GitHub Copilot's published per-token
pricing table, including the context-tier rows the current pricing table drops, with the
documentation URL and a verification date so the data can be kept current.

**Explicitly out of scope:** changing how `usage.unit_price` is computed. Context-tier
pricing is *displayed* here but is not yet *billed*. See "Deferred" below.

---

## Why

The gateway prices requests from static per-provider tables
(`vnext/packages/provider-copilot/src/pricing.ts` and siblings). Those tables are the only
place model pricing exists, and they have three problems:

1. **No comparison surface.** Both `ModelsTab` (a chat playground) and `UpstreamsTab` (an
   admin editor) are organised upstream-first and show no prices at all. To compare model
   costs an operator must read TypeScript source.
2. **Source-of-truth drift is invisible.** Each table cites its documentation URL in a file
   header comment, but nothing records *when* the numbers were last checked against it.
3. **Context tiers are silently dropped.** GitHub publishes a second, higher price band for
   long-context requests (GPT-5.5 above 272K tokens is `$10.00 / $1.00 / — / $45.00` versus
   the default `$5.00 / $0.50 / — / $30.00`). `ModelPricing` is single-vector, so only the
   default band is stored. Long-context requests are currently under-costed by roughly 2x.

This spec addresses (1) and (2) fully, and makes (3) *visible and structurally represented*
without yet changing billing.

### Non-goal: premium request multipliers

The original request included a "multiplier" column and a multiplier-derived effective
price. Investigation of the source documentation showed GitHub no longer publishes
per-model multipliers: the page is now purely per-token, and multipliers survive only as
"Model multipliers for annual plans on request-based billing (legacy)" for existing annual
subscribers, with values not listed on that page.

Multipliers are therefore dropped. A multiplier-derived "effective price per request" is
also dropped: it would require assuming an average token count per request, and the
requirement is to display standard published figures, not estimates.

---

## Decisions

### D1. Single source of truth: `pricing.ts` gains tiers, billing behaviour unchanged

`vnext/packages/provider-copilot/src/pricing.ts` becomes the tiered catalog. A separate
display-only table was rejected: two copies of the same numbers would drift on the first
update, defeating the tab's purpose.

Replace the current `PricingRule = readonly [key: string | RegExp, pricing: ModelPricing]`
with:

```ts
interface PricingTier {
  /** Tier name as printed in the docs, e.g. "Default", "Long context". */
  readonly label: string
  /** Input-token count above which this tier applies. Absent on the default tier. */
  readonly contextThreshold?: number
  readonly pricing: ModelPricing
}

interface CopilotModelPricing {
  /** Model name exactly as printed in the docs, e.g. "GPT-5.5". Absent when the
   *  entry exists only to price a model the docs no longer list. */
  readonly displayName?: string
  /** Matcher against the public model id. Same semantics as today's key. */
  readonly match: string | RegExp
  /** tiers[0] is the default tier and is what billing uses. */
  readonly tiers: readonly PricingTier[]
}
```

Exports:

- **`pricingForCopilotModelKey(modelKey)`** — signature and return type unchanged. Walks
  entries, matches on `match` using today's rules (variant-suffix stripping via
  `copilotPublicModelId`, then ISO-date-suffix retry), returns `tiers[0].pricing`. Billing
  callers (`provider.ts:104`) are untouched.
- **`pricingForCopilotPublicModelId(publicName)`** — unchanged, same treatment.
- **`copilotPricingCatalog()`** — returns `{ source, models }` for the API layer.

### D2. `displayName` optional; the tab shows exactly what the docs show

`pricing.ts` contains entries the documentation page does not list — legacy and internal
models such as `gpt-3.5-turbo`, `gpt-4-0125-preview`, `goldeneye`, `raptor-mini`. These
must keep matching for billing, but must not appear in a tab that claims to mirror the
docs.

Rule: **`displayName` present ⇔ the model has a row on the docs page.** Entries without it
are billing-only and are filtered out of `copilotPricingCatalog()`.

Catalog rows are one-to-one with docs rows. Today several entries use one regex to cover
multiple model ids at the same price (`/^claude-opus-4[.-][5678]$/`). Where such a regex
corresponds to more than one row on the docs page, split it into one entry per docs row,
each with that row's `displayName` and its own `match`; the tier data may reference a shared
pricing constant. Where it corresponds to a single docs row (the other ids being older
versions the page no longer lists), keep one entry. No invented merged labels such as
"Claude Opus 4.5–4.8".

### D3. Provenance and freshness

```ts
export const COPILOT_PRICING_SOURCE = {
  url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  verifiedOn: "2026-08-12",
} as const
```

`verifiedOn` is updated by hand whenever the table is reconciled against the page. The tab
renders both, so stale data is visible rather than assumed current.

One URL per provider, not per model — the docs page is a single page.

### D4. Scope: Copilot only

Providers fall into three groups:

| Provider | Pricing source | Provider-level or upstream-level |
| --- | --- | --- |
| copilot, codex, claude-code | static TS table + docs URL | provider-level |
| custom, azure | operator-supplied `cost` block in upstream config | upstream-level |
| sdf | `getPricingForModelKey()` returns `null` | none |

Only **copilot** is in scope. `codex` and `claude-code` have the same shape and can be
added later by repeating D1–D3 against their own doc URLs. `custom` and `azure` prices are
operator-entered and already visible in the upstream editor; surfacing them here would mix
published figures with local configuration under a heading that promises the former. `sdf`
has no pricing to show.

The API response is nonetheless shaped as a list of providers so adding one later is
additive on both sides.

### D5. Axis is provider, not upstream

The tab is grouped by *provider*, not by configured upstream instance. Copilot pricing is
identical across every Copilot upstream an operator configures, so an upstream axis would
duplicate identical tables. The data is static, so the tab performs no upstream probing and
cannot fail from an unreachable upstream.

---

## Architecture

```
provider-copilot/src/pricing.ts        tiered catalog + source constant  [single source]
        │
        ├── pricingForCopilotModelKey()  →  provider.ts  →  usage.unit_price   (unchanged)
        │
        └── copilotPricingCatalog()      →  GET /api/pricing  →  PricingTab
```

The dashboard app depends only on `@vibe-llm/protocols`, not on provider packages, so the
catalog reaches the frontend through an endpoint rather than a direct import. This matches
every other tab (`api/models.ts`, `api/usage.ts`, …).

### API

`GET /api/pricing`, static, no upstream I/O, following the existing dashboard endpoint
auth. Response:

```json
{
  "providers": [
    {
      "provider": "copilot",
      "source": {
        "url": "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
        "verifiedOn": "2026-08-12"
      },
      "models": [
        {
          "displayName": "GPT-5.5",
          "tiers": [
            { "label": "Default", "pricing": { "input": 5, "input_cache_read": 0.5, "output": 30 } },
            { "label": "Long context", "contextThreshold": 272000,
              "pricing": { "input": 10, "input_cache_read": 1, "output": 45 } }
          ]
        }
      ]
    }
  ]
}
```

Client module: `vnext/apps/dashboard/src/api/pricing.ts`.

### UI

New `vnext/apps/dashboard/src/tabs/pricing/PricingTab.tsx`. Registration:

- `App.tsx`: add `{ id: "pricing", labelKey: "dash.pricing", fallback: "Pricing", userOk: true }`
  to `ALL_TABS`, positioned after `models`; add the `case "pricing"` arm to `TabBody`.
- `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`: add `dash.pricing` to both the
  English and Chinese blocks ("Pricing" / "价格").

Layout — one section per provider, each with a header line carrying the source link and
verification date, then a table:

| Model | Tier | Input | Cached input | Cache write | Output |
| --- | --- | --- | --- | --- | --- |
| GPT-5.5 | Default | 5.00 | 0.50 | — | 30.00 |
|  | > 272K | 10.00 | 1.00 | — | 45.00 |

- Unit (USD per 1M tokens) is stated once in the table caption, not repeated per cell.
- Multi-tier models leave the model cell blank on continuation rows so tiers read as a group.
- Dimensions the docs do not price show `—`. Most models have no cache-write price; per the
  docs it applies to OpenAI's GPT-5.6 series and all Anthropic models.
- Follows existing tab styling; no new dependencies.

### Data transcription

The tiered values are transcribed by hand from the three vendor tables on the source page
(OpenAI, Anthropic, Google). This is the highest-risk step and is why D3 exists. Column
shapes differ between the tables — the OpenAI and Google tables carry Context/Threshold
columns, the Anthropic table does not — so the transcription must be driven by each table's
own header row rather than a single assumed layout.

Where the page lists a model absent from `pricing.ts`, add the entry. Where `pricing.ts`
holds a model absent from the page, leave it as a billing-only entry with no `displayName`.

---

## Testing

**Invariants** (new, in `provider-copilot/src/__tests__/pricing.test.ts`):

1. Every entry's `tiers[0]` has no `contextThreshold`. Violating this makes billing silently
   pick a long-context rate and roughly double recorded cost.
2. Every entry has at least one tier.
3. `displayName` values are unique across the catalog, so no two rows render identically.
4. `copilotPricingCatalog()` returns only entries carrying a `displayName`.

**Regression:** the existing `provider-copilot/src/__tests__/pricing.test.ts` and
`provider-pricing.test.ts` cases pass **without modification**. This is the evidence that
billing behaviour is unchanged; if a case needs editing, the refactor changed behaviour and
must be revisited.

**API:** `/api/pricing` returns the documented shape and includes the copilot provider.

**Manual acceptance:** rendered figures are checked row-by-row against the docs page. This
cannot be automated against a third-party page that changes without notice; `verifiedOn`
records that the check happened.

---

## Deferred

**Billing the context tier.** Once tiers exist in the data model, a follow-up spec can make
`unit_price` tier-aware: `getPricingForModelKey` gains a context-length argument and the
usage write path selects the matching tier. That work is separated because its verification
is entirely different — it requires issuing a real request above 272K input tokens and
asserting the persisted `unit_price`, and it must first establish whether input token count
is known at the point the usage row is written. Historical rows keep the price frozen at
write time either way.

Until then, the Pricing tab shows long-context rates that the Usage tab does not charge.

**Other providers.** `codex` and `claude-code` follow the same shape against
`https://developers.openai.com/api/docs/pricing` and
`https://docs.claude.com/en/docs/about-claude/pricing`. The operator has additionally
flagged DeepSeek and Kimi as likely future upstreams.
