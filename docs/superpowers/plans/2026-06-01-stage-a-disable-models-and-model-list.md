# Stage A — Disable Models Per Upstream + Generic Model-List Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring this repo to parity with copilot-gateway commits `b7fff06` (disable individual models per upstream) and the non-Azure half of `1722166` (shared model-list shape across custom/copilot upstreams), so admins can blacklist specific public model ids per upstream and the dashboard exposes a single editor for that list.

**Architecture:**
- Add a top-level `disabledPublicModelIds: string[]` field on every `UpstreamRecord`, persisted as a new column `disabled_public_model_ids TEXT NOT NULL DEFAULT '[]'` (migration 0028, mirrored in `src/repo/sqlite.ts`).
- Filter the disabled set inside `listProviderBindings` in `src/providers/registry.ts` so disabled ids vanish from every `/v1/models`, every routing decision, and every binding consumer — orthogonal to per-model metadata.
- Plumb the field through normalize / save / serialize in `src/routes/control-plane.ts`, and expose a multi-id editor in the existing `UpstreamFormModal.tsx`.

**Tech Stack:** Bun + Elysia (backend), bun:sqlite (local) / Cloudflare D1 (prod), React 19 functional components + Tailwind (dashboard).

---

## File Structure

### New
- `migrations/0028_upstream_disabled_models.sql` — adds the `disabled_public_model_ids` column to `upstreams`.

### Modified (backend)
- `src/repo/types.ts` — add `disabledPublicModelIds: string[]` to `UpstreamRecord`.
- `src/repo/shared/repos.ts` — extend `UPSTREAM_COLS`, `toUpstreamRecord`, `save`.
- `src/repo/sqlite.ts` — extend the inline `CREATE TABLE upstreams` + `INSERT OR IGNORE` legacy backfill.
- `src/providers/registry.ts` — drop disabled model ids inside `listProviderBindings`; the dashboard catalog stays unfiltered.
- `src/routes/control-plane.ts` — accept and serialize `disabledPublicModelIds` on POST + PATCH; new endpoint `GET /api/upstreams/:id/models` for dashboard catalog (returns the full live list, including disabled ids).

### Modified (dashboard)
- `src/ui/dashboard-app/api/types.ts` — add `disabledPublicModelIds: string[]` to `UpstreamRecord`.
- `src/ui/dashboard-app/api/upstreams.ts` — extend `UpstreamPatch`; add `getUpstreamCatalog(id)` helper.
- `src/ui/dashboard-app/tabs/upstreams/UpstreamFormModal.tsx` — render and edit the disabled set via a `<select multiple>` (model ids fetched from the new catalog endpoint when editing; free-form add input for ids not in the live list).

### Tests (new / extended)
- `tests/repo-upstream-disabled-models.test.ts` — round-trip `disabledPublicModelIds` through `SqliteRepo`.
- `tests/registry-disabled-models.test.ts` — `listProviderBindings` drops disabled ids; the dashboard catalog path retains them.
- `tests/control-plane.test.ts` — extend with normalize / serialize cases and a `GET /api/upstreams/:id/models` case.

---

## Task 1: D1 Migration + SQLite Bootstrap

**Files:**
- Create: `migrations/0028_upstream_disabled_models.sql`
- Modify: `src/repo/sqlite.ts` (inline schema)

- [ ] **Step 1: Write the migration file**

Create `migrations/0028_upstream_disabled_models.sql`:

