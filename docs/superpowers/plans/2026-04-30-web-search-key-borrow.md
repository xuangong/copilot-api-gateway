# Web-Search Key Borrow References — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an api_key's three web-search secret fields (LangSearch, Tavily, Microsoft Grounding) to either hold a literal value OR a reference to another visible api_key that holds the literal — borrower can use the secret but can never retrieve it.

**Architecture:** Add three nullable `*_ref` columns to `api_keys`. PATCH enforces "literal XOR ref" per engine. A new `resolveWebSearchKeys` helper rehydrates refs at request time, re-checking visibility each call. Resolution results are cached **per borrower api_key id for 5 minutes** to avoid hot-path DB lookups + visibility checks; PATCH and copy-from invalidate the borrower's cache entry. All four SDK routes (`messages.ts`, `chat-completions.ts`, `responses.ts`, `gemini.ts`) plus the inline path in `messages.ts` route through the helper. The dashboard renders refs as `↗ <name>` (or `↗ (unavailable)`) and never receives the source's value.

**Tech Stack:** Bun + TypeScript, Elysia routes, bun:sqlite + Cloudflare D1 dual repos, Alpine.js dashboard.

---

## File map

**Create:**
- `migrations/0021_api_key_web_search_refs.sql` — three new columns
- `src/services/web-search/resolver.ts` — `resolveWebSearchKeys`, `isKeyVisibleTo`, in-memory 5-min cache, `invalidateResolverCache`, types
- `tests/web-search-borrow.test.ts` — unit tests for the resolver
- `tests/api-keys-borrow.test.ts` — route tests for PATCH/GET/copy-from
- `tests/messages-borrow-integration.test.ts` — integration coverage for the inline path

**Modify:**
- `src/repo/types.ts` — extend `ApiKey` with three `*Ref` fields
- `src/repo/sqlite.ts` — `INIT_SQL`, runtime-migration `hasColumn` block, `SELECT_COLS`, `save()`, `toApiKey()`
- `src/repo/d1.ts` — `ApiKeyRow`, `SELECT_COLS`, `save()`, `toApiKey()`
- `src/services/web-search/core.ts` — `loadWebSearchConfig` now calls resolver; signature drops `msGroundingKey` arg in favour of resolver-internal env fallback
- `src/services/web-search/engine-manager.ts` — no change required; engines silently skipped when key undefined
- `src/routes/api-keys.ts` — `keyToJson` ref descriptors; PATCH accepts `*_ref` fields with XOR enforcement; `copy-web-search-from` writes refs
- `src/routes/messages.ts` — replace inline `engineOptions` with resolver call; add `priority` wiring
- `src/routes/chat-completions.ts`, `responses.ts`, `gemini.ts` — drop the `state.msGroundingKey` 3rd arg
- `src/ui/dashboard/client.ts` — extend `wsConfig` / `wsEdit*` state with ref fields and picker
- `src/ui/dashboard/tabs.ts` — render `↗ <name>` chips, "Borrow from…" buttons, picker modal
- `src/ui/i18n.ts` — five new strings

---

## Task 1: Migration + repo types

**Files:**
- Create: `migrations/0021_api_key_web_search_refs.sql`
- Modify: `src/repo/types.ts`

- [ ] **Step 1: Write the migration**

Create `migrations/0021_api_key_web_search_refs.sql`:

```sql
-- Borrow references for web-search secret fields. When a *_ref column is set,
-- the corresponding *_key column MUST be NULL. Resolver rehydrates the source
-- key value at request time and re-checks visibility every call.
ALTER TABLE api_keys ADD COLUMN web_search_langsearch_ref TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_tavily_ref TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_ref TEXT;
```

- [ ] **Step 2: Extend ApiKey interface**

In `src/repo/types.ts`, after the existing `webSearchPriority?: string[]` line in `ApiKey`, add:

```ts
  /** When set, resolves to source api_key.id's webSearchLangsearchKey at request time. Mutually exclusive with webSearchLangsearchKey. */
  webSearchLangsearchRef?: string
  /** Same as above for Tavily. */
  webSearchTavilyRef?: string
  /** Same as above for Microsoft Grounding. */
  webSearchMsGroundingRef?: string
```

- [ ] **Step 3: Commit**

```bash
git add migrations/0021_api_key_web_search_refs.sql src/repo/types.ts
git commit -m "feat(web-search): add ref columns + ApiKey fields for borrow"
```

---

## Task 2: SQLite repo support

**Files:**
- Modify: `src/repo/sqlite.ts`

- [ ] **Step 1: Update INIT_SQL CREATE TABLE for api_keys**

In `src/repo/sqlite.ts`, the `CREATE TABLE IF NOT EXISTS api_keys` block currently lists base columns. The runtime migration block at lines ~545-561 already adds existing web_search columns via `hasColumn`. Add three matching guarded migrations after the last existing one (after `web_search_copilot_priority`):

```ts
  if (!hasColumn(db, "api_keys", "web_search_ms_grounding_key")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_key TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_priority")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_priority TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_langsearch_ref")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_langsearch_ref TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_tavily_ref")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_tavily_ref TEXT")
  }
  if (!hasColumn(db, "api_keys", "web_search_ms_grounding_ref")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_ref TEXT")
  }
```

(The first two checks for `web_search_ms_grounding_key`/`web_search_priority` may already exist from migration 0020; verify before adding to avoid duplication. If duplicated, keep only the new three.)

- [ ] **Step 2: Update SELECT_COLS**

Replace the `SELECT_COLS` constant in `SqliteApiKeyRepo` (line ~136):

```ts
  private static readonly SELECT_COLS = "id, name, key, created_at, last_used_at, owner_id, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_bing_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_copilot_enabled, web_search_copilot_priority, web_search_ms_grounding_key, web_search_priority, web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref"
```

- [ ] **Step 3: Update save() INSERT/UPDATE**

Replace the entire `save()` body in `SqliteApiKeyRepo` (lines ~156-161):

