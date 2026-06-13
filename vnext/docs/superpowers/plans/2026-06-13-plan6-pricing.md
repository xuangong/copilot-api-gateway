# Plan 6: Pricing & Per-Dimension Usage Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vNext's 4-fixed-column read-time-recompute usage scheme with main's 6-dimension per-row `unit_price` snapshot model, with provider-owned pricing.

**Architecture:** Two narrow tables (`usage` per-dimension + `usage_requests` per-bucket), each `usage` row carrying its own frozen `unit_price`. Pricing is resolved by the dispatched `ModelProvider.getPricingForModelKey(modelKey)` once per request and threaded through observability — observability stays a leaf module. Cost is a billing fact computed at write time, not a derived display value.

**Tech Stack:** Bun + bun:sqlite, D1, Hono, Cloudflare Workers (CFW + Docker dual-deploy). Spec at `docs/superpowers/specs/2026-06-13-plan6-pricing-design.md`.

---

## Task 1: Replace `ModelPricing` with 6-dimension shape in `@vnext/protocols`

**Files:**
- Modify: `packages/protocols/src/common/index.ts`
- Test: `packages/protocols/tests/pricing.test.ts` (new)

- [ ] **Step 1: Write failing tests for `unitPriceForDimension`**

Create `packages/protocols/tests/pricing.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { unitPriceForDimension, BILLING_DIMENSIONS, type ModelPricing } from '../src/common/index.ts'

test('BILLING_DIMENSIONS lists all six in canonical order', () => {
  expect([...BILLING_DIMENSIONS]).toEqual([
    'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image',
  ])
})

test('unitPriceForDimension: returns null for null pricing', () => {
  expect(unitPriceForDimension(null, 'input')).toBeNull()
  expect(unitPriceForDimension(null, 'output_image')).toBeNull()
})

test('unitPriceForDimension: returns explicit price when present', () => {
  const p: ModelPricing = { input: 3, output: 15, input_cache_read: 0.3, input_cache_write: 3.75 }
  expect(unitPriceForDimension(p, 'input')).toBe(3)
  expect(unitPriceForDimension(p, 'output')).toBe(15)
  expect(unitPriceForDimension(p, 'input_cache_read')).toBe(0.3)
  expect(unitPriceForDimension(p, 'input_cache_write')).toBe(3.75)
})

test('unitPriceForDimension: cached input falls back to bare input', () => {
  const p: ModelPricing = { input: 2, output: 8 }
  expect(unitPriceForDimension(p, 'input_cache_read')).toBe(2)
  expect(unitPriceForDimension(p, 'input_cache_write')).toBe(2)
})

test('unitPriceForDimension: image input falls back to text input', () => {
  const p: ModelPricing = { input: 2, output: 8 }
  expect(unitPriceForDimension(p, 'input_image')).toBe(2)
  expect(unitPriceForDimension(p, 'output_image')).toBe(8)
})

test('unitPriceForDimension: returns null when neither field nor fallback set', () => {
  expect(unitPriceForDimension({}, 'input')).toBeNull()
  expect(unitPriceForDimension({ output: 1 }, 'input')).toBeNull()
})
```

- [ ] **Step 2: Run tests — expect FAIL (symbols not yet exported)**

Run: `cd packages/protocols && bun test tests/pricing.test.ts`
Expected: imports fail or `unitPriceForDimension`/`BILLING_DIMENSIONS` undefined.

- [ ] **Step 3: Replace legacy `ModelPricing` in `packages/protocols/src/common/index.ts`**

Find the existing block (lines 42-47):

```ts
export interface ModelPricing {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}
```

Replace with:

```ts
export type BillingDimension =
  | 'input'
  | 'input_cache_read'
  | 'input_cache_write'
  | 'input_image'
  | 'output'
  | 'output_image'

export const BILLING_DIMENSIONS: readonly BillingDimension[] = [
  'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image',
]

/** USD per million tokens, per billing dimension. Aligned with sst/models.dev `Cost`. */
export type ModelPricing = Partial<Record<BillingDimension, number>>

/**
 * Resolve unit price for a dimension with fallback chain:
 *   input_cache_read / input_cache_write / input_image → input
 *   output_image → output
 * Returns null if neither the dimension nor its fallback is set.
 */
export function unitPriceForDimension(
  pricing: ModelPricing | null,
  dimension: BillingDimension,
): number | null {
  if (!pricing) return null
  switch (dimension) {
    case 'input':            return pricing.input ?? null
    case 'input_cache_read': return pricing.input_cache_read ?? pricing.input ?? null
    case 'input_cache_write':return pricing.input_cache_write ?? pricing.input ?? null
    case 'input_image':      return pricing.input_image ?? pricing.input ?? null
    case 'output':           return pricing.output ?? null
    case 'output_image':     return pricing.output_image ?? pricing.output ?? null
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/protocols && bun test tests/pricing.test.ts`
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/protocols/src/common/index.ts packages/protocols/tests/pricing.test.ts
git commit -m "feat(protocols): replace ModelPricing with 6-dim BillingDimension + unitPriceForDimension"
```

---

## Task 2: Add `getPricingForModelKey` to `ModelProvider` interface

**Files:**
- Modify: `packages/provider/src/types.ts`
- Test: `packages/provider/tests/fake-provider.test.ts` (new or extend)

- [ ] **Step 1: Write failing test for FakeProvider.getPricingForModelKey**

Create or extend `packages/provider/tests/fake-provider.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { FakeProvider } from '../src/types.ts'

test('FakeProvider.getPricingForModelKey returns null by default', () => {
  const p = new FakeProvider({ name: 'fake', supportedEndpoints: ['chat_completions'] })
  expect(p.getPricingForModelKey('any-model')).toBeNull()
})
```

- [ ] **Step 2: Run test — expect FAIL (method missing)**

Run: `cd packages/provider && bun test tests/fake-provider.test.ts`

- [ ] **Step 3: Add method to interface and FakeProvider**

In `packages/provider/src/types.ts`, add to the `ModelProvider` interface (preserve existing fields):

```ts
import type { ModelPricing } from '@vnext/protocols/common'

export interface ModelProvider {
  // ... existing fields ...

  /** Resolve pricing for the given raw upstream model id. Returns null when
   *  this provider doesn't know the price (caller persists null unit_price). */
  getPricingForModelKey(modelKey: string): ModelPricing | null
}
```

In the `FakeProvider` class (around line 91), add:

```ts
  getPricingForModelKey(_modelKey: string): ModelPricing | null {
    return null
  }