```sql
-- Per-upstream blacklist of public model ids. Filtered out of
-- listProviderBindings so disabled ids disappear from /v1/models and from
-- any routing decision, while the dashboard catalog endpoint (which bypasses
-- the registry) keeps showing them so admins can toggle them back on.
ALTER TABLE upstreams ADD COLUMN disabled_public_model_ids TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 2: Mirror the column in the SQLite bootstrap schema**

Edit `src/repo/sqlite.ts`. Find the `CREATE TABLE IF NOT EXISTS upstreams` block (around line 37 and again around line 242) and add the column. Example for the second one:

```ts
    CREATE TABLE IF NOT EXISTS upstreams (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      flag_overrides TEXT NOT NULL DEFAULT '{}',
      disabled_public_model_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

Apply the same change to the first `CREATE TABLE upstreams` near line 37. Do NOT change the `INSERT OR IGNORE … FROM github_accounts` block — the default `'[]'` is what we want for legacy rows.

- [ ] **Step 3: Add an ALTER TABLE upgrade path for existing local DBs**

In `src/repo/sqlite.ts`, find where prior column upgrades live (search for `ALTER TABLE upstreams`). If there's an existing batch of `try { ALTER TABLE ... } catch {}` blocks for upstreams, add:

```ts
    try { this.db.run("ALTER TABLE upstreams ADD COLUMN disabled_public_model_ids TEXT NOT NULL DEFAULT '[]'") } catch {}
```

If no such block exists yet, place this directly after the inline `CREATE TABLE upstreams` (the second one, near line 242) so a previously-created local DB picks up the new column on next boot.

- [ ] **Step 4: Sanity-check migration ordering**

Run:

```bash
ls migrations/ | sort | tail -3
```

Expected (must end with the new file):

```
0026_unified_upstreams.sql
0027_rewrite_legacy_upstream_ids.sql
0028_upstream_disabled_models.sql
```

- [ ] **Step 5: Commit**

```bash
git add migrations/0028_upstream_disabled_models.sql src/repo/sqlite.ts
git commit -m "feat(upstreams): add disabled_public_model_ids column"
```

---

## Task 2: Repo Layer — Type + Serialization

**Files:**
- Modify: `src/repo/types.ts:46-57`
- Modify: `src/repo/shared/repos.ts:43, 136-149, 391-408`
- Test: `tests/repo-upstream-disabled-models.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/repo-upstream-disabled-models.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import type { UpstreamRecord } from "~/repo"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
})

afterEach(() => {
  setRepoForTest(null)
  db.close()
})

test("save + list round-trips disabledPublicModelIds", async () => {
  const now = new Date().toISOString()
  const upstream: UpstreamRecord = {
    id: "up_custom_x_aaaaaaaa",
    ownerId: "",
    provider: "custom",
    name: "x",
    enabled: true,
    sortOrder: 0,
    config: { name: "x", baseUrl: "https://x", apiKey: "k" },
    flagOverrides: {},
    disabledPublicModelIds: ["gpt-3.5-turbo", "text-embedding-ada-002"],
    createdAt: now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(upstream)
  const [round] = await getRepo().upstreams.list({})
  expect(round.disabledPublicModelIds).toEqual(["gpt-3.5-turbo", "text-embedding-ada-002"])
})

test("legacy rows default to empty disabledPublicModelIds", async () => {
  // Simulate a row written before this migration by inserting directly.
  const now = new Date().toISOString()
  db.run(
    "INSERT INTO upstreams (id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["up_legacy_a", "", "custom", "legacy", 1, 0, "{}", "{}", now, now],
  )
  const [round] = await getRepo().upstreams.list({})
  expect(round.disabledPublicModelIds).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/repo-upstream-disabled-models.test.ts
```

Expected: FAIL — type error or `disabledPublicModelIds` is `undefined`.

- [ ] **Step 3: Add the field to UpstreamRecord**

Edit `src/repo/types.ts`. Update the `UpstreamRecord` interface (around line 46):

```ts
export interface UpstreamRecord {
  id: string
  ownerId?: string
  provider: UpstreamKind
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown>
  flagOverrides: Record<string, boolean>
  /** Public model ids hidden from /v1/models and from routing. Empty by default. */
  disabledPublicModelIds: string[]
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 4: Extend the shared repo SQL columns and row mapping**

Edit `src/repo/shared/repos.ts`.

Replace the `UPSTREAM_COLS` constant (line 43):

```ts
const UPSTREAM_COLS = "id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, created_at, updated_at"
```

Add a helper near `parseObject` / `parseBooleanRecord` (search the same file for those):

```ts
function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of v) {
      if (typeof item !== "string") continue
      const trimmed = item.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  } catch {
    return []
  }
}
```

Update `toUpstreamRecord` (line 136):

```ts
function toUpstreamRecord(row: any): UpstreamRecord {
  return {
    id: row.id,
    ownerId: row.owner_id || undefined,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order ?? 0,
    config: parseObject(row.config_json),
    flagOverrides: parseBooleanRecord(row.flag_overrides),
    disabledPublicModelIds: parseStringArray(row.disabled_public_model_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
```

Update `save` (line 391) — the SQL placeholders now have one more column (11 total):

```ts
  async save(upstream: UpstreamRecord): Promise<void> {
    await this.x.run(
      `INSERT INTO upstreams (${UPSTREAM_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, provider = excluded.provider, name = excluded.name, enabled = excluded.enabled, sort_order = excluded.sort_order, config_json = excluded.config_json, flag_overrides = excluded.flag_overrides, disabled_public_model_ids = excluded.disabled_public_model_ids, updated_at = excluded.updated_at`,
      [
        upstream.id,
        upstream.ownerId ?? "",
        upstream.provider,
        upstream.name,
        upstream.enabled ? 1 : 0,
        upstream.sortOrder,
        JSON.stringify(upstream.config ?? {}),
        JSON.stringify(upstream.flagOverrides ?? {}),
        JSON.stringify(upstream.disabledPublicModelIds ?? []),
        upstream.createdAt,
        upstream.updatedAt,
      ],
    )
  }
```

- [ ] **Step 5: Fix every UpstreamRecord literal that now lacks the new field**

Grep and patch:

```bash
grep -rn "UpstreamRecord = {" src/ tests/
```

For each match, add `disabledPublicModelIds: []` in the same column position as in the type. Expected locations (verify each by reading the surrounding code):
- `src/routes/control-plane.ts` (the POST handler around line 301 and the PATCH handler around line 352)
- Any test fixture that constructs an `UpstreamRecord` directly.

- [ ] **Step 6: Run the test to verify it passes**

```bash
bun test tests/repo-upstream-disabled-models.test.ts
```

Expected: PASS (both cases).

- [ ] **Step 7: Run the full test suite — nothing should regress**

```bash
bun test
```

Expected: existing tests still pass (in particular `tests/control-plane.test.ts`). If a test that constructs `UpstreamRecord` fails with a missing-field complaint, fix it in place per Step 5.

- [ ] **Step 8: Commit**

```bash
git add src/repo/types.ts src/repo/shared/repos.ts src/routes/control-plane.ts tests/repo-upstream-disabled-models.test.ts
git commit -m "feat(repo): persist disabledPublicModelIds on UpstreamRecord"
```

---

## Task 3: Registry Filtering

**Files:**
- Modify: `src/providers/registry.ts:129-183`
- Test: `tests/registry-disabled-models.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/registry-disabled-models.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { listProviderBindings, invalidateUpstreamListCache } from "~/providers/registry"
import type { UpstreamRecord } from "~/repo"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
  invalidateUpstreamListCache()
})

afterEach(() => {
  setRepoForTest(null)
  invalidateUpstreamListCache()
  db.close()
})

test("listProviderBindings hides disabled public model ids", async () => {
  const now = new Date().toISOString()
  const upstream: UpstreamRecord = {
    id: "up_custom_test_aaaaaaaa",
    ownerId: "",
    provider: "custom",
    name: "test",
    enabled: true,
    sortOrder: 0,
    config: {
      name: "test",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      // Manual model list short-circuits the live /models fetch.
      models: ["gpt-4o-mini", "gpt-3.5-turbo", "text-embedding-ada-002"],
    },
    flagOverrides: {},
    disabledPublicModelIds: ["gpt-3.5-turbo", "text-embedding-ada-002"],
    createdAt: now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(upstream)

  const bindings = await listProviderBindings()
  const ids = bindings.map((b) => b.model.id)
  expect(ids).toEqual(["gpt-4o-mini"])
})

test("listProviderBindings is unaffected when disabled list is empty", async () => {
  const now = new Date().toISOString()
  const upstream: UpstreamRecord = {
    id: "up_custom_full_aaaaaaaa",
    ownerId: "",
    provider: "custom",
    name: "full",
    enabled: true,
    sortOrder: 0,
    config: {
      name: "full",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      models: ["a", "b", "c"],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(upstream)

  const bindings = await listProviderBindings()
  const ids = bindings.map((b) => b.model.id).sort()
  expect(ids).toEqual(["a", "b", "c"])
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/registry-disabled-models.test.ts
```

Expected: FAIL — the first test sees all three ids because the filter doesn't exist yet.

- [ ] **Step 3: Add the filter in listProviderBindings**

Edit `src/providers/registry.ts`. Inside `listProviderBindings`, replace the inner per-model loop (around lines 146-156) with:

```ts
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      const disabled = new Set(upstream.disabledPublicModelIds)
      for (const model of models.data ?? []) {
        if (disabled.has(model.id)) continue
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model),
          upstreamEndpoints: endpoints,
          enabledFlags,
          provider,
        })
      }
```

The fallback branch (lines 162-180, where `opts.copilot` is consumed without an upstream record) intentionally has no disabled set — that path runs only when zero copilot upstreams exist, so a disabled list cannot apply to it.

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/registry-disabled-models.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/registry.ts tests/registry-disabled-models.test.ts
git commit -m "feat(upstreams): filter disabled public model ids in listProviderBindings"
```

---

## Task 4: Control-Plane Normalize + Serialize

**Files:**
- Modify: `src/routes/control-plane.ts:36-44, 81-92, 209-211, 293-369`
- Test: `tests/control-plane.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test (extension to control-plane.test.ts)**

Append to `tests/control-plane.test.ts`:

```ts
describe("disabledPublicModelIds normalization", () => {
  test("POST stores disabledPublicModelIds as deduped trimmed array", async () => {
    const res = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "deepseek",
        config: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" },
        disabledPublicModelIds: [" gpt-3.5-turbo ", "gpt-3.5-turbo", "", "ada-002"],
      },
    }))
    expect(res.status).toBe(201)
    const body = await res.json() as { upstream: { disabledPublicModelIds: string[] } }
    expect(body.upstream.disabledPublicModelIds).toEqual(["gpt-3.5-turbo", "ada-002"])
  })

  test("POST rejects non-array disabledPublicModelIds with 400", async () => {
    const res = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "x",
        config: { name: "x", baseUrl: "https://x", apiKey: "k" },
        disabledPublicModelIds: "gpt-3.5-turbo",
      },
    }))
    expect(res.status).toBe(400)
  })

  test("PATCH updates only the disabled set without touching config", async () => {
    const create = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "ds2",
        config: { name: "ds2", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" },
      },
    }))
    const { upstream } = await create.json() as { upstream: { id: string } }

    const patch = await app.handle(req(`/api/upstreams/${encodeURIComponent(upstream.id)}`, {
      admin: true, method: "PATCH",
      body: { disabledPublicModelIds: ["gpt-3.5-turbo"] },
    }))
    expect(patch.status).toBe(200)
    const body = await patch.json() as { upstream: { disabledPublicModelIds: string[] } }
    expect(body.upstream.disabledPublicModelIds).toEqual(["gpt-3.5-turbo"])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/control-plane.test.ts
