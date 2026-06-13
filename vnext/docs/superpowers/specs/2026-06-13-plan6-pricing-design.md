# Plan 6: Pricing & Per-Dimension Usage Tracking — Design

**Status:** Draft for review
**Date:** 2026-06-13
**Goal:** Port main copilot-gateway's per-dimension billing + pricing snapshot system to vNext, replacing the current 4-fixed-column / read-time-recompute scheme.

## Why

vNext today:

- `UsageRecord` has 4 fixed token columns (`input/output/cacheRead/cacheCreation`).
- `cost_json` column exists but is **never written**; the `token-usage` route recomputes cost from a global pricing table at read time (`apps/gateway/src/shared/lib/pricing/`). Comment in `routes.ts:11` says "costJson is intentionally ignored".
- `ModelPricing` in `@vnext/protocols/common` is the legacy 4-field shape (`input/output/cache_read/cache_write`).
- Pricing only resolves for copilot models; azure/custom always cost = null.
- Image-modality billing dimensions (`input_image`, `output_image`) and `input_cache_write` distinction: missing.

main has already evolved past this:

1. **6-dimension billing** (`migrations/0019_usage_billing_dimensions.sql`): `input | input_cache_read | input_cache_write | input_image | output | output_image`. Stored as a JSON-shape via per-dimension rows.
2. **Per-dimension unit_price snapshot at write time** (`migrations/0011_usage_cost_snapshot.sql` then refined into per-row `unit_price` columns): each dimension row carries its own frozen unit price. Pricing table changes do **not** rewrite history; model retirements do **not** lose historical cost.
3. **Provider-owned pricing source**: each provider implements `getPricingForModelKey(modelKey) → ModelPricing | null` and decides where pricing comes from (built-in regex table, user config, upstream `/v1/models` `cost` block).
4. **Cost is a billing fact, not a derived display value.** Aggregation simply sums `tokens × unit_price / 1e6` across dimension rows.

vNext should align with main so dual-deploy and back-port stay clean. We're following exactly the same data model main settled on after its own migration.

## Architecture

### Schema (D1 + SQLite)

Replace the single `usage` table with two tables:

```sql
-- Per-dimension token rows, each carrying a frozen unit_price snapshot.
CREATE TABLE usage (
  key_id      TEXT NOT NULL,
  model       TEXT NOT NULL,
  upstream    TEXT,                -- nullable: pre-port rows / request-scoped fallback
  model_key   TEXT NOT NULL,       -- raw upstream model id (post-variant strip lives in pricing lookup)
  hour        TEXT NOT NULL,       -- ISO hour bucket "YYYY-MM-DDTHH"
  dimension   TEXT NOT NULL,       -- BillingDimension enum
  tokens      INTEGER NOT NULL,
  unit_price  REAL,                -- USD per million tokens; null = pricing unknown at write time
  PRIMARY KEY (key_id, model, COALESCE(upstream, ''), model_key, hour, dimension)
);
CREATE INDEX usage_hour ON usage(hour);

-- Request counts (separate so we don't multiply requests by dimension count).
CREATE TABLE usage_requests (
  key_id      TEXT NOT NULL,
  model       TEXT NOT NULL,
  upstream    TEXT,
  model_key   TEXT NOT NULL,
  hour        TEXT NOT NULL,
  requests    INTEGER NOT NULL,
  PRIMARY KEY (key_id, model, COALESCE(upstream, ''), model_key, hour)
);
CREATE INDEX usage_requests_hour ON usage_requests(hour);
```