```

- [ ] **Step 4: Run test — expect PASS**

Run: `cd packages/provider && bun test`

- [ ] **Step 5: Commit**

```bash
git add packages/provider/
git commit -m "feat(provider): add ModelProvider.getPricingForModelKey"
```

---

## Task 3: Port Copilot pricing table to `@vnext/provider-copilot`

**Files:**
- Create: `packages/provider-copilot/src/pricing.ts`
- Test: `packages/provider-copilot/tests/pricing.test.ts` (new)
- Reference: `packages/provider-copilot/src/model-name.ts` (existing — must export `copilotPublicModelId`)

- [ ] **Step 1: Verify `copilotPublicModelId` is exported**

Run: `grep -n "export.*copilotPublicModelId" packages/provider-copilot/src/model-name.ts`
Expected: at least one match. If absent, add `export` to that helper before continuing.

- [ ] **Step 2: Write failing tests**

Create `packages/provider-copilot/tests/pricing.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from '../src/pricing.ts'

test('claude-opus-4-7 → 6-dim pricing with cache columns', () => {
  expect(pricingForCopilotPublicModelId('claude-opus-4-7')).toEqual({
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25,
  })
})

test('claude-sonnet-4-5 matches the variant-merged regex', () => {
  expect(pricingForCopilotPublicModelId('claude-sonnet-4-5')).toEqual({
    input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15,
  })
})

test('gpt-5.4 mini/nano differ from base 5.4', () => {
  expect(pricingForCopilotPublicModelId('gpt-5.4-mini')).toEqual({ input: 0.75, input_cache_read: 0.075, output: 4.5 })
  expect(pricingForCopilotPublicModelId('gpt-5.4-nano')).toEqual({ input: 0.2, input_cache_read: 0.02, output: 1.25 })
})

test('pricingForCopilotModelKey strips variant + date suffix', () => {
  expect(pricingForCopilotModelKey('claude-opus-4-7-xhigh')).toEqual({
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25,
  })
  expect(pricingForCopilotModelKey('claude-opus-4-5-20251101')).toEqual({
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25,
  })
})

test('unknown model returns null', () => {
  expect(pricingForCopilotModelKey('totally-made-up-model')).toBeNull()
  expect(pricingForCopilotPublicModelId('does-not-exist')).toBeNull()
})

test('embedding models map to input-only pricing', () => {
  expect(pricingForCopilotPublicModelId('text-embedding-3-small')).toEqual({ input: 0.02, output: 0 })
})
```

- [ ] **Step 3: Run tests — expect FAIL (file does not exist)**

Run: `cd packages/provider-copilot && bun test tests/pricing.test.ts`

- [ ] **Step 4: Create `packages/provider-copilot/src/pricing.ts`**

Copy verbatim from `/Users/zhangxian/projects/copilot-gateway/packages/provider-copilot/src/pricing.ts` (the full PricingRule table — 30+ rules: claude-opus-4-[5-8], claude-sonnet-4(-[56])?, claude-haiku-4-5, gpt-5.5/.4/.4-mini/.4-nano/.2/.3/.1-codex-mini/.1/-mini, gpt-4.1, gpt-41-copilot, gpt-4o variants, gpt-4o-mini, gpt-4(-0613), gpt-4-0125-preview, gpt-3.5-turbo, gpt-3.5-turbo-0613, gemini-2.5-pro, gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.5-flash, grok-code-fast, goldeneye, raptor-mini, minimax-m2.5, text-embedding-3-small, text-embedding-ada-002), changing only the import to `@vnext/protocols/common`:

```ts
import { copilotPublicModelId } from './model-name.ts'
import type { ModelPricing } from '@vnext/protocols/common'

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing]

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  // ... full table verbatim from main, see file map ...
]

const matchPricing = (publicName: string): ModelPricing | null => {
  for (const [key, pricing] of COPILOT_MODEL_PRICING) {
    if (typeof key === 'string' ? publicName === key : key.test(publicName)) return pricing
  }
  return null
}

export const pricingForCopilotPublicModelId = (publicName: string): ModelPricing | null =>
  matchPricing(publicName)

export const pricingForCopilotModelKey = (modelKey: string): ModelPricing | null =>
  matchPricing(copilotPublicModelId(modelKey))
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `cd packages/provider-copilot && bun test tests/pricing.test.ts`
Expected: 6/6 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/provider-copilot/src/pricing.ts packages/provider-copilot/tests/pricing.test.ts
git commit -m "feat(provider-copilot): port 6-dim pricing table from main"
```

---

## Task 4: Wire `getPricingForModelKey` in copilot/azure/custom providers

**Files:**
- Modify: `packages/provider-copilot/src/provider.ts`
- Modify: `packages/provider-azure/src/provider.ts`, `packages/provider-azure/src/types.ts` (or wherever `AzureProviderConfig` lives)
- Modify: `packages/provider-custom/src/provider.ts`, `packages/provider-custom/src/types.ts`
- Test: `packages/provider-copilot/tests/provider-pricing.test.ts`, `packages/provider-azure/tests/provider-pricing.test.ts`, `packages/provider-custom/tests/provider-pricing.test.ts`

- [ ] **Step 1: Write failing tests for copilot provider pricing**

Create `packages/provider-copilot/tests/provider-pricing.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { CopilotProvider } from '../src/provider.ts'

test('CopilotProvider.getPricingForModelKey delegates to pricingForCopilotModelKey', () => {
  const p = new CopilotProvider({ name: 'copilot', /* minimal config — see existing copilot tests for shape */ } as any)
  expect(p.getPricingForModelKey('claude-opus-4-7')).toEqual({
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25,
  })
  expect(p.getPricingForModelKey('unknown')).toBeNull()
})
```

(Adjust the constructor call to match `CopilotProvider`'s real config shape; copy from the existing copilot provider test fixtures.)

- [ ] **Step 2: Run — expect FAIL**

Run: `cd packages/provider-copilot && bun test tests/provider-pricing.test.ts`

- [ ] **Step 3: Implement in `CopilotProvider`**

In `packages/provider-copilot/src/provider.ts`, add inside the `CopilotProvider` class:

```ts
import { pricingForCopilotModelKey } from './pricing.ts'
import type { ModelPricing } from '@vnext/protocols/common'

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return pricingForCopilotModelKey(modelKey)
  }
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Write failing test for azure provider pricing**

Create `packages/provider-azure/tests/provider-pricing.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { AzureProvider } from '../src/provider.ts'

const baseCfg = {
  name: 'azure-test',
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'k',
  deployment: 'gpt-4o-deploy',
  apiVersion: '2024-08-01-preview',
  endpoints: ['chat_completions'] as const,
}

test('AzureProvider.getPricingForModelKey reads from config.models', () => {
  const p = new AzureProvider({
    ...baseCfg,
    models: [{ upstreamModelId: 'gpt-4o', cost: { input: 2.5, input_cache_read: 1.25, output: 10 } }],
  })
  expect(p.getPricingForModelKey('gpt-4o')).toEqual({ input: 2.5, input_cache_read: 1.25, output: 10 })
})

test('AzureProvider returns null for models without configured pricing', () => {
  const p = new AzureProvider(baseCfg)
  expect(p.getPricingForModelKey('gpt-4o')).toBeNull()
})
```