```

Expected: FAIL — all three new cases.

- [ ] **Step 3: Add a normalizer**

Edit `src/routes/control-plane.ts`. Add this helper near `normalizeFlagOverrides` (line 81):

```ts
function normalizeDisabledPublicModelIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("disabledPublicModelIds must be an array of strings")
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") throw new Error("disabledPublicModelIds entries must be strings")
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}
```

- [ ] **Step 4: Extend the request body interface**

In the same file, update the `UpstreamBody` interface (line 36):

```ts
interface UpstreamBody {
  ownerId?: string
  provider?: string
  name?: string
  enabled?: boolean
  sortOrder?: number
  config?: Record<string, unknown>
  flagOverrides?: Record<string, unknown>
  disabledPublicModelIds?: unknown
}
```

- [ ] **Step 5: Plumb through POST and PATCH**

In the POST handler (around line 301) update the constructed record:

```ts
      const upstream: UpstreamRecord = {
        id: upstreamId(provider, body.name),
        ownerId: body.ownerId,
        provider,
        name: body.name.trim(),
        enabled: body.enabled !== false,
        sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 0,
        config: normalizeConfig(provider, body.config),
        flagOverrides: normalizeFlagOverrides(body.flagOverrides),
        disabledPublicModelIds: normalizeDisabledPublicModelIds(body.disabledPublicModelIds),
        createdAt: now,
        updatedAt: now,
      }
