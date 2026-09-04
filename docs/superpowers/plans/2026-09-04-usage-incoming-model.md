# Usage Incoming Model Dimension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将映射前的规范化逻辑模型作为 `incomingModel` 一等 Usage 维度，完整贯穿存储、请求身份、聚合 API 与 Dashboard，同时保持 routed `model` 和 provider `modelKey` 的既有语义。

**Architecture:** 新增 0008 migration，把 `incoming_model` 同时加入 `usage` / `usage_requests` 与两个唯一索引；入口处由 `resolveKeyModel()` 产生 immutable incoming identity，并经 chat-flow extra/telemetry、非 chat attempts、cross-protocol 与 server-tool 全链路传递。控制面按 incoming+routed 分组，Dashboard 提供独立 Incoming/Routed 筛选和分布切换，历史空字符串仅在 UI 显示为 Legacy / Unknown。

**Tech Stack:** Bun、TypeScript、Hono、`bun:sqlite`、Cloudflare D1、React、现有 Dashboard Tailwind/custom components、Bun test。

**Approved design:** `vnext/docs/superpowers/specs/2026-09-04-usage-incoming-model-design.md`

---

## File responsibility map

### New files

- `vnext/packages/gateway/migrations/0008_usage_incoming_model.sql` — 双表列与 identity indexes migration。
- `vnext/apps/dashboard/src/state/usage-model-dimensions.ts` — Incoming/Routed 过滤和分布的纯函数，避免业务逻辑埋在 hook/JSX。
- `vnext/apps/dashboard/src/state/usage-model-dimensions.test.ts` — filtering、legacy sentinel、distribution totals 测试。

### Main modified files