```ts
  async save(key: ApiKey): Promise<void> {
    this.db.query(
      `INSERT INTO api_keys (id, name, key, created_at, last_used_at, owner_id, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_bing_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_copilot_enabled, web_search_copilot_priority, web_search_ms_grounding_key, web_search_priority, web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, owner_id = excluded.owner_id, quota_requests_per_day = excluded.quota_requests_per_day, quota_tokens_per_day = excluded.quota_tokens_per_day, web_search_enabled = excluded.web_search_enabled, web_search_bing_enabled = excluded.web_search_bing_enabled, web_search_langsearch_key = excluded.web_search_langsearch_key, web_search_tavily_key = excluded.web_search_tavily_key, web_search_copilot_enabled = excluded.web_search_copilot_enabled, web_search_copilot_priority = excluded.web_search_copilot_priority, web_search_ms_grounding_key = excluded.web_search_ms_grounding_key, web_search_priority = excluded.web_search_priority, web_search_langsearch_ref = excluded.web_search_langsearch_ref, web_search_tavily_ref = excluded.web_search_tavily_ref, web_search_ms_grounding_ref = excluded.web_search_ms_grounding_ref`,
    ).run(
      key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, key.ownerId ?? null,
      key.quotaRequestsPerDay ?? null, key.quotaTokensPerDay ?? null,
      key.webSearchEnabled ? 1 : 0, key.webSearchBingEnabled ? 1 : 0,
      key.webSearchLangsearchKey ?? null, key.webSearchTavilyKey ?? null,
      key.webSearchCopilotEnabled ? 1 : 0, key.webSearchCopilotPriority ? 1 : 0,
      key.webSearchMsGroundingKey ?? null,
      key.webSearchPriority ? JSON.stringify(key.webSearchPriority) : null,
      key.webSearchLangsearchRef ?? null,
      key.webSearchTavilyRef ?? null,
      key.webSearchMsGroundingRef ?? null,
    )
  }
```

- [ ] **Step 4: Update toApiKey() to read ref columns**

Replace the return value of `toApiKey()` at line ~181:

```ts
  return {
    id: row.id, name: row.name, key: row.key, createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined, ownerId: row.owner_id ?? undefined,
    quotaRequestsPerDay: row.quota_requests_per_day ?? undefined,
    quotaTokensPerDay: row.quota_tokens_per_day ?? undefined,
    webSearchEnabled: row.web_search_enabled === 1,
    webSearchBingEnabled: row.web_search_bing_enabled === 1,
    webSearchLangsearchKey: row.web_search_langsearch_key ?? undefined,
    webSearchTavilyKey: row.web_search_tavily_key ?? undefined,
    webSearchCopilotEnabled: row.web_search_copilot_enabled === 1,
    webSearchCopilotPriority: row.web_search_copilot_priority === 1,
    webSearchMsGroundingKey: row.web_search_ms_grounding_key ?? undefined,
    webSearchPriority: priority,
    webSearchLangsearchRef: row.web_search_langsearch_ref ?? undefined,
    webSearchTavilyRef: row.web_search_tavily_ref ?? undefined,
    webSearchMsGroundingRef: row.web_search_ms_grounding_ref ?? undefined,
  }
```

- [ ] **Step 5: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/repo/sqlite.ts
git commit -m "feat(repo/sqlite): persist web_search ref columns"
```

---

## Task 3: D1 repo support

**Files:**
- Modify: `src/repo/d1.ts`

- [ ] **Step 1: Read the existing D1 ApiKeyRepo**

Run: `grep -n "class D1ApiKeyRepo\|SELECT_COLS\|toApiKey\|ApiKeyRow\|web_search" src/repo/d1.ts | head -40`
Identify: `ApiKeyRow` interface, `SELECT_COLS` constant, `save()` method, `toApiKey` mapper. They mirror sqlite.ts.

- [ ] **Step 2: Extend ApiKeyRow**

Find the `ApiKeyRow` interface in `src/repo/d1.ts`. After the `web_search_priority?: string | null` field, add:

```ts
  web_search_langsearch_ref?: string | null
  web_search_tavily_ref?: string | null
  web_search_ms_grounding_ref?: string | null
```

- [ ] **Step 3: Extend SELECT_COLS**

Append `, web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref` to the `SELECT_COLS` constant in D1ApiKeyRepo, matching the sqlite version.

- [ ] **Step 4: Extend save()**

Mirror the sqlite save change: add the three new columns to the INSERT column list, the `?` placeholders, the `ON CONFLICT ... DO UPDATE SET ...` clause, and the bound parameter list (use `?? null` for each).

- [ ] **Step 5: Extend toApiKey()**

Add the three new fields to the return value, matching sqlite (`row.web_search_langsearch_ref ?? undefined`, etc).

- [ ] **Step 6: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/repo/d1.ts
git commit -m "feat(repo/d1): persist web_search ref columns"
```

---

## Task 4: Visibility helper

**Files:**
- Create: `src/services/web-search/resolver.ts`

- [ ] **Step 1: Write the visibility helper with literal-only resolution**

Create `src/services/web-search/resolver.ts`:

```ts
import { getApiKeyById } from "~/lib/api-keys"
import { getRepo } from "~/repo"
import type { ApiKey } from "~/repo/types"

/**
 * Returns true if `borrowerOwnerId` can see `sourceKey` per the same rules
 * as `GET /api/keys`:
 *   - same owner, OR
 *   - borrower has a key-assignment to the source, OR
 *   - borrower has been granted observability on the source's owner.
 *
 * Admin / no-owner borrower (legacy api-key auth without an owner) is treated
 * as visible only when the source has no owner either, to avoid leaking
 * across multi-tenant boundaries.
 */
export async function isKeyVisibleTo(
  sourceKey: ApiKey,
  borrowerOwnerId: string | undefined,
): Promise<boolean> {
  if (!sourceKey.ownerId && !borrowerOwnerId) return true
  if (!borrowerOwnerId) return false
  if (sourceKey.ownerId === borrowerOwnerId) return true

  const repo = getRepo()
  const assignments = await repo.keyAssignments.listByUser(borrowerOwnerId)
  if (assignments.some(a => a.keyId === sourceKey.id)) return true

  if (sourceKey.ownerId) {
    const granted = await repo.observabilityShares.isGranted(sourceKey.ownerId, borrowerOwnerId)
    if (granted) return true
  }
  return false
}

export interface ResolvedWebSearchKeys {
  langsearchKey?: string
  tavilyKey?: string
  msGroundingKey?: string
}

/**
 * Per-borrower TTL cache. Keyed by borrower api_key.id; value is the resolved
 * key bundle plus the env msGroundingKey it was resolved against (env can
 * differ across deployments / process restarts, so include it in the key).
 *
 * TTL is intentionally short (5 min) to bound staleness when:
 *   - source key rotates its literal,
 *   - borrower loses visibility (assignment unassigned, share revoked),
 *   - source is deleted.
 *
 * PATCH /api/keys/:id and copy-web-search-from explicitly call
 * `invalidateResolverCache(borrowerId)` to make their changes take effect
 * immediately for that one key. Cross-key invalidation (e.g. revoking a
 * share) intentionally relies on TTL — those flows are rare and the 5-min
 * window is acceptable.
 */
const CACHE_TTL_MS = 5 * 60 * 1000
interface CacheEntry { value: ResolvedWebSearchKeys; expiresAt: number; envKey: string }
const resolverCache = new Map<string, CacheEntry>()

export function invalidateResolverCache(borrowerKeyId?: string): void {
  if (borrowerKeyId) resolverCache.delete(borrowerKeyId)
  else resolverCache.clear()
}

/**
 * Resolve borrowed refs into literal values. Re-checks visibility on every
 * cache miss. Refs to missing/invisible/refless sources silently degrade to
 * undefined (engine layer skips them). Transitive refs are NOT followed —
 * the source must hold a literal.
 *
 * Results are cached per borrower id for 5 minutes; pass `skipCache: true`
 * for tests or admin debug paths that need a fresh read.
 */
export async function resolveWebSearchKeys(
  keyConfig: ApiKey,
  envMsGroundingKey?: string,
  opts: { skipCache?: boolean } = {},
): Promise<ResolvedWebSearchKeys> {
  const envKey = envMsGroundingKey ?? ""
  if (!opts.skipCache) {
    const hit = resolverCache.get(keyConfig.id)
    if (hit && hit.expiresAt > Date.now() && hit.envKey === envKey) {
      return hit.value
    }
  }

  const borrowerOwnerId = keyConfig.ownerId

  const resolveOne = async (
    literal: string | undefined,
    refId: string | undefined,
    pickFromSource: (s: ApiKey) => string | undefined,
  ): Promise<string | undefined> => {
    if (literal) return literal
    if (!refId) return undefined
    const source = await getApiKeyById(refId)
    if (!source) return undefined
    if (!(await isKeyVisibleTo(source, borrowerOwnerId))) return undefined
    return pickFromSource(source) // ignores source's own ref → no transitive
  }

  const [langsearchKey, tavilyKey, msFromRef] = await Promise.all([
    resolveOne(keyConfig.webSearchLangsearchKey, keyConfig.webSearchLangsearchRef, s => s.webSearchLangsearchKey),
    resolveOne(keyConfig.webSearchTavilyKey, keyConfig.webSearchTavilyRef, s => s.webSearchTavilyKey),
    resolveOne(keyConfig.webSearchMsGroundingKey, keyConfig.webSearchMsGroundingRef, s => s.webSearchMsGroundingKey),
  ])

  const value: ResolvedWebSearchKeys = {
    langsearchKey,
    tavilyKey,
    msGroundingKey: msFromRef ?? envMsGroundingKey,
  }

  if (!opts.skipCache) {
    resolverCache.set(keyConfig.id, { value, expiresAt: Date.now() + CACHE_TTL_MS, envKey })
  }
  return value
}
```

- [ ] **Step 2: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/web-search/resolver.ts
git commit -m "feat(web-search): add resolveWebSearchKeys + isKeyVisibleTo"
```

---

## Task 5: Resolver unit tests

**Files:**
- Create: `tests/web-search-borrow.test.ts`

- [ ] **Step 1: Write resolver unit tests**

Create `tests/web-search-borrow.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepo } from "~/repo"
import { createSqliteRepo } from "~/repo/sqlite"
import { resolveWebSearchKeys, isKeyVisibleTo } from "~/services/web-search/resolver"
import type { ApiKey } from "~/repo/types"

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: overrides.id ?? "k_" + Math.random().toString(36).slice(2, 8),
    name: overrides.name ?? "test",
    key: overrides.key ?? "raw_" + Math.random().toString(36).slice(2, 10),
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("resolveWebSearchKeys", () => {
  beforeEach(() => {
    const db = new Database(":memory:")
    setRepo(createSqliteRepo(db))
  })

  test("literal-only returns the literal", async () => {
    const repo = (await import("~/repo")).getRepo()
    const k = key({ webSearchLangsearchKey: "lit-1" })
    await repo.apiKeys.save(k)
    const result = await resolveWebSearchKeys(k)
    expect(result.langsearchKey).toBe("lit-1")
    expect(result.tavilyKey).toBeUndefined()
  })

  test("ref resolves to source literal when same owner", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "src-lit" })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBe("src-lit")
  })

  test("ref to missing source returns undefined", async () => {
    const repo = (await import("~/repo")).getRepo()
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: "k_does_not_exist" })
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBeUndefined()
  })

  test("ref to source with no literal returns undefined (no transitive)", async () => {
    const repo = (await import("~/repo")).getRepo()
    const root = key({ ownerId: "u1", webSearchLangsearchKey: "deep" })
    const middle = key({ ownerId: "u1", webSearchLangsearchRef: root.id })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: middle.id })
    await repo.apiKeys.save(root)
    await repo.apiKeys.save(middle)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBeUndefined()
  })

  test("ref to invisible source returns undefined", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "secret" })
    const borrower = key({ ownerId: "u2", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBeUndefined()
  })

  test("msGrounding falls back to env when neither literal nor ref present", async () => {
    const repo = (await import("~/repo")).getRepo()
    const k = key({ ownerId: "u1" })
    await repo.apiKeys.save(k)
    const result = await resolveWebSearchKeys(k, "env-ms-key")
    expect(result.msGroundingKey).toBe("env-ms-key")
  })

  test("msGrounding ref overrides env fallback", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchMsGroundingKey: "ref-ms" })
    const borrower = key({ ownerId: "u1", webSearchMsGroundingRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower, "env-ms-key")
    expect(result.msGroundingKey).toBe("ref-ms")
  })

  test("cache returns stale value within TTL even after source rotation", async () => {
    const { invalidateResolverCache } = await import("~/services/web-search/resolver")
    invalidateResolverCache()
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "v1" })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    expect((await resolveWebSearchKeys(borrower)).langsearchKey).toBe("v1")
    // Rotate source literal directly in repo, do NOT invalidate.
    await repo.apiKeys.save({ ...source, webSearchLangsearchKey: "v2" })
    expect((await resolveWebSearchKeys(borrower)).langsearchKey).toBe("v1") // cached
    expect((await resolveWebSearchKeys(borrower, undefined, { skipCache: true })).langsearchKey).toBe("v2")
  })

  test("invalidateResolverCache(borrowerId) drops only that entry", async () => {
    const { invalidateResolverCache } = await import("~/services/web-search/resolver")
    invalidateResolverCache()
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "v1" })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    await resolveWebSearchKeys(borrower) // populate cache
    await repo.apiKeys.save({ ...source, webSearchLangsearchKey: "v2" })
    invalidateResolverCache(borrower.id)
    expect((await resolveWebSearchKeys(borrower)).langsearchKey).toBe("v2")
  })
})

