# API Key Ordered Model Mappings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个 API Key 增加默认关闭、可有序链式执行的模型映射，并让所有模型 API、响应身份、计费、统计和 Dashboard 一致使用最终 destination。

**Architecture:** Key 表用一个 boolean 列和一个 JSON TEXT 列持久化策略；鉴权只把无秘密的 routing policy 放入 data-plane context。共享纯函数负责严格解析配置和按顺序映射，各协议在记录原始 dump 后、binding 选择前做适配；共享响应观察器统一保护映射后的具体模型身份并同步最终价格。

**Tech Stack:** Bun 1.3/1.4、TypeScript、Hono、`bun:sqlite`、Cloudflare D1、React、现有 Dashboard Tailwind/custom components、Bun test。

**Approved design:** `vnext/docs/superpowers/specs/2026-09-04-api-key-model-mappings-design.md`

---

## File and responsibility map

### New files

- `vnext/packages/gateway/migrations/0007_api_key_model_mappings.sql` — 给现有和新 Key 设置 Disabled + 默认规则。
- `vnext/packages/gateway/src/shared/api-key-model-mappings.ts` — 共享类型、默认值、限制和 fail-closed normalizer；不访问数据库或 model catalog。
- `vnext/packages/gateway/src/data-plane/routing/key-model-mapping.ts` — 无 I/O 的有序链式映射 resolver；复用现有 `parseModelRouting()` 的 pin 语义。
- `vnext/packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts` — normalizer/resolver 规则矩阵。
- `vnext/apps/dashboard/src/tabs/keys/model-mappings-state.ts` — 编辑状态、移动、dirty 比较、destination 去重和 unavailable 判断纯函数。
- `vnext/apps/dashboard/src/tabs/keys/model-mappings-state.test.ts` — Dashboard 纯状态测试。
- `vnext/apps/dashboard/src/tabs/keys/ModelMappingsPanel.tsx` — Key 详情里的开关和有序 CRUD 面板。

### Existing files with focused changes

- `vnext/packages/gateway/src/repo/types.ts` — `ApiKey` 增加 mapping 持久化/派生字段。
- `vnext/packages/gateway/src/repo/shared/repos.ts` — 列清单、严格读取、完整 upsert。
- `vnext/packages/gateway/src/control-plane/lib/api-keys.ts` — 新 Key 默认值和安全鉴权投影。
- `vnext/packages/gateway/src/control-plane/auth/session-auth.ts` — routing policy 进入 auth context；ownerless Key 不再丢 context。
- `vnext/packages/gateway/src/data-plane/models/routes.ts` — `DataPlaneAuthCtx` 类型携带 policy。
- `vnext/packages/gateway/src/control-plane/api-keys/routes.ts` — dual-case GET、snake-case PATCH、destination catalog 校验、assignee 的窄权限。
- `vnext/packages/gateway/src/data-plane/chat-flow/{messages,responses,chat-completions,gemini}/serve.ts` 和 `gemini/http.ts` — chat 协议 pre-binding mapping。
- `vnext/packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts`、`gemini/count-tokens.ts` — token count 使用最终模型。
- `vnext/packages/gateway/src/data-plane/embeddings/routes.ts`、`images/routes.ts` — 非 chat JSON/multipart 适配。
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts` 和四个 renderer — 响应/统计最终模型归一化。
- `vnext/packages/protocols-llm/src/common/result.ts`、`vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts` — 给 event result 提供与 binding/provider 一致的最终 identity resolver，确保 modelKey 和 pricing 同步改变。
- `vnext/apps/dashboard/src/api/keys.ts`、`state/models.ts`、`tabs/keys/KeyDetailPanel.tsx` — UI contract、可选 destination、面板挂载。

## Dependency order

```text
Task 1 shared parser/resolver
  → Task 2 migration/repo
    → Task 3 auth policy
    → Task 4 control-plane CRUD
  → Task 5 response/telemetry identity
  → Task 6 chat protocol adapters
  → Task 7 count-tokens/embeddings/images
Task 4 + Task 3 → Task 8 Dashboard
Tasks 1–8 → Task 9 end-to-end + full verification + local Docker
```

---

### Task 1: Shared policy normalizer and ordered resolver

**Files:**
- Create: `vnext/packages/gateway/src/shared/api-key-model-mappings.ts`
- Create: `vnext/packages/gateway/src/data-plane/routing/key-model-mapping.ts`
- Create: `vnext/packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts`
- Modify: `vnext/packages/gateway/src/repo/types.ts:8-45`

- [ ] **Step 1: Write failing normalizer tests**

Create table-driven tests for valid/default/empty/invalid policies. The key assertions are:

```ts
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_API_KEY_MODEL_MAPPINGS,
  normalizeApiKeyModelMappings,
} from '../../../src/shared/api-key-model-mappings.ts'

test('normalizer trims fields and preserves duplicates and order', () => {
  expect(normalizeApiKeyModelMappings([
    { source: ' a ', destination: ' b ' },
    { source: 'a', destination: 'c' },
  ])).toEqual({
    ok: true,
    mappings: [
      { source: 'a', destination: 'b' },
      { source: 'a', destination: 'c' },
    ],
  })
})

test.each([
  ['not_array', {}],
  ['invalid_item', [{ source: 'a', destination: 'b' }, null]],
  ['invalid_source', [{ source: 1, destination: 'b' }]],
  ['blank_destination', [{ source: 'a', destination: '   ' }]],
  ['too_many_entries', Array.from({ length: 101 }, (_, i) => ({ source: `s${i}`, destination: 'd' }))],
  ['field_too_long', [{ source: 's'.repeat(257), destination: 'd' }]],
] as const)('normalizer fails the whole list: %s', (reason, raw) => {
  const result = normalizeApiKeyModelMappings(raw)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toBe(reason)
})