- `vnext/apps/platform-cloudflare/src/d1-repo.ts` — programmatic D1 bootstrap/legacy conversion 与 migration schema parity。
- `vnext/packages/gateway/src/repo/{types.ts,shared/repos.ts}` — UsageRecord、双表 projection/upsert/set/reassembly。
- `vnext/packages/gateway/src/data-plane/routing/key-model-mapping.ts` — immutable incoming identity。
- `vnext/packages/protocols-llm/src/common/result.ts` — TelemetryModelIdentity required incoming field。
- `vnext/packages/chat-flow-kit/src/serve-template.ts` — post-preprocess extra 进入 telemetry builder。
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/{telemetry-ctx.ts,kit-deps.ts,attempt-helpers.ts,respond-telemetry.ts,traverse-translation.ts}` — request carrier、identity resolver、usage write。
- 四种 chat `serve.ts` / `attempt.ts` 与 Responses server-tool — outer incoming propagation。
- `vnext/packages/gateway/src/data-plane/{embeddings/routes.ts,images/routes.ts,observability/attempts/*,shared/token-usage.ts}` — non-chat writers。
- `vnext/packages/gateway/src/control-plane/token-usage/{aggregate.ts,routes.ts}` — display grouping/API。
- `vnext/apps/dashboard/src/{api/usage.ts,state/usage.ts,tabs/usage/*}` — UI adapter、filters、distribution mode。

## Dependency graph

```text
Task 1 migration/D1 schema
  → Task 2 Usage repo identity
    → Task 3 routing + telemetry types
      → Task 4 chat-flow carrier + chat ingress
      → Task 5 server-tool + non-chat writers
        → Task 6 aggregate/API
          → Task 7 Dashboard
            → Task 8 E2E/CI/Docker
```

---

### Task 1: Add 0008 migration and D1 bootstrap parity

**Files:**
- Create: `vnext/packages/gateway/migrations/0008_usage_incoming_model.sql`
- Modify: `vnext/packages/gateway/tests/migrate.test.ts`
- Modify: `vnext/packages/gateway/tests/migrations.test.ts`
- Modify: `vnext/packages/gateway/tests/schema-baseline.txt`
- Modify: `vnext/apps/platform-cloudflare/src/d1-repo.ts:37-105`
- Create: `vnext/apps/platform-cloudflare/src/d1-repo.test.ts` — D1 statement recorder tests for fresh, dual-table upgrade, legacy conversion, and index rebuilding

- [ ] **Step 1: Write the SQLite ledger-upgrade RED test**

Extend `migrate.test.ts` with a real 0001–0007 ledger database:

```ts
// Copy actual 0001..0007 files to a temp migrations directory.
// applyMigrations(db, tempDir), then insert matching legacy rows:
db.query(`INSERT INTO usage
  (key_id, model, upstream, model_key, client, hour, dimension, tokens, unit_price)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('k1', 'target', 'up_a', 'provider-key', 'cli', '2026-09-04T01', 'input', 7, 2)
db.query(`INSERT INTO usage_requests
  (key_id, model, upstream, model_key, client, hour, requests)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('k1', 'target', 'up_a', 'provider-key', 'cli', '2026-09-04T01', 3)

// Copy actual 0008, rerun, assert both incoming_model values === ''.
// Assert original identity/tokens/requests/unit_price remain unchanged.
// Assert index SQL contains incoming_model, and second rerun is a no-op.
```

Use `try/finally` to close DB and remove the temporary directory.

- [ ] **Step 2: Run migration tests and verify RED**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/gateway/tests/migrate.test.ts packages/gateway/tests/migrations.test.ts
```

Expected: FAIL because 0008 and the baseline columns/index definitions do not exist.

- [ ] **Step 3: Create migration 0008 exactly as approved**

```sql
ALTER TABLE usage
  ADD COLUMN incoming_model TEXT NOT NULL DEFAULT '';

ALTER TABLE usage_requests
  ADD COLUMN incoming_model TEXT NOT NULL DEFAULT '';

DROP INDEX idx_usage_identity;
DROP INDEX idx_usage_requests_identity;

CREATE UNIQUE INDEX idx_usage_identity
ON usage (
  key_id,
  incoming_model,
  model,
  COALESCE(upstream, ''),
  model_key,
  client,
  hour,
  dimension
);

CREATE UNIQUE INDEX idx_usage_requests_identity
ON usage_requests (
  key_id,
  incoming_model,
  model,
  COALESCE(upstream, ''),
  model_key,
  client,
  hour
);
```

Do not modify `0001_baseline.sql` and do not use nullable incoming values.

- [ ] **Step 4: Update D1 programmatic bootstrap with RED tests first**

Add D1 fake/database tests proving:

1. fresh tables include `incoming_model TEXT NOT NULL DEFAULT ''`;
2. an existing dual-table schema without the column receives both ALTERs;
3. legacy single-table conversion writes incoming `''` into both temp tables;
4. old same-name indexes are dropped before creation;
5. resulting index SQL includes incoming model;
6. every D1 statement is issued independently.

Then update `initD1()`:

```ts
// Fresh CREATE TABLE definitions include incoming_model.
// Before final indexes:
if (!(await d1HasColumn(db, 'usage', 'incoming_model'))) {
  await db.prepare("ALTER TABLE usage ADD COLUMN incoming_model TEXT NOT NULL DEFAULT ''").run()
}
if (!(await d1HasColumn(db, 'usage_requests', 'incoming_model'))) {
  await db.prepare("ALTER TABLE usage_requests ADD COLUMN incoming_model TEXT NOT NULL DEFAULT ''").run()
}
await db.prepare('DROP INDEX IF EXISTS idx_usage_identity').run()
await db.prepare('DROP INDEX IF EXISTS idx_usage_requests_identity').run()
// Recreate approved indexes without IF NOT EXISTS ambiguity.
```

Legacy `usage_dims_new` / `usage_reqs_new` definitions and explicit INSERT lists must include incoming `''`.

- [ ] **Step 5: Regenerate and verify the schema baseline**

```bash
UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts
bun test packages/gateway/tests/migrations.test.ts packages/gateway/tests/migrate.test.ts
```

Inspect the snapshot diff: only the two columns and two rebuilt index definitions should change.

- [ ] **Step 6: Run platform typecheck and focused tests**

```bash
bun run --cwd apps/platform-cloudflare typecheck
bun run --cwd packages/gateway typecheck
```

Expected: migration/bootstrap tests pass; later UsageRecord type work has not started yet.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/gateway/migrations/0008_usage_incoming_model.sql \
  vnext/packages/gateway/tests/migrate.test.ts \
  vnext/packages/gateway/tests/migrations.test.ts \
  vnext/packages/gateway/tests/schema-baseline.txt \
  vnext/apps/platform-cloudflare/src/d1-repo.ts \
  vnext/apps/platform-cloudflare/src/d1-repo.test.ts
git commit -m "feat(usage): add incoming model storage dimension"
```

---

### Task 2: Make incoming model part of both Usage repository identities

**Files:**
- Modify: `vnext/packages/gateway/src/repo/types.ts:82-99`
- Modify: `vnext/packages/gateway/src/repo/shared/repos.ts:53-54,542-690`
- Modify: `vnext/packages/gateway/tests/repo-usage.test.ts`
- Modify: all typed `UsageRecord` fixtures revealed by `bun run typecheck`

- [ ] **Step 1: Write repository RED tests**

Add `incomingModel: 'source-a'` to the central fixture and tests for:

```ts
// Same target, distinct incoming aliases stay separate.
await repo.usage.record(baseRec({ incomingModel: 'alias-a', model: 'target', tokens: { input: 3 }, requests: 1 }))
await repo.usage.record(baseRec({ incomingModel: 'alias-b', model: 'target', tokens: { input: 7 }, requests: 2 }))
expect(await repo.usage.listAll()).toHaveLength(2)

// set(alias-a) replaces only alias-a dimensions and requests; alias-b survives.
// Legacy raw SQL with incoming_model='' assembles as incomingModel:''.
// Same full identity record() remains additive.
```

Inspect raw `usage` and `usage_requests` rows to prove request/token alignment, not only array length.

- [ ] **Step 2: Run repository tests and verify RED**

```bash
bun test packages/gateway/tests/repo-usage.test.ts
```

Expected: FAIL because `UsageRecord`, projections and unique conflict keys lack incoming identity.

- [ ] **Step 3: Add required UsageRecord field**

```ts
export interface UsageRecord {
  keyId: ApiKeyId
  /** Normalized logical request model before API-key mapping; '' for legacy. */
  incomingModel: string
  model: string
  // existing fields unchanged
}
```

Keep it required so typecheck exposes every writer/fixture.

- [ ] **Step 4: Update every shared repo identity site**

Use this exact field order for both tables:

```text
key_id, incoming_model, model, upstream, model_key, client, hour
```

Token table then adds `dimension, tokens, unit_price`.

Update:

- `USAGE_DIM_COLS` / `USAGE_REQ_COLS`;
- DB row interfaces;
- `usageBucketKey()`;
- `ensureRecord()` construction;
- record INSERT binds/conflict targets;
- set DELETE predicate/INSERT/request upsert;
- query/list projections.

The set DELETE must include:

```sql
AND incoming_model = ?
```

- [ ] **Step 5: Update all UsageRecord fixtures explicitly**

Run:

```bash
bun run --cwd packages/gateway typecheck
```

For each UsageRecord construction, choose intentional values:

- new request fixtures: incoming equals request source;
- legacy fixture: `''`;
- mapped fixture: source alias distinct from target.

Do not make the type optional or add a repository fallback that aliases incoming to routed model.

- [ ] **Step 6: Run repository and migration tests**

```bash
bun test packages/gateway/tests/repo-usage.test.ts \
  packages/gateway/tests/migrate.test.ts \
  packages/gateway/tests/migrations.test.ts