describe("isKeyVisibleTo", () => {
  beforeEach(() => {
    const db = new Database(":memory:")
    setRepo(createSqliteRepo(db))
  })

  test("same owner is visible", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    expect(await isKeyVisibleTo(source, "u1")).toBe(true)
  })

  test("different owner without share is not visible", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    expect(await isKeyVisibleTo(source, "u2")).toBe(false)
  })

  test("key-assignment grants visibility", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    await repo.keyAssignments.assign(source.id, "u2", "u1")
    expect(await isKeyVisibleTo(source, "u2")).toBe(true)
  })

  test("observability share grants visibility", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    await repo.observabilityShares.share("u1", "u2", "u1")
    expect(await isKeyVisibleTo(source, "u2")).toBe(true)
  })
})
```

> **Note:** If `setRepo` / `createSqliteRepo` are not exported with these exact names, run `grep -n 'export' src/repo/index.ts src/repo/sqlite.ts` and adjust imports to match. The intent is: install a fresh in-memory SQLite repo per test.

- [ ] **Step 2: Run tests, expect failures only if naming differs**

Run: `bun test tests/web-search-borrow.test.ts`
Expected: 13 tests pass. If imports fail, fix per the note above and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/web-search-borrow.test.ts
git commit -m "test(web-search): cover resolveWebSearchKeys + isKeyVisibleTo"
```