```

In the PATCH handler (around line 323), find where the `next: UpstreamRecord` literal is built and add:

```ts
        disabledPublicModelIds:
          body.disabledPublicModelIds === undefined
            ? existing.disabledPublicModelIds
            : normalizeDisabledPublicModelIds(body.disabledPublicModelIds),
```

(Place it in the same position as in the `UpstreamRecord` shape so the file stays diff-friendly.)

- [ ] **Step 6: Verify serializeUpstream needs no change**

Read `serializeUpstream` (line 209). Because it does `{ ...upstream, config: ... }`, the new field flows through automatically. No edit needed.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
bun test tests/control-plane.test.ts
```

Expected: PASS (the three new cases + every existing case still green).

- [ ] **Step 8: Commit**

```bash
git add src/routes/control-plane.ts tests/control-plane.test.ts
git commit -m "feat(control-plane): accept disabledPublicModelIds on POST/PATCH"
```

---

## Task 5: Dashboard Catalog Endpoint (`GET /api/upstreams/:id/models`)

**Files:**
- Modify: `src/routes/control-plane.ts` (append a new route in the chain)
- Test: `tests/control-plane.test.ts` (extend)

The dashboard needs the full live model list (including ids the admin currently has disabled) so the disable toggles can be rendered. The existing `/api/models` route applies the filter, so we need a separate path.