bun run --cwd packages/gateway typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/gateway/src/repo/types.ts \
  vnext/packages/gateway/src/repo/shared/repos.ts \
  vnext/packages/gateway/tests/repo-usage.test.ts \
  vnext/packages/gateway/tests/aggregate.test.ts \
  vnext/packages/gateway/tests/control-plane-token-usage.test.ts
git commit -m "feat(repo): preserve incoming usage buckets"
```

Commit only repository/types/fixtures changed for this task.

---

### Task 3: Produce immutable incoming identity at model mapping

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/routing/key-model-mapping.ts`
- Modify: `vnext/packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts`

- [ ] **Step 1: Add resolver RED tests**

Assert:

```ts
expect(resolveKeyModel('up_123/a', undefined)).toMatchObject({
  incomingModel: 'a', routedModel: 'a', upstreamPin: 'up_123',
})
expect(resolveKeyModel('vendor/a', undefined)).toMatchObject({
  incomingModel: 'vendor/a', routedModel: 'vendor/a',
})
expect(resolveKeyModel('a', enabled([{ source: 'a', destination: 'b' }, { source: 'b', destination: 'c' })))
  .toMatchObject({ incomingModel: 'a', routedModel: 'c' })
```

Cover disabled, unmatched, self-map and input/policy immutability.