---

## Task 6: Wire resolver into loadWebSearchConfig

**Files:**
- Modify: `src/services/web-search/core.ts`
- Modify: `src/routes/chat-completions.ts`, `src/routes/responses.ts`, `src/routes/gemini.ts`

- [ ] **Step 1: Update loadWebSearchConfig signature and body**

In `src/services/web-search/core.ts`, replace `loadWebSearchConfig`:

```ts
import { resolveWebSearchKeys } from "./resolver"

export async function loadWebSearchConfig(
  apiKeyId: string | undefined,
  githubToken: string,
  envMsGroundingKey?: string,
): Promise<WebSearchConfigResult> {
  const keyConfig = apiKeyId ? await getApiKeyById(apiKeyId) : null
  if (!keyConfig?.webSearchEnabled) {
    return {
      enabled: false,
      errorResponse: new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message:
              "Web search is not enabled for this API key. Configure it in the dashboard.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    }
  }

  const resolved = await resolveWebSearchKeys(keyConfig, envMsGroundingKey)

  return {
    enabled: true,
    engineOptions: {
      langsearchKey: resolved.langsearchKey,
      tavilyKey: resolved.tavilyKey,
      bingEnabled: keyConfig.webSearchBingEnabled,
      githubToken,
      copilotEnabled: keyConfig.webSearchCopilotEnabled,
      copilotPriority: keyConfig.webSearchCopilotPriority,
      msGroundingKey: resolved.msGroundingKey,
      priority: keyConfig.webSearchPriority,
    },
  }
}
```

- [ ] **Step 2: No call-site changes needed for chat-completions / responses / gemini**

These routes already call `loadWebSearchConfig(apiKeyId, state.githubToken, state.msGroundingKey)`. The new third arg name is `envMsGroundingKey` but signature is positional — confirm via:

Run: `grep -n 'loadWebSearchConfig' src/routes/`
Expected: three call sites, all passing three args. No edits needed.

- [ ] **Step 3: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/web-search/core.ts
git commit -m "feat(web-search): loadWebSearchConfig uses resolver, includes priority"
```

---

## Task 7: Wire resolver into messages.ts inline path

**Files:**
- Modify: `src/routes/messages.ts`

- [ ] **Step 1: Replace inline engineOptions with resolver call**

In `src/routes/messages.ts`, find the block at lines ~99-127. The `keyConfig` is already loaded. After the `webSearchEnabled` check passes, before constructing `interceptPayload`, add:

```ts
      const { resolveWebSearchKeys } = await import("~/services/web-search/resolver")
      const resolvedKeys = await resolveWebSearchKeys(keyConfig, state.msGroundingKey)
```

Then replace the `engineOptions` block (lines ~118-126):

```ts
        engineOptions: {
          langsearchKey: resolvedKeys.langsearchKey,
          tavilyKey: resolvedKeys.tavilyKey,
          bingEnabled: keyConfig.webSearchBingEnabled,
          githubToken: state.githubToken,
          copilotEnabled: keyConfig.webSearchCopilotEnabled,
          copilotPriority: keyConfig.webSearchCopilotPriority,
          msGroundingKey: resolvedKeys.msGroundingKey,
          priority: keyConfig.webSearchPriority,
        },
```

(Use a top-of-file static import instead of dynamic if the import section already has `~/services/web-search/...` siblings — preferred.)

- [ ] **Step 2: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages.ts
git commit -m "feat(routes/messages): use resolver + priority for inline engine options"
```

---

## Task 8: API surface — keyToJson ref descriptors

**Files:**
- Modify: `src/routes/api-keys.ts`

- [ ] **Step 1: Build a ref-descriptor helper**

Below `maskKey` in `src/routes/api-keys.ts`, add:

```ts
interface RefDescriptor {
  id: string
  name: string | null
  owner_id: string | null
  broken: true | undefined
}

/**
 * Build the GET-shape ref descriptor for a borrowed engine key. If the
 * source still exists, returns { id, name, owner_id }. If not, returns
 * { id, name: null, owner_id: null, broken: true }. Caller passes the
 * pre-loaded source map to avoid N+1 lookups.
 */
function refDescriptor(refId: string, sourceMap: Map<string, ApiKey>): RefDescriptor {
  const src = sourceMap.get(refId)
  if (!src) return { id: refId, name: null, owner_id: null, broken: true }
  return { id: refId, name: src.name, owner_id: src.ownerId ?? null, broken: undefined }
}
```

- [ ] **Step 2: Update keyToJson to accept and emit ref descriptors**

Replace `keyToJson` at line ~20:

