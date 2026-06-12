# P1 Plan 1: responses-store package

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone `@vnext/responses-store` package: snapshot interface, in-memory + SQL implementations (D1 / bun:sqlite via the existing `SqlExecutor` abstraction), migration, owner-isolated reads, opportunistic GC, full test coverage. Zero coupling to gateway code.

**Architecture:** New workspace package mirroring the layout of `@vnext/translate`. Reuses the existing `SqlExecutor` interface from `apps/gateway/src/shared/repo/shared/executor.ts` so the same SQL implementation runs against D1 (CFW) and bun:sqlite (local/test). Migration file lives next to existing migrations under `/migrations/0030_responses_snapshots.sql`. The package itself ships only the SQL impl + an in-memory impl; consumers wire the executor in.

**Tech Stack:** TypeScript, Bun test runner, SQLite (bun:sqlite local + D1 prod), workspace package.

---

## File Structure

- Create: `vnext/packages/responses-store/package.json`
- Create: `vnext/packages/responses-store/tsconfig.json`
- Create: `vnext/packages/responses-store/src/index.ts` (re-exports)
- Create: `vnext/packages/responses-store/src/types.ts` (interface + Snapshot type + constants)
- Create: `vnext/packages/responses-store/src/in-memory.ts` (test/dev impl)
- Create: `vnext/packages/responses-store/src/sql.ts` (D1/bun:sqlite impl via SqlExecutor)
- Create: `vnext/packages/responses-store/src/__tests__/contract.ts` (shared test contract; both impls run it)
- Create: `vnext/packages/responses-store/src/__tests__/in-memory.test.ts`
- Create: `vnext/packages/responses-store/src/__tests__/sql.test.ts`
- Create: `migrations/0030_responses_snapshots.sql` (project root migrations dir)
- Modify: `vnext/package.json` (no — workspaces glob already covers `packages/*`)

The shared `SqlExecutor` lives at `vnext/apps/gateway/src/shared/repo/shared/executor.ts`. The new package re-declares the same minimal interface internally to avoid taking a dependency on `@vnext/gateway`. (`SqlExecutor` is a 3-method shape; duplicating the type is cheaper than the dependency edge.)

---

## Task 1: Scaffold package skeleton

**Files:**
- Create: `vnext/packages/responses-store/package.json`
- Create: `vnext/packages/responses-store/tsconfig.json`
- Create: `vnext/packages/responses-store/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@vnext/responses-store",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Create tsconfig.json (mirror translate package)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

Verify by running `cat vnext/packages/translate/tsconfig.json` first; copy its options exactly so build/lint behavior matches the rest of the workspace.

- [ ] **Step 3: Create src/index.ts (placeholder, fills in later tasks)**

```ts
export type { ResponsesSnapshot, ResponsesSnapshotStore, SqlExecutor } from './types.ts'
export { DEFAULT_TTL_MS, GC_BATCH_LIMIT } from './types.ts'
export { InMemoryResponsesSnapshotStore } from './in-memory.ts'
export { SqliteResponsesSnapshotStore } from './sql.ts'
```

- [ ] **Step 4: Verify Bun resolves the workspace**

Run: `cd vnext && bun install`
Expected: no errors. `node_modules/@vnext/responses-store` is symlinked.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/responses-store/
git commit -m "feat(responses-store): scaffold package skeleton"
```

---

## Task 2: Define types and constants

**Files:**
- Create: `vnext/packages/responses-store/src/types.ts`

- [ ] **Step 1: Write the type module**

```ts
/**
 * Public types for @vnext/responses-store.
 *
 * A "snapshot" is the merged input + output items array from one /v1/responses
 * turn. The next turn — when the client sends previous_response_id — the
 * gateway loads this snapshot, prepends its `items` to the new request's
 * input, and deletes previous_response_id before forwarding upstream.
 */

/** Default snapshot TTL: 24 hours. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** Opportunistic GC: how many expired rows to delete per save call. */
export const GC_BATCH_LIMIT = 100

export interface ResponsesSnapshot {
  responseId: string
  /** Owner isolation key. null = anonymous; null callers can only read null rows. */
  apiKeyId: string | null
  model: string
  /** Full Responses-protocol items array (input + output for the turn). */
  items: unknown[]
  /** ms since epoch. */
  createdAt: number
  /** ms since epoch. After this time, load() must return null and GC may delete. */
  expiresAt: number
}

export interface ResponsesSnapshotStore {
  /** Returns the snapshot iff response_id matches AND owner matches (null-safe). */
  load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null>
  /** Inserts (or replaces) the snapshot. Implementations may also run opportunistic GC. */
  save(snap: ResponsesSnapshot): Promise<void>
}

/**
 * Minimal SQL adapter; mirrors apps/gateway/src/shared/repo/shared/executor.ts.
 * Duplicated here so the package has no dependency on @vnext/gateway.
 */
export interface SqlExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all<T = any>(sql: string, binds: unknown[]): Promise<T[]>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  first<T = any>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
}
```