- [ ] **Step 2: Run resolver test and verify RED**

```bash
bun test packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts
```

Expected: FAIL because `incomingModel` is absent.

- [ ] **Step 3: Implement incoming identity once, before mapping**

```ts
const { upstreamPin, bareModel } = parseModelRouting(requestedModel)
const incomingModel = bareModel
let routedModel = incomingModel
// Apply each rule once only to routedModel.
```

Return incoming, bare routed model, optional pin and matched indexes. Remove `requestedModel` only if a full production search confirms no caller uses it; update tests accordingly.

- [ ] **Step 4: Run tests/typecheck and commit**

```bash
bun test packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts
bun run --cwd packages/gateway typecheck
git add vnext/packages/gateway/src/data-plane/routing/key-model-mapping.ts \
  vnext/packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts
git commit -m "feat(routing): expose incoming model identity"
```

---

### Task 4: Add incoming model to TelemetryModelIdentity and correction resolvers

**Files:**
- Modify: `vnext/packages/protocols-llm/src/common/result.ts:12-26`
- Modify: `vnext/packages/protocols-llm/tests/common/result.test.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts:35-65`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts:145-220`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts`
- Modify: focused shared telemetry tests and all identity literals revealed by typecheck

- [ ] **Step 1: Write identity/correction RED tests**

Cover:

```text
incoming alias + public target + provider revision
resolver(revision-2) keeps incoming/public, changes modelKey/cost
resolver(unpriced key) keeps incoming/public, modelKey corrected, cost null
traverse initial/finalMetadata/resolver all preserve incoming and translatorPair
recordUsage emits UsageRecord.incomingModel
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bun test packages/protocols-llm/tests/common/result.test.ts \
  packages/gateway/tests/data-plane/chat-flow/shared/attempt-helpers.test.ts \
  packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts \
  packages/gateway/tests/data-plane/chat-flow/shared/respond-telemetry.test.ts
```

- [ ] **Step 3: Make TelemetryModelIdentity incoming required**

```ts
readonly incomingModel: string
```

Use a named object parameter in helpers:

```ts
interface TelemetryIdentityInput {
  incomingModel: string
  publicModel: string
}
```

`modelIdentityResolver(binding, input)` captures both immutable fields; only modelKey/cost change on correction.

- [ ] **Step 4: Persist incoming and preserve it through wrappers**

Add incoming to `recordUsage()` row. Ensure object-spread wrappers in traverse/finalMetadata/server-tool retain incoming. Never reconstruct it from provider events.

- [ ] **Step 5: Update identity fixtures via typecheck**

```bash
bun run --cwd packages/protocols-llm typecheck
bun run --cwd packages/gateway typecheck
```

Every literal must state an intentional incoming value; do not use broad casts to suppress errors.

- [ ] **Step 6: Run focused tests and commit**

```bash
bun test packages/protocols-llm/tests/common/result.test.ts \
  packages/gateway/tests/data-plane/chat-flow/shared

git add vnext/packages/protocols-llm/src/common/result.ts \
  vnext/packages/protocols-llm/tests/common/result.test.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts \
  vnext/packages/gateway/tests/data-plane/chat-flow/shared/attempt-helpers.test.ts \
  vnext/packages/gateway/tests/data-plane/chat-flow/shared/respond-telemetry.test.ts
git commit -m "feat(telemetry): carry incoming model identity"
```

---

### Task 5: Carry post-normalization incoming model through chat-flow kit