- [ ] **Step 6: Run — expect FAIL**

- [ ] **Step 7: Add `models` to `AzureProviderConfig` and implement**

In `packages/provider-azure/src/provider.ts`, extend `AzureProviderConfig`:

```ts
export interface AzureProviderConfig {
  // ... existing fields ...
  models?: ReadonlyArray<{ upstreamModelId: string; cost?: ModelPricing }>
}
```

Add field + method to the class:

```ts
import type { ModelPricing } from '@vnext/protocols/common'

  private readonly modelPricing: ReadonlyArray<{ upstreamModelId: string; cost?: ModelPricing }>

  constructor(cfg: AzureProviderConfig) {
    // ... existing init ...
    this.modelPricing = cfg.models ?? []
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    const entry = this.modelPricing.find((m) => m.upstreamModelId === modelKey)
    return entry?.cost ?? null
  }
```

- [ ] **Step 8: Run — expect PASS**

- [ ] **Step 9: Write failing tests for custom provider pricing**

Create `packages/provider-custom/tests/provider-pricing.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { CustomProvider } from '../src/provider.ts'

const baseCfg = {
  name: 'custom-test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'k',
  endpoints: ['chat_completions'] as const,
}

test('CustomProvider: manual config.models[].cost wins', () => {
  const p = new CustomProvider({
    ...baseCfg,
    models: [{ upstreamModelId: 'deepseek-chat', cost: { input: 0.27, output: 1.1 } }],
  })
  expect(p.getPricingForModelKey('deepseek-chat')).toEqual({ input: 0.27, output: 1.1 })
})

test('CustomProvider: returns null when no manual + no fetched pricing', () => {
  const p = new CustomProvider(baseCfg)
  expect(p.getPricingForModelKey('whatever')).toBeNull()
})
```

- [ ] **Step 10: Run — expect FAIL**

- [ ] **Step 11: Implement on `CustomProvider`**

In `packages/provider-custom/src/provider.ts` extend the config interface (same shape as azure) and add:

```ts
import type { ModelPricing } from '@vnext/protocols/common'

  // pricing layered: manual (from config) > auto (from /v1/models cost block, populated in fetch-models.ts).
  private readonly manualPricing: Map<string, ModelPricing>
  private autoPricing: Map<string, ModelPricing> = new Map()

  constructor(cfg: CustomProviderConfig) {
    // ... existing init ...
    this.manualPricing = new Map(
      (cfg.models ?? [])
        .filter((m) => m.cost)
        .map((m) => [m.upstreamModelId, m.cost as ModelPricing]),
    )
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return this.manualPricing.get(modelKey) ?? this.autoPricing.get(modelKey) ?? null
  }

  /** Called by fetch-models when refresh succeeds. */
  setAutoPricing(map: Map<string, ModelPricing>): void {
    this.autoPricing = map
  }
```

- [ ] **Step 12: Run — expect PASS**

- [ ] **Step 13: Commit**

```bash
git add packages/provider-copilot/ packages/provider-azure/ packages/provider-custom/
git commit -m "feat(providers): implement getPricingForModelKey on copilot/azure/custom"
```

---

## Task 5: Auto-parse `cost` block from custom provider's `/v1/models`

**Files:**
- Modify: `packages/provider-custom/src/fetch-models.ts`
- Test: `packages/provider-custom/tests/fetch-models-cost.test.ts` (new)

- [ ] **Step 1: Write failing tests for `parseCost`**

Create `packages/provider-custom/tests/fetch-models-cost.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { parseCost } from '../src/fetch-models.ts'

test('parseCost: full 6-dim shape', () => {
  expect(parseCost({
    input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_image: 2,
    output: 5, output_image: 6,
  })).toEqual({
    input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_image: 2,
    output: 5, output_image: 6,
  })
})

test('parseCost: returns undefined for null/non-object', () => {
  expect(parseCost(null)).toBeUndefined()
  expect(parseCost('cheap')).toBeUndefined()
  expect(parseCost(42)).toBeUndefined()
})

test('parseCost: drops non-number fields silently (lenient — malformed cost is "absent")', () => {
  expect(parseCost({ input: 'free', output: 5 })).toEqual({ output: 5 })
})

test('parseCost: returns undefined when no usable fields', () => {
  expect(parseCost({})).toBeUndefined()
  expect(parseCost({ banana: 1 })).toBeUndefined()
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Add `parseCost` + wiring in `fetch-models.ts`**

Add (export) a `parseCost` helper and call it on each model entry. After parsing the `/v1/models` response, build a `Map<string, ModelPricing>` of `(modelId → parsed cost)` and call `provider.setAutoPricing(map)`:

```ts
import { BILLING_DIMENSIONS, type ModelPricing } from '@vnext/protocols/common'

export function parseCost(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: ModelPricing = {}
  for (const dim of BILLING_DIMENSIONS) {
    const v = (raw as Record<string, unknown>)[dim]
    if (typeof v === 'number') out[dim] = v
  }
  return Object.keys(out).length === 0 ? undefined : out
}
```

In the existing models-refresh flow, after parsing the model list:

```ts
const pricingMap = new Map<string, ModelPricing>()
for (const m of upstreamModels) {
  const cost = parseCost((m as { cost?: unknown }).cost)
  if (cost) pricingMap.set(m.id, cost)
}
provider.setAutoPricing(pricingMap)
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/provider-custom/
git commit -m "feat(provider-custom): parse models.dev cost block from /v1/models"
```

---

## Task 6: Rewrite `UsageRecord` and `UsageRepo` types

**Files:**
- Modify: `apps/gateway/src/shared/repo/types.ts`

This task changes types only — no runtime yet. Tests for callers will compile-fail; subsequent tasks fix them. We commit after the type swap so each downstream task has a green incremental.

- [ ] **Step 1: Replace `UsageRecord` (lines 61-75)**

```ts
import type { BillingDimension, ModelPricing } from '@vnext/protocols/common'

export type TokenUsage = Partial<Record<BillingDimension, number>>