test('default mappings returns a fresh mutable copy', () => {
  const first = DEFAULT_API_KEY_MODEL_MAPPINGS.map((m) => ({ ...m }))
  first[0]!.source = 'changed'
  expect(DEFAULT_API_KEY_MODEL_MAPPINGS).toEqual([
    { source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' },
  ])
})
```

- [ ] **Step 2: Run the normalizer test and verify RED**

Run:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts
```

Expected: FAIL because `api-key-model-mappings.ts` does not exist.

- [ ] **Step 3: Define types, constants, and a strict fail-closed normalizer**

Implement in `src/shared/api-key-model-mappings.ts`:

```ts
export interface ApiKeyModelMapping {
  source: string
  destination: string
}

export interface ApiKeyRoutingPolicy {
  modelMappingsEnabled: boolean
  modelMappings: readonly ApiKeyModelMapping[]
}

export const MAX_MODEL_MAPPINGS = 100
export const MAX_MODEL_NAME_LENGTH = 256
export const DEFAULT_API_KEY_MODEL_MAPPINGS: readonly ApiKeyModelMapping[] = [
  { source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' },
]

export type ModelMappingsInvalidReason =
  | 'invalid_json'
  | 'not_array'
  | 'too_many_entries'
  | 'invalid_item'
  | 'invalid_source'
  | 'invalid_destination'
  | 'blank_source'
  | 'blank_destination'
  | 'field_too_long'

export type NormalizeModelMappingsResult =
  | { ok: true; mappings: ApiKeyModelMapping[] }
  | { ok: false; reason: ModelMappingsInvalidReason; index?: number; field?: 'source' | 'destination' }
```

`normalizeApiKeyModelMappings(raw)` must validate every item before returning success, trim both fields, preserve order/duplicates, and return only safe reason/index/field metadata on failure. Add a separate `parseStoredApiKeyModelMappings(raw)` that catches JSON parse errors and delegates to the same normalizer; it must not log source/destination.

Import/re-export the shared types from `repo/types.ts` and add required fields to `ApiKey`:

```ts
modelMappingsEnabled: boolean
modelMappings: ApiKeyModelMapping[]
/** Derived while reading corrupt storage; never persisted. */
modelMappingsInvalid?: boolean
```

- [ ] **Step 4: Write failing resolver tests**

Add tests covering disabled, empty, unmatched, chained, duplicate, self-map, finite loopback, pin, a non-`up_` slash, matched indexes, and immutability:

```ts
test('runs every rule once against the current model', () => {
  const policy = {
    modelMappingsEnabled: true,
    modelMappings: [
      { source: 'a', destination: 'b' },
      { source: 'b', destination: 'a' },
      { source: 'a', destination: 'c' },
    ],
  }
  expect(resolveKeyModel('a', policy)).toEqual({
    requestedModel: 'a',
    routedModel: 'c',
    matchedRuleIndexes: [0, 1, 2],
  })
})

test('maps the bare model and preserves an explicit upstream pin', () => {
  expect(resolveKeyModel('up_123/a', {
    modelMappingsEnabled: true,
    modelMappings: [{ source: 'a', destination: 'b' }],
  })).toEqual({
    requestedModel: 'up_123/a',
    routedModel: 'up_123/b',
    upstreamPin: 'up_123',
    matchedRuleIndexes: [0],
  })
})
```

- [ ] **Step 5: Run resolver tests and verify RED**

Expected: FAIL because `resolveKeyModel` is missing.

- [ ] **Step 6: Implement the minimal immutable resolver**

In `key-model-mapping.ts`, import `parseModelRouting()` and implement:

```ts
export interface ResolvedKeyModel {
  requestedModel: string
  routedModel: string
  upstreamPin?: string
  matchedRuleIndexes: number[]
}

export function resolveKeyModel(
  requestedModel: string,
  policy: ApiKeyRoutingPolicy | undefined,
): ResolvedKeyModel {
  const { upstreamPin, bareModel } = parseModelRouting(requestedModel)
  let current = bareModel
  const matchedRuleIndexes: number[] = []
  if (policy?.modelMappingsEnabled) {
    for (const [index, rule] of policy.modelMappings.entries()) {
      if (current !== rule.source) continue
      current = rule.destination
      matchedRuleIndexes.push(index)
    }
  }
  return {
    requestedModel,
    routedModel: upstreamPin ? `${upstreamPin}/${current}` : current,
    ...(upstreamPin ? { upstreamPin } : {}),
    matchedRuleIndexes,
  }
}
```

Do not trim request values, inspect catalogs, log model names, restart at rule 0, or mutate policy/input.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
bun test packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts
bunx tsc --noEmit -p packages/gateway
```

Expected: all new tests PASS; typecheck may identify API-key fixture construction sites, which Task 2 updates together with persistence.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/gateway/src/shared/api-key-model-mappings.ts \
  vnext/packages/gateway/src/data-plane/routing/key-model-mapping.ts \
  vnext/packages/gateway/src/repo/types.ts \
  vnext/packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts
git commit -m "feat(routing): add ordered api key model mappings"
```

---

### Task 2: Migration and SQLite/D1 shared repository support

**Files:**
- Create: `vnext/packages/gateway/migrations/0007_api_key_model_mappings.sql`
- Modify: `vnext/packages/gateway/src/repo/shared/repos.ts:48-99,308-362`
- Modify: `vnext/packages/gateway/tests/migrate.test.ts:25-81`
- Modify: `vnext/packages/gateway/tests/migrations.test.ts:56-70`
- Modify: `vnext/packages/gateway/tests/schema-baseline.txt`
- Modify: `vnext/packages/gateway/tests/repo.sqlite.test.ts:1-22`
- Modify: API-key test fixtures found by `grep -R "apiKeys.save({" vnext/packages/gateway/tests`

- [ ] **Step 1: Write migration tests before creating 0007**

Extend the fresh-schema test to require both columns. Add an upgrade test that uses a scratch migration directory containing 0001–0006, inserts a Key, adds 0007, then asserts:

```ts
expect(row.model_mappings_enabled).toBe(0)
expect(JSON.parse(row.model_mappings)).toEqual([
  { source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' },
])
```

Also extend the pre-ledger reconstruction test to drop the two new columns before replay, then assert they return without touching existing user/Key data.

- [ ] **Step 2: Run migration tests and verify RED**

```bash
bun test packages/gateway/tests/migrate.test.ts packages/gateway/tests/migrations.test.ts
```

Expected: FAIL because the new columns/migration and baseline snapshot are absent.

- [ ] **Step 3: Add migration 0007**

Create exactly:

```sql
ALTER TABLE api_keys
  ADD COLUMN model_mappings_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE api_keys
  ADD COLUMN model_mappings TEXT NOT NULL DEFAULT
  '[{"source":"gpt-5.6-sol","destination":"gpt-5.6-sol-fast"}]';
```

Do not edit `0001_baseline.sql` and do not add `model_mappings_invalid` to storage.

- [ ] **Step 4: Regenerate and inspect the schema baseline**

```bash
UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts
bun test packages/gateway/tests/migrations.test.ts
```

Expected: first command updates only `schema-baseline.txt`; second command PASSes without environment flags. Inspect the diff and confirm only the `api_keys` table definition gained the two columns.

- [ ] **Step 5: Write repository RED tests**

Use real `BunSqliteRepo(new Database(':memory:'))`, never `mock.module()`. Add tests for:

- ordered duplicate mappings round-trip;
- explicit `[]` round-trip;
- toggle enabled without changing list;
- unrelated full save (rename/quota) keeps mappings;
- direct SQL corrupt JSON/shape/item/blank/101 entries/257 chars returns disabled + empty + `modelMappingsInvalid: true`;
- one invalid item discards the whole list, not only that item.

Example:

```ts
await repo.apiKeys.save({
  id: 'k1', name: 'test', key: 'raw-secret-1', createdAt: now,
  modelMappingsEnabled: true,
  modelMappings: [
    { source: 'a', destination: 'b' },
    { source: 'a', destination: 'c' },
  ],
})
expect((await repo.apiKeys.getById('k1'))?.modelMappings).toEqual([
  { source: 'a', destination: 'b' },
  { source: 'a', destination: 'c' },
])
```

- [ ] **Step 6: Run repository tests and verify RED**

```bash
bun test packages/gateway/tests/repo.sqlite.test.ts
```

Expected: FAIL because `API_KEY_COLS`, parser and upsert do not handle mappings.

- [ ] **Step 7: Implement strict row conversion and full upsert**

Update all four coupled SQL pieces together:

1. Append `model_mappings_enabled, model_mappings` to `API_KEY_COLS`.
2. In `toApiKey`, call `parseStoredApiKeyModelMappings(row.model_mappings)`. On invalid storage return:
   ```ts
   modelMappingsEnabled: false,
   modelMappings: [],
   modelMappingsInvalid: true,
   ```
   and emit only safe JSON warning metadata such as `{evt:'api_key_model_mappings_invalid', reason}`; do not include row, Key, source, destination or request model.
3. Increase INSERT placeholders from 22 to 24.
4. Add both columns to `ON CONFLICT DO UPDATE`.
5. Bind `key.modelMappingsEnabled ? 1 : 0` and `JSON.stringify(key.modelMappings)`.

Make `ApiKey` fields required and update every repository fixture/construction site to state its intent explicitly. Production `createApiKey()` receives its default in Task 3; test-only keys that do not test mapping should use `modelMappingsEnabled: false, modelMappings: []` rather than silently relying on repo fallback. This protects the semantic difference between “default rule on creation” and “user explicitly cleared the list”.

- [ ] **Step 8: Run migration/repo tests and full gateway typecheck**

```bash
bun test packages/gateway/tests/migrate.test.ts \
  packages/gateway/tests/migrations.test.ts \
  packages/gateway/tests/repo.sqlite.test.ts
bunx tsc --noEmit -p packages/gateway
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add vnext/packages/gateway/migrations/0007_api_key_model_mappings.sql \
  vnext/packages/gateway/src/repo/shared/repos.ts \
  vnext/packages/gateway/tests/migrate.test.ts \
  vnext/packages/gateway/tests/migrations.test.ts \
  vnext/packages/gateway/tests/schema-baseline.txt \
  vnext/packages/gateway/tests/repo.sqlite.test.ts \
  vnext/packages/gateway/tests
git commit -m "feat(repo): persist api key model mappings"
```

Before committing, inspect staged files so `git add .../tests` does not include unrelated artifacts.

---

### Task 3: Safe authentication routing policy

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/lib/api-keys.ts:21-31,66-72`
- Modify: `vnext/packages/gateway/src/control-plane/auth/session-auth.ts:23-155`
- Modify: `vnext/packages/gateway/src/data-plane/models/routes.ts:85-96`
- Modify: `vnext/packages/gateway/tests/api-keys.test.ts`
- Modify: `vnext/packages/gateway/tests/session-auth-prewarm.test.ts`

- [ ] **Step 1: Write RED tests for creation and minimal projection**

Assert `createApiKey()` explicitly writes Disabled + a fresh default rule. Assert `validateApiKey()` returns only:

```ts
{
  id,
  name,
  ownerId,
  routingPolicy: {
    modelMappingsEnabled,
    modelMappings,
  },
}
```

Verify serialized result does not contain `key`, any `webSearch*Key`, refs, quotas, or the full `ApiKey` object.

- [ ] **Step 2: Write the ownerless-key middleware RED test**

Create a Key with no `ownerId`, enabled mappings, run `sessionAuthMiddleware`, and assert downstream sees:

```ts
{
  authKind: 'apiKey',
  apiKeyId: key.id,
  routingPolicy: keyPolicy,
}
```

with no `userId`. Also retain existing tests that user-specific Copilot prewarm only runs for owned Keys.

- [ ] **Step 3: Run tests and verify RED**

```bash
bun test packages/gateway/tests/api-keys.test.ts \
  packages/gateway/tests/session-auth-prewarm.test.ts
```

Expected: creation/projection assertions fail; ownerless context is absent.

- [ ] **Step 4: Implement defaults and safe `ValidatedApiKey`**

In `api-keys.ts`, add:

```ts
export interface ValidatedApiKey {
  id: ApiKeyId
  name: string
  ownerId?: UserId
  routingPolicy: ApiKeyRoutingPolicy
}
```

`createApiKey()` must clone the default array:

```ts
modelMappingsEnabled: false,
modelMappings: DEFAULT_API_KEY_MODEL_MAPPINGS.map((m) => ({ ...m })),
```

`validateApiKey()` builds only the safe projection. If repo marked storage invalid, its effective fields are already disabled/empty; never expose corrupt raw JSON.

- [ ] **Step 5: Thread policy through auth without exposing secrets**

Add optional `routingPolicy?: ApiKeyRoutingPolicy` to `FullAuthCtx` and `DataPlaneAuthCtx`. API-key resolution assigns it.

Restructure the end of middleware:

```ts
if (ctx) c.set('auth' as never, ctx as never)

if (ctx && resolvedUserId) {
  // existing owner-specific Copilot token resolution only
  // if this enriches ctx after c.set(), either set again or enrich before final set
}
```

The final code must set auth exactly once after optional enrichment, but the condition must be `ctx`, not `ctx && resolvedUserId`. Missing/broken credentials keep existing public-route behavior.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
bun test packages/gateway/tests/api-keys.test.ts \
  packages/gateway/tests/session-auth-prewarm.test.ts \
  packages/gateway/tests/control-plane-auth.test.ts
bunx tsc --noEmit -p packages/gateway
```

Expected: PASS; no raw credential fields appear in assertions/logs.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/lib/api-keys.ts \
  vnext/packages/gateway/src/control-plane/auth/session-auth.ts \
  vnext/packages/gateway/src/data-plane/models/routes.ts \
  vnext/packages/gateway/tests/api-keys.test.ts \
  vnext/packages/gateway/tests/session-auth-prewarm.test.ts \
  vnext/packages/gateway/tests/control-plane-auth.test.ts
git commit -m "fix(auth): propagate safe api key routing policy"
```

---

### Task 4: Control-plane serialization, validation, catalog checks, and narrow assignee permission

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/api-keys/routes.ts:37-370`
- Modify: `vnext/packages/gateway/tests/control-plane-api-keys.test.ts`
- Modify: `vnext/packages/gateway/src/data-plane/providers/registry.ts:336-398` — export a non-cached key-owner raw catalog helper used by both `/api/models` and PATCH validation
- Modify: `vnext/packages/gateway/tests/data-plane-models-embeddings-images.test.ts` — prove the shared helper and HTTP route return the same eligible model ids

- [ ] **Step 1: Write GET dual-case RED tests**

For list and detail responses, assert all six fields exist:

```ts
model_mappings_enabled
model_mappings
model_mappings_invalid
modelMappingsEnabled
modelMappings
modelMappingsInvalid
```

Normal keys return invalid `false`; corrupt storage returns disabled, empty list, invalid `true`; explicit `[]` remains empty.

- [ ] **Step 2: Write PATCH structural validation RED tests**

Add table tests for wrong enabled type (`'true'`, `1`, `null`, object), non-array mappings, invalid item, missing/non-string/blank fields, 101 items and 257-character names. Error messages must identify `model_mappings[<index>].<field>` without echoing source/destination values.

Assert:

- mapping-only patch preserves enabled;
- enabled-only patch validates and preserves the resulting list;
- both update in one `save()` call;
- duplicates/order/self-map are preserved;
- source may be absent from catalog;
- camelCase PATCH fields are ignored as unknown fields and do not modify state.

- [ ] **Step 3: Write destination availability and authorization RED tests**

Set up owner-scoped fake bindings/models and test:

- owner/admin may patch;
- assignee may patch **only** `model_mappings_enabled` and/or `model_mappings`;
- assignee mixing `name`, quota, Web Search, dump retention, or another Key field gets 403 and no save;
- unrelated user, API-key-only caller, and anonymous caller cannot patch;
- ownerless Key is manageable only by admin;
- destination direct id is accepted;
- a supported Copilot composite/Claude variant is accepted when its base binding advertises that available combination;
- missing destination is rejected even if source exists;
- empty `[]` requires no upstream catalog;
- explicit saved target later unavailable is returned by GET but any subsequent mapping-config PATCH must fix/remove it before save.

Return an explicit derived response permission:

```ts
can_manage_model_mappings / canManageModelMappings
```

It is true for owner/admin/assignee and false for API-key self-view or unrelated visibility. This lets the new panel avoid reusing `is_owner`, which intentionally controls broader settings.

- [ ] **Step 4: Run route tests and verify RED**

```bash
bun test packages/gateway/tests/control-plane-api-keys.test.ts
```

Expected: FAIL because route contract/validation/permission is missing.

- [ ] **Step 5: Implement key-specific management authorization**

Keep existing `loadOwned()` unchanged. Add private helpers in `api-keys/routes.ts` (or a new focused `control-plane/api-keys/model-mappings.ts` if the route would exceed manageable size):

```ts
async function canManageModelMappings(key: ApiKey, auth: AuthCtx): Promise<boolean> {
  if (auth.isAdmin) return true
  if (!auth.userId || !key.ownerId) return false
  if (key.ownerId === auth.userId) return true
  const grants = await getRepo().keyAssignments.listByUser(auth.userId)
  return grants.some((g) => g.keyId === key.id)
}
```

PATCH authorization algorithm:

1. Load existing Key without revealing foreign/missing distinction.
2. Detect whether body contains any non-mapping mutable field.
3. For owner/admin, retain all existing behavior.
4. For assignee, require mapping fields to be present and every other mutable field absent.
5. Otherwise return 403 before validation/save.

- [ ] **Step 6: Implement dual-case serializer and strict PATCH normalizer**

Use `normalizeApiKeyModelMappings()` for structure/trim/limits. PATCH input remains snake_case only. If either mapping field is present, validate the **resulting** list, not merely the field supplied, so enabling an old unavailable destination cannot bypass checks.

`keyToJson()` must clone arrays/objects rather than return a mutable repo reference.

- [ ] **Step 7: Validate destination against the Key owner's raw bindings**

Use the same underlying registry data as `/api/models?keyId=`—do not call the HTTP endpoint from the server and do not apply Key mappings. Build a Set of direct model ids plus valid advertised composite variants. Check every normalized destination. Preserve list order.

Catalog/provider failures should return the existing server error handling rather than saving an unvalidated policy; use status 503 with a generic “model catalog unavailable” message if the route currently lacks a typed upstream error. Do not log model names.

- [ ] **Step 8: Run control-plane and model visibility tests**

```bash
bun test packages/gateway/tests/control-plane-api-keys.test.ts \
  packages/gateway/tests/data-plane-models-embeddings-images.test.ts
bunx tsc --noEmit -p packages/gateway
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/api-keys/routes.ts \
  vnext/packages/gateway/tests/control-plane-api-keys.test.ts \
  vnext/packages/gateway/tests/data-plane-models-embeddings-images.test.ts
git commit -m "feat(control-plane): manage api key model mappings"
```

---

### Task 5: Shared final model identity, response normalization, and repricing

**Files:**
- Modify: `vnext/packages/protocols-llm/src/common/result.ts:12-26,74-100`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts:26-45`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.ts:107-155`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts:84-162`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts:102-162`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/respond.ts:85-144`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts:95-156`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/state-bridge.ts:41-84`
- Modify: the four attempt files where `llmEventResult(...)` is constructed
- Test: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/respond-telemetry.test.ts`
- Test: `vnext/packages/gateway/tests/data-plane/chat-flow/gemini/state-bridge.test.ts`
- Test: `vnext/packages/gateway/tests/observability/usage-extractor.test.ts`

- [ ] **Step 1: Write final-identity RED tests**

Test these exact transitions:

```text
initial modelKey gpt-5.6-sol-fast + observed gpt-5.6-sol
  → keep gpt-5.6-sol-fast and Fast pricing

initial gpt-4-turbo + observed gpt-4-turbo-2025
  → accept gpt-4-turbo-2025 and re-resolve its pricing

invalid/empty observed model
  → retain initial identity

interceptor finalMetadata
  → remains authoritative
```

Also test a genuine correction with no price returns `cost: null`, never the old model's price.

- [ ] **Step 2: Write response-event normalization RED tests**

For each protocol shape, feed an event echoing base Sol while initial final target is Sol Fast and assert the emitted event exposes Sol Fast:

```ts
{ model: 'gpt-5.6-sol' }
{ response: { model: 'gpt-5.6-sol' } }
{ message: { model: 'gpt-5.6-sol' } }
{ modelVersion: 'gpt-5.6-sol' }
```

The helper must clone only the touched object path and never mutate the parsed upstream event. Unrelated objects without a model field pass through by identity.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
bun test packages/gateway/tests/data-plane/chat-flow/shared/respond-telemetry.test.ts \
  packages/gateway/tests/data-plane/chat-flow/gemini/state-bridge.test.ts
```

Expected: FAIL because stream state blindly accepts observed keys and renderers emit upstream model fields unchanged.

- [ ] **Step 4: Add a result-local identity resolver**

Extend `LlmEventResult<T>` with an optional in-memory callback:

```ts
readonly resolveModelIdentity?: (modelKey: string) => TelemetryModelIdentity
```

This callback is never serialized or persisted. Extend the `llmEventResult()` constructor with a final seventh optional argument and return field. In each successful bound attempt, provide:

```ts
const resolveModelIdentity = (modelKey: string) =>
  telemetryModelIdentity(bindingForTelemetry, modelKey)
```

Update `traverseTranslation()` to forward `innerEvents.resolveModelIdentity` when it constructs the source result. When the resolver returns an identity, graft the source/hub `translatorPair` onto it exactly as `sourceModelIdentity` does; otherwise a cross-protocol terminal correction would lose attribution. This makes a genuine correction update `modelKey` and `cost` atomically against the same selected provider.

- [ ] **Step 5: Implement shared effective model-key selection**

Use the already-tested `pickUsageModelId(observed, initial)` semantics rather than substring matching. Add a pure helper in `respond-telemetry.ts`:

```ts
export function effectiveObservedModelKey(initial: string, observed: unknown): string {
  if (typeof observed !== 'string' || observed.length === 0) return initial
  return pickUsageModelId(observed, initial)
}
```

`SourceStreamState.rememberModelKey()` updates via this helper. This preserves `gpt-5.6-sol-fast` over a base echo while still accepting a genuine more-specific or unrelated provider correction according to the existing rule.

- [ ] **Step 6: Implement immutable event model normalization**

Add a pure `normalizeStreamEventModel(event, effectiveModelKey)` that recognizes the four explicit protocol paths (`model`, `response.model`, `message.model`, `modelVersion`). It clones the containing event/nested object only when the effective id differs.

In all four `consumeWithState()` loops:

1. read observed id;
2. call `state.rememberModelKey(observed)`;
3. normalize the event to `state.modelKey`;
4. pass the normalized event to dump, usage extractor, translator/encoder, and downstream yield.

Usage extraction is unaffected because only model-bearing fields are cloned.

- [ ] **Step 7: Centralize final identity construction**

Add:

```ts
export function finalModelIdentity(
  result: LlmEventResult<unknown>,
  metadata: EventResultMetadata,
  observedModelKey: string,
): TelemetryModelIdentity
```

Rules:

- if `result.finalMetadata` exists, return `metadata.modelIdentity` unchanged;
- if observed equals initial, return initial;
- otherwise call `result.resolveModelIdentity?.(observed)`;
- if callback absent, retain initial rather than producing modelKey/cost mismatch;
- preserve the initial/final translator pair.

Replace the four duplicated `{ ...md.modelIdentity, modelKey: state.modelKey }` expressions with this helper.

- [ ] **Step 8: Run focused and cross-protocol tests**

```bash
bun test packages/gateway/tests/data-plane/chat-flow/shared/respond-telemetry.test.ts \
  packages/gateway/tests/data-plane/chat-flow/gemini/state-bridge.test.ts \
  packages/gateway/tests/integration/cross-protocol-messages-to-responses.test.ts \
  packages/gateway/tests/integration/cross-protocol-responses-to-messages.test.ts
bunx tsc --noEmit -p packages/protocols-llm
bunx tsc --noEmit -p packages/gateway
```

Expected: PASS; output events and persisted identity both keep mapped Fast over a base echo.

- [ ] **Step 9: Commit**

```bash
git add vnext/packages/protocols-llm/src/common/result.ts \
  vnext/packages/gateway/src/data-plane/chat-flow \
  vnext/packages/gateway/tests/data-plane/chat-flow \
  vnext/packages/gateway/tests/integration
git commit -m "fix(telemetry): preserve mapped model identity and pricing"
```

Inspect staged scope before committing; do not include unrelated chat-flow files.

---

### Task 6: Map Messages, Responses, Chat Completions, Gemini, compact, and continuation

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts:40-120`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts:40-113`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts:92-216`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts:34-125`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/http.ts:10-53`
- Test/Create focused serve tests under `vnext/packages/gateway/tests/data-plane/chat-flow/{messages,responses,chat-completions,gemini}/`
- Modify: `vnext/packages/gateway/tests/responses-compact.e2e.test.ts`
- Modify: `vnext/packages/gateway/tests/responses-previous-id.e2e.test.ts`

- [ ] **Step 1: Write Messages and Chat serve-level RED tests**

Capture the payload seen by injected/fake upstream and assert:

- disabled policy forwards source;
- enabled default forwards `gpt-5.6-sol-fast`;
- alias `my-code-model` maps even though source is not in catalog;
- `up_123/source` only chooses `up_123` and forwards bare destination;
- pinned target unavailable produces existing protocol-specific 404 and no other upstream call;
- dump requested model remains source;
- response event model is destination even when upstream echoes base.

- [ ] **Step 2: Add immutable preProcess mapping to Messages and Chat**

The kit stamps dump model before `preProcess` (`serve-template.ts:172-200`), so add:

```ts
preProcess: (payload, ctx) => {
  const { routedModel } = resolveKeyModel(payload.model, ctx.auth.routingPolicy)
  return {
    kind: 'continue',
    payload: { ...payload, model: routedModel },
  }
},
```

Add `routingPolicy` to each local serve auth and copy it from `DataPlaneAuthCtx`. Attempts/selectors remain unchanged and consume the final payload model.

- [ ] **Step 3: Write Responses continuation and compact RED tests**

Assert mapping occurs after `expandPreviousResponseId()`:

- a current/snapshot source model maps using the current Key policy;
- turning policy off before the next continuation keeps source;
- expanded input and cleared `previous_response_id` remain unchanged;
- compact route uses the same mapping path and forwards destination;
- dump still records the client model before expansion/mapping.

- [ ] **Step 4: Extend Responses preProcess in the correct order**

Keep the existing try/catch and error envelope. After expansion succeeds, resolve the model on the expanded payload and return a cloned payload with mapped model. Preserve `mergedInputItems` exactly.

If expansion does not restore a missing model, retain parser-required behavior; do not invent a model from prior snapshot unless existing snapshot semantics already do so.

- [ ] **Step 5: Write Gemini normalization-order RED tests**

Assert:

```text
gemini-2.5-flash-customtools
→ existing normalization gemini-3-flash-preview
→ key mapping destination
→ same destination passed to selectBinding and translate request
```

Cover generateContent, streamGenerateContent and disabled behavior. Dump attribution uses the normalized pre-mapping name, matching the approved source-matching contract.

- [ ] **Step 6: Implement Gemini extras split**

In `serveGemini()` calculate mapping once and pass two extras:

```ts
extras: {
  requestedModel: args.model,
  model: resolved.routedModel,
  forceStream: args.forceStream,
}
```

`extractRequestedModel` reads `requestedModel`; `runAttempt` reads `model`. Copy routing policy into `GeminiServeAuth`. Keep `remapGeminiModel()` in `http.ts` before calling `serveGemini()`.

- [ ] **Step 7: Run all focused chat tests**

```bash
bun test packages/gateway/tests/data-plane/chat-flow/messages \
  packages/gateway/tests/data-plane/chat-flow/responses \
  packages/gateway/tests/data-plane/chat-flow/chat-completions \
  packages/gateway/tests/data-plane/chat-flow/gemini \
  packages/gateway/tests/responses-compact.e2e.test.ts \
  packages/gateway/tests/responses-previous-id.e2e.test.ts
```

Expected: PASS. If Bun reports a test directory does not exist, run the exact new file path created in Step 1 rather than silently skipping it.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/{messages,responses,chat-completions,gemini} \
  vnext/packages/gateway/tests/data-plane/chat-flow \
  vnext/packages/gateway/tests/responses-compact.e2e.test.ts \
  vnext/packages/gateway/tests/responses-previous-id.e2e.test.ts
git commit -m "feat(chat): route mapped api key models across protocols"
```

---

### Task 7: Map count-tokens, embeddings, image generations, and image edits

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts:18-68`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts:26-94`
- Modify: `vnext/packages/gateway/src/data-plane/embeddings/routes.ts:48-135`
- Modify: `vnext/packages/gateway/src/data-plane/images/routes.ts:90-295`
- Modify: `vnext/packages/gateway/tests/data-plane-models-embeddings-images.test.ts`
- Create or modify focused count-token tests under `vnext/packages/gateway/tests/data-plane/chat-flow/count-tokens/`
- Modify: `vnext/packages/gateway/tests/observability/attempts/embeddings-attempt.test.ts`
- Modify: `vnext/packages/gateway/tests/observability/attempts/images-attempt.test.ts`

- [ ] **Step 1: Write Anthropic/Gemini count-token RED tests**

Verify dump sees source, while translated payload and binding resolver both see the same destination. Cover disabled, enabled chain, retained pin, and strict model-not-found. For Gemini assert existing protocol normalization precedes mapping.

- [ ] **Step 2: Implement count-token adapters**

Anthropic order:

```text
parse → dump source → resolve mapping → clone/set payload.model
→ strip pin → resolve binding → provider fetch
```

Gemini order:

```text
normalized URL model already received → dump source → resolve mapping
→ translateGeminiToMessages(destination) → strip pin
→ resolveBinding(destination) → provider fetch
```

Never translate with source while resolving with destination.

- [ ] **Step 3: Write embeddings and generations RED tests**

Assert final destination is used by binding, provider payload, pricing, `run*Attempt.model`, and `modelKey`; usage creates no source row. Verify `presetBody` input is not mutated by cloning before mapping/`stripUpstreamPin`.

- [ ] **Step 4: Implement embeddings and generations mapping**

After `dump.requestedModel(source)`, resolve mapping and shallow-clone payload/body with `model: routedModel`. Then use existing `stripUpstreamPin`, binding and attempt flow. After pin stripping, all pricing/telemetry fields use the bare destination.

- [ ] **Step 5: Write image-edit FormData RED tests**

For JSON and multipart inputs assert:

- destination reaches binding and upstream;
- forwarded `FormData.getAll('model')` equals exactly `[bareDestination]`, even if input contains repeated model fields;
- image/mask bytes, filenames, repeated non-model fields and strings are unchanged;
- dump raw bytes and requested model remain source;
- disabled behavior is equivalent;
- unavailable pinned destination does not call provider.

- [ ] **Step 6: Implement a focused FormData rebuild helper**

Extract a local pure helper in `images/routes.ts` (or `images/model-form.ts` if tests need direct import):

```ts
export function rebuildImageEditForm(form: FormData, bareDestination: string): FormData {
  const forward = new FormData()
  for (const [key, value] of form.entries()) {
    if (key === 'model') continue
    if (typeof value === 'string') forward.append(key, value)
    else forward.append(key, value, value.name ?? key)
  }
  forward.append('model', bareDestination)
  return forward
}
```

Resolve the pinned routed model for binding, then use `parseModelRouting(routedModel).bareModel` for the single forwarded field, pricing, model and modelKey.

- [ ] **Step 7: Run non-chat and observability tests**

```bash
bun test packages/gateway/tests/data-plane-models-embeddings-images.test.ts \
  packages/gateway/tests/data-plane/chat-flow/count-tokens \
  packages/gateway/tests/observability/attempts/embeddings-attempt.test.ts \
  packages/gateway/tests/observability/attempts/images-attempt.test.ts
bunx tsc --noEmit -p packages/gateway
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/count-tokens \
  vnext/packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts \
  vnext/packages/gateway/src/data-plane/embeddings/routes.ts \
  vnext/packages/gateway/src/data-plane/images \
  vnext/packages/gateway/tests/data-plane-models-embeddings-images.test.ts \
  vnext/packages/gateway/tests/data-plane/chat-flow/count-tokens \
  vnext/packages/gateway/tests/observability/attempts
git commit -m "feat(data-plane): apply key mappings to all model endpoints"
```

---

### Task 8: Dashboard API contract, state helpers, and Model Mappings panel

**Files:**
- Modify: `vnext/apps/dashboard/src/api/keys.ts:17-61`
- Modify: `vnext/apps/dashboard/src/state/models.ts:8-147`
- Create: `vnext/apps/dashboard/src/tabs/keys/model-mappings-state.ts`
- Create: `vnext/apps/dashboard/src/tabs/keys/model-mappings-state.test.ts`
- Create: `vnext/apps/dashboard/src/tabs/keys/ModelMappingsPanel.tsx`
- Modify: `vnext/apps/dashboard/src/tabs/keys/KeyDetailPanel.tsx:1-80`
- Modify: relevant strings in `vnext/apps/dashboard/src/state/i18n.ts` (or the actual locale files imported there)

- [ ] **Step 1: Add API types and write pure state RED tests**

Add dashboard `ApiKeyModelMapping`, three snake-case read fields, `can_manage_model_mappings`, and two snake-case patch fields.

Create pure helper tests for:

- `initialMappingsEdit(key)` clones server values;
- disabled state remains editable;
- moving up/down is immutable and bounded;
- delete/add preserves order;
- dirty compares enabled, source, destination and order;
- choices dedupe same model across upstreams while retaining a stable sorted list of upstream labels;
- expanded Claude combinations in `catalog.claudeBig` are selectable, not only base `byUpstream` ids;
- unavailable saved destination remains in edit state and is flagged;
- client validation rejects blank/overlong fields, >100 rows and unavailable destination before Save.

- [ ] **Step 2: Run helper test and verify RED**

```bash
bun test apps/dashboard/src/tabs/keys/model-mappings-state.test.ts
```

Expected: FAIL because helper module/API fields are missing.

- [ ] **Step 3: Export a destination-ready model catalog**

Make `RawModel`/`buildCatalog` or a focused derived helper export enough data to construct destination choices. Do not change `/api/models` and do not cache effective mappings. Combine:

- direct `byUpstream` ids;
- valid advertised Claude/composite ids already expanded by `buildCatalog`;
- upstream names for badges/help text.

Stable sort by model id; save only the model id.

- [ ] **Step 4: Implement pure edit helpers and rerun tests**

Use immutable copies throughout. Return a structured validation result with row index/field for inline messages. Do not duplicate the server catalog check logic beyond UI feedback—the server remains authoritative.

```bash
bun test apps/dashboard/src/tabs/keys/model-mappings-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Implement `ModelMappingsPanel` using existing components**

Follow `WebSearchPanel` edit/save/cancel conventions and the existing `Select` component. Required UI:

- header + Enabled/Disabled checkbox/switch;
- explanatory text that Disabled still allows editing;
- source text input;
- destination Select with upstream badge/help;
- add/delete/up/down buttons with `type="button"` and accessible labels;
- inline `Unavailable` state without clearing the saved value;
- Save disabled for busy/no changes/client validation errors;
- one `onSave({ model_mappings_enabled, model_mappings })` call;
- failed save preserves local edit state;
- successful parent reload causes state to reset from new `keyRow`;
- `canEdit={keyRow.can_manage_model_mappings}` rather than broad `is_owner`.

Use existing styling conventions; do not add a new UI library or direct DOM drag/drop. Add i18n keys in both supported locales rather than hardcoding mixed-language labels.

- [ ] **Step 6: Mount the panel before ConfigurationPanel**

```tsx
<ModelMappingsPanel
  keyRow={keyRow}
  canEdit={keyRow.can_manage_model_mappings}
  busy={busy}
  onSave={onPatch}
/>
<ConfigurationPanel keyRow={keyRow} />
```

Keep Quota/Web Search `canManage` logic unchanged so an assignee gains only the approved model-mapping permission.

- [ ] **Step 7: Run Dashboard tests, typecheck, and build**

```bash
bun test apps/dashboard/src/tabs/keys/model-mappings-state.test.ts
bunx tsc --noEmit -p apps/dashboard
bun run build:ui
```

Expected: PASS and dashboard bundle regenerates successfully. `dist` is gitignored; do not add it to Git.

- [ ] **Step 8: Commit**

```bash
git add vnext/apps/dashboard/src/api/keys.ts \
  vnext/apps/dashboard/src/state/models.ts \
  vnext/apps/dashboard/src/state/i18n.ts \
  vnext/apps/dashboard/src/tabs/keys/model-mappings-state.ts \
  vnext/apps/dashboard/src/tabs/keys/model-mappings-state.test.ts \
  vnext/apps/dashboard/src/tabs/keys/ModelMappingsPanel.tsx \
  vnext/apps/dashboard/src/tabs/keys/KeyDetailPanel.tsx
git commit -m "feat(dashboard): add api key model mappings editor"
```

Adjust the i18n path in `git add` to the actual locale files changed; do not add nonexistent paths.

---

### Task 9: End-to-end identity, cost, quota, and complete verification

**Files:**
- Modify: `vnext/packages/gateway/tests/integration/messages-telemetry.test.ts`
- Create: `vnext/packages/gateway/tests/integration/key-model-mapping-surfaces.test.ts`
- No production files unless a failing end-to-end test identifies a real gap; return to RED/GREEN for that gap and use a separate commit.

- [ ] **Step 1: Write the primary cross-protocol end-to-end test**

Set up an enabled Key with default mapping and a fake Copilot Responses upstream. Send Anthropic streaming Messages with `model: gpt-5.6-sol`; have upstream echo `gpt-5.6-sol` while returning cache read/write usage. Assert:

1. upstream request payload model is `gpt-5.6-sol-fast`;
2. client-facing `message_start.message.model` is `gpt-5.6-sol-fast`;
3. usage row has `model === 'gpt-5.6-sol-fast'` and `modelKey === 'gpt-5.6-sol-fast'`;
4. no `gpt-5.6-sol` usage row exists;
5. frozen price is Fast (`input=4`, read `0.4`, write `5`, output `20` per MTok, or current verified catalog values if the promotion update has changed before implementation);
6. request and cost quota are attributed to the calling Key;
7. dump requested model remains `gpt-5.6-sol`;
8. disabled Key keeps the existing Sol route and identity.

- [ ] **Step 2: Write the complete surface-matrix integration test**

Create `key-model-mapping-surfaces.test.ts` with one table-driven harness that mounts the real gateway and captures provider requests. Include one case each for:

```text
/v1/messages
/v1/responses
/v1/chat/completions
/v1beta/models/<model>:generateContent
/v1beta/models/<model>:streamGenerateContent
/v1/messages/count_tokens
/v1beta/models/<model>:countTokens
/v1/embeddings
/v1/images/generations
/v1/images/edits (JSON)
/v1/images/edits (multipart)
```

For every case assert destination reaches the selected provider and disabled sends source. Add dedicated assertions for pin strictness, Gemini normalization order, Responses continuation/compact reuse, and multipart exactly-one-model-field semantics rather than duplicating the full telemetry assertion from Step 1.

- [ ] **Step 3: Run both end-to-end tests and verify RED/GREEN honestly**

```bash
bun test packages/gateway/tests/integration/messages-telemetry.test.ts \
  packages/gateway/tests/integration/key-model-mapping-surfaces.test.ts
```

If either fails, identify the exact violated layer, add the smallest production fix under a new RED test, then rerun. Do not weaken identity/cost assertions to match incorrect output.

- [ ] **Step 4: Run the focused acceptance battery**

```bash
bun test \
  packages/gateway/tests/data-plane/routing/key-model-mapping.test.ts \
  packages/gateway/tests/migrate.test.ts \
  packages/gateway/tests/migrations.test.ts \
  packages/gateway/tests/repo.sqlite.test.ts \
  packages/gateway/tests/api-keys.test.ts \
  packages/gateway/tests/session-auth-prewarm.test.ts \
  packages/gateway/tests/control-plane-api-keys.test.ts \
  packages/gateway/tests/data-plane-models-embeddings-images.test.ts \
  packages/gateway/tests/responses-compact.e2e.test.ts \
  packages/gateway/tests/responses-previous-id.e2e.test.ts \
  packages/gateway/tests/data-plane/chat-flow/shared/respond-telemetry.test.ts \
  packages/gateway/tests/data-plane/chat-flow/gemini/state-bridge.test.ts \
  packages/gateway/tests/integration/messages-telemetry.test.ts \
  apps/dashboard/src/tabs/keys/model-mappings-state.test.ts
```

Expected: all PASS; no test path is silently skipped.

- [ ] **Step 5: Run full repository quality gates**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun run typecheck
bun run lint
bun run build:ui
bun test
bun run ci:local
```

Expected:

- typecheck exit 0;
- lint 0 errors (existing warnings may remain, but no new warning in touched files);
- UI build writes JS/CSS bundle;
- all tests pass;
- `ci:local` Cloudflare `deploy:dry` succeeds without a real deployment.

- [ ] **Step 6: Build and start the required local Docker target**

Run from repo root, not `vnext/`:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
docker compose -f docker-compose.vnext.yml up -d --build
curl -fsS http://localhost:41414/health
```

Expected health body:

```json
{"status":"ok","service":"copilot-gateway-vnext"}
```

- [ ] **Step 7: Verify migration/default/clear persistence locally**

Using a safe local dev/session credential without printing it:

1. create a Key;
2. GET it and verify Disabled + default mapping;
3. PATCH mappings to `[]`;
4. restart `gateway-vnext`;
5. GET again and verify `[]` remains empty;
6. re-add default and enable it;
7. send one supported mapped request if local upstream credentials are present;
8. verify destination in response/usage. If local storage has no upstream account, report that model-call smoke is unavailable and rely on the integration test; do not treat `/health` alone as model-routing proof.

Never print API Key, GitHub token, Copilot token, prompt body, or credential-bearing config.

- [ ] **Step 8: Review working tree and commit only final test gaps**

```bash
git status --short
git diff --check
git diff --stat
```

If Task 9 added only integration tests:

```bash
git add vnext/packages/gateway/tests/integration/messages-telemetry.test.ts \
  vnext/packages/gateway/tests/integration/key-model-mapping-surfaces.test.ts
git commit -m "test: verify api key model mappings end to end"
```

If no files changed, do not create an empty commit.

- [ ] **Step 9: Request code review before push/deploy**

Invoke `superpowers:requesting-code-review` against the complete implementation and fix only verified findings through fresh RED/GREEN cycles. Re-run Step 4 after every production change.

- [ ] **Step 10: Stop before outward deployment unless explicitly requested**

This plan includes local Docker because the project requires it. Do not push, deploy CFW, or update the SSH Docker host merely because implementation is complete; those are outward actions and require a separate explicit user request. If requested later:

- push `vNext` first;
- CFW must run `bun run deploy:full` from `vnext/apps/platform-cloudflare` so D1 migration 0007 applies before code;
- SSH host pulls Git, so deploy only after push and verify `localhost:41414` through SSH.

---

## Implementation invariants checklist

Before declaring completion, verify each statement directly:

- [ ] Existing and new Keys default Disabled with one Sol→Sol Fast item.
- [ ] Explicit `[]` survives repo save, PATCH, process restart, and Docker restart.
- [ ] Disabled policies never alter any endpoint.
- [ ] Enabled policies execute each list item once, in order, against current model.
- [ ] Explicit `up_*/` pin survives mapping and prevents fallback to another upstream.
- [ ] Destination save validation uses the Key owner's raw catalog, not mapped/effective catalog.
- [ ] Source aliases never appear in `/v1/models` unless an upstream already advertises them.
- [ ] Full `ApiKey` and credentials never enter auth routing policy or logs.
- [ ] Ownerless API Keys retain `apiKeyId` and routing policy context.
- [ ] Assignees can modify only mapping settings, not quotas/Web Search/name/other fields.
- [ ] Messages, Responses, Chat, Gemini, both count-token paths, embeddings, image generation, JSON edits and multipart edits all use destination.
- [ ] Multipart edits forward exactly one bare destination model field and preserve files/repeated non-model fields.
- [ ] Responses continuation expands first and maps with the current policy second.
- [ ] Upstream base echo never downgrades a mapped specific destination.
- [ ] Accepted genuine model correction refreshes both modelKey and price.
- [ ] Client response, usage model, modelKey, pricing and quota all agree on destination.
- [ ] Dashboard can edit while Disabled; unavailable target remains visible and blocks Save.
- [ ] Upstream model cache remains Key-agnostic.
- [ ] No `mock.module()` was introduced.
- [ ] Full `ci:local` and required local Docker smoke pass.