**Files:**
- Modify: `vnext/packages/chat-flow-kit/src/serve-template.ts`
- Modify: `vnext/packages/chat-flow-kit/src/serve-template.test.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts`
- Create/Modify: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`
- Modify: four chat protocol `serve.ts` and `attempt.ts` files

- [ ] **Step 1: Write framework ordering/carrier RED test**

Make preProcess return:

```ts
extra: { incomingModel: 'alias-a', upstreamPin: 'up_a' }
```

Assert `buildTelemetryCtx()` receives post-preprocess `payload` and `extra`, while quota/attempt still use original auth unchanged. Preserve sequence parse→preprocess→telemetry→quota→attempt→respond.

- [ ] **Step 2: Extend buildTelemetryCtx input generics**

Add payload/extra to the dependency callback input and pass them after preProcess. Do not store incoming in auth or reintroduce auth patching.

- [ ] **Step 3: Add incoming to TelemetryRequestContext**

```ts
readonly incomingModel: string
```

Gateway `kitDeps` reads the endpoint extra and constructs the immutable context while preserving all existing context fields.

- [ ] **Step 4: Add incoming to protocol preprocess extras**

Chat/Messages/Responses extras include both:

```ts
{ incomingModel: resolved.incomingModel, upstreamPin: resolved.upstreamPin }
```

Responses also retains `mergedInputItems`. Gemini separates normalized requested model from routed model and puts resolved incoming into telemetry extra.

- [ ] **Step 5: Build initial identities from telemetry incoming**

Chat/Messages/Responses/Gemini attempts call identity helpers with:

```ts
incomingModel: args.telemetryCtx.incomingModel
publicModel: sel.bareModel
```

Nested translation inherits the same telemetry context; do not rerun model mapping.

- [ ] **Step 6: Test all four protocol boundaries**

Direct tests assert:

- mapped source→target records incoming source;
- pin excluded;
- Gemini compatibility normalized before incoming capture;
- provider correction does not alter incoming;
- Responses continuation uses current outer incoming.

- [ ] **Step 7: Run and commit**

```bash
bun test packages/chat-flow-kit/src/serve-template.test.ts \
  packages/gateway/tests/data-plane/chat-flow \
  packages/gateway/tests/responses-previous-id.e2e.test.ts
bun run --cwd packages/chat-flow-kit typecheck
bun run --cwd packages/gateway typecheck
git add vnext/packages/chat-flow-kit/src/serve-template.ts \
  vnext/packages/chat-flow-kit/src/serve-template.test.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini} \
  vnext/packages/gateway/tests/data-plane/chat-flow \
  vnext/packages/gateway/tests/responses-previous-id.e2e.test.ts
git commit -m "feat(chat): propagate incoming model usage identity"
```

---

### Task 6: Preserve outer incoming identity through server-tool/ReAct turns

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts`
- Modify: server-tool request/shim context types
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts`
- Modify: `vnext/packages/gateway/src/data-plane/shared/token-usage.ts`
- Modify: corresponding server-tool/image/shared-token tests

- [ ] **Step 1: Write two-turn and image sub-call RED tests**

Use outer identity `{incomingModel:'alias-a', model:'responses-target'}`. Run a real two-turn hosted-tool loop with different inner provider keys. Assert every final metadata/resolver result keeps alias-a. For image sub-call usage, assert incoming is outer alias, not image backend model, and there is no duplicate outer/image record.

- [ ] **Step 2: Add immutable incoming to server-tool context/state**

Carry only the outer incoming string through request context and ShimState. Every next turn receives the same outer telemetry context. Do not derive incoming from `nextResult.modelIdentity.modelKey` or image candidate binding.

- [ ] **Step 3: Update image usage identity**

`ImageUsageModelIdentity` and `recordTokenUsage()` accept/emit incomingModel. Both streaming/non-streaming image completion paths use state.incomingModel.

- [ ] **Step 4: Run server-tool tests and commit**

```bash
bun test packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-shim.test.ts \
  packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tools \
  packages/gateway/tests/shared/token-usage.test.ts
bun run --cwd packages/gateway typecheck
git add vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts \
  vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts \
  vnext/packages/gateway/src/data-plane/shared/token-usage.ts \
  vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-shim.test.ts \
  vnext/packages/gateway/tests/shared/token-usage.test.ts