- [ ] **Step 1: Write the failing test**

Append to `tests/control-plane.test.ts`:

```ts
describe("GET /api/upstreams/:id/models", () => {
  test("returns the full upstream catalog regardless of disabled list", async () => {
    const create = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "catalog",
        config: {
          name: "catalog",
          baseUrl: "https://catalog.invalid",
          apiKey: "k",
          models: ["a", "b", "c"],
        },
        disabledPublicModelIds: ["a"],
      },
    }))
    const { upstream } = await create.json() as { upstream: { id: string } }

    const res = await app.handle(req(`/api/upstreams/${encodeURIComponent(upstream.id)}/models`, { admin: true }))
    expect(res.status).toBe(200)
    const body = await res.json() as { models: Array<{ id: string }>; disabledPublicModelIds: string[] }
    expect(body.models.map((m) => m.id).sort()).toEqual(["a", "b", "c"])
    expect(body.disabledPublicModelIds).toEqual(["a"])
  })

  test("returns 404 for an unknown upstream id", async () => {
    const res = await app.handle(req("/api/upstreams/up_nope/models", { admin: true }))
    expect(res.status).toBe(404)
  })

  test("requires admin", async () => {
    const res = await app.handle(req("/api/upstreams/up_x/models"))
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/control-plane.test.ts
```