```ts
function keyToJson(k: ApiKey, ownerName?: string, isOwner?: boolean, sourceMap?: Map<string, ApiKey>) {
  const map = sourceMap ?? new Map<string, ApiKey>()
  const langsearchRef = k.webSearchLangsearchRef ? refDescriptor(k.webSearchLangsearchRef, map) : null
  const tavilyRef = k.webSearchTavilyRef ? refDescriptor(k.webSearchTavilyRef, map) : null
  const msGroundingRef = k.webSearchMsGroundingRef ? refDescriptor(k.webSearchMsGroundingRef, map) : null
  return {
    id: k.id, name: k.name, key: k.key, created_at: k.createdAt,
    last_used_at: k.lastUsedAt ?? null, owner_id: k.ownerId ?? null,
    owner_name: ownerName ?? null, is_owner: isOwner ?? true,
    quota_requests_per_day: k.quotaRequestsPerDay ?? null,
    quota_tokens_per_day: k.quotaTokensPerDay ?? null,
    web_search_enabled: k.webSearchEnabled ?? false,
    web_search_bing_enabled: k.webSearchBingEnabled ?? false,
    web_search_langsearch_key: langsearchRef ? null : maskKey(k.webSearchLangsearchKey),
    web_search_langsearch_ref: langsearchRef,
    web_search_tavily_key: tavilyRef ? null : maskKey(k.webSearchTavilyKey),
    web_search_tavily_ref: tavilyRef,
    web_search_ms_grounding_key: msGroundingRef ? null : maskKey(k.webSearchMsGroundingKey),
    web_search_ms_grounding_ref: msGroundingRef,
    web_search_copilot_enabled: k.webSearchCopilotEnabled ?? false,
    web_search_copilot_priority: k.webSearchCopilotPriority ?? false,
    web_search_priority: k.webSearchPriority ?? null,
  }
}
```

- [ ] **Step 3: Pre-load source map in each list handler**

In every place `keyToJson(...)` is called from a list handler (admin list ~67, user own list ~98, user assigned list ~116, single-key list ~127, single-id GET ~147, PATCH return ~220, etc.), pre-build a `sourceMap`:

For the **admin list handler** (around lines 41-73), after `const allAssignments = ...` add:

```ts
      const refIds = new Set<string>()
      for (const k of keys) {
        if (k.webSearchLangsearchRef) refIds.add(k.webSearchLangsearchRef)
        if (k.webSearchTavilyRef) refIds.add(k.webSearchTavilyRef)
        if (k.webSearchMsGroundingRef) refIds.add(k.webSearchMsGroundingRef)
      }
      const sourceMap = new Map<string, ApiKey>()
      await Promise.all([...refIds].map(async (id) => {
        const src = await getApiKeyById(id)
        if (src) sourceMap.set(id, src)
      }))
```

Then change the `keyToJson(k, ...)` call to pass `sourceMap` as the 4th arg. Repeat the same pattern in the user list handler and any other place that maps multiple keys.

For single-key paths (PATCH return at line ~220, GET-by-id at ~147), build a 1-entry `sourceMap` inline, e.g.:

```ts
    const sourceMap = new Map<string, ApiKey>()
    for (const refId of [updated.webSearchLangsearchRef, updated.webSearchTavilyRef, updated.webSearchMsGroundingRef]) {
      if (refId) {
        const s = await getApiKeyById(refId)
        if (s) sourceMap.set(refId, s)
      }
    }
    return keyToJson(updated, undefined, true, sourceMap)
```

- [ ] **Step 4: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat(routes/api-keys): emit web_search ref descriptors in GET responses"
```

---

## Task 9: PATCH handler — accept ref fields with XOR enforcement

**Files:**
- Modify: `src/routes/api-keys.ts`

- [ ] **Step 1: Build a visibility check helper at module scope**

Below `checkOwnership` (~line 36) add:

```ts
/**
 * Same visibility rules as GET /api/keys: same owner OR key-assignment OR
 * observability share. Admin always passes.
 */
async function checkRefVisible(refSourceId: string, ctx: AuthCtx): Promise<{ ok: boolean; reason?: string; status: number }> {
  const src = await getApiKeyById(refSourceId)
  if (!src) return { ok: false, reason: "Source key not found", status: 404 }
  if (ctx.isAdmin) return { ok: true, status: 200 }
  if (!ctx.userId) return { ok: false, reason: "Forbidden", status: 403 }
  const { isKeyVisibleTo } = await import("~/services/web-search/resolver")
  const visible = await isKeyVisibleTo(src, ctx.userId)
  return visible ? { ok: true, status: 200 } : { ok: false, reason: "Source key not visible", status: 400 }
}
```

- [ ] **Step 2: Extend the PATCH body destructure**

Replace the destructure at line ~177 to include the three new ref fields and the previously-missing fields (`web_search_ms_grounding_key`, `web_search_priority`):

```ts
    const {
      name, quota_requests_per_day, quota_tokens_per_day,
      web_search_enabled, web_search_bing_enabled,
      web_search_langsearch_key, web_search_tavily_key,
      web_search_copilot_enabled, web_search_copilot_priority,
      web_search_ms_grounding_key, web_search_priority,
      web_search_langsearch_ref, web_search_tavily_ref, web_search_ms_grounding_ref,
    } = body as {
      name?: string;
      quota_requests_per_day?: number | null;
      quota_tokens_per_day?: number | null;
      web_search_enabled?: boolean;
      web_search_bing_enabled?: boolean;
      web_search_langsearch_key?: string | null;
      web_search_tavily_key?: string | null;
      web_search_copilot_enabled?: boolean;
      web_search_copilot_priority?: boolean;
      web_search_ms_grounding_key?: string | null;
      web_search_priority?: string[] | null;
      web_search_langsearch_ref?: string | null;
      web_search_tavily_ref?: string | null;
      web_search_ms_grounding_ref?: string | null;
    }
```

- [ ] **Step 3: Add XOR enforcement and ref handling per engine**

Inside the PATCH handler, before `await getRepo().apiKeys.save(updated)`, add (after the existing `web_search_*_key` handlers and before the priority/grounding ones):

```ts
    // XOR enforcement: literal vs ref for each of the three secret engines.
    const pairs: Array<[string, unknown, unknown, keyof ApiKey, keyof ApiKey]> = [
      ["langsearch", web_search_langsearch_key, web_search_langsearch_ref, "webSearchLangsearchKey", "webSearchLangsearchRef"],
      ["tavily", web_search_tavily_key, web_search_tavily_ref, "webSearchTavilyKey", "webSearchTavilyRef"],
      ["ms_grounding", web_search_ms_grounding_key, web_search_ms_grounding_ref, "webSearchMsGroundingKey", "webSearchMsGroundingRef"],
    ]
    for (const [engineLabel, literalVal, refVal, literalField, refField] of pairs) {
      const literalProvided = literalVal !== undefined && literalVal !== null && literalVal !== ""
      const refProvided = refVal !== undefined && refVal !== null && refVal !== ""
      if (literalProvided && refProvided) {
        return new Response(JSON.stringify({ error: `Cannot set both web_search_${engineLabel}_key and web_search_${engineLabel}_ref` }), { status: 400, headers: { "Content-Type": "application/json" } })
      }
      if (refProvided) {
        const check = await checkRefVisible(refVal as string, authCtx)
        if (!check.ok) {
          return new Response(JSON.stringify({ error: check.reason }), { status: check.status, headers: { "Content-Type": "application/json" } })
        }
        // Setting a ref clears the matching literal.
        ;(updated as any)[refField] = refVal
        ;(updated as any)[literalField] = undefined
      } else if (refVal === null) {
        ;(updated as any)[refField] = undefined
      }
      if (literalProvided) {
        // Setting a literal clears the matching ref.
        ;(updated as any)[literalField] = literalVal
        ;(updated as any)[refField] = undefined
      } else if (literalVal === null) {
        ;(updated as any)[literalField] = undefined
      }
    }

    // Pre-existing missing handlers, add them too:
    if (web_search_priority !== undefined) {
      updated.webSearchPriority = web_search_priority === null ? undefined : web_search_priority
    }
    // (web_search_ms_grounding_key handled above via the pairs loop — DO NOT add a second handler.)