git commit -m "feat(responses): retain incoming model across tool turns"
```

---

### Task 7: Propagate incoming identity through non-chat writers

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/embeddings/routes.ts`
- Modify: `vnext/packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts`
- Modify: `vnext/packages/gateway/src/data-plane/images/routes.ts`
- Modify: `vnext/packages/gateway/src/data-plane/observability/attempts/images-attempt.ts`
- Modify: `vnext/packages/gateway/src/data-plane/shared/token-usage.ts`
- Modify: relevant observability and mapped routing tests

- [ ] **Step 1: Write embeddings/Ollama RED tests**

Assert source alias→destination produces:

```text
incomingModel=source
model=destination
modelKey=provider key/destination
```

Ollama embed delegates once and does not remap/recompute incoming.

- [ ] **Step 2: Update embeddings route/attempt**

Pass `resolved.incomingModel` explicitly through attempt input, usage row and dump identity. Provider response correction may change modelKey/cost only.

- [ ] **Step 3: Write standalone image RED tests**

For generation, JSON edit and multipart edit, assert incoming source is carried whenever usage exists; if upstream supplies no usage, assert no fabricated row. Mapping, pin and verbatim response behavior remain covered.

- [ ] **Step 4: Update image attempt/writer contracts**

Pass resolved incoming through route and attempt. Do not consume client response twice or create usage without an upstream usage payload. Keep server-tool image usage distinct and outer-incoming-aware per Task 6.

- [ ] **Step 5: Assert count-token zero usage**

Messages and Gemini count-token requests still route correctly but leave usage tables unchanged.

- [ ] **Step 6: Run and commit**

```bash
bun test packages/gateway/tests/observability/attempts \
  packages/gateway/tests/shared/token-usage.test.ts \
  packages/gateway/tests/mapped-model-routing.e2e.test.ts \
  packages/gateway/tests/data-plane/ollama/chat.test.ts
bun run --cwd packages/gateway typecheck
git add vnext/packages/gateway/src/data-plane/embeddings/routes.ts \
  vnext/packages/gateway/src/data-plane/images/routes.ts \
  vnext/packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts \
  vnext/packages/gateway/src/data-plane/observability/attempts/images-attempt.ts \
  vnext/packages/gateway/src/data-plane/shared/token-usage.ts \
  vnext/packages/gateway/tests/observability/attempts \
  vnext/packages/gateway/tests/shared/token-usage.test.ts \
  vnext/packages/gateway/tests/mapped-model-routing.e2e.test.ts \
  vnext/packages/gateway/tests/data-plane/ollama/chat.test.ts
git commit -m "feat(data-plane): record incoming models for non-chat usage"
```

---

### Task 8: Add incoming model to control-plane aggregation and API

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/token-usage/aggregate.ts`
- Modify: `vnext/packages/gateway/src/control-plane/token-usage/routes.ts`
- Modify: `vnext/packages/gateway/tests/aggregate.test.ts`
- Modify: `vnext/packages/gateway/tests/control-plane-token-usage.test.ts`

- [ ] **Step 1: Write aggregation/API RED tests**

Cover:

```text
same incoming+routed+client+hour → merge
different incoming, same routed → separate rows
legacy incoming '' → API returns ''
admin/user/shared branches retain incoming
requests/tokens/cost totals conserved
```

Also cover `aggregateUsageByUserForDisplay()` if any current consumer uses it; otherwise still prevent latent alias collapse by adding incoming to its identity/output.

- [ ] **Step 2: Add incoming to display records and keys**

```ts
interface DisplayUsageRecord {
  incomingModel: string
  model: string
  // existing fields
}
```

Group key:

```ts
`${record.keyId}\0${record.incomingModel}\0${record.model}\0${record.client}\0${record.hour}`
```

Routes naturally spread the camelCase field, but route tests must lock it.

- [ ] **Step 3: Run and commit**

```bash
bun test packages/gateway/tests/aggregate.test.ts \
  packages/gateway/tests/control-plane-token-usage.test.ts
