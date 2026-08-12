# Copilot Pricing Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only dashboard tab that mirrors GitHub Copilot's published per-token pricing table — including the long-context tier rows the current table drops — with the source URL and a verification date.

**Architecture:** `provider-copilot/src/pricing.ts` becomes a tiered catalog and stays the single source of truth. Billing keeps reading `tiers[0].pricing` through an unchanged `pricingForCopilotModelKey()`. A new `copilotPricingCatalog()` export is served by `GET /api/pricing` from the gateway control plane, and rendered by a new `PricingTab` in the dashboard SPA.

**Tech Stack:** Bun (test runner + package manager), TypeScript, Hono (gateway control plane), React 19 + Tailwind (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-12-copilot-pricing-tab-design.md`

---

## Open question for the operator (surface before Task 3)

The Anthropic docs table has a row **"Claude Opus 4.8 (fast mode) (preview)" — $10.00 / $1.00 / $12.50 / $50.00** that has no matcher in `pricing.ts`, and its upstream model id is unknown. The price is documented; the id-to-price mapping is not.

Per the operator's rule "没有依据的就不显示", **this plan omits that row** from the catalog. If the operator later identifies the model id, adding it is a one-entry change in Task 3.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `vnext/packages/provider-copilot/src/pricing.ts` | Modify | Tiered catalog + source constant + billing lookups + `copilotPricingCatalog()` |
| `vnext/packages/provider-copilot/src/__tests__/pricing.test.ts` | Modify (append only) | Existing 7 billing cases stay byte-identical; new invariant + catalog cases appended |
| `vnext/packages/provider-copilot/src/index.ts` | Modify | Re-export `copilotPricingCatalog` and its types |
| `vnext/packages/gateway/src/control-plane/pricing/routes.ts` | Create | `GET /api/pricing` — static, no I/O |
| `vnext/packages/gateway/src/control-plane/routes.ts` | Modify | Mount the pricing router |
| `vnext/packages/gateway/tests/control-plane-pricing.test.ts` | Create | Endpoint shape test |
| `vnext/apps/dashboard/src/api/pricing.ts` | Create | Typed fetch wrapper |
| `vnext/apps/dashboard/src/tabs/pricing/PricingTab.tsx` | Create | Rendering |
| `vnext/apps/dashboard/src/App.tsx` | Modify | Tab registration + `TabBody` arm |
| `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts` | Modify | EN + 中文 strings |

---

## Task 1: Tiered types, mechanically refactored

Turn the `PricingRule` tuple list into `CopilotModelPricing` objects **without changing a single price**. The existing 7 tests are the proof of parity — they must pass unmodified.

**Files:**
- Modify: `vnext/packages/provider-copilot/src/pricing.ts`
- Test: `vnext/packages/provider-copilot/src/__tests__/pricing.test.ts` (run only, do not edit)

- [ ] **Step 1: Run the existing tests to record the green baseline**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/provider-copilot/src/__tests__/pricing.test.ts
```

Expected: 7 pass, 0 fail.

- [ ] **Step 2: Rewrite `pricing.ts` with the tiered shape, same data**

Replace the whole file with:

```ts
/**
 * Per-public-model pricing catalog used by the Copilot provider. `match` targets
 * the public model id that survives Claude variant merging (e.g.
 * `claude-opus-4-7`, `gpt-5.4`). `pricingForCopilotModelKey` strips raw-id
 * variant suffixes (`-high`, `-xhigh`, `-1m`, `-1m-internal`, trailing date)
 * using the same rules as `copilotPublicModelId` in variants.ts so it can be
 * fed the modelKey persisted in `usage.model_key`. Values are USD per million
 * tokens, aligned with sst/models.dev `Cost`.
 *
 * `tiers[0]` is the default tier and is the only tier billing reads. Later
 * tiers are the long-context bands GitHub publishes; they are displayed by the
 * dashboard Pricing tab but are not yet billed (see the design spec).
 *
 * Source of truth for Copilot pricing updates: COPILOT_PRICING_SOURCE below.
 */

import { copilotPublicModelId } from "./variants"
import type { ModelPricing } from "@vibe-llm/protocols/common"

export const COPILOT_PRICING_SOURCE = {
  url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  verifiedOn: "2026-08-12",
} as const

export interface PricingTier {
  /** Tier name as printed in the docs, e.g. "Default", "Long context". */
  readonly label: string
  /** Input-token count above which this tier applies. Absent on the default tier. */
  readonly contextThreshold?: number
  readonly pricing: ModelPricing
}

export interface CopilotModelPricing {
  /**
   * Model name exactly as printed in the docs, e.g. "GPT-5.5". Absent when the
   * entry exists only to price a model the docs no longer list.
   */
  readonly displayName?: string
  /** Matcher against the public model id. */
  readonly match: string | RegExp
  /** tiers[0] is the default tier and is what billing uses. */
  readonly tiers: readonly PricingTier[]
}

const only = (pricing: ModelPricing): readonly PricingTier[] => [{ label: "Default", pricing }]

const COPILOT_MODEL_PRICING: readonly CopilotModelPricing[] = [
  // Claude ids may appear in either dot form (`claude-opus-4.7`, Copilot raw)
  // or dash form (`claude-opus-4-7`, Anthropic public id), so the matchers
  // accept `[.-]`.
  { match: /^claude-opus-4[.-][5678]$/, tiers: only({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }) },
  { match: /^claude-opus-5([.-]\d)?$/, tiers: only({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }) },
  { match: /^claude-sonnet-4([.-][56])?$/, tiers: only({ input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }) },
  { match: /^claude-sonnet-5([.-]\d)?$/, tiers: only({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10 }) },
  { match: /^claude-fable-5([.-]\d)?$/, tiers: only({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 }) },
  { match: /^claude-haiku-4[.-]5$/, tiers: only({ input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 }) },
  { match: "gpt-5.6-sol", tiers: only({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 }) },
  { match: "gpt-5.6-terra", tiers: only({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 12 }) },
  { match: "gpt-5.6-luna", tiers: only({ input: 0.2, input_cache_read: 0.02, input_cache_write: 0.25, output: 1.2 }) },
  { match: "gpt-5.5", tiers: only({ input: 5, input_cache_read: 0.5, output: 30 }) },
  { match: "gpt-5.4", tiers: only({ input: 2.5, input_cache_read: 0.25, output: 15 }) },
  { match: "gpt-5.4-mini", tiers: only({ input: 0.75, input_cache_read: 0.075, output: 4.5 }) },
  { match: "gpt-5.4-nano", tiers: only({ input: 0.2, input_cache_read: 0.02, output: 1.25 }) },
  { match: /^gpt-5[.][23](-codex)?$/, tiers: only({ input: 1.75, input_cache_read: 0.175, output: 14 }) },
  { match: "gpt-5.1-codex-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: /^gpt-5[.]1/, tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "gpt-5-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: /^gpt-4[.]1/, tiers: only({ input: 2, input_cache_read: 0.5, output: 8 }) },
  { match: "gpt-41-copilot", tiers: only({ input: 2, input_cache_read: 0.5, output: 8 }) },
  { match: /^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, tiers: only({ input: 2.5, input_cache_read: 1.25, output: 10 }) },
  { match: "gpt-4-o-preview", tiers: only({ input: 2.5, input_cache_read: 1.25, output: 10 }) },
  { match: /^gpt-4o-mini/, tiers: only({ input: 0.15, input_cache_read: 0.075, output: 0.6 }) },
  { match: /^gpt-4(-0613)?$/, tiers: only({ input: 30, output: 60 }) },
  { match: "gpt-4-0125-preview", tiers: only({ input: 10, output: 30 }) },
  { match: "gpt-3.5-turbo", tiers: only({ input: 0.5, output: 1.5 }) },
  { match: "gpt-3.5-turbo-0613", tiers: only({ input: 1.5, output: 2 }) },
  { match: "gemini-2.5-pro", tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "gemini-3-flash-preview", tiers: only({ input: 0.5, input_cache_read: 0.05, output: 3 }) },
  { match: "gemini-3.1-pro-preview", tiers: only({ input: 2, input_cache_read: 0.2, output: 12 }) },
  { match: "gemini-3.5-flash", tiers: only({ input: 1.5, input_cache_read: 0.15, output: 9 }) },
  { match: "gemini-3.6-flash", tiers: only({ input: 1.5, input_cache_read: 0.15, output: 7.5 }) },
  { match: /^grok-code-fast/, tiers: only({ input: 0.2, output: 1.5 }) },
  { match: /^grok-4[.]5/, tiers: only({ input: 2, input_cache_read: 0.5, output: 6 }) },
  { match: /^mai-code-1-flash/, tiers: only({ input: 0.75, input_cache_read: 0.075, output: 4.5 }) },
  { match: /^kimi-k2[.]7-code/, tiers: only({ input: 0.95, input_cache_read: 0.19, output: 4 }) },
  { match: /^kimi-k3/, tiers: only({ input: 3, input_cache_read: 0.3, output: 15 }) },
  { match: "goldeneye", tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "raptor-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: "minimax-m2.5", tiers: only({ input: 0.3, output: 1.2 }) },
  { match: /^text-embedding-3-small/, tiers: only({ input: 0.02, output: 0 }) },
  { match: "text-embedding-ada-002", tiers: only({ input: 0.1, output: 0 }) },
]

const ISO_DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

const matchPricing = (publicName: string): ModelPricing | null => {
  for (const entry of COPILOT_MODEL_PRICING) {
    const hit =
      typeof entry.match === "string" ? publicName === entry.match : entry.match.test(publicName)
    if (hit) return entry.tiers[0]!.pricing
  }
  const dateless = publicName.replace(ISO_DATE_SUFFIX, "")
  if (dateless !== publicName) return matchPricing(dateless)
  return null
}

export const pricingForCopilotPublicModelId = (publicName: string): ModelPricing | null =>
  matchPricing(publicName)

export const pricingForCopilotModelKey = (modelKey: string): ModelPricing | null =>
  matchPricing(copilotPublicModelId(modelKey))
```

- [ ] **Step 3: Run the same tests — they must still pass, unmodified**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/provider-copilot/src/__tests__/pricing.test.ts
```

Expected: 7 pass, 0 fail. If any case needs editing, the refactor changed behaviour — revert and redo.

- [ ] **Step 4: Run the wider pricing regression**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test provider-pricing
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/src/pricing.ts
git commit -m "refactor(pricing): give the copilot table room for context tiers"
```

---

## Task 2: `copilotPricingCatalog()` and its invariants

**Files:**
- Modify: `vnext/packages/provider-copilot/src/pricing.ts`
- Modify: `vnext/packages/provider-copilot/src/__tests__/pricing.test.ts` (append only)

- [ ] **Step 1: Write the failing tests**

Append to `vnext/packages/provider-copilot/src/__tests__/pricing.test.ts`:

```ts
import {
  copilotPricingCatalog,
  COPILOT_PRICING_SOURCE,
} from "../pricing"

test("the default tier never carries a context threshold", () => {
  // A threshold on tiers[0] would make billing silently charge the
  // long-context rate for every request.
  for (const model of copilotPricingCatalog().models) {
    expect(model.tiers[0]?.contextThreshold).toBeUndefined()
  }
})

test("every catalog entry has at least one tier", () => {
  for (const model of copilotPricingCatalog().models) {
    expect(model.tiers.length).toBeGreaterThan(0)
  }
})

test("display names are unique so no two rows render identically", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  expect(new Set(names).size).toBe(names.length)
})

test("the catalog exposes only documented models", () => {
  for (const model of copilotPricingCatalog().models) {
    expect(typeof model.displayName).toBe("string")
    expect(model.displayName.length).toBeGreaterThan(0)
  }
})

test("the catalog carries its source url and verification date", () => {
  const { source } = copilotPricingCatalog()
  expect(source.url).toBe(COPILOT_PRICING_SOURCE.url)
  expect(source.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/provider-copilot/src/__tests__/pricing.test.ts
```

Expected: FAIL — `copilotPricingCatalog is not a function` / import error.

- [ ] **Step 3: Add the catalog export**

Append to `vnext/packages/provider-copilot/src/pricing.ts`:

```ts
/** A catalog row: a model the docs page lists, with its tiers. */
export interface CopilotCatalogModel {
  readonly displayName: string
  readonly tiers: readonly PricingTier[]
}

export interface CopilotPricingCatalog {
  readonly source: typeof COPILOT_PRICING_SOURCE
  readonly models: readonly CopilotCatalogModel[]
}

/**
 * The subset of the table that mirrors the docs page: entries carrying a
 * `displayName`. Billing-only entries (legacy and internal models the page no
 * longer lists) are filtered out. Regex matchers are never exposed.
 */
export const copilotPricingCatalog = (): CopilotPricingCatalog => ({
  source: COPILOT_PRICING_SOURCE,
  models: COPILOT_MODEL_PRICING.filter(
    (m): m is CopilotModelPricing & { displayName: string } => Boolean(m.displayName),
  ).map((m) => ({ displayName: m.displayName, tiers: m.tiers })),
})
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/provider-copilot/src/__tests__/pricing.test.ts
```

Expected: 12 pass. The four invariant tests pass vacuously — no entry has a `displayName` yet, so `models` is empty. Task 3 fills it and makes them load-bearing.

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/src/pricing.ts vnext/packages/provider-copilot/src/__tests__/pricing.test.ts
git commit -m "feat(pricing): expose a docs-mirroring copilot pricing catalog"
```

---

## Task 3: Transcribe the docs rows

Data transcribed 2026-08-12 from the seven vendor tables on
`https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing`.
This is the highest-risk step; every number below is verbatim from the page.

Three kinds of change:
1. **Add `displayName`** to entries the page lists.
2. **Add long-context tiers** where the page prints a second band.
3. **Split** matchers that cover more than one docs row into one entry per row (D2), and **add** `mai-code-1.1-flash`, which the page lists but the table lacks.

Entries with no `displayName` stay exactly as they are — they are billing-only.

**Files:**
- Modify: `vnext/packages/provider-copilot/src/pricing.ts`
- Test: `vnext/packages/provider-copilot/src/__tests__/pricing.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `vnext/packages/provider-copilot/src/__tests__/pricing.test.ts`:

```ts
function catalogRow(displayName: string) {
  const row = copilotPricingCatalog().models.find((m) => m.displayName === displayName)
  if (!row) throw new Error(`no catalog row for ${displayName}`)
  return row
}

test("GPT-5.5 carries both published bands", () => {
  const row = catalogRow("GPT-5.5")
  expect(row.tiers).toEqual([
    { label: "Default", pricing: { input: 5, input_cache_read: 0.5, output: 30 } },
    {
      label: "Long context",
      contextThreshold: 272_000,
      pricing: { input: 10, input_cache_read: 1, output: 45 },
    },
  ])
})

test("GPT-5.6 Luna's long-context band starts at 200K, not 272K", () => {
  expect(catalogRow("GPT-5.6 Luna").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 0.4, input_cache_read: 0.04, input_cache_write: 0.5, output: 1.8 },
  })
})

test("Grok 4.5 and Gemini 3.1 Pro also have long-context bands", () => {
  expect(catalogRow("Grok 4.5").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 4, input_cache_read: 1, output: 12 },
  })
  expect(catalogRow("Gemini 3.1 Pro").tiers[1]).toEqual({
    label: "Long context",
    contextThreshold: 200_000,
    pricing: { input: 4, input_cache_read: 0.4, output: 18 },
  })
})

test("the merged claude matchers are split into one row per docs row", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  for (const n of [
    "Claude Opus 4.5",
    "Claude Opus 4.6",
    "Claude Opus 4.7",
    "Claude Opus 4.8",
    "Claude Sonnet 4",
    "Claude Sonnet 4.5",
    "Claude Sonnet 4.6",
  ]) {
    expect(names).toContain(n)
  }
})

test("splitting the claude matchers did not change what they price", () => {
  const opus = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }
  for (const id of ["claude-opus-4-5", "claude-opus-4.6", "claude-opus-4-7", "claude-opus-4.8"]) {
    expect(pricingForCopilotPublicModelId(id)).toEqual(opus)
  }
  const sonnet = { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }
  for (const id of ["claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4.6"]) {
    expect(pricingForCopilotPublicModelId(id)).toEqual(sonnet)
  }
})

test("MAI-Code-1.1-Flash is priced separately from MAI-Code-1-Flash", () => {
  expect(pricingForCopilotPublicModelId("mai-code-1.1-flash")).toEqual({
    input: 0.2,
    input_cache_read: 0.02,
    output: 1.2,
  })
  expect(pricingForCopilotPublicModelId("mai-code-1-flash")).toEqual({
    input: 0.75,
    input_cache_read: 0.075,
    output: 4.5,
  })
})

test("legacy and internal models stay out of the catalog", () => {
  const names = copilotPricingCatalog().models.map((m) => m.displayName)
  for (const n of ["goldeneye", "gpt-3.5-turbo", "gpt-4o", "minimax-m2.5"]) {
    expect(names).not.toContain(n)
  }
  // ...but they still price.
  expect(pricingForCopilotPublicModelId("goldeneye")).not.toBeNull()
  expect(pricingForCopilotPublicModelId("gpt-3.5-turbo")).not.toBeNull()
})

test("the catalog has one row per documented model", () => {
  // 11 Anthropic + 9 OpenAI + 3 Google + 1 xAI + 2 Microsoft + 2 Moonshot + 1 fine-tuned
  expect(copilotPricingCatalog().models.length).toBe(29)
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/provider-copilot/src/__tests__/pricing.test.ts
```

Expected: FAIL — `no catalog row for GPT-5.5`, etc.

- [ ] **Step 3: Replace the `COPILOT_MODEL_PRICING` array**

Replace the whole `const COPILOT_MODEL_PRICING: readonly CopilotModelPricing[] = [ ... ]` block in `vnext/packages/provider-copilot/src/pricing.ts` with:

```ts
const OPUS_4X_5: ModelPricing = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }
const SONNET_4X: ModelPricing = { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 }

const COPILOT_MODEL_PRICING: readonly CopilotModelPricing[] = [
  // ── Anthropic ────────────────────────────────────────────────────────────
  // Claude ids may appear in either dot form (`claude-opus-4.7`, Copilot raw)
  // or dash form (`claude-opus-4-7`, Anthropic public id), so the matchers
  // accept `[.-]`. One entry per docs row, sharing a pricing constant.
  { displayName: "Claude Opus 4.5", match: /^claude-opus-4[.-]5$/, tiers: only(OPUS_4X_5) },
  { displayName: "Claude Opus 4.6", match: /^claude-opus-4[.-]6$/, tiers: only(OPUS_4X_5) },
  { displayName: "Claude Opus 4.7", match: /^claude-opus-4[.-]7$/, tiers: only(OPUS_4X_5) },
  { displayName: "Claude Opus 4.8", match: /^claude-opus-4[.-]8$/, tiers: only(OPUS_4X_5) },
  { displayName: "Claude Opus 5", match: /^claude-opus-5([.-]\d)?$/, tiers: only(OPUS_4X_5) },
  { displayName: "Claude Sonnet 4", match: /^claude-sonnet-4$/, tiers: only(SONNET_4X) },
  { displayName: "Claude Sonnet 4.5", match: /^claude-sonnet-4[.-]5$/, tiers: only(SONNET_4X) },
  { displayName: "Claude Sonnet 4.6", match: /^claude-sonnet-4[.-]6$/, tiers: only(SONNET_4X) },
  {
    displayName: "Claude Sonnet 5",
    match: /^claude-sonnet-5([.-]\d)?$/,
    tiers: only({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10 }),
  },
  {
    displayName: "Claude Fable 5",
    match: /^claude-fable-5([.-]\d)?$/,
    tiers: only({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 }),
  },
  {
    displayName: "Claude Haiku 4.5",
    match: /^claude-haiku-4[.-]5$/,
    tiers: only({ input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 }),
  },

  // ── OpenAI ───────────────────────────────────────────────────────────────
  {
    displayName: "GPT-5.6 Sol",
    match: "gpt-5.6-sol",
    tiers: [
      { label: "Default", pricing: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 } },
      {
        label: "Long context",
        contextThreshold: 272_000,
        pricing: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 },
      },
    ],
  },
  {
    displayName: "GPT-5.6 Terra",
    match: "gpt-5.6-terra",
    tiers: [
      { label: "Default", pricing: { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 12 } },
      {
        label: "Long context",
        contextThreshold: 272_000,
        pricing: { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 18 },
      },
    ],
  },
  {
    displayName: "GPT-5.6 Luna",
    match: "gpt-5.6-luna",
    tiers: [
      { label: "Default", pricing: { input: 0.2, input_cache_read: 0.02, input_cache_write: 0.25, output: 1.2 } },
      {
        label: "Long context",
        contextThreshold: 200_000,
        pricing: { input: 0.4, input_cache_read: 0.04, input_cache_write: 0.5, output: 1.8 },
      },
    ],
  },
  {
    displayName: "GPT-5.5",
    match: "gpt-5.5",
    tiers: [
      { label: "Default", pricing: { input: 5, input_cache_read: 0.5, output: 30 } },
      {
        label: "Long context",
        contextThreshold: 272_000,
        pricing: { input: 10, input_cache_read: 1, output: 45 },
      },
    ],
  },
  {
    displayName: "GPT-5.4",
    match: "gpt-5.4",
    tiers: [
      { label: "Default", pricing: { input: 2.5, input_cache_read: 0.25, output: 15 } },
      {
        label: "Long context",
        contextThreshold: 272_000,
        pricing: { input: 5, input_cache_read: 0.5, output: 22.5 },
      },
    ],
  },
  {
    displayName: "GPT-5.4 mini",
    match: "gpt-5.4-mini",
    tiers: only({ input: 0.75, input_cache_read: 0.075, output: 4.5 }),
  },
  {
    displayName: "GPT-5.4 nano",
    match: "gpt-5.4-nano",
    tiers: only({ input: 0.2, input_cache_read: 0.02, output: 1.25 }),
  },
  // The page lists only GPT-5.3-Codex; the matcher also covers the 5.2 ids it
  // no longer lists, so this stays one entry (D2).
  {
    displayName: "GPT-5.3-Codex",
    match: /^gpt-5[.][23](-codex)?$/,
    tiers: only({ input: 1.75, input_cache_read: 0.175, output: 14 }),
  },
  // Billing-only from here in the OpenAI block.
  { match: "gpt-5.1-codex-mini", tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }) },
  { match: /^gpt-5[.]1/, tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  {
    displayName: "GPT-5 mini",
    match: "gpt-5-mini",
    tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }),
  },
  { match: /^gpt-4[.]1/, tiers: only({ input: 2, input_cache_read: 0.5, output: 8 }) },
  { match: "gpt-41-copilot", tiers: only({ input: 2, input_cache_read: 0.5, output: 8 }) },
  { match: /^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, tiers: only({ input: 2.5, input_cache_read: 1.25, output: 10 }) },
  { match: "gpt-4-o-preview", tiers: only({ input: 2.5, input_cache_read: 1.25, output: 10 }) },
  { match: /^gpt-4o-mini/, tiers: only({ input: 0.15, input_cache_read: 0.075, output: 0.6 }) },
  { match: /^gpt-4(-0613)?$/, tiers: only({ input: 30, output: 60 }) },
  { match: "gpt-4-0125-preview", tiers: only({ input: 10, output: 30 }) },
  { match: "gpt-3.5-turbo", tiers: only({ input: 0.5, output: 1.5 }) },
  { match: "gpt-3.5-turbo-0613", tiers: only({ input: 1.5, output: 2 }) },

  // ── Google ───────────────────────────────────────────────────────────────
  { match: "gemini-2.5-pro", tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "gemini-3-flash-preview", tiers: only({ input: 0.5, input_cache_read: 0.05, output: 3 }) },
  {
    displayName: "Gemini 3.1 Pro",
    match: "gemini-3.1-pro-preview",
    tiers: [
      { label: "Default", pricing: { input: 2, input_cache_read: 0.2, output: 12 } },
      {
        label: "Long context",
        contextThreshold: 200_000,
        pricing: { input: 4, input_cache_read: 0.4, output: 18 },
      },
    ],
  },
  {
    displayName: "Gemini 3.5 Flash",
    match: "gemini-3.5-flash",
    tiers: only({ input: 1.5, input_cache_read: 0.15, output: 9 }),
  },
  {
    displayName: "Gemini 3.6 Flash",
    match: "gemini-3.6-flash",
    tiers: only({ input: 1.5, input_cache_read: 0.15, output: 7.5 }),
  },

  // ── xAI ──────────────────────────────────────────────────────────────────
  { match: /^grok-code-fast/, tiers: only({ input: 0.2, output: 1.5 }) },
  {
    displayName: "Grok 4.5",
    match: /^grok-4[.]5/,
    tiers: [
      { label: "Default", pricing: { input: 2, input_cache_read: 0.5, output: 6 } },
      {
        label: "Long context",
        contextThreshold: 200_000,
        pricing: { input: 4, input_cache_read: 1, output: 12 },
      },
    ],
  },

  // ── Microsoft ────────────────────────────────────────────────────────────
  {
    displayName: "MAI-Code-1.1-Flash",
    match: /^mai-code-1[.]1-flash/,
    tiers: only({ input: 0.2, input_cache_read: 0.02, output: 1.2 }),
  },
  {
    displayName: "MAI-Code-1-Flash",
    match: /^mai-code-1-flash/,
    tiers: only({ input: 0.75, input_cache_read: 0.075, output: 4.5 }),
  },

  // ── Moonshot AI ──────────────────────────────────────────────────────────
  {
    displayName: "Kimi K2.7 Code",
    match: /^kimi-k2[.]7-code/,
    tiers: only({ input: 0.95, input_cache_read: 0.19, output: 4 }),
  },
  {
    displayName: "Kimi K3",
    match: /^kimi-k3/,
    tiers: only({ input: 3, input_cache_read: 0.3, output: 15 }),
  },

  // ── Fine-tuned (GitHub) ──────────────────────────────────────────────────
  {
    displayName: "Raptor mini",
    match: "raptor-mini",
    tiers: only({ input: 0.25, input_cache_read: 0.025, output: 2 }),
  },

  // ── Billing-only: not listed on the docs page ────────────────────────────
  { match: "goldeneye", tiers: only({ input: 1.25, input_cache_read: 0.125, output: 10 }) },
  { match: "minimax-m2.5", tiers: only({ input: 0.3, output: 1.2 }) },
  { match: /^text-embedding-3-small/, tiers: only({ input: 0.02, output: 0 }) },
  { match: "text-embedding-ada-002", tiers: only({ input: 0.1, output: 0 }) },
]
```

Note on ordering: `gpt-5.1-codex-mini` must stay before `/^gpt-5[.]1/`, and the `gpt-4o` matchers keep their relative order. `mai-code-1.1-flash` is placed before `mai-code-1-flash` for readability; the matchers are disjoint either way.

- [ ] **Step 4: Run the full provider-copilot suite**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/provider-copilot
```

Expected: all pass, including the original 7 billing cases unmodified.

- [ ] **Step 5: Run the cross-package pricing regression**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test provider-pricing
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/src/pricing.ts vnext/packages/provider-copilot/src/__tests__/pricing.test.ts
git commit -m "feat(pricing): transcribe the published copilot context tiers"
```

---

## Task 4: `GET /api/pricing`

**Files:**
- Modify: `vnext/packages/provider-copilot/src/index.ts`
- Create: `vnext/packages/gateway/src/control-plane/pricing/routes.ts`
- Modify: `vnext/packages/gateway/src/control-plane/routes.ts`
- Test: `vnext/packages/gateway/tests/control-plane-pricing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/control-plane-pricing.test.ts`:

```ts
/**
 * pricing control-plane tests. The endpoint is static — no repo, no upstream
 * I/O — so the test only asserts the response contract.
 */
import { test, expect } from 'bun:test'
import { Hono } from 'hono'
import { pricingRouter } from '../src/control-plane/pricing/routes.ts'

function app() {
  const a = new Hono()
  a.route('/api', pricingRouter)
  return a
}

test('GET /api/pricing returns the copilot provider with its source', async () => {
  const res = await app().request('/api/pricing')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    providers: Array<{
      provider: string
      source: { url: string; verifiedOn: string }
      models: Array<{ displayName: string; tiers: Array<{ label: string }> }>
    }>
  }
  const copilot = body.providers.find((p) => p.provider === 'copilot')
  expect(copilot).toBeDefined()
  expect(copilot!.source.url).toContain('docs.github.com')
  expect(copilot!.source.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(copilot!.models.length).toBeGreaterThan(0)
})

test('GET /api/pricing exposes context tiers and no regex matchers', async () => {
  const res = await app().request('/api/pricing')
  const body = (await res.json()) as {
    providers: Array<{ models: Array<Record<string, unknown> & { displayName: string }> }>
  }
  const models = body.providers.flatMap((p) => p.models)
  for (const m of models) expect(m.match).toBeUndefined()
  const gpt55 = models.find((m) => m.displayName === 'GPT-5.5')
  expect(gpt55).toBeDefined()
  expect((gpt55!.tiers as unknown[]).length).toBe(2)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/gateway/tests/control-plane-pricing.test.ts
```

Expected: FAIL — cannot resolve `../src/control-plane/pricing/routes.ts`.

- [ ] **Step 3: Export the catalog from the provider barrel**

In `vnext/packages/provider-copilot/src/index.ts`, after the line
`export { copilotModelEndpoints } from "./endpoints"`, add:

```ts
export { copilotPricingCatalog, COPILOT_PRICING_SOURCE } from "./pricing"
export type {
  CopilotPricingCatalog,
  CopilotCatalogModel,
  PricingTier,
} from "./pricing"
```

- [ ] **Step 4: Create the router**

Create `vnext/packages/gateway/src/control-plane/pricing/routes.ts`:

```ts
/**
 * pricing control-plane router — GET /api/pricing.
 *
 * Static: the published per-token price tables live in the provider packages,
 * so this handler does no repo or upstream I/O and cannot fail from an
 * unreachable upstream. The response is shaped as a list of providers so
 * adding codex / claude-code later is additive on both sides.
 */
import { Hono } from 'hono'
import { copilotPricingCatalog } from '@vibe-llm/provider-copilot'
import type { Env } from '../../app.ts'

export const pricingRouter = new Hono<{ Bindings: Env }>()

pricingRouter.get('/pricing', (c) => {
  const copilot = copilotPricingCatalog()
  return c.json({
    providers: [
      {
        provider: 'copilot',
        source: copilot.source,
        models: copilot.models,
      },
    ],
  })
})
```

- [ ] **Step 5: Mount it**

In `vnext/packages/gateway/src/control-plane/routes.ts`, add the import after
the `dumpRoutes` import:

```ts
import { pricingRouter } from './pricing/routes.ts'
```

and the mount after the `dataTransferRouter` line:

```ts
// /api/pricing
controlPlane.route('/api', pricingRouter)
```

- [ ] **Step 6: Run the test**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/gateway/tests/control-plane-pricing.test.ts
```

Expected: 2 pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/src/index.ts \
        vnext/packages/gateway/src/control-plane/pricing/routes.ts \
        vnext/packages/gateway/src/control-plane/routes.ts \
        vnext/packages/gateway/tests/control-plane-pricing.test.ts
git commit -m "feat(api): serve the published pricing catalog at /api/pricing"
```

---

## Task 5: Dashboard client and tab

**Files:**
- Create: `vnext/apps/dashboard/src/api/pricing.ts`
- Create: `vnext/apps/dashboard/src/tabs/pricing/PricingTab.tsx`
- Modify: `vnext/apps/dashboard/src/App.tsx`
- Modify: `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`

- [ ] **Step 1: Create the API client**

Create `vnext/apps/dashboard/src/api/pricing.ts`:

```ts
import { api } from "./client"

export interface PricingTier {
  label: string
  /** Input-token count above which this tier applies. Absent on the default tier. */
  contextThreshold?: number
  pricing: {
    input?: number
    input_cache_read?: number
    input_cache_write?: number
    output?: number
  }
}

export interface PricingModel {
  displayName: string
  tiers: PricingTier[]
}

export interface PricingProvider {
  provider: string
  source: { url: string; verifiedOn: string }
  models: PricingModel[]
}

export interface PricingCatalog {
  providers: PricingProvider[]
}

export function getPricing(): Promise<PricingCatalog> {
  return api<PricingCatalog>("/api/pricing")
}
```

- [ ] **Step 2: Create the tab**

Create `vnext/apps/dashboard/src/tabs/pricing/PricingTab.tsx`:

```tsx
import { useEffect, useState } from "react"
import { getPricing, type PricingCatalog, type PricingTier } from "../../api/pricing"
import { useT } from "../../state/i18n"

/** "5.00", "0.075", "—" — two decimals unless a third is significant. */
function usd(v: number | undefined): string {
  if (v === undefined) return "—"
  const three = v.toFixed(3)
  return three.endsWith("0") ? v.toFixed(2) : three
}

function tierLabel(tier: PricingTier, defaultLabel: string): string {
  if (tier.contextThreshold === undefined) return defaultLabel
  return `> ${Math.round(tier.contextThreshold / 1000)}K`
}

export function PricingTab() {
  const t = useT()
  const [data, setData] = useState<PricingCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getPricing()
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  if (error) return <div className="glass-card p-4 sm:p-6 text-sm text-accent-red">{error}</div>
  if (!data) return <div className="glass-card p-4 sm:p-6 text-sm text-themed-dim">{t("dash.loadingShort")}</div>

  return (
    <div className="flex flex-col gap-4">
      {data.providers.map((p) => (
        <div key={p.provider} className="glass-card p-4 sm:p-6 animate-in">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">
              {p.provider}
            </span>
            <div className="flex items-center gap-3 text-xs text-themed-dim">
              <span>
                {t("dash.pricing.verifiedOn")} {p.source.verifiedOn}
              </span>
              <a
                href={p.source.url}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-themed-secondary"
              >
                {t("dash.pricing.source")}
              </a>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left text-xs text-themed-dim pb-3">
                {t("dash.pricing.caption")}
              </caption>
              <thead>
                <tr className="text-xs text-themed-dim uppercase tracking-wider">
                  <th className="text-left font-medium py-2 pr-4">{t("dash.pricing.model")}</th>
                  <th className="text-left font-medium py-2 pr-4">{t("dash.pricing.tier")}</th>
                  <th className="text-right font-medium py-2 pr-4">{t("dash.pricing.input")}</th>
                  <th className="text-right font-medium py-2 pr-4">{t("dash.pricing.cachedInput")}</th>
                  <th className="text-right font-medium py-2 pr-4">{t("dash.pricing.cacheWrite")}</th>
                  <th className="text-right font-medium py-2">{t("dash.pricing.output")}</th>
                </tr>
              </thead>
              <tbody>
                {p.models.flatMap((m) =>
                  m.tiers.map((tier, i) => (
                    <tr key={`${m.displayName}-${tier.label}`} className="border-t border-white/5">
                      <td className="py-2 pr-4 whitespace-nowrap">{i === 0 ? m.displayName : ""}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-themed-dim">
                        {tierLabel(tier, t("dash.pricing.default"))}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(tier.pricing.input)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(tier.pricing.input_cache_read)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(tier.pricing.input_cache_write)}</td>
                      <td className="py-2 text-right tabular-nums">{usd(tier.pricing.output)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Register the tab**

In `vnext/apps/dashboard/src/App.tsx`:

Add the import after `import { ModelsTab } from "./tabs/models/ModelsTab"`:

```ts
import { PricingTab } from "./tabs/pricing/PricingTab"
```

Add to `ALL_TABS`, immediately after the `models` entry:

```ts
  { id: "pricing", labelKey: "dash.pricing", fallback: "Pricing", userOk: true },
```

Add to `TabBody`, immediately after the `case "models"` arm:

```tsx
    case "pricing":
      return <PricingTab />
```

- [ ] **Step 4: Add the strings**

In `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`, in the English
block after `"dash.models": "Models",`:

```ts
      "dash.pricing": "Pricing",
      "dash.pricing.caption": "USD per 1M tokens, as published by GitHub.",
      "dash.pricing.model": "Model",
      "dash.pricing.tier": "Tier",
      "dash.pricing.input": "Input",
      "dash.pricing.cachedInput": "Cached input",
      "dash.pricing.cacheWrite": "Cache write",
      "dash.pricing.output": "Output",
      "dash.pricing.default": "Default",
      "dash.pricing.verifiedOn": "Verified",
      "dash.pricing.source": "Source",
```

and in the Chinese block after `"dash.models": "模型",`:

```ts
      "dash.pricing": "价格",
      "dash.pricing.caption": "美元 / 每百万 token，取自 GitHub 官方文档。",
      "dash.pricing.model": "模型",
      "dash.pricing.tier": "档位",
      "dash.pricing.input": "输入",
      "dash.pricing.cachedInput": "缓存读取",
      "dash.pricing.cacheWrite": "缓存写入",
      "dash.pricing.output": "输出",
      "dash.pricing.default": "默认",
      "dash.pricing.verifiedOn": "核对于",
      "dash.pricing.source": "出处",
```

- [ ] **Step 5: Typecheck and build the dashboard**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/dashboard
bun run build
```

Expected: build succeeds, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/apps/dashboard/src/api/pricing.ts \
        vnext/apps/dashboard/src/tabs/pricing/PricingTab.tsx \
        vnext/apps/dashboard/src/App.tsx \
        vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(dashboard): add a Pricing tab mirroring the published tables"
```

---

## Task 6: Full suite and manual acceptance

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run the whole test suite**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test
```

Expected: all pass. In particular the seven original cases in
`packages/provider-copilot/src/__tests__/pricing.test.ts` pass with no edits —
that is the evidence billing behaviour is unchanged.

- [ ] **Step 2: Serve the gateway locally and open the tab**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
bun run local
```

Open the dashboard, sign in, click **Pricing**.

- [ ] **Step 3: Check the endpoint directly**

```bash
curl -s localhost:8787/api/pricing | head -c 600
```

Expected: JSON with `providers[0].provider === "copilot"`, a `source` object,
and a `models` array. No `match` field anywhere.

- [ ] **Step 4: Verify row-by-row against the docs page**

Open `https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing`
side by side with the tab and check every rendered figure. Expect **29 model
rows** covering all seven vendor tables, with two tier rows each for GPT-5.4,
GPT-5.5, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, Gemini 3.1 Pro and Grok 4.5.

If the page has changed since 2026-08-12, update both the figures and
`COPILOT_PRICING_SOURCE.verifiedOn` in the same commit.

- [ ] **Step 5: Switch to 中文 and confirm the tab label and headers translate**

Expected: tab reads 价格; column headers read 模型 / 档位 / 输入 / 缓存读取 / 缓存写入 / 输出.

- [ ] **Step 6: Commit any corrections found during verification**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A
git commit -m "fix(pricing): reconcile transcribed figures with the docs page"
```

(Skip if nothing needed correcting.)

---

## Deferred (not in this plan)

- **Billing the context tier.** `getPricingForModelKey` gaining a context-length
  argument, and the usage write path selecting the matching tier. Separate spec:
  its verification requires a real >272K-token request and first establishing
  whether input token count is known when the usage row is written.
- **Other providers.** `codex` and `claude-code` repeat Tasks 1–3 against their
  own doc URLs; the API response and the tab are already shaped for them.
- **Claude Opus 4.8 (fast mode).** Add one entry once the model id is known.