export interface UsageRecord {
  keyId: string
  /** Public model id (post-variant-merge). */
  model: string
  /** Raw upstream model id used for pricing lookup. */
  modelKey: string
  /** Provider-prefixed upstream id, e.g. "copilot:<id>"; null for pre-port rows. */
  upstream: string | null
  /** SDK/client distinguisher; '' when unknown (vNext-specific PK part). */
  client: string
  hour: string
  requests: number
  /** Per-dimension token counts; dimensions with 0 tokens are dropped. */
  tokens: TokenUsage
  /** Frozen pricing snapshot reassembled from per-dimension unit_price on read,
   *  or supplied at write time from `provider.getPricingForModelKey`. */
  cost: ModelPricing | null
}
```

- [ ] **Step 2: Replace `UsageRepo` (lines 141-159)**

```ts
export interface UsageRepo {
  /** Additive upsert: tokens += excluded.tokens, requests += excluded.requests. */
  record(r: UsageRecord): Promise<void>
  /** Replacement upsert (used by data-transfer import): clears bucket's
   *  dimension rows first, then inserts the new record's dimensions. */
  set(r: UsageRecord): Promise<void>
  query(opts: { keyId?: string; keyIds?: string[]; start: string; end: string }): Promise<UsageRecord[]>
  listAll(): Promise<UsageRecord[]>
  deleteAll(): Promise<void>
}
```

- [ ] **Step 3: TypeScript check (will fail for downstream callers — that's intended)**

Run: `cd apps/gateway && bun tsc --noEmit 2>&1 | head -40`
Expected: compile errors in `repo/shared/repos.ts`, `observability/usage-tracker.ts`, `data-plane/observability/attempts/*.ts`, `control-plane/token-usage/routes.ts`, and tests. These are addressed in Tasks 7-15.

- [ ] **Step 4: Commit (broken intermediate, but isolated to this single types diff)**

```bash
git add apps/gateway/src/shared/repo/types.ts
git commit -m "feat(repo): rewrite UsageRecord/UsageRepo for 6-dim TokenUsage + ModelPricing snapshot

Intermediate breakage: callers in repos.ts, usage-tracker.ts, attempts/*, and
token-usage routes are addressed in Tasks 7-15."
```

---

## Task 7: New schema in sqlite.ts + d1.ts (two tables, in-place migration)

**Files:**
- Modify: `apps/gateway/src/shared/repo/sqlite.ts`
- Modify: `apps/gateway/src/shared/repo/d1.ts`
- Test: `apps/gateway/tests/repo-usage-migration.test.ts` (new)

- [ ] **Step 1: Write failing migration test**

Create `apps/gateway/tests/repo-usage-migration.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSqlite } from '../src/shared/repo/sqlite.ts'

test('in-place migration: legacy 4-column usage rows are converted to per-dimension rows', () => {
  const db = new Database(':memory:')
  // Seed legacy schema (subset — just enough for the migration block).
  db.exec(`
    CREATE TABLE usage (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, hour TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_json TEXT
    );
    INSERT INTO usage VALUES ('k1','gpt-4o','copilot:1','2026-06-13T10','curl',3,100,50,10,5,NULL);
    INSERT INTO usage VALUES ('k1','gpt-4o','copilot:1','2026-06-13T11','curl',1,80,40,0,0,NULL);
  `)

  initSqlite(db) // bootstrap should detect legacy column + migrate

  // After: usage_requests carries per-bucket request counts
  const reqs = db.prepare('SELECT key_id, hour, requests FROM usage_requests ORDER BY hour').all() as any[]
  expect(reqs).toEqual([
    { key_id: 'k1', hour: '2026-06-13T10', requests: 3 },
    { key_id: 'k1', hour: '2026-06-13T11', requests: 1 },
  ])

  // And: usage carries per-dimension rows (zero-token dims are dropped)
  const dims = db.prepare(
    "SELECT hour, dimension, tokens, unit_price FROM usage WHERE key_id='k1' ORDER BY hour, dimension",
  ).all() as any[]
  expect(dims).toEqual([
    { hour: '2026-06-13T10', dimension: 'input', tokens: 100, unit_price: null },
    { hour: '2026-06-13T10', dimension: 'input_cache_read', tokens: 10, unit_price: null },
    { hour: '2026-06-13T10', dimension: 'input_cache_write', tokens: 5, unit_price: null },
    { hour: '2026-06-13T10', dimension: 'output', tokens: 50, unit_price: null },
    { hour: '2026-06-13T11', dimension: 'input', tokens: 80, unit_price: null },
    { hour: '2026-06-13T11', dimension: 'output', tokens: 40, unit_price: null },
  ])
})

test('fresh install: new schema created directly with no legacy rows', () => {
  const db = new Database(':memory:')
  initSqlite(db)
  // Both tables exist
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage','usage_requests')")
    .all() as Array<{ name: string }>
  expect(tables.map((t) => t.name).sort()).toEqual(['usage', 'usage_requests'])
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Replace the legacy `CREATE TABLE usage` block in `sqlite.ts` (lines 54-68)**

```sql
CREATE TABLE IF NOT EXISTS usage (
  key_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  upstream   TEXT,
  model_key  TEXT NOT NULL,
  client     TEXT NOT NULL DEFAULT '',
  hour       TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  unit_price REAL,
  PRIMARY KEY (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension)
);
CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);

CREATE TABLE IF NOT EXISTS usage_requests (
  key_id    TEXT NOT NULL,
  model     TEXT NOT NULL,
  upstream  TEXT,
  model_key TEXT NOT NULL,
  client    TEXT NOT NULL DEFAULT '',
  hour      TEXT NOT NULL,
  requests  INTEGER NOT NULL,
  PRIMARY KEY (key_id, model, COALESCE(upstream, ''), model_key, client, hour)
);
CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour);
```

- [ ] **Step 4: Add migration block in `sqlite.ts` bootstrap**

Replace the existing `if (!hasColumn(db, "usage", "client"))` block and the `cache_read_tokens`/`cache_creation_tokens` ALTERs with a single forward-port block. Place it after the bootstrap CREATE TABLEs but before any ALTER blocks for unrelated tables:

```ts
// Plan 6: in-place upgrade legacy 4-column `usage` to per-dimension rows.
// Detect legacy by presence of `input_tokens` (gone in new schema).
if (hasColumn(db, "usage", "input_tokens")) {
  db.exec(`
    -- Stage new tables under temp names so we can swap atomically.
    CREATE TABLE usage_dims_new (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, dimension TEXT NOT NULL,
      tokens INTEGER NOT NULL, unit_price REAL,
      PRIMARY KEY (key_id, model, COALESCE(upstream, ''), model_key, client, hour, dimension)
    );
    CREATE TABLE usage_reqs_new (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT '', hour TEXT NOT NULL, requests INTEGER NOT NULL,
      PRIMARY KEY (key_id, model, COALESCE(upstream, ''), model_key, client, hour)
    );

    INSERT INTO usage_reqs_new (key_id, model, upstream, model_key, client, hour, requests)
      SELECT key_id, model, upstream, model AS model_key, client, hour, requests FROM usage;

    INSERT INTO usage_dims_new (key_id, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
      SELECT key_id, model, upstream, model, client, hour, 'input', input_tokens, NULL FROM usage WHERE input_tokens > 0
      UNION ALL
      SELECT key_id, model, upstream, model, client, hour, 'output', output_tokens, NULL FROM usage WHERE output_tokens > 0
      UNION ALL
      SELECT key_id, model, upstream, model, client, hour, 'input_cache_read', cache_read_tokens, NULL FROM usage WHERE cache_read_tokens > 0
      UNION ALL
      SELECT key_id, model, upstream, model, client, hour, 'input_cache_write', cache_creation_tokens, NULL FROM usage WHERE cache_creation_tokens > 0;

    DROP TABLE usage;
    ALTER TABLE usage_dims_new RENAME TO usage;
    ALTER TABLE usage_reqs_new RENAME TO usage_requests;
    CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage (hour);
    CREATE INDEX IF NOT EXISTS idx_usage_requests_hour ON usage_requests (hour);
  `)
}
```

Note: legacy rows have no `model_key` distinct from `model` — we set `model_key = model` as the best-effort recovery. unit_price stays NULL (acceptable per spec — pre-port history has no snapshot).

- [ ] **Step 5: Mirror the same schema + migration logic in `d1.ts`**

Apply the identical CREATE TABLE statements and migration `db.exec(...)` block in `d1.ts`'s init path. D1's `prepare`/`exec` API differs slightly — use the same SQL but invoked via `await db.batch([...])` if needed; the SQL itself is portable.

- [ ] **Step 6: Run migration test — expect PASS**

Run: `cd apps/gateway && bun test tests/repo-usage-migration.test.ts`

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/shared/repo/sqlite.ts apps/gateway/src/shared/repo/d1.ts apps/gateway/tests/repo-usage-migration.test.ts
git commit -m "feat(repo): two-table per-dimension usage schema + in-place migration"
```

---

## Task 8: Rewrite `SharedUsageRepo` for the two-table model

**Files:**
- Modify: `apps/gateway/src/shared/repo/shared/repos.ts`
- Test: `apps/gateway/tests/repo-usage.test.ts` (new — exercise record/set/query)

- [ ] **Step 1: Write failing tests**

Create `apps/gateway/tests/repo-usage.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSqlite } from '../src/shared/repo/sqlite.ts'
import { buildSharedRepo } from '../src/shared/repo/shared/repos.ts'
import type { UsageRecord } from '../src/shared/repo/types.ts'

let db: Database
let repo: ReturnType<typeof buildSharedRepo>

beforeEach(() => {
  db = new Database(':memory:')
  initSqlite(db)
  repo = buildSharedRepo(db) // adapt to actual factory signature
})

const baseRec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'k1', model: 'gpt-4o', modelKey: 'gpt-4o', upstream: 'copilot:1',
  client: 'curl', hour: '2026-06-13T10', requests: 1,
  tokens: { input: 100, output: 50 }, cost: { input: 2.5, output: 10 },
  ...over,
})

test('record() is additive: two calls double tokens, double requests, keep first unit_price', async () => {
  await repo.usage.record(baseRec())
  await repo.usage.record(baseRec({ cost: { input: 9999, output: 9999 } })) // new price ignored per COALESCE rule

  const got = await repo.usage.listAll()
  expect(got).toHaveLength(1)
  expect(got[0].requests).toBe(2)
  expect(got[0].tokens).toEqual({ input: 200, output: 100 })
  expect(got[0].cost).toEqual({ input: 2.5, output: 10 }) // first non-null wins
})

test('set() is replacement: drops dimensions absent from the new record', async () => {
  await repo.usage.record(baseRec({ tokens: { input: 100, output: 50, input_cache_read: 10 } }))
  await repo.usage.set(baseRec({ tokens: { input: 200 }, requests: 5 }))

  const got = await repo.usage.listAll()
  expect(got).toHaveLength(1)
  expect(got[0].tokens).toEqual({ input: 200 })
  expect(got[0].requests).toBe(5)
})

test('record() with cost=null persists null unit_price; query reassembles cost=null', async () => {
  await repo.usage.record(baseRec({ cost: null }))
  const got = await repo.usage.listAll()
  expect(got[0].cost).toBeNull()
})

test('query() honors hour range', async () => {
  await repo.usage.record(baseRec({ hour: '2026-06-13T09' }))
  await repo.usage.record(baseRec({ hour: '2026-06-13T10' }))
  await repo.usage.record(baseRec({ hour: '2026-06-13T11' }))
  const got = await repo.usage.query({ keyId: 'k1', start: '2026-06-13T10', end: '2026-06-13T11' })
  expect(got).toHaveLength(1)
  expect(got[0].hour).toBe('2026-06-13T10')
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Replace `SharedUsageRepo` (around lines 452-483 of repos.ts)**

Port the implementation from `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/repo/sql.ts` (lines 367-512). Adapt: vNext's `client` PK part must be threaded through every INSERT, the DELETE WHERE clause for `set()`, and `assembleUsageRecords`. Replace the old `USAGE_COLS` constant and the entire `SharedUsageRepo` class.

Key SQL:

```ts
const BILLING_DIMENSIONS: readonly BillingDimension[] = [
  'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image',
]

const dimensionRows = (record: UsageRecord) =>
  BILLING_DIMENSIONS.flatMap((dimension) => {
    const tokens = record.tokens[dimension] ?? 0
    return tokens > 0 ? [{ dimension, tokens, unitPrice: unitPriceForDimension(record.cost, dimension) }] : []
  })

class SharedUsageRepo implements UsageRepo {
  // record(): for each dimension row, INSERT ... ON CONFLICT DO UPDATE SET
  //   tokens = tokens + excluded.tokens,
  //   unit_price = COALESCE(unit_price, excluded.unit_price)
  // Plus one INSERT into usage_requests with additive ON CONFLICT.
  //
  // set(): DELETE FROM usage WHERE bucket; INSERT new dimension rows;
  //   INSERT INTO usage_requests ... ON CONFLICT DO UPDATE SET requests = excluded.requests.
  //
  // query()/listAll(): two SELECTs (dimensions + requests) → assembleUsageRecords.
}
```

Reuse main's `assembleUsageRecords` exactly (adjusted for the extra `client` PK part).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/shared/repo/shared/repos.ts apps/gateway/tests/repo-usage.test.ts
git commit -m "feat(repo): rewrite SharedUsageRepo for two-table per-dim model"
```

---

## Task 9: Extend `usage-extractor.ts` with image-modality split

**Files:**
- Modify: `apps/gateway/src/shared/observability/usage-extractor.ts`
- Test: `apps/gateway/tests/observability/usage-extractor.test.ts`

- [ ] **Step 1: Update `UsageInfo` type and add `tokenUsageFromImagesResponse`**

Replace existing `UsageInfo` with a `TokenUsage`-shaped result:

```ts
import type { TokenUsage } from '../repo/types.ts'
import { BILLING_DIMENSIONS, type BillingDimension } from '@vnext/protocols/common'

export interface UsageInfo {
  model?: string
  tokens: TokenUsage
}
```

Add `tokenUsageFromImagesResponse` ported verbatim from `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/shared/telemetry/usage.ts` (lines 41-79). Update existing extractors so they emit:
- Anthropic Messages: `{ input, input_cache_read = cache_read_input_tokens, input_cache_write = cache_creation_input_tokens, output }` — note `input` should be the post-subtraction value (current logic preserved).
- OpenAI /v1/responses: same mapping, plus call `tokenUsageFromImagesResponse` when `input_tokens_details`/`output_tokens_details` present.
- OpenAI Chat Completions: `{ input = prompt_tokens, output = completion_tokens, input_cache_read = prompt_tokens_details.cached_tokens }`.

- [ ] **Step 2: Add tests for image-modality split**

In `usage-extractor.test.ts`:

```ts
import { tokenUsageFromImagesResponse } from '../../src/shared/observability/usage-extractor.ts'

test('tokenUsageFromImagesResponse: splits text/image counts via details', () => {
  expect(tokenUsageFromImagesResponse({
    input_tokens: 100, output_tokens: 50,
    input_tokens_details: { text_tokens: 80, image_tokens: 20 },
    output_tokens_details: { text_tokens: 30, image_tokens: 20 },
  })).toEqual({ input: 80, input_image: 20, output: 30, output_image: 20 })
})

test('tokenUsageFromImagesResponse: missing details charges total to bare dim', () => {
  expect(tokenUsageFromImagesResponse({ input_tokens: 100, output_tokens: 50 }))
    .toEqual({ input: 100, output: 50 })
})

test('tokenUsageFromImagesResponse: malformed (non-number) → null', () => {
  expect(tokenUsageFromImagesResponse({ input_tokens: 'huh', output_tokens: 50 })).toBeNull()
})

test('tokenUsageFromImagesResponse: null/non-object → null', () => {
  expect(tokenUsageFromImagesResponse(null)).toBeNull()
  expect(tokenUsageFromImagesResponse('x')).toBeNull()
})
```

- [ ] **Step 3: Update existing extractor tests for new return shape**

In `usage-extractor.test.ts`, replace assertions like `expect(info.input).toBe(100)` with `expect(info.tokens.input).toBe(100)`. For cache fields, use `tokens.input_cache_read` and `tokens.input_cache_write`.

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/gateway && bun test tests/observability/usage-extractor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/shared/observability/usage-extractor.ts apps/gateway/tests/observability/usage-extractor.test.ts
git commit -m "feat(observability): emit TokenUsage; add tokenUsageFromImagesResponse"
```

---

## Task 10: Rewrite `usage-tracker.ts` to accept `pricing` parameter

**Files:**
- Modify: `apps/gateway/src/shared/observability/usage-tracker.ts`
- Test: `apps/gateway/tests/observability/usage-tracker.test.ts`

- [ ] **Step 1: Update entrypoint signatures**

Replace the three entrypoints. New signatures:

```ts
import type { ModelPricing } from '@vnext/protocols/common'
import type { TokenUsage, UsageRecord } from '../repo/types.ts'

export async function trackNonStreamingUsage(
  json: unknown,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Promise<void> { /* ... */ }