bun run --cwd packages/gateway typecheck
git add vnext/packages/gateway/src/control-plane/token-usage/aggregate.ts \
  vnext/packages/gateway/src/control-plane/token-usage/routes.ts \
  vnext/packages/gateway/tests/aggregate.test.ts \
  vnext/packages/gateway/tests/control-plane-token-usage.test.ts
git commit -m "feat(control-plane): expose incoming model usage"
```

---

### Task 9: Add Dashboard Incoming/Routed filters and distribution mode

**Files:**
- Modify: `vnext/apps/dashboard/src/api/usage.ts`
- Modify: `vnext/apps/dashboard/src/state/usage.ts`
- Create: `vnext/apps/dashboard/src/state/usage-model-dimensions.ts`
- Create: `vnext/apps/dashboard/src/state/usage-model-dimensions.test.ts`
- Modify: `vnext/apps/dashboard/src/tabs/usage/UsageFilters.tsx`
- Modify: `vnext/apps/dashboard/src/tabs/usage/UsageDistributionTable.tsx`
- Modify: `vnext/apps/dashboard/src/tabs/usage/UsageTab.tsx`
- Modify: `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`

- [ ] **Step 1: Write pure filter/distribution RED tests**

Test:

- incoming exact filter;
- incoming + routed AND filtering;
- `null` means all while `''` means legacy unknown;
- routed distribution merges aliases;
- incoming distribution separates aliases;
- one incoming lists sorted unique routed models;
- both grouping modes conserve requests/tokens/cost and match summary;
- incoming-filtered rows feed charts/rolling strip without changing chart group dimension.

- [ ] **Step 2: Adapt API rows safely**

`ServerUsageRow.incomingModel?: string`, `UsageRow.incomingModel: string`, adapter fallback `r.incomingModel ?? ''` for rolling deploy compatibility.

- [ ] **Step 3: Add filter state with distinct All/Legacy semantics**

```ts
interface UsageFilters {
  // existing
  model: string
  incomingModel: string | null
}
```

- `null`: All Incoming Models
- `''`: Legacy / Unknown
- nonempty: exact incoming model

Add dimensions, filtering, initial state and clear behavior. Keep chart grouping priority unchanged.

- [ ] **Step 4: Add distribution mode and routed model lists**

Expose `byRoutedModel` and `byIncomingModel`, with incoming rows carrying sorted unique routed model labels. Add a Routed/Incoming segmented control in UsageTab and pass mode to the table. Totals must be invariant.

- [ ] **Step 5: Add accessible filters and i18n**

Rename existing Model UI to Routed Model, add Incoming Model, All Incoming Models and Legacy / Unknown translations in EN/ZH. Use Select aria labels; do not use `''` for both All and Legacy options—map All through a sentinel and convert to state `null`.

- [ ] **Step 6: Confirm no Usage CSV exists**

Search the Usage tab for export consumers. Do not add a new export feature. If an existing export is discovered, add incoming model to that existing row only.

- [ ] **Step 7: Run Dashboard tests/build and commit**

```bash
bun test apps/dashboard/src/state/usage-model-dimensions.test.ts \
  apps/dashboard/src/state/usage-range.test.ts \
  apps/dashboard/src/state/usage-strip.test.ts
bun run --cwd apps/dashboard typecheck
bun run build:ui
bun run lint

git add vnext/apps/dashboard/src/api/usage.ts \
  vnext/apps/dashboard/src/state/usage.ts \
  vnext/apps/dashboard/src/state/usage-model-dimensions.ts \
  vnext/apps/dashboard/src/state/usage-model-dimensions.test.ts \
  vnext/apps/dashboard/src/tabs/usage/UsageFilters.tsx \
  vnext/apps/dashboard/src/tabs/usage/UsageDistributionTable.tsx \
  vnext/apps/dashboard/src/tabs/usage/UsageTab.tsx \
  vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(dashboard): add incoming model usage dimension"