- [ ] **Step 2: Typecheck**

Run: `cd vnext/packages/responses-store && bun run typecheck`
Expected: clean (no diagnostics).

- [ ] **Step 3: Commit**

```bash
git add vnext/packages/responses-store/src/types.ts
git commit -m "feat(responses-store): define snapshot type, store interface, SqlExecutor shim"
```

---

## Task 3: Shared test contract

The same behavioral contract runs against in-memory and SQL implementations. Writing it once, parameterized, keeps the two impls behaviorally identical.

**Files:**
- Create: `vnext/packages/responses-store/src/__tests__/contract.ts`

- [ ] **Step 1: Write the contract**

```ts
/**
 * Shared behavioral contract for ResponsesSnapshotStore implementations.
 *
 * Each implementation passes a factory that returns a fresh empty store and
 * a "now" controller (so tests can advance time deterministically without
 * Bun fake timers, which don't compose with Bun's test runner well).
 *
 * Implementations differ in *how* they store rows; behaviorally they MUST
 * be indistinguishable to the gateway.
 */
import { test, expect } from 'bun:test'
import type { ResponsesSnapshotStore, ResponsesSnapshot } from '../types.ts'

export interface StoreFactory {
  /** Returns a fresh store + a setter that controls `now()` for that store. */
  make(): Promise<{ store: ResponsesSnapshotStore; setNow: (ms: number) => void }>
  /** Human-readable label used in test names. */
  label: string
}

export function runStoreContract(factory: StoreFactory): void {
  const make = (): ResponsesSnapshot => ({
    responseId: 'resp_1',
    apiKeyId: 'key_a',
    model: 'gpt-5',
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    createdAt: 1_000,
    expiresAt: 1_000 + 60_000,
  })

  test(`[${factory.label}] save then load returns the snapshot`, async () => {
    const { store } = await factory.make()
    await store.save(make())
    const got = await store.load('resp_1', 'key_a')
    expect(got).not.toBeNull()
    expect(got!.responseId).toBe('resp_1')
    expect(got!.model).toBe('gpt-5')
    expect(got!.items).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })

  test(`[${factory.label}] load returns null when response_id is unknown`, async () => {
    const { store } = await factory.make()
    const got = await store.load('resp_does_not_exist', 'key_a')
    expect(got).toBeNull()
  })

  test(`[${factory.label}] load returns null when api_key_id mismatches (cross-owner isolation)`, async () => {
    const { store } = await factory.make()
    await store.save(make()) // saved under key_a
    const got = await store.load('resp_1', 'key_b')
    expect(got).toBeNull()
  })

  test(`[${factory.label}] null apiKeyId only matches null apiKeyId`, async () => {
    const { store } = await factory.make()
    await store.save({ ...make(), responseId: 'resp_anon', apiKeyId: null })
    const anonHit = await store.load('resp_anon', null)
    expect(anonHit).not.toBeNull()
    const namedMiss = await store.load('resp_anon', 'key_a')
    expect(namedMiss).toBeNull()
  })

  test(`[${factory.label}] expired snapshot returns null on load`, async () => {
    const { store, setNow } = await factory.make()
    setNow(1_000)
    await store.save(make()) // expiresAt = 61_000
    setNow(70_000)
    const got = await store.load('resp_1', 'key_a')
    expect(got).toBeNull()
  })

  test(`[${factory.label}] save replaces an existing row with same response_id`, async () => {
    const { store } = await factory.make()
    await store.save(make())
    await store.save({ ...make(), model: 'gpt-5-upgraded' })
    const got = await store.load('resp_1', 'key_a')
    expect(got!.model).toBe('gpt-5-upgraded')
  })

  test(`[${factory.label}] save runs opportunistic GC of expired rows`, async () => {
    const { store, setNow } = await factory.make()
    setNow(1_000)
    // Insert two rows that will be expired by t=70_000.
    await store.save({ ...make(), responseId: 'expired_1' })
    await store.save({ ...make(), responseId: 'expired_2' })
    setNow(70_000)
    // Saving a fresh one should also evict the two expired siblings.
    await store.save({ ...make(), responseId: 'fresh', createdAt: 70_000, expiresAt: 130_000 })
    setNow(70_000) // still after expiry — load() returns null on its own;
                   // GC effect is observable only at the storage layer.
                   // We assert via load() which combines both: must be null.
    expect(await store.load('expired_1', 'key_a')).toBeNull()
    expect(await store.load('expired_2', 'key_a')).toBeNull()
    expect(await store.load('fresh', 'key_a')).not.toBeNull()
  })

  test(`[${factory.label}] items round-trip preserves nested arrays and objects`, async () => {
    const { store } = await factory.make()
    const nested = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
      { type: 'function_call', name: 'tool', arguments: '{"k":1}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ]
    await store.save({ ...make(), items: nested })
    const got = await store.load('resp_1', 'key_a')
    expect(got!.items).toEqual(nested)
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `cd vnext/packages/responses-store && bun run typecheck`
Expected: clean — no exports yet referenced by tests, but the file imports only its own `../types.ts`.

- [ ] **Step 3: Commit**

```bash
git add vnext/packages/responses-store/src/__tests__/contract.ts
git commit -m "test(responses-store): shared contract tests for snapshot store"
```

---

## Task 4: InMemoryResponsesSnapshotStore (TDD via contract)

**Files:**
- Create: `vnext/packages/responses-store/src/in-memory.ts`
- Create: `vnext/packages/responses-store/src/__tests__/in-memory.test.ts`

- [ ] **Step 1: Wire the contract test (will fail — no impl yet)**

`vnext/packages/responses-store/src/__tests__/in-memory.test.ts`:

```ts
import { runStoreContract } from './contract.ts'
import { InMemoryResponsesSnapshotStore } from '../in-memory.ts'