```

> **Note:** Because the pairs loop now handles `web_search_langsearch_key`, `web_search_tavily_key`, and `web_search_ms_grounding_key`, **delete** the pre-existing line-by-line handlers for `web_search_langsearch_key` and `web_search_tavily_key` (lines ~207-212) so they don't run twice.

- [ ] **Step 4: Invalidate resolver cache after save**

After the `await getRepo().apiKeys.save(updated)` call in PATCH, add:

```ts
    const { invalidateResolverCache } = await import("~/services/web-search/resolver")
    invalidateResolverCache(updated.id)
```

This ensures the borrower's next request sees the new ref/literal immediately rather than waiting up to 5 minutes for the cache to expire.

- [ ] **Step 5: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat(routes/api-keys): PATCH accepts web_search ref fields with XOR enforcement"
```

---

## Task 10: Refactor copy-web-search-from to set refs

**Files:**
- Modify: `src/routes/api-keys.ts`

- [ ] **Step 1: Replace the updated body inside the copy handler**

In `src/routes/api-keys.ts` lines ~379-387, replace:

```ts
    const updated = {
      ...target,
      webSearchEnabled: source.webSearchEnabled,
      webSearchBingEnabled: source.webSearchBingEnabled,
      webSearchCopilotEnabled: source.webSearchCopilotEnabled,
      webSearchCopilotPriority: source.webSearchCopilotPriority,
      webSearchPriority: source.webSearchPriority,
      // Secret literals → refs. If source itself holds a ref or no value,
      // leave target's slot empty (do not propagate ref-of-ref).
      webSearchLangsearchKey: undefined,
      webSearchLangsearchRef: source.webSearchLangsearchKey ? source.id : undefined,
      webSearchTavilyKey: undefined,
      webSearchTavilyRef: source.webSearchTavilyKey ? source.id : undefined,
      webSearchMsGroundingKey: undefined,
      webSearchMsGroundingRef: source.webSearchMsGroundingKey ? source.id : undefined,
    }
```

(Then `await getRepo().apiKeys.save(updated)` and the `keyToJson(updated)` return continue as today, but the `keyToJson` call now needs a sourceMap — use the same 1-entry pattern from Task 8 step 3. Also call `invalidateResolverCache(updated.id)` after save, mirroring Task 9 step 4.)

- [ ] **Step 2: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat(routes/api-keys): copy-web-search-from sets refs instead of copying secrets"
```

---

## Task 11: Route-level tests

**Files:**
- Create: `tests/api-keys-borrow.test.ts`

- [ ] **Step 1: Write route tests**

Create `tests/api-keys-borrow.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"
import { setRepo, getRepo } from "~/repo"
import { createSqliteRepo } from "~/repo/sqlite"
import { apiKeysRoute } from "~/routes/api-keys"

let app: Elysia

beforeEach(async () => {
  const db = new Database(":memory:")
  setRepo(createSqliteRepo(db))
  app = new Elysia()
    .derive(() => ({ isAdmin: true, userId: "u1", authKind: "session" as const }))
    .use(apiKeysRoute)
})

async function createKey(ownerId: string, opts: Partial<{ langsearch: string; tavily: string; msGrounding: string }> = {}) {
  const repo = getRepo()
  const id = "k_" + Math.random().toString(36).slice(2, 8)
  await repo.apiKeys.save({
    id, name: id, key: "raw-" + id, createdAt: new Date().toISOString(), ownerId,
    webSearchEnabled: true,
    webSearchLangsearchKey: opts.langsearch,
    webSearchTavilyKey: opts.tavily,
    webSearchMsGroundingKey: opts.msGrounding,
  })
  return id
}

describe("PATCH /api/keys/:id ref fields", () => {
  test("400 when both literal and ref provided for same engine", async () => {
    const sourceId = await createKey("u1", { langsearch: "src" })
    const targetId = await createKey("u1")
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ web_search_langsearch_key: "lit", web_search_langsearch_ref: sourceId }),
    }))
    expect(res.status).toBe(400)
  })

  test("404 when ref source does not exist", async () => {
    const targetId = await createKey("u1")
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ web_search_langsearch_ref: "k_does_not_exist" }),
    }))
    expect(res.status).toBe(404)
  })

  test("setting ref clears the matching literal", async () => {
    const sourceId = await createKey("u1", { langsearch: "src-secret" })
    const targetId = await createKey("u1", { langsearch: "old-literal" })
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ web_search_langsearch_ref: sourceId }),
    }))
    expect(res.status).toBe(200)
    const stored = await getRepo().apiKeys.getById(targetId)
    expect(stored?.webSearchLangsearchKey).toBeUndefined()
    expect(stored?.webSearchLangsearchRef).toBe(sourceId)
  })

  test("setting literal clears the matching ref", async () => {
    const sourceId = await createKey("u1", { langsearch: "src" })
    const targetId = await createKey("u1")
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(targetId))!,
      webSearchLangsearchRef: sourceId,
    })
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ web_search_langsearch_key: "new-literal" }),
    }))
    expect(res.status).toBe(200)
    const stored = await getRepo().apiKeys.getById(targetId)
    expect(stored?.webSearchLangsearchKey).toBe("new-literal")
    expect(stored?.webSearchLangsearchRef).toBeUndefined()
  })
})