export function trackStreamingUsage(
  upstreamRes: Response,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Response { /* ... */ }

export async function consumeStreamForUsage(
  body: ReadableStream,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Promise<void> { /* ... */ }
```

`persistUsage` becomes:

```ts
async function persistUsage(
  usage: TokenUsage, keyId: string, model: string, client: string,
  upstream: string | null, modelKey: string, pricing: ModelPricing | null,
): Promise<void> {
  if (!Object.values(usage).some((v) => (v ?? 0) > 0)) return
  const rec: UsageRecord = {
    keyId, model, modelKey, upstream, client,
    hour: currentHour(), requests: 1, tokens: usage, cost: pricing,
  }
  await Promise.all([
    getRepo().usage.record(rec),
    getRepo().apiKeys.touchLastUsed(keyId),
  ])
}
```

(`apiKeys.touchLastUsed` already exists in vNext's `ApiKeyRepo` — see `repo/types.ts:115`.)

- [ ] **Step 2: Update `usage-tracker.test.ts` callers**

For each test, append `modelKey` and `pricing` arguments. Example:

```ts
await trackNonStreamingUsage(json, 'k1', 'gpt-4o', 'cursor', 'copilot:1', 'gpt-4o', { input: 2.5, output: 10 })
```

Add a test for pricing snapshot:

```ts
test('trackNonStreamingUsage: persists per-dim unit_price snapshot', async () => {
  // ... seed ...
  await trackNonStreamingUsage(
    { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    'k1', 'gpt-4o', 'curl', 'copilot:1', 'gpt-4o',
    { input: 2.5, output: 10 },
  )
  const got = await getRepo().usage.listAll()
  expect(got[0].cost).toEqual({ input: 2.5, output: 10 })
  expect(got[0].tokens).toEqual({ input: 100, output: 50 })
})

test('trackNonStreamingUsage: pricing=null still records tokens', async () => {
  await trackNonStreamingUsage(
    { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    'k2', 'mystery-model', 'curl', null, 'mystery-model', null,
  )
  const got = await getRepo().usage.listAll()
  expect(got[0].cost).toBeNull()
  expect(got[0].tokens.input).toBe(100)
})
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `cd apps/gateway && bun test tests/observability/usage-tracker.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/shared/observability/usage-tracker.ts apps/gateway/tests/observability/usage-tracker.test.ts
git commit -m "feat(observability): track* accepts (modelKey, pricing); writes per-dim snapshot"
```

---

## Task 11: Wire dispatcher to resolve pricing and pass it to tracker

**Files:**
- Modify: `apps/gateway/src/data-plane/observability/attempts/conversation-attempt.ts`
- Modify: `apps/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts`
- Modify: `apps/gateway/src/data-plane/observability/attempts/images-attempt.ts` (if exists)
- Modify: `apps/gateway/src/data-plane/routes.ts`, `apps/gateway/src/data-plane/embeddings/routes.ts`
- Modify: `apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts` (if it now records usage)
- Test: `apps/gateway/tests/observability/attempts/{conversation,embeddings}-attempt.test.ts`, `apps/gateway/tests/observability/dispatch-observability.test.ts`

- [ ] **Step 1: Extend `ConversationAttemptInput` (and `EmbeddingsAttemptInput`)**

In `conversation-attempt.ts:39-54`:

```ts
import type { ModelPricing } from '@vnext/protocols/common'

export interface ConversationAttemptInput {
  // ... existing fields ...
  /** Raw upstream model id (post-binding). Used to persist as model_key. */
  modelKey: string
  /** Resolved by the dispatcher via provider.getPricingForModelKey(modelKey). null = unknown. */
  pricing: ModelPricing | null
}
```

Same for `EmbeddingsAttemptInput`.

- [ ] **Step 2: Pass through to `track*Usage` calls**

In `conversation-attempt.ts:127`:

```ts
response = trackStreamingUsage(res, input.apiKeyId, input.model, client, input.upstream, input.modelKey, input.pricing)
```

Line 150:

```ts
await trackNonStreamingUsage(json, input.apiKeyId, input.model, client, input.upstream, input.modelKey, input.pricing)
```

Same edit pattern in `embeddings-attempt.ts:100`.

- [ ] **Step 3: Wire the dispatcher to resolve pricing and pass it**

In `apps/gateway/src/data-plane/routes.ts:216`, before constructing the attempt:

```ts
const modelKey = bareModel // adapt: this is the raw upstream id post-binding
const pricing = binding.provider.getPricingForModelKey(modelKey)

attempt = await runConversationAttempt({
  apiKeyId: input.obsCtx.apiKeyId,
  model: bareModel,
  modelKey,
  pricing,
  // ... rest unchanged ...
})
```

Apply the same pattern in `embeddings/routes.ts` and any other `runConversationAttempt`/`runEmbeddingsAttempt` caller (grep first):

```bash
grep -rln "runConversationAttempt\|runEmbeddingsAttempt" apps/gateway/src
```

- [ ] **Step 4: Update attempt + dispatch tests**

`tests/observability/attempts/conversation-attempt.test.ts`, `embeddings-attempt.test.ts`, `images-attempt.test.ts` (if exists), `dispatch-observability.test.ts`: add `modelKey` and `pricing` to each `runConversationAttempt({...})` / `runEmbeddingsAttempt({...})` input fixture. Use `pricing: null` where the test doesn't assert on pricing; otherwise assert that the persisted UsageRecord's `cost` matches.

Add one positive test in `dispatch-observability.test.ts`:

```ts
test('dispatcher resolves pricing from binding.provider and persists snapshot', async () => {
  // mock provider whose getPricingForModelKey returns { input: 1, output: 2 }
  // ... run dispatch, then ...
  const usage = await getRepo().usage.listAll()
  expect(usage[0].cost).toEqual({ input: 1, output: 2 })
})
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd apps/gateway && bun test tests/observability/`

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/data-plane/ apps/gateway/tests/observability/
git commit -m "feat(dispatch): resolve provider pricing and thread through attempts"
```

---

## Task 12: Port `aggregate.ts` and replace `costForUsage` in token-usage routes

**Files:**
- Create: `apps/gateway/src/control-plane/token-usage/aggregate.ts`
- Modify: `apps/gateway/src/control-plane/token-usage/routes.ts`
- Delete: `apps/gateway/src/shared/lib/pricing/index.ts` (or strip to nothing)
- Delete: `apps/gateway/src/shared/lib/pricing/copilot.ts`
- Test: `apps/gateway/tests/control-plane-token-usage.test.ts`, `apps/gateway/tests/aggregate.test.ts` (new)

- [ ] **Step 1: Create `aggregate.ts`**

Port verbatim from `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/control-plane/token-usage/aggregate.ts`. Adjust the import path:

```ts
import type { UsageRecord } from '../../shared/repo/types.ts'
import { BILLING_DIMENSIONS, unitPriceForDimension, type BillingDimension } from '@vnext/protocols/common'

// recordCostUsd, accumulate, aggregateUsageForDisplay, aggregateUsageByUserForDisplay — verbatim
```

- [ ] **Step 2: Add `aggregate.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { aggregateUsageForDisplay } from '../src/control-plane/token-usage/aggregate.ts'
import type { UsageRecord } from '../src/shared/repo/types.ts'

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'k', model: 'm', modelKey: 'm', upstream: null, client: '',
  hour: 'h', requests: 1, tokens: {}, cost: null, ...over,
})

test('aggregateUsageForDisplay: cost = Σ tokens × unit_price / 1e6', () => {
  const out = aggregateUsageForDisplay([
    rec({ tokens: { input: 1_000_000, output: 1_000_000 }, cost: { input: 2.5, output: 10 } }),
  ])
  expect(out[0].cost).toBeCloseTo(12.5, 6) // 1M × 2.5/1M + 1M × 10/1M = 12.5
})

test('aggregateUsageForDisplay: pricing-table change after write does not change historical cost', () => {
  // Two records same bucket: first cost=null, second cost={input:5}. Sum is computed
  // per-record from each row's snapshot, not from any global table.
  const out = aggregateUsageForDisplay([
    rec({ tokens: { input: 1_000_000 }, cost: null }),
    rec({ tokens: { input: 1_000_000 }, cost: { input: 5 } }),
  ])
  expect(out).toHaveLength(1)
  expect(out[0].cost).toBeCloseTo(5, 6) // null half contributes nothing
  expect(out[0].tokens.input).toBe(2_000_000)
})

test('aggregateUsageForDisplay: input_image falls back to input price', () => {
  const out = aggregateUsageForDisplay([
    rec({ tokens: { input_image: 1_000_000 }, cost: { input: 3 } }),
  ])
  expect(out[0].cost).toBeCloseTo(3, 6)
})
```

- [ ] **Step 3: Run aggregate test — expect PASS**

- [ ] **Step 4: Replace `enrichUsage` in `token-usage/routes.ts`**

Find the `enrichUsage` / `costForUsage` reference (around line 11-34) and replace with a call to `aggregateUsageForDisplay`. The route's response shape becomes the `DisplayUsageRecord[]` output (same `keyId/model/hour/requests/tokens/cost` field set the dashboard already consumes).

Update the `routes.ts` handler:

```ts
import { aggregateUsageForDisplay } from './aggregate.ts'

// inside handler:
const records = await getRepo().usage.query({ keyId, start, end })
return c.json(aggregateUsageForDisplay(records))
```

- [ ] **Step 5: Delete obsolete pricing files**

```bash
git rm apps/gateway/src/shared/lib/pricing/index.ts apps/gateway/src/shared/lib/pricing/copilot.ts
```

If `shared/lib/pricing/` had any other helpers (e.g. `pricingForCopilotPublicModelId` used elsewhere), grep and re-route imports to `@vnext/provider-copilot`:

```bash
grep -rln "shared/lib/pricing" apps/gateway/src apps/gateway/tests
```

- [ ] **Step 6: Update `control-plane-token-usage.test.ts` fixtures**

Replace any `repo.usage.record(keyId, model, hour, ...)` positional calls with the object-shape `record({ ... })`. Assert that the route's response carries cost summed from `cost`-snapshot fields, not from the now-deleted global pricing table.

- [ ] **Step 7: Run — expect PASS**

Run: `cd apps/gateway && bun test tests/control-plane-token-usage.test.ts tests/aggregate.test.ts`

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/
git commit -m "feat(control-plane): aggregate usage from per-dim snapshots; delete read-time recompute"
```

---

## Task 13: Adapt `data-plane/dispatch/quota.ts` for new `TokenUsage` shape

**Files:**
- Modify: `apps/gateway/src/data-plane/dispatch/quota.ts` (or wherever weighted quota lives — grep first)
- Test: `apps/gateway/tests/observability/quota.test.ts`, `dispatch-quota.test.ts`

- [ ] **Step 1: Locate quota math**

```bash
grep -rn "cacheRead\s*\*\s*0\.1\|input.*\*.*1\.0\|cacheReadTokens" apps/gateway/src/data-plane/
```

- [ ] **Step 2: Update weighted-token computation**

The weighted formula stays `cache_read*0.1 + input*1.0 + output*5.0`. Replace any reads from `record.cacheReadTokens / inputTokens / outputTokens` with reads from `record.tokens.input_cache_read / input / output` (using `?? 0`):

```ts
const weighted =
  (record.tokens.input_cache_read ?? 0) * 0.1 +
  (record.tokens.input ?? 0) * 1.0 +
  (record.tokens.output ?? 0) * 5.0
```

Image dimensions also count: optionally include `(tokens.input_image ?? 0) * 1.0 + (tokens.output_image ?? 0) * 5.0` since a token is a token. Check main's quota implementation — if main treats them the same, mirror it.

- [ ] **Step 3: Update quota tests**

`tests/observability/quota.test.ts` and `dispatch-quota.test.ts`: replace positional `record(keyId, model, hour, requests, input, output, ...)` fixtures with object-shape calls:

```ts
await getRepo().usage.record({
  keyId, model, modelKey: model, upstream: null, client: '',
  hour, requests: 1, tokens: { input, output, input_cache_read: cacheRead },
  cost: null,
})
```

Assert that quota math is unchanged.

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/gateway && bun test tests/observability/quota.test.ts tests/observability/dispatch-quota.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/data-plane/ apps/gateway/tests/observability/
git commit -m "feat(quota): read weighted tokens from TokenUsage map"
```

---

## Task 14: Update `data-transfer/routes.ts` round-trip

**Files:**
- Modify: `apps/gateway/src/control-plane/data-transfer/routes.ts`
- Test: `apps/gateway/tests/control-plane-data-transfer.test.ts` (or equivalent)

- [ ] **Step 1: Inspect current export/import shape**

```bash
grep -n "usage\|UsageRecord" apps/gateway/src/control-plane/data-transfer/routes.ts
```

- [ ] **Step 2: Update export to serialize new `UsageRecord` shape**

JSON field set: `keyId, model, modelKey, upstream, client, hour, requests, tokens, cost`. Replace any flat `inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens / costJson` keys with the nested `tokens` map and `cost` snapshot.

- [ ] **Step 3: Update import to use `set(rec)` (replacement upsert)**

Each imported record is a full bucket; `set` replaces, preserving idempotent re-imports.

- [ ] **Step 4: Update tests**

Adjust round-trip JSON fixtures. Round-trip invariant: `set(rec); listAll() ⇒ [rec]` (modulo dimension-order).

- [ ] **Step 5: Run — expect PASS**

Run: `cd apps/gateway && bun test tests/control-plane-data-transfer.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/
git commit -m "feat(data-transfer): round-trip TokenUsage + cost snapshot"
```

---

## Task 15: Sweep remaining call sites

**Files:**
- `apps/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts` (if not already covered in Task 11)
- `apps/gateway/src/data-plane/observability/attempts/conversation-attempt.ts` (verify)
- `apps/gateway/src/data-plane/observability/attempts/images-attempt.ts` (port `tokenUsageFromImagesResponse` if image endpoint exists)
- `apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts`
- `apps/gateway/tests/control-plane-presence.test.ts` (one-line fixture call)
- Any remaining `repo.usage.record(` positional caller

- [ ] **Step 1: Find every remaining caller**

```bash
grep -rn "usage\.record\|usage\.set\|UsageRecord" apps/gateway/src apps/gateway/tests
```

- [ ] **Step 2: Convert each to object-shape `record({ ... })`**

Mechanical pass — compile errors guide you. For test fixtures with no real pricing, use `cost: null`.

- [ ] **Step 3: Wire image endpoint to `tokenUsageFromImagesResponse` (if vNext has an images attempt)**

If `images-attempt.ts` exists, parse the response usage block via `tokenUsageFromImagesResponse` and call `persistUsage`. If the path currently doesn't track usage at all, add minimal wiring.

- [ ] **Step 4: Type-check passes cleanly**

```bash
cd apps/gateway && bun tsc --noEmit
```

- [ ] **Step 5: Full test suite**

```bash
cd apps/gateway && bun test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/
git commit -m "chore(usage): convert remaining callers to object-shape record()"
```

---

## Task 16: End-to-end verification

- [ ] **Step 1: Run all package + app tests**

```bash
bun test
```

Expected: green across protocols, provider, provider-copilot, provider-azure, provider-custom, gateway.

- [ ] **Step 2: Boot a local gateway against a seeded SQLite, send a real request, verify cost**

Per `CLAUDE.md` (copilot-api-gateway): `bun run local`, send a small chat completion, then:

```bash
sqlite3 .data/gateway.sqlite \
  "SELECT key_id, hour, dimension, tokens, unit_price FROM usage ORDER BY hour DESC LIMIT 10"
```

Expected: per-dimension rows with non-null `unit_price` for known models.

- [ ] **Step 3: Hit the `/control-plane/token-usage` route, verify `cost` field is non-null and matches Σ tokens × unit_price**

- [ ] **Step 4: Final commit if anything turned up**

```bash
git add -A
git commit -m "chore(plan6): final verification fixes"
```

---

## Notes for the executor

- **Order matters.** Tasks 6 and 7 break the build deliberately; Tasks 8-15 close the gap. Don't reorder.
- **vNext-specific extensions kept:** `client` PK part on both tables; `apiKeys.touchLastUsed` already exists (don't replicate main's `apiKeys.save({ ...key, lastUsedAt })` pattern).
- **No backfill** for legacy rows — `unit_price = NULL` is acceptable per spec.
- **`shared/lib/pricing/`** disappears entirely. If any callers outside the gateway app import it, grep and reroute to `@vnext/provider-copilot`'s `pricingForCopilotPublicModelId` re-export.
- **Image dims are best-effort:** present where extractor produces them; fall back via `unitPriceForDimension`.
- **For sqlite + d1 mirror:** D1's batched-statement API is stricter — every CREATE/INSERT must run in a `db.batch([prepare(...).bind(...)])` or sequential awaits. Match the existing init-block style in `d1.ts`.