runStoreContract({
  label: 'in-memory',
  async make() {
    let nowMs = 0
    const store = new InMemoryResponsesSnapshotStore({ now: () => nowMs })
    return { store, setNow: (ms) => { nowMs = ms } }
  },
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd vnext/packages/responses-store && bun test src/__tests__/in-memory.test.ts`
Expected: FAIL — `Cannot find module '../in-memory.ts'`.

- [ ] **Step 3: Implement InMemoryResponsesSnapshotStore**

`vnext/packages/responses-store/src/in-memory.ts`:

```ts
/**
 * In-memory ResponsesSnapshotStore — for tests and local dev with no DB.
 *
 * Owner isolation is enforced inside load(); cross-owner reads return null.
 * `save` runs opportunistic GC by walking the map and dropping expired rows.
 */
import type { ResponsesSnapshot, ResponsesSnapshotStore } from './types.ts'
import { GC_BATCH_LIMIT } from './types.ts'

export interface InMemoryStoreOptions {
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

export class InMemoryResponsesSnapshotStore implements ResponsesSnapshotStore {
  private readonly rows = new Map<string, ResponsesSnapshot>()
  private readonly now: () => number

  constructor(opts: InMemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  async load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null> {
    const row = this.rows.get(responseId)
    if (!row) return null
    if (row.apiKeyId !== apiKeyId) return null
    if (row.expiresAt <= this.now()) return null
    return row
  }

  async save(snap: ResponsesSnapshot): Promise<void> {
    this.rows.set(snap.responseId, snap)
    this.gc()
  }

  private gc(): void {
    const cutoff = this.now()
    let evicted = 0
    for (const [id, row] of this.rows) {
      if (evicted >= GC_BATCH_LIMIT) break
      if (row.expiresAt <= cutoff) {
        this.rows.delete(id)
        evicted++
      }
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd vnext/packages/responses-store && bun test src/__tests__/in-memory.test.ts`
Expected: all 8 contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/responses-store/src/in-memory.ts vnext/packages/responses-store/src/__tests__/in-memory.test.ts
git commit -m "feat(responses-store): InMemoryResponsesSnapshotStore + contract pass"
```

---

## Task 5: SQL migration

**Files:**
- Create: `migrations/0030_responses_snapshots.sql` (project root, alongside existing migrations)

The project root `migrations/` dir holds D1 migrations applied via `wrangler d1 migrations apply`. Local `bun:sqlite` initializes its schema in code (see `vnext/apps/gateway/src/shared/repo/sqlite.ts` `INIT_SQL`). The new table needs entries in *both*; this task adds the D1 migration file. Local `INIT_SQL` is updated in Task 6 alongside the SQL impl.

- [ ] **Step 1: Inspect adjacent migration for style**

Run: `cat migrations/0029_responses_items.sql`
Expected: short SQL with `CREATE TABLE IF NOT EXISTS` and a `CREATE INDEX IF NOT EXISTS`. Match this style.

- [ ] **Step 2: Write the migration**

`migrations/0030_responses_snapshots.sql`:

```sql
-- Per-turn snapshot of /v1/responses input+output items, keyed by the
-- response.id we returned. The next turn — when the client sends
-- previous_response_id — the gateway loads this row, prepends `items_json`
-- to the new request's input, and strips previous_response_id before
-- forwarding upstream. Owner isolation is enforced via api_key_id (nullable
-- for anonymous keys; null only matches null at read time).
CREATE TABLE IF NOT EXISTS responses_snapshots (
  response_id TEXT PRIMARY KEY,
  api_key_id  TEXT,
  model       TEXT NOT NULL,
  items_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_responses_snapshots_expires
  ON responses_snapshots (expires_at);

CREATE INDEX IF NOT EXISTS idx_responses_snapshots_owner
  ON responses_snapshots (api_key_id, response_id);
```

- [ ] **Step 3: Commit**

```bash
git add migrations/0030_responses_snapshots.sql
git commit -m "feat(migrations): 0030 responses_snapshots table"
```

---

## Task 6: SqliteResponsesSnapshotStore (TDD via contract)

**Files:**
- Create: `vnext/packages/responses-store/src/sql.ts`
- Create: `vnext/packages/responses-store/src/__tests__/sql.test.ts`

- [ ] **Step 1: Wire the contract test against bun:sqlite**

`vnext/packages/responses-store/src/__tests__/sql.test.ts`:

```ts
import { Database } from 'bun:sqlite'
import { runStoreContract } from './contract.ts'
import { SqliteResponsesSnapshotStore } from '../sql.ts'
import type { SqlExecutor } from '../types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS responses_snapshots (
  response_id TEXT PRIMARY KEY,
  api_key_id  TEXT,
  model       TEXT NOT NULL,
  items_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_snapshots_expires
  ON responses_snapshots (expires_at);
CREATE INDEX IF NOT EXISTS idx_responses_snapshots_owner
  ON responses_snapshots (api_key_id, response_id);
`

function makeExecutor(db: Database): SqlExecutor {
  return {
    async all(sql, binds) {
      return db.query(sql).all(...(binds as never[])) as never[]
    },
    async first(sql, binds) {
      const row = db.query(sql).get(...(binds as never[]))
      return (row ?? null) as never
    },
    async run(sql, binds) {
      const info = db.query(sql).run(...(binds as never[]))
      return { changes: Number(info.changes ?? 0) }
    },
  }
}

runStoreContract({
  label: 'sql/bun-sqlite',
  async make() {
    const db = new Database(':memory:')
    db.exec(SCHEMA)
    let nowMs = 0
    const store = new SqliteResponsesSnapshotStore(makeExecutor(db), { now: () => nowMs })
    return { store, setNow: (ms) => { nowMs = ms } }
  },
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd vnext/packages/responses-store && bun test src/__tests__/sql.test.ts`
Expected: FAIL — `Cannot find module '../sql.ts'`.

- [ ] **Step 3: Implement SqliteResponsesSnapshotStore**

`vnext/packages/responses-store/src/sql.ts`:

```ts
/**
 * SQL-backed ResponsesSnapshotStore — runs against either D1 (CFW) or
 * bun:sqlite (local) via the SqlExecutor adapter. Storing items as JSON
 * TEXT keeps schema flat; both backends are SQLite under the hood so this
 * is the natural choice.
 *
 * Owner isolation uses a nullable-safe predicate (SQLite/D1 lack
 * IS NOT DISTINCT FROM): match when api_key_id = ? OR (api_key_id IS NULL
 * AND ? IS NULL). Pass apiKeyId twice as a bind.
 *
 * load() filters out expired rows in the WHERE clause so a deferred GC
 * sweep is purely a storage concern, never affecting correctness.
 *
 * save() does an UPSERT (REPLACE INTO) and follows up with an opportunistic
 * GC delete of up to GC_BATCH_LIMIT expired rows. GC is best-effort: a
 * failure logs nothing and does not surface — the caller's save semantics
 * already succeeded.
 */
import type { ResponsesSnapshot, ResponsesSnapshotStore, SqlExecutor } from './types.ts'
import { GC_BATCH_LIMIT } from './types.ts'

export interface SqliteStoreOptions {
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

interface Row {
  response_id: string
  api_key_id: string | null
  model: string
  items_json: string
  created_at: number
  expires_at: number
}

export class SqliteResponsesSnapshotStore implements ResponsesSnapshotStore {
  private readonly now: () => number

  constructor(private readonly exec: SqlExecutor, opts: SqliteStoreOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  async load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null> {
    const row = await this.exec.first<Row>(
      `SELECT response_id, api_key_id, model, items_json, created_at, expires_at
         FROM responses_snapshots
        WHERE response_id = ?
          AND (api_key_id = ? OR (api_key_id IS NULL AND ? IS NULL))
          AND expires_at > ?`,
      [responseId, apiKeyId, apiKeyId, this.now()],
    )
    if (!row) return null
    return {
      responseId: row.response_id,
      apiKeyId: row.api_key_id,
      model: row.model,
      items: JSON.parse(row.items_json) as unknown[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  async save(snap: ResponsesSnapshot): Promise<void> {
    await this.exec.run(
      `INSERT OR REPLACE INTO responses_snapshots
         (response_id, api_key_id, model, items_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [snap.responseId, snap.apiKeyId, snap.model, JSON.stringify(snap.items), snap.createdAt, snap.expiresAt],
    )
    try {
      await this.exec.run(
        `DELETE FROM responses_snapshots
          WHERE response_id IN (
            SELECT response_id FROM responses_snapshots WHERE expires_at <= ? LIMIT ?
          )`,
        [this.now(), GC_BATCH_LIMIT],
      )
    } catch {
      // GC is best-effort; the save itself already succeeded.
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd vnext/packages/responses-store && bun test src/__tests__/sql.test.ts`
Expected: all 8 contract tests pass.

- [ ] **Step 5: Run full package test suite**

Run: `cd vnext/packages/responses-store && bun test`
Expected: 16 tests pass (8 in-memory + 8 sql).

- [ ] **Step 6: Typecheck the package**

Run: `cd vnext/packages/responses-store && bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/responses-store/src/sql.ts vnext/packages/responses-store/src/__tests__/sql.test.ts
git commit -m "feat(responses-store): SqliteResponsesSnapshotStore + contract pass"
```

---

## Task 7: Workspace-wide checks

- [ ] **Step 1: Typecheck the whole workspace**

Run: `cd vnext && bun run typecheck`
Expected: clean across every package (no regressions in gateway, translate, etc.).

- [ ] **Step 2: Run the full vnext test suite**

Run: `cd vnext && bun test`
Expected: existing tests still pass; new responses-store tests included.

- [ ] **Step 3: If clean, commit (no changes; verify)**

If anything required fixing, commit those fixes:
```bash
git add -A
git commit -m "chore(responses-store): workspace integration cleanups"
```
Otherwise no commit needed for this task.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Implemented in |
|---|---|
| `ResponsesSnapshotStore` interface | Task 2 |
| `SqliteResponsesSnapshotStore` (D1 + bun:sqlite) | Task 6 |
| `InMemoryResponsesSnapshotStore` | Task 4 |
| Migration `0001_responses_snapshots.sql` (renamed `0030_*` to fit project numbering) | Task 5 |
| TTL default 24h via `DEFAULT_TTL_MS` | Task 2 |
| Opportunistic GC on save (`LIMIT 100`) | Task 6 |
| Nullable-safe owner match (`api_key_id = ? OR (api_key_id IS NULL AND ? IS NULL)`) | Task 6 |
| Items stored as JSON TEXT | Task 6 |

**Out-of-scope items deferred to Plan 2 / Plan 3:**

- `responses-store-bridge.ts` (expand/save) → Plan 3
- `Env.responsesStore` wiring + `apps/gateway/src/app.ts` construction → Plan 3
- Translator pair registration → Plan 2
- E2E + SDK multi-turn integration tests → Plan 3