Expected: FAIL — 404 on a real id (route missing).

- [ ] **Step 3: Implement the route**

In `src/routes/control-plane.ts`, append to the Elysia chain (after the existing `/api/upstreams/:id/test` POST handler, before the chain export ends):

```ts
  .get("/api/upstreams/:id/models", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const upstream = await getRepo().upstreams.getById(ctx.params.id)
    if (!upstream) return jsonError("upstream not found", 404)
    const provider = await createProviderFromUpstream(upstream)
    if (!provider) return jsonError(`unable to construct ${upstream.provider} provider for upstream ${upstream.id}`, 502)
    try {
      const models = await provider.getModels()
      const list = (models.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
      return { models: list, disabledPublicModelIds: upstream.disabledPublicModelIds }
    } catch (err) {
      return jsonError(`failed to list models: ${err instanceof Error ? err.message : String(err)}`, 502)
    }
  })
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/control-plane.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/control-plane.ts tests/control-plane.test.ts
git commit -m "feat(control-plane): expose GET /api/upstreams/:id/models catalog"
```

---

## Task 6: Dashboard — Types + API Client

**Files:**
- Modify: `src/ui/dashboard-app/api/types.ts:15-39`
- Modify: `src/ui/dashboard-app/api/upstreams.ts:22-76`

- [ ] **Step 1: Extend the dashboard UpstreamRecord type**

Edit `src/ui/dashboard-app/api/types.ts`. Update the `UpstreamRecord` interface:

```ts
export interface UpstreamRecord {
  id: string
  ownerId: string
  provider: "copilot" | "azure" | "custom"
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown> & {
    githubToken?: string
    accountType?: string
    user?: { id: number; login: string; name?: string; avatar_url?: string }
    baseUrl?: string
    apiKey?: string
    endpoint?: string
    azureApiKey?: string
    deployment?: string
    apiVersion?: string
    endpoints?: string[]
    models?: string[]
    azureDeployments?: string
  }
  flagOverrides?: Record<string, boolean>
  disabledPublicModelIds: string[]
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 2: Extend the api client**

Edit `src/ui/dashboard-app/api/upstreams.ts`. Update the existing `UpstreamPatch` and `CreateUpstreamBody` and add a catalog fetcher:

```ts
export interface UpstreamPatch {
  name?: string
  enabled?: boolean
  sortOrder?: number
  flagOverrides?: Record<string, boolean>
  disabledPublicModelIds?: string[]
  config?: Record<string, unknown>
}
```

```ts
export interface CreateUpstreamBody {
  provider: "azure" | "custom"
  name: string
  config: Record<string, unknown>
  flagOverrides?: Record<string, boolean>
  disabledPublicModelIds?: string[]
}
```

```ts
export interface UpstreamCatalog {
  models: { id: string; name: string }[]
  disabledPublicModelIds: string[]
}
export function getUpstreamCatalog(id: string): Promise<UpstreamCatalog> {
  return api<UpstreamCatalog>(`/api/upstreams/${encodeURIComponent(id)}/models`)
}
```

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/dashboard-app/api/types.ts src/ui/dashboard-app/api/upstreams.ts
git commit -m "feat(dashboard): expose disabledPublicModelIds in API client"
```

---

## Task 7: Dashboard — Edit Field in `UpstreamFormModal`

**Files:**
- Modify: `src/ui/dashboard-app/tabs/upstreams/UpstreamFormModal.tsx`

Goal: when editing an upstream, fetch its catalog via `getUpstreamCatalog(id)`, render the model ids in a multi-select (`<select multiple>`) sized so the admin can scroll the list, plus a free-form `<input>` to add an id that no longer appears in the live catalog (so an admin can keep a stale entry checked). When creating a new upstream (no id yet), only the free-form input is shown.

- [ ] **Step 1: Add catalog state and effect**