```

---

### Task 10: End-to-end conservation, full CI, and local Docker

**Files:**
- Modify: `vnext/packages/gateway/tests/mapped-model-routing.e2e.test.ts`
- Modify: `vnext/packages/gateway/tests/integration/chat-completions-telemetry.test.ts`
- Modify: `vnext/packages/gateway/tests/integration/messages-telemetry.test.ts`
- Modify: `vnext/packages/gateway/tests/integration/responses-telemetry.test.ts`
- Modify: `vnext/packages/gateway/tests/integration/gemini-telemetry.test.ts`
- No production changes unless a failing test identifies a verified gap

- [ ] **Step 1: Write the primary two-alias E2E test**

Using one API key and hour, send:

```text
alias-a → target
alias-b → target
```

Persist usage, call `/api/token-usage`, and assert two rows with distinct incomingModel, same routed model, correct provider modelKey, requests/tokens/cost. Assert routed aggregation totals equal incoming aggregation totals.

- [ ] **Step 2: Complete the protocol matrix**

Directly verify incoming identity for Chat, Messages, Responses continuation, Gemini normalized pinned alias, Embeddings/Ollama embed, Ollama chat, image usage paths and Responses server-tool multi-turn. Assert count-token routes create zero usage rows.

- [ ] **Step 3: Run focused acceptance battery**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/gateway/tests/migrate.test.ts \
  packages/gateway/tests/migrations.test.ts \
  packages/gateway/tests/repo-usage.test.ts \
  packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts \
  packages/protocols-llm/tests/common/result.test.ts \
  packages/chat-flow-kit/src/serve-template.test.ts \
  packages/gateway/tests/aggregate.test.ts \
  packages/gateway/tests/control-plane-token-usage.test.ts \
  packages/gateway/tests/mapped-model-routing.e2e.test.ts \
  apps/dashboard/src/state/usage-model-dimensions.test.ts
```

Expected: all PASS, no test path skipped.

- [ ] **Step 4: Run full quality gate**

```bash
bun run ci:local
```

Expected: framework purity, all workspace typechecks, tests, lint, UI build and Wrangler dry-run exit 0. Existing warnings may remain; touched files add no new warning.

- [ ] **Step 5: Build required local Docker**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
docker compose -f docker-compose.vnext.yml up -d --build
curl -fsS http://localhost:41414/health
```

- [ ] **Step 6: Verify local migration and Usage API**

Without printing credentials:

1. check migration ledger contains `0008_usage_incoming_model.sql`;
2. send two aliases mapped to one target;
3. query `/api/token-usage`;
4. verify two incoming rows, one routed target and real provider modelKey;
5. verify historical rows return `incomingModel:''`;
6. verify Dashboard Incoming/Routed modes conserve totals.

If local storage has no working upstream account, report the model-call smoke unavailable and rely on the E2E integration test; do not claim `/health` proves usage attribution.

- [ ] **Step 7: Review and commit final test-only gaps**

```bash
git status --short
git diff --check
git diff --stat
```

Commit only exact test files if Task 10 added coverage. Do not create an empty commit.

- [ ] **Step 8: Request final code review**

Use `superpowers:requesting-code-review`; fix only verified findings through fresh RED/GREEN cycles and rerun `bun run ci:local` after every production change.

- [ ] **Step 9: Stop before outward deployment**

Do not push, deploy CFW or update SSH Docker without a new explicit user request. If later authorized, push first and run CFW only through `vnext/apps/platform-cloudflare` → `bun run deploy:full` so 0008 applies before code.

---

## Final invariants checklist

- [ ] New usage rows always have nonempty incomingModel; legacy rows are `''`.
- [ ] Pin is excluded and Gemini compatibility normalization precedes incoming capture.
- [ ] API-key mapping changes routed model only, never incoming.
- [ ] Provider correction changes modelKey/cost only.
- [ ] `usage` and `usage_requests` share identical incoming identity keys.
- [ ] `record()` merges same incoming bucket; `set()` cannot delete sibling aliases.
- [ ] Cross-protocol, continuation and ReAct preserve outer incoming.
- [ ] Count-token requests generate no Usage.
- [ ] API does not merge distinct incoming aliases.
- [ ] Dashboard All (`null`) and Legacy (`''`) are distinct.
- [ ] Routed and Incoming distribution totals equal filtered summary.
- [ ] No new CSV/export feature is introduced.
- [ ] Full `ci:local` and local Docker verification pass.