describe("GET /api/keys with ref fields", () => {
  test("borrower never sees source's literal value", async () => {
    const sourceId = await createKey("u1", { langsearch: "supersecret-XYZ" })
    const targetId = await createKey("u1")
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(targetId))!,
      webSearchLangsearchRef: sourceId,
    })
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}`))
    const json = await res.json() as any[]
    const target = json.find(k => k.id === targetId)
    expect(target.web_search_langsearch_key).toBeNull()
    expect(target.web_search_langsearch_ref).toMatchObject({ id: sourceId, broken: undefined })
    expect(JSON.stringify(target)).not.toContain("supersecret-XYZ")
  })

  test("broken ref renders as { broken: true }", async () => {
    const targetId = await createKey("u1")
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(targetId))!,
      webSearchLangsearchRef: "k_deleted",
    })
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}`))
    const json = await res.json() as any[]
    const target = json.find(k => k.id === targetId)
    expect(target.web_search_langsearch_ref).toMatchObject({
      id: "k_deleted", name: null, owner_id: null, broken: true,
    })
  })
})

describe("POST /api/keys/:id/copy-web-search-from/:sourceId", () => {
  test("sets refs, clears literals, preserves flags", async () => {
    const sourceId = await createKey("u1", { langsearch: "src-l", tavily: "src-t" })
    await getRepo().apiKeys.save({
      ...(await getRepo().apiKeys.getById(sourceId))!,
      webSearchPriority: ["msGrounding", "langsearch"],
      webSearchBingEnabled: true,
      webSearchCopilotPriority: true,
    })
    const targetId = await createKey("u1", { langsearch: "old-target-literal" })
    const res = await app.handle(new Request(`http://x/api/keys/${targetId}/copy-web-search-from/${sourceId}`, {
      method: "POST",
    }))
    expect(res.status).toBe(200)
    const stored = await getRepo().apiKeys.getById(targetId)
    expect(stored?.webSearchLangsearchKey).toBeUndefined()
    expect(stored?.webSearchLangsearchRef).toBe(sourceId)
    expect(stored?.webSearchTavilyRef).toBe(sourceId)
    expect(stored?.webSearchMsGroundingRef).toBeUndefined() // source had no ms key
    expect(stored?.webSearchBingEnabled).toBe(true)
    expect(stored?.webSearchCopilotPriority).toBe(true)
    expect(stored?.webSearchPriority).toEqual(["msGrounding", "langsearch"])
  })
})
```

> **Note:** If `apiKeysRoute` requires more middleware than the simple `derive`, mirror what `local.ts` does to mount it. Check by running `grep -n "apiKeysRoute" src/local.ts src/index.ts`.

- [ ] **Step 2: Run tests**

Run: `bun test tests/api-keys-borrow.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/api-keys-borrow.test.ts
git commit -m "test(routes/api-keys): cover web_search ref PATCH/GET/copy-from"
```

---

## Task 12: Dashboard — state + GET handling

**Files:**
- Modify: `src/ui/dashboard/client.ts`

- [ ] **Step 1: Read current state shape and edit handlers**

Run: `grep -n 'wsConfig\|wsEdit\|web_search_langsearch\|web_search_tavily\|web_search_ms_grounding' src/ui/dashboard/client.ts`
Identify: the Alpine state object that holds the current key's web-search config and the edit form.

- [ ] **Step 2: Extend wsConfig (display) state**

Where the current key's web-search config is stored after a list refresh, add fields for refs. Example pattern (adapt to actual variable names; the file uses `wsConfig` and `wsEdit*`):

```ts
// After processing each key from GET /api/keys:
key.wsLangsearchRef = key.web_search_langsearch_ref ?? null   // { id, name, owner_id, broken } | null
key.wsTavilyRef = key.web_search_tavily_ref ?? null
key.wsMsGroundingRef = key.web_search_ms_grounding_ref ?? null
```

- [ ] **Step 3: Extend the edit form state**

When opening the edit modal for a key, populate three new fields alongside the existing literal-key fields:

```ts
this.wsEditLangsearchRef = key.web_search_langsearch_ref?.id ?? ""
this.wsEditTavilyRef = key.web_search_tavily_ref?.id ?? ""
this.wsEditMsGroundingRef = key.web_search_ms_grounding_ref?.id ?? ""
```

Add a "borrow picker" array of candidate sources that the user can pick from. Populate from the already-fetched key list, filtered to keys whose corresponding literal is non-null:

```ts
get borrowCandidatesLangsearch() {
  return this.keys.filter(k => k.web_search_langsearch_key && k.id !== this.editingKeyId)
}
// Same for tavily and msGrounding
```

- [ ] **Step 4: Update PATCH submit**

When saving the edit form, include either the literal OR the ref per engine, never both. Example for langsearch:

```ts
const body: Record<string, unknown> = { /* name, quotas, etc */ }
if (this.wsEditLangsearchRef) {
  body.web_search_langsearch_ref = this.wsEditLangsearchRef
} else if (this.wsEditLangsearchKey !== this.originalLangsearchMasked) {
  // Only PATCH the literal if user typed something new (not the masked placeholder).
  body.web_search_langsearch_key = this.wsEditLangsearchKey || null
}
```

Repeat for tavily and msGrounding. The "Unlink" button sets `wsEditXxxRef = ""` and `body.web_search_xxx_ref = null`.

- [ ] **Step 5: Smoke test**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/client.ts
git commit -m "feat(dashboard): track web_search ref fields + borrow candidates"
```

---

## Task 13: Dashboard — render and picker UI

**Files:**
- Modify: `src/ui/dashboard/tabs.ts`
- Modify: `src/ui/i18n.ts`

- [ ] **Step 1: Add i18n strings**

In `src/ui/i18n.ts`, add to both `en` and `zh` blocks:

```ts
wsBorrowFrom: "Borrow from…",                  // zh: "借用其他 Key…"
wsBorrowedFrom: "Borrowed from",               // zh: "借用自"
wsBorrowedUnavailable: "Borrowed (unavailable)", // zh: "借用（不可用）"
wsUnlink: "Unlink",                            // zh: "解除借用"
wsBorrowPickerTitle: "Pick a key to borrow from", // zh: "选择借用来源"
```

- [ ] **Step 2: Render ref or input per engine**

In `src/ui/dashboard/tabs.ts`, find the existing inputs for `web_search_langsearch_key`, `web_search_tavily_key`, and `web_search_ms_grounding_key`. For each, wrap with a conditional:

```html
<template x-if="wsEditLangsearchRef">
  <div class="ws-ref-chip">
    <span x-text="wsLangsearchRefDisplay()"></span>
    <button type="button" @click="wsEditLangsearchRef = ''" x-text="t('wsUnlink')"></button>
  </div>
</template>
<template x-if="!wsEditLangsearchRef">
  <div>
    <input type="text" x-model="wsEditLangsearchKey" :placeholder="originalLangsearchMasked || ''" />
    <button type="button" @click="openBorrowPicker('langsearch')" x-text="t('wsBorrowFrom')"></button>
  </div>
</template>
```

Add a `wsLangsearchRefDisplay()` method on the Alpine component that returns:

```ts
wsLangsearchRefDisplay() {
  const ref = this.editingKey?.web_search_langsearch_ref
  if (!ref) return ""
  if (ref.broken) return `↗ ${this.t("wsBorrowedUnavailable")}`
  return `↗ ${ref.name}`
}
```

Repeat for tavily and msGrounding.

- [ ] **Step 3: Add the picker modal**

Append a single picker modal block (one for all three engines, parameterised by `borrowPickerEngine`):

```html
<template x-if="borrowPickerEngine">
  <div class="modal">
    <h3 x-text="t('wsBorrowPickerTitle')"></h3>
    <ul>
      <template x-for="cand in currentBorrowCandidates()" :key="cand.id">
        <li @click="confirmBorrow(cand.id)">
          <strong x-text="cand.name"></strong>
          <small x-text="cand.owner_name || cand.owner_id || ''"></small>
        </li>
      </template>
    </ul>
    <button @click="borrowPickerEngine = ''">Cancel</button>
  </div>
</template>
```

Where `currentBorrowCandidates()` returns one of `borrowCandidatesLangsearch / Tavily / MsGrounding` based on `borrowPickerEngine`, and `confirmBorrow(id)` sets the matching `wsEditXxxRef` to `id` and closes the modal.

- [ ] **Step 4: Smoke test the build**

Run: `bun build src/ui/dashboard/index.ts --target browser --outfile /tmp/dashboard-bundle.js`
Expected: builds without errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/tabs.ts src/ui/i18n.ts
git commit -m "feat(dashboard): render web_search ref chips + borrow picker"
```

---

## Task 14: messages.ts integration test

**Files:**
- Create: `tests/messages-borrow-integration.test.ts`

- [ ] **Step 1: Write a focused integration test**

Create `tests/messages-borrow-integration.test.ts`. The goal is to assert that when a `messages` request is made with a key that borrows langsearch via ref, the resolver actually fires (mocking the engine to record what key it received):

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepo, getRepo } from "~/repo"
import { createSqliteRepo } from "~/repo/sqlite"
import { resolveWebSearchKeys } from "~/services/web-search/resolver"

beforeEach(() => {
  const db = new Database(":memory:")
  setRepo(createSqliteRepo(db))
})

describe("messages.ts inline path uses resolveWebSearchKeys", () => {
  test("borrowed langsearch key is resolved at request time", async () => {
    const repo = getRepo()
    const sourceId = "k_src"
    await repo.apiKeys.save({
      id: sourceId, name: "src", key: "raw-src",
      createdAt: new Date().toISOString(), ownerId: "u1",
      webSearchEnabled: true, webSearchLangsearchKey: "real-secret",
    })
    const borrowerId = "k_brw"
    await repo.apiKeys.save({
      id: borrowerId, name: "brw", key: "raw-brw",
      createdAt: new Date().toISOString(), ownerId: "u1",
      webSearchEnabled: true, webSearchLangsearchRef: sourceId,
    })

    const borrower = (await repo.apiKeys.getById(borrowerId))!
    const resolved = await resolveWebSearchKeys(borrower)
    expect(resolved.langsearchKey).toBe("real-secret")
  })

  test("source revoked between writes makes the key undefined", async () => {
    const repo = getRepo()
    const sourceId = "k_src"
    await repo.apiKeys.save({
      id: sourceId, name: "src", key: "raw-src",
      createdAt: new Date().toISOString(), ownerId: "u1",
      webSearchEnabled: true, webSearchLangsearchKey: "real-secret",
    })
    const borrowerId = "k_brw"
    await repo.apiKeys.save({
      id: borrowerId, name: "brw", key: "raw-brw",
      createdAt: new Date().toISOString(), ownerId: "u2",
      webSearchEnabled: true, webSearchLangsearchRef: sourceId,
    })
    // u2 had access via assignment; revoke it.
    await repo.keyAssignments.assign(sourceId, "u2", "u1")
    expect((await resolveWebSearchKeys((await repo.apiKeys.getById(borrowerId))!)).langsearchKey).toBe("real-secret")
    await repo.keyAssignments.unassign(sourceId, "u2")
    expect((await resolveWebSearchKeys((await repo.apiKeys.getById(borrowerId))!)).langsearchKey).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run**

Run: `bun test tests/messages-borrow-integration.test.ts`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/messages-borrow-integration.test.ts
git commit -m "test(web-search): integration coverage for borrow + revoke flow"
```

---

## Task 15: End-to-end smoke + cleanup

- [ ] **Step 1: Run full type check**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: all unit/route tests pass. (Pre-existing 67 SDK integration failures unrelated to this work — confirm count is unchanged, not increased.)

- [ ] **Step 3: Manual UI smoke**

Run: `bun run local`
In another shell, open `http://localhost:<port>/dashboard`, create two keys under the same user, set a literal LangSearch key on one, click "Borrow from…" on the other, pick the source, save. Reload — the borrower should show `↗ <source name>` and no literal value should be visible.

- [ ] **Step 4: Final commit if any cleanup needed**

```bash
git add -A
git status
# If there are any unintended changes, review them now.
git commit -m "chore(web-search): tidy after borrow-ref implementation" || true
```

---

## Self-review

**Spec coverage check:**
- Migration & schema → Tasks 1-3 ✓
- `resolveWebSearchKeys` + visibility re-check → Tasks 4-5 ✓
- 5-min per-borrower TTL cache + `invalidateResolverCache` on PATCH/copy-from → Tasks 4, 5, 9, 10 ✓
- All four routes wired (chat-completions/responses/gemini via `loadWebSearchConfig`, messages.ts inline) → Tasks 6-7 ✓
- snake_case API surface (GET descriptors + PATCH XOR) → Tasks 8-9 ✓
- copy-from sets refs, preserves flags → Task 10 ✓
- Tests (unit + route + integration) → Tasks 5, 11, 14 ✓
- Dashboard UI (state, chips, picker, i18n) → Tasks 12-13 ✓
- Broken-ref descriptor in GET → Task 8 step 1-2 ✓

**Placeholder scan:** No "TBD", no "implement later", every code step has actual code. The two notes that say "adapt to actual variable names" (Tasks 5, 12) include the grep command to discover the names — acceptable because the dashboard file is large and field naming is convention-driven.

**Type consistency:** `webSearchLangsearchRef` / `webSearchTavilyRef` / `webSearchMsGroundingRef` used identically across types.ts, sqlite.ts, d1.ts, resolver.ts, api-keys.ts. PATCH wire fields `web_search_*_ref` consistent in routes + tests. `RefDescriptor` shape consistent between `keyToJson` and the GET test assertions.