At the top of the component, alongside the existing `form`/`provider` state:

```tsx
import * as api from "../../api/upstreams"
// ...
const [catalog, setCatalog] = useState<{ id: string; name: string }[] | null>(null)
const [catalogError, setCatalogError] = useState<string | null>(null)
const [disabledIds, setDisabledIds] = useState<string[]>(
  mode.kind === "edit" ? [...(mode.row.disabledPublicModelIds ?? [])] : [],
)
const [extraIdInput, setExtraIdInput] = useState("")

useEffect(() => {
  if (mode.kind !== "edit") return
  let cancelled = false
  api.getUpstreamCatalog(mode.row.id).then(
    (c) => { if (!cancelled) setCatalog(c.models) },
    (err) => { if (!cancelled) setCatalogError(err instanceof Error ? err.message : String(err)) },
  )
  return () => { cancelled = true }
}, [mode])
```

- [ ] **Step 2: Render the editor**

Insert this block in the form, immediately before the existing flag-overrides section:

```tsx
<div className="mt-4">
  <label className="block text-sm font-medium mb-1">{t("upstreams.disabled_models")}</label>
  <p className="text-xs text-gray-500 mb-2">{t("upstreams.disabled_models.hint")}</p>
  {mode.kind === "edit" && catalog === null && !catalogError && (
    <p className="text-xs text-gray-400">{t("upstreams.disabled_models.loading")}</p>
  )}
  {catalogError && (
    <p className="text-xs text-red-500">{catalogError}</p>
  )}
  {mode.kind === "edit" && catalog && (
    <select
      multiple
      size={Math.min(8, Math.max(3, catalog.length))}
      className="w-full border rounded p-2"
      value={disabledIds}
      onChange={(e) => {
        const selected = Array.from(e.target.selectedOptions).map((o) => o.value)
        // Union with any stale (not-in-catalog) ids already disabled,
        // so a previously-disabled id stays checked even if it's gone from upstream.
        const ids = new Set(catalog.map((m) => m.id))
        const stale = disabledIds.filter((id) => !ids.has(id))
        setDisabledIds([...new Set([...selected, ...stale])])
      }}
    >
      {catalog.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}{m.name && m.name !== m.id ? ` — ${m.name}` : ""}
        </option>
      ))}
    </select>
  )}
  <div className="mt-2 flex gap-2">
    <input
      type="text"
      className="flex-1 border rounded p-1 text-sm"
      placeholder={t("upstreams.disabled_models.add_placeholder")}
      value={extraIdInput}
      onChange={(e) => setExtraIdInput(e.target.value)}
    />
    <button
      type="button"
      className="px-3 py-1 text-sm border rounded"
      onClick={() => {
        const id = extraIdInput.trim()
        if (!id) return
        if (!disabledIds.includes(id)) setDisabledIds([...disabledIds, id])
        setExtraIdInput("")
      }}
    >
      {t("upstreams.disabled_models.add")}
    </button>
  </div>
  {disabledIds.length > 0 && (
    <ul className="mt-2 flex flex-wrap gap-1">
      {disabledIds.map((id) => (
        <li key={id} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 rounded">
          <span>{id}</span>
          <button
            type="button"
            className="text-gray-500 hover:text-red-500"
            onClick={() => setDisabledIds(disabledIds.filter((x) => x !== id))}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )}
</div>
```

- [ ] **Step 3: Submit the disabled set on save**

Find the existing `onSubmit` (or `onSave`) handler in this file. Locate where it calls `api.createUpstream({ ... })` and `api.patchUpstream(id, { ... })`. Add `disabledPublicModelIds: disabledIds` to each body. Example:

```tsx
await api.createUpstream({
  provider: form.provider as "azure" | "custom",
  name: form.name.trim(),
  config,
  flagOverrides: form.flagOverrides,
  disabledPublicModelIds: disabledIds,
})
```