Note: vNext currently has a `client` column; we keep it on both tables for parity with the existing `usage` schema (drop it only if main doesn't have it — it doesn't; we'll drop `client`).

**Migration strategy** (in-place upgrade of `apps/gateway/src/shared/repo/sqlite.ts` and `d1.ts` init code, since vNext has no migrations directory):

1. Add to bootstrap: detect old `usage` shape (`input_tokens` column present) → run one-shot migration that:
   - Reads all rows from old `usage` table.
   - For each row, inserts up to 4 dimension rows (`input/output/input_cache_read/input_cache_write` mapped from `input_tokens/output_tokens/cache_read_tokens/cache_creation_tokens`) with `unit_price = NULL` (history pre-port has no snapshot — acceptable; aggregate will skip null prices in cost sum).
   - Inserts request count into `usage_requests`.
   - Drops old `usage`, renames new tables into place.
2. Fresh installs skip migration and create the new shape directly.

### Protocol types

Update `@vnext/protocols/common`:

```ts
export type BillingDimension =
  | 'input'
  | 'input_cache_read'
  | 'input_cache_write'
  | 'input_image'
  | 'output'
  | 'output_image'

export type ModelPricing = Partial<Record<BillingDimension, number>>

export const BILLING_DIMENSIONS: readonly BillingDimension[] = [
  'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image',
]

// Fallback chain: cached → uncached, image → text-modality counterpart.
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

Old `ModelPricing` (input/output/cache_read/cache_write) is **replaced**, not aliased. All call sites in `apps/gateway/src/shared/lib/pricing/` and `control-plane/token-usage/` get rewritten.

### Repo types

Replace current `UsageRecord` shape:

```ts
export type TokenUsage = Partial<Record<BillingDimension, number>>

export interface UsageRecord {
  keyId: string
  model: string             // public model id (post-variant-merge)
  modelKey: string          // raw upstream model id (used for pricing lookup)
  upstream: string | null   // provider-prefixed upstream id, e.g. "copilot:u_abc"; null for pre-port rows
  hour: string
  requests: number
  tokens: TokenUsage        // dimensions with 0 tokens are dropped
  cost: ModelPricing | null // re-assembled from per-dimension unit_price on read; written from provider.getPricingForModelKey at write
}
```

`UsageRepo`:

```ts
export interface UsageRepo {
  record(r: UsageRecord): Promise<void>          // additive upsert (tokens += excluded, requests += excluded)
  set(r: UsageRecord): Promise<void>             // replacement upsert (used by data-transfer import)
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>
  listAll(): Promise<UsageRecord[]>
  deleteAll(): Promise<void>
}
```

### Provider interface

Extend `ModelProvider` in `@vnext/provider`:

```ts
export interface ModelProvider {
  // ... existing fields ...
  /** Resolve pricing for the given raw upstream model id. Returns null when
   *  this provider doesn't know the price (UI shows cost as null). */
  getPricingForModelKey(modelKey: string): ModelPricing | null
}
```

Each provider's source of pricing:

- **`@vnext/provider-copilot`**: built-in regex table (port `pricingForCopilotModelKey` from `apps/gateway/src/shared/lib/pricing/copilot.ts`, expand to 6-dim shape).
- **`@vnext/provider-azure`**: `AzureProviderConfig.models?: Array<{ upstreamModelId: string; cost?: ModelPricing }>` — user supplies per-deployment pricing.
- **`@vnext/provider-custom`**: two-layer:
  1. `CustomProviderConfig.models[].cost` (manual, wins over auto)
  2. Auto-parse from upstream `/v1/models` response `cost` block (OpenAI-shape conventions per models.dev). Cached per refresh.

### Telemetry (write path)

`apps/gateway/src/shared/observability/usage-tracker.ts` rewrites:

1. The extractor (`usage-extractor.ts`) keeps its current per-dimension counts but maps them to `BillingDimension` keys:
   - `input` → `input` (after subtracting cache_read/cache_creation)
   - `cacheRead` → `input_cache_read`
   - `cacheCreation` → `input_cache_write`
   - `output` → `output`
   - Image-modality split (`input_tokens_details.image_tokens` etc.) → `input_image`/`output_image`. Port `tokenUsageFromImagesResponse` from main.
2. `persistUsage` resolves pricing via the provider that served the request:

   ```ts
   const provider = providerForUpstream(upstream)
   const pricing = provider?.getPricingForModelKey(modelKey) ?? null
   await getRepo().usage.record({
     keyId, model, modelKey, upstream, hour: currentHour(),
     requests: 1, tokens: usage, cost: pricing,
   })
   ```

   The repo's `record` implementation extracts per-dimension `unit_price` from `cost` via `unitPriceForDimension` and writes one `usage` row per non-zero dimension.

3. Image-endpoint path (which currently doesn't call usage tracking in vNext) gets wired to `tokenUsageFromImagesResponse` — Plan 6 covers it.

### Read path / aggregation

`control-plane/token-usage/routes.ts`:

- **Stop using `costForUsage`** (read-time recompute). Delete `apps/gateway/src/shared/lib/pricing/index.ts:costForUsage`.
- Aggregation iterates `UsageRecord.tokens` × `unitPriceForDimension(record.cost, dim)` per dimension. Port main's `aggregateUsageForDisplay` from `control-plane/token-usage/aggregate.ts`.
- Output shape becomes `{ requests, tokens: TokenUsage, cost: number }` (cost is the totaled USD figure for that bucket, derived from row-level unit_price snapshots — consistent across reads regardless of pricing-table updates).

### Backfill / cost recovery

History from the in-place migration has `unit_price = NULL`. We accept that historical buckets show partial cost (only post-port rows count). main's `0011` migration provides a backfill snapshot but vNext doesn't have prod traffic worth backfilling, so we skip it. **Out of scope.**

## Components / file map

```
packages/protocols/src/common/index.ts          rewrite ModelPricing; add BillingDimension, unitPriceForDimension
packages/provider/src/types.ts                  add getPricingForModelKey to ModelProvider
packages/provider-copilot/src/pricing.ts        new — port main's regex table (6-dim)
packages/provider-copilot/src/provider.ts       implement getPricingForModelKey
packages/provider-azure/src/provider.ts         implement getPricingForModelKey via config.models
packages/provider-azure/src/types.ts            add models?: Array<{ upstreamModelId; cost? }>
packages/provider-custom/src/provider.ts        implement getPricingForModelKey (manual + upstream-parsed)
packages/provider-custom/src/fetch-models.ts    parse cost block from /v1/models
packages/provider-custom/src/types.ts           add models?: Array<{ upstreamModelId; cost? }>

apps/gateway/src/shared/repo/types.ts           rewrite UsageRecord, UsageRepo
apps/gateway/src/shared/repo/sqlite.ts          new schema + in-place migration block
apps/gateway/src/shared/repo/d1.ts              new schema (init) + same migration block
apps/gateway/src/shared/repo/shared/repos.ts    rewrite UsageRepo (record/set/query) for two-table model
apps/gateway/src/shared/observability/usage-tracker.ts    map UsageInfo → TokenUsage; resolve pricing via provider
apps/gateway/src/shared/observability/usage-extractor.ts  add image-modality split (port tokenUsageFromImagesResponse)
apps/gateway/src/shared/lib/pricing/index.ts    delete costForUsage; thin re-export of provider helpers
apps/gateway/src/shared/lib/pricing/copilot.ts  delete (moved to provider-copilot)
apps/gateway/src/control-plane/token-usage/routes.ts      use aggregateUsageForDisplay
apps/gateway/src/control-plane/token-usage/aggregate.ts   new — port from main
apps/gateway/src/data-plane/dispatch/quota.ts   adapt token-weighted quota to new TokenUsage shape (input/output/cache_read still summed; image dims contribute too)
apps/gateway/src/control-plane/data-transfer/routes.ts    update import/export to round-trip TokenUsage shape

apps/gateway/tests/observability/usage-tracker.test.ts    update fixtures to TokenUsage; add image-modality coverage
apps/gateway/tests/observability/usage-extractor.test.ts  add image-split tests
apps/gateway/tests/observability/quota.test.ts            update record() shape; quota math unchanged
apps/gateway/tests/observability/dispatch-quota.test.ts   same
apps/gateway/tests/observability/attempts/*.ts            update record() calls
apps/gateway/tests/control-plane-token-usage.test.ts      update fixtures; assert cost from row-level unit_price
apps/gateway/tests/control-plane-presence.test.ts         update fixture call
apps/gateway/tests/repo-usage-migration.test.ts           new — assert in-place upgrade preserves rows
apps/gateway/tests/providers/{copilot,azure,custom}-pricing.test.ts  new — getPricingForModelKey per provider
```

## Error handling / edge cases

- **Pricing unknown at write time**: `unit_price = NULL` in the row. Aggregation treats null as "skip this dimension's cost contribution"; tokens still counted.
- **Pricing changed mid-hour**: per-row snapshot means each request-batch's rows carry the price *as of write time*. The `additive upsert` `unit_price = COALESCE(unit_price, excluded.unit_price)` keeps the first non-null price per (bucket, dimension) — pricing volatility within a single hour is a non-issue in practice.
- **Image dimension on a model that only prices text**: `unitPriceForDimension` falls back to the bare-modality price (`input_image → input`); aggregation produces a non-zero (approximate) cost rather than null. Matches main behavior.
- **Custom provider upstream returns malformed `cost` block**: `parseCost` returns `undefined` (not throws); auto-pricing for that model is just absent. User can override via `config.models[].cost`.

## Testing strategy

1. **Unit**: `unitPriceForDimension` fallback chain; `parseCost` for custom provider; image-modality split (`tokenUsageFromImagesResponse` ports).
2. **Provider pricing**: each provider's `getPricingForModelKey` returns expected `ModelPricing` for representative model ids; returns null for unknown.
3. **Repo**: `record` is additive (two calls double tokens, requests +=); `set` is replacement (drops dimensions absent from the new record); `query` reassembles `UsageRecord.cost` from per-row unit prices.
4. **Migration**: seed old-shape `usage` table → boot → assert dimension rows + request rows present; old table gone.
5. **Telemetry**: streaming + non-streaming paths write the right dimensions; provider not found → cost = null but tokens still recorded.
6. **Aggregation**: `aggregateUsageForDisplay` sums per-dimension correctly; pricing-table change after write does not change historical cost.
7. **Quota**: weighted quota math (`cacheRead*0.1 + input*1.0 + output*5.0`) still passes against new shape.

## Out of scope

- Historical cost backfill for pre-port rows (accept null unit_price).
- UI changes — `dash.cost` already exists; the route output keeps a `cost` field, just sourced differently.
- Codex provider pricing (vNext doesn't have provider-codex yet).
- Cross-provider pricing override mechanism (e.g. account-level discounts).

## Risks

- **Repo shape change is invasive.** Every test fixture writing `usage.record(keyId, model, hour, requests, input, output)` (positional) needs to switch to the record-object shape. Estimated 8–12 test files touched.
- **`@vnext/protocols/common` `ModelPricing` rename is breaking.** All current consumers (`apps/gateway/src/shared/lib/pricing/*`, `control-plane/token-usage/routes.ts`) get rewritten in the same plan — no shim period.
- **Image-modality extraction not yet in vNext.** Adding it touches the dispatcher's response handling for the images endpoints; small but real surface.

## Open questions

None — A2+ provider-owned pricing + per-dimension snapshot is confirmed.