```tsx
await api.patchUpstream(mode.row.id, {
  name: form.name.trim(),
  config,
  flagOverrides: form.flagOverrides,
  disabledPublicModelIds: disabledIds,
})
```

- [ ] **Step 4: Add i18n strings**

Edit `src/ui/i18n.ts`. Find the existing `upstreams.*` keys and add (use Chinese + English for both sets that file maintains — match the existing pattern):

- `upstreams.disabled_models` — "Disabled models" / "已禁用模型"
- `upstreams.disabled_models.hint` — "Hidden from /v1/models and from routing for this upstream." / "该上游下从 /v1/models 与路由中隐藏的模型。"
- `upstreams.disabled_models.loading` — "Loading catalog…" / "加载模型清单…"
- `upstreams.disabled_models.add_placeholder` — "Add a model id not in the live list" / "添加未出现在实时列表中的模型 id"
- `upstreams.disabled_models.add` — "Add" / "添加"

If you can't tell the pattern from a glance at the file, read the surrounding entries first.

- [ ] **Step 5: Rebuild the dashboard bundle**

The repo has `scripts/build-dashboard.ts` (per the git status preview). Run:

```bash
bun run scripts/build-dashboard.ts
```

Expected: the build script writes to `src/ui/dashboard-app/dist/` without errors.

- [ ] **Step 6: Smoke-test in a browser**

Start the dev server:

```bash
bun --hot src/local.ts
```

Open `http://localhost:4141/dashboard`, sign in, edit an existing custom upstream, confirm:
- the catalog loads
- selecting a model id and saving persists it (reload the modal to verify)
- the model id disappears from the `/models` listing (top right or another tab — find an obvious place to verify, e.g. an Inspector tab if one exists)

If you cannot start the server in your environment, say so explicitly rather than claim success.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard-app/tabs/upstreams/UpstreamFormModal.tsx src/ui/i18n.ts src/ui/dashboard-app/dist/
git commit -m "feat(dashboard): edit disabledPublicModelIds in UpstreamFormModal"
```

---

## Task 8: End-to-End Verification

- [ ] **Step 1: Run the full test suite**

```bash
bun test
```

Expected: every test passes.

- [ ] **Step 2: Apply the migration locally**

```bash
bun run scripts/build-dashboard.ts  # ensure the dashboard bundle is fresh
bun x wrangler d1 migrations apply copilot-db --local
```

Expected: `0028_upstream_disabled_models.sql` reported as `applied`.

- [ ] **Step 3: Verify schema**

```bash
bun x wrangler d1 execute copilot-db --local --command "PRAGMA table_info(upstreams);"
```

Expected: output includes a row with name `disabled_public_model_ids`.

- [ ] **Step 4: Optional remote apply**

Defer to the user. Do NOT run `--remote` migrations without explicit user confirmation in the conversation.

- [ ] **Step 5: Final commit (only if any files changed in step 1-3)**

```bash
git status
git diff
```

If clean, no commit needed.

---

## Self-Review Checklist

- [x] Spec coverage: disable model per upstream (`b7fff06`) → Tasks 1-4, 6-7; dashboard fetch path (`1722166` non-Azure half) → Task 5 + 7. Azure deployment-rename and shared `UpstreamModelConfig` are intentionally out of scope (no Azure upstreams in this repo's prod usage).
- [x] No placeholders: every step has either code or an exact command.
- [x] Type consistency: `disabledPublicModelIds: string[]` is used identically across `UpstreamRecord` (backend), `UpstreamRecord` (dashboard), `UpstreamPatch`, `CreateUpstreamBody`, `UpstreamCatalog`, and the normalizer's return type. Column name `disabled_public_model_ids` matches between migration, sqlite bootstrap, `UPSTREAM_COLS`, and `toUpstreamRecord`.
- [x] Each task ends in `git commit`.
- [x] TDD pattern: write failing test → run → implement → run → commit, on every task that produces backend code.
