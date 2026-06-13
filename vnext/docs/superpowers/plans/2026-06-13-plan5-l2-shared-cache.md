# Plan 5 — Two-Level Cache (`@vnext/shared-cache` + Registry L1/L2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime-agnostic two-level cache so `listProviderBindings` can survive isolate restarts on Cloudflare Workers and multi-instance Docker, while keeping today's in-process L1 memo as the fast path.

**Architecture:** A new `@vnext/shared-cache` workspace package defines a single `Cache` interface and three implementations: `MemoryCache` (in-process Map with TTL), `KvCache` (Cloudflare KV, native `expirationTtl`), `D1Cache` (SQLite `cache_kv` table with lazy + 1%-probability batch GC). The gateway gets a parallel `shared/cache/` bootstrap to `shared/repo/` with `getCache/initCache/setCacheForTest` and a runtime-aware factory (`CACHE_BACKEND` env override, otherwise CFW→KV→D1, Docker→Memory→D1). `data-plane/providers/registry.ts` upgrades `getCachedModels` to L1 (existing module-level Map) → L2 (`getCache()`) → upstream; both layers are written on miss.

**Tech Stack:** TypeScript, Bun (test runner + bun:sqlite), Cloudflare Workers (`KVNamespace`, `D1Database`), Hono, existing `SqlExecutor` shim pattern from `apps/gateway/src/shared/repo/shared/executor.ts`.

---

## File Structure

**New package `packages/shared-cache/`:**
- `package.json` — workspace package descriptor mirroring `packages/shared-http/package.json`.
- `tsconfig.json` — extends `tsconfig.base.json`.
- `src/types.ts` — `Cache` interface + helper types.
- `src/memory.ts` — `MemoryCache` class (Map<string, { value: string; expiresAt: number }>).
- `src/kv.ts` — `KvCache` class around `KVNamespace.get/put/delete`.
- `src/d1.ts` — `D1Cache` class around a `SqlExecutor` (shared with repo).
- `src/index.ts` — re-exports.
- `src/__tests__/memory.test.ts`
- `src/__tests__/d1.test.ts` (uses `bun:sqlite` directly via an inline executor adapter).
- `src/__tests__/kv.test.ts` (uses a fake KV adapter — no real CFW needed).

**Gateway wiring (`apps/gateway/`):**
- New `src/shared/cache/index.ts` — bootstrap parallel to `src/shared/repo/index.ts` (`getCache/initCache/setCacheForTest/onCacheReset`).
- New `src/shared/cache/factory.ts` — selects implementation from `Env` + `process.env.CACHE_BACKEND`.
- Modify `src/data-plane/providers/registry.ts:155-168` — replace single-tier memo with L1+L2 lookup.
- Modify `src/app.ts:31-36` — middleware initializes the cache from `c.env` if not yet wired (parallel to the existing responsesStore wiring).
- Modify `entry-bun.ts` — wire `initCache(new MemoryCache())` (or D1 when `CACHE_BACKEND=d1`).
- Modify `src/shared/repo/sqlite.ts:7` — extend `INIT_SQL` with the `cache_kv` table + index so local bun tests don't need a separate migration step.
- New `migrations/0031_cache_kv.sql` (at repo root, sibling of `migrations/0030_responses_snapshots.sql`) — D1 schema.

**Tests added/updated:**
- `apps/gateway/tests/providers-registry.test.ts` — new tests for L2 fallthrough, L1 backfill, and graceful L2 failure.
- New `apps/gateway/tests/shared-cache-bootstrap.test.ts` — covers `factory.ts` selection + `setCacheForTest` lifecycle.

---

## Conventions

- **Interface:**
  ```ts
  export interface Cache {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T, ttlSec: number): Promise<void>
    delete(key: string): Promise<void>
  }
  ```
  Values are serialized to JSON internally. `ttlSec` is **required** — there is no "cache forever" path (forces an explicit cap).
- **Keys** are caller-namespaced strings. Registry uses `models:${upstream.id}@${upstream.updatedAt}` — same shape as today's L1 memo.
- **Errors swallow upward** at the cache call site: a `get` that throws returns `null`; a `set` that throws is logged-and-ignored. The gateway must never 5xx because L2 is down.
- **No `any`** — use `unknown` + `JSON.parse` typed via `<T>`.
- **Tests use Bun's built-in runner** (`import { test, expect } from 'bun:test'`). Each test file commits with the implementation it covers.

---

## Task 1 — Scaffold `@vnext/shared-cache` package + types

**Files:**
- Create: `packages/shared-cache/package.json`
- Create: `packages/shared-cache/tsconfig.json`
- Create: `packages/shared-cache/src/index.ts`
- Create: `packages/shared-cache/src/types.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@vnext/shared-cache",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./memory": "./src/memory.ts",
    "./kv": "./src/kv.ts",
    "./d1": "./src/d1.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `src/types.ts`**

```ts
/**
 * Runtime-agnostic key/value cache. Implementations live in `./memory.ts`,
 * `./kv.ts`, `./d1.ts`. Values are JSON-serialized internally.
 *
 * Contract:
 * - `get` returns `null` on miss, on expired entry, or on any transport error
 *   (errors are swallowed — callers must always handle null).
 * - `set` writes with a required ttl in seconds. There is intentionally no
 *   "cache forever" overload; callers must pick a cap.
 * - `delete` is idempotent.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSec: number): Promise<void>
  delete(key: string): Promise<void>
}
```

- [ ] **Step 4: Create `src/index.ts`**

```ts
export type { Cache } from './types.ts'
export { MemoryCache } from './memory.ts'
export { KvCache, type KVLike } from './kv.ts'
export { D1Cache, type CacheSqlExecutor } from './d1.ts'
```

> Note: the `./memory.ts`, `./kv.ts`, `./d1.ts` modules are created in subsequent tasks. TypeScript will error here until Task 2/3/4 land — that's expected; the import is in place so each subsequent task only touches its own module.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-cache/package.json packages/shared-cache/tsconfig.json packages/shared-cache/src/index.ts packages/shared-cache/src/types.ts
git commit -m "feat(shared-cache): scaffold package + Cache interface"
```

---

## Task 2 — `MemoryCache` implementation

**Files:**
- Create: `packages/shared-cache/src/memory.ts`
- Create: `packages/shared-cache/src/__tests__/memory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared-cache/src/__tests__/memory.test.ts
import { test, expect } from 'bun:test'
import { MemoryCache } from '../memory.ts'

test('MemoryCache get returns null on miss', async () => {
  const c = new MemoryCache()
  expect(await c.get('absent')).toBeNull()
})

test('MemoryCache get round-trips typed values', async () => {
  const c = new MemoryCache()
  await c.set('k', { a: 1, b: 'two' }, 60)
  expect(await c.get<{ a: number; b: string }>('k')).toEqual({ a: 1, b: 'two' })
})

test('MemoryCache get returns null after ttl expires', async () => {
  let now = 1_000_000
  const c = new MemoryCache(() => now)
  await c.set('k', 'v', 5)
  now += 4_999
  expect(await c.get<string>('k')).toBe('v')
  now += 2
  expect(await c.get<string>('k')).toBeNull()
})

test('MemoryCache delete removes entry', async () => {
  const c = new MemoryCache()
  await c.set('k', 'v', 60)
  await c.delete('k')
  expect(await c.get<string>('k')).toBeNull()
})

test('MemoryCache delete is idempotent', async () => {
  const c = new MemoryCache()
  await c.delete('never-set')
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd packages/shared-cache && bun test src/__tests__/memory.test.ts
```

Expected: FAIL — `Cannot find module '../memory.ts'`.

- [ ] **Step 3: Write `src/memory.ts`**

```ts
import type { Cache } from './types.ts'

interface Entry { value: string; expiresAt: number }

/**
 * In-process cache for a single Node/Bun process or a single CFW isolate.
 * Stores values as serialized JSON so that swapping in a distributed backend
 * (KV/D1) doesn't change observed semantics. The optional `clock` parameter
 * exists so tests can advance time without sleeping.
 */
export class MemoryCache implements Cache {
  private store = new Map<string, Entry>()

  constructor(private clock: () => number = () => Date.now()) {}

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key)
    if (!hit) return null
    if (hit.expiresAt <= this.clock()) {
      this.store.delete(key)
      return null
    }
    return JSON.parse(hit.value) as T
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.clock() + ttlSec * 1000,
    })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}
```

- [ ] **Step 4: Re-run the test and confirm it passes**

```bash
cd packages/shared-cache && bun test src/__tests__/memory.test.ts
```

Expected: PASS — 5/5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-cache/src/memory.ts packages/shared-cache/src/__tests__/memory.test.ts
git commit -m "feat(shared-cache): MemoryCache with ttl + injectable clock"
```

---

## Task 3 — `KvCache` implementation

**Files:**
- Create: `packages/shared-cache/src/kv.ts`
- Create: `packages/shared-cache/src/__tests__/kv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared-cache/src/__tests__/kv.test.ts
import { test, expect } from 'bun:test'
import { KvCache, type KVLike } from '../kv.ts'

interface Call { op: 'get' | 'put' | 'delete'; key: string; value?: string; ttl?: number }

function fakeKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const calls: Call[] = []
  const kv: KVLike = {
    async get(key) { calls.push({ op: 'get', key }); return data.get(key) ?? null },
    async put(key, value, opts) {
      calls.push({ op: 'put', key, value, ttl: opts?.expirationTtl })
      data.set(key, value)
    },
    async delete(key) { calls.push({ op: 'delete', key }); data.delete(key) },
  }
  return { kv, calls, data }
}

test('KvCache get returns null on miss', async () => {
  const { kv } = fakeKv()
  const c = new KvCache(kv)
  expect(await c.get('absent')).toBeNull()
})

test('KvCache round-trips typed values and forwards expirationTtl', async () => {
  const { kv, calls } = fakeKv()
  const c = new KvCache(kv)
  await c.set('k', { hello: 'world' }, 120)
  expect(calls).toContainEqual({ op: 'put', key: 'k', value: '{"hello":"world"}', ttl: 120 })
  expect(await c.get<{ hello: string }>('k')).toEqual({ hello: 'world' })
})

test('KvCache delete forwards to KV', async () => {
  const { kv, data } = fakeKv({ k: '"v"' })
  const c = new KvCache(kv)
  await c.delete('k')
  expect(data.has('k')).toBe(false)
})

test('KvCache get swallows transport errors and returns null', async () => {
  const kv: KVLike = {
    async get() { throw new Error('boom') },
    async put() {},
    async delete() {},
  }
  const c = new KvCache(kv)
  expect(await c.get('k')).toBeNull()
})

test('KvCache set swallows transport errors', async () => {
  const kv: KVLike = {
    async get() { return null },
    async put() { throw new Error('boom') },
    async delete() {},
  }
  const c = new KvCache(kv)
  await c.set('k', 'v', 60) // must not throw
})

test('KvCache rejects ttl < 60s (KV minimum)', async () => {
  const { kv } = fakeKv()
  const c = new KvCache(kv)
  await expect(c.set('k', 'v', 30)).rejects.toThrow(/ttlSec must be >= 60/)
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd packages/shared-cache && bun test src/__tests__/kv.test.ts
```

Expected: FAIL — `Cannot find module '../kv.ts'`.

- [ ] **Step 3: Write `src/kv.ts`**

```ts
import type { Cache } from './types.ts'

/**
 * Minimal subset of Cloudflare's `KVNamespace` that we actually call. Defining
 * it here keeps `@vnext/shared-cache` free of `@cloudflare/workers-types`
 * (which would pull a dom-shaped global into every workspace consumer).
 */
export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * KV-backed cache. Reads/writes are JSON; ttl is forwarded as `expirationTtl`
 * so Cloudflare evicts at the edge without us needing GC. Errors are swallowed
 * (logged via `console.warn` so they show up in `wrangler tail`) — the gateway
 * must continue to serve from upstream + L1 even when KV is degraded.
 *
 * KV's minimum expirationTtl is 60 seconds; we reject anything shorter at
 * construction-time-of-the-call so the failure mode is loud during dev
 * instead of a silent 400 from the KV API at runtime.
 */
export class KvCache implements Cache {
  constructor(private kv: KVLike) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.kv.get(key)
      if (raw === null) return null
      return JSON.parse(raw) as T
    } catch (err) {
      console.warn('[KvCache] get failed', { key, err: String(err) })
      return null
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (ttlSec < 60) throw new Error(`KvCache: ttlSec must be >= 60, got ${ttlSec}`)
    try {
      await this.kv.put(key, JSON.stringify(value), { expirationTtl: ttlSec })
    } catch (err) {
      console.warn('[KvCache] put failed', { key, err: String(err) })
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key)
    } catch (err) {
      console.warn('[KvCache] delete failed', { key, err: String(err) })
    }
  }
}
```

- [ ] **Step 4: Re-run the test and confirm it passes**

```bash
cd packages/shared-cache && bun test src/__tests__/kv.test.ts
```

Expected: PASS — 6/6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-cache/src/kv.ts packages/shared-cache/src/__tests__/kv.test.ts
git commit -m "feat(shared-cache): KvCache with native expirationTtl + error swallow"
```

---

## Task 4 — `D1Cache` implementation

**Files:**
- Create: `packages/shared-cache/src/d1.ts`
- Create: `packages/shared-cache/src/__tests__/d1.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared-cache/src/__tests__/d1.test.ts
import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { D1Cache, type CacheSqlExecutor } from '../d1.ts'

function sqliteExecutor(db: Database): CacheSqlExecutor {
  return {
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      return (db.query(sql).get(...(binds as never[])) ?? null) as T | null
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const info = db.query(sql).run(...(binds as never[]))
      return { changes: Number(info.changes ?? 0) }
    },
  }
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cache_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX cache_kv_expires_at ON cache_kv(expires_at);
  `)
  return db
}

test('D1Cache get returns null on miss', async () => {
  const db = makeDb()
  const c = new D1Cache(sqliteExecutor(db))
  expect(await c.get('absent')).toBeNull()
})

test('D1Cache round-trips typed values', async () => {
  const db = makeDb()
  let now = 1_000_000
  const c = new D1Cache(sqliteExecutor(db), () => now, 0) // 0% GC for determinism
  await c.set('k', { a: 1 }, 60)
  expect(await c.get<{ a: number }>('k')).toEqual({ a: 1 })
})

test('D1Cache get skips entries past expires_at (lazy expiration)', async () => {
  const db = makeDb()
  let now = 1_000_000
  const c = new D1Cache(sqliteExecutor(db), () => now, 0)
  await c.set('k', 'v', 5)
  now += 4_999
  expect(await c.get<string>('k')).toBe('v')
  now += 2
  expect(await c.get<string>('k')).toBeNull()
})

test('D1Cache set upserts (second set overwrites first)', async () => {
  const db = makeDb()
  const c = new D1Cache(sqliteExecutor(db), () => 1_000_000, 0)
  await c.set('k', 'v1', 60)
  await c.set('k', 'v2', 60)
  expect(await c.get<string>('k')).toBe('v2')
})

test('D1Cache delete removes entry', async () => {
  const db = makeDb()
  const c = new D1Cache(sqliteExecutor(db), () => 1_000_000, 0)
  await c.set('k', 'v', 60)
  await c.delete('k')
  expect(await c.get<string>('k')).toBeNull()
})

test('D1Cache GC sweep removes expired rows when probability fires', async () => {
  const db = makeDb()
  let now = 1_000_000
  const c = new D1Cache(sqliteExecutor(db), () => now, 1) // 100% GC every call
  await c.set('k1', 'v', 5)
  await c.set('k2', 'v', 60)
  now += 10_000
  // Trigger the gc-probability check via a get (use a value past expiry):
  await c.get('anything')
  const remaining = db.query('SELECT key FROM cache_kv ORDER BY key').all() as Array<{ key: string }>
  expect(remaining.map((r) => r.key)).toEqual(['k2'])
})

test('D1Cache get swallows executor errors and returns null', async () => {
  const c = new D1Cache({
    async first() { throw new Error('db down') },
    async run() { return { changes: 0 } },
  }, () => 1_000_000, 0)
  expect(await c.get('k')).toBeNull()
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd packages/shared-cache && bun test src/__tests__/d1.test.ts
```

Expected: FAIL — `Cannot find module '../d1.ts'`.

- [ ] **Step 3: Write `src/d1.ts`**

```ts
import type { Cache } from './types.ts'

/**
 * The subset of `SqlExecutor` we need. We redeclare it here (instead of
 * importing from `apps/gateway/src/shared/repo/shared/executor.ts`) so this
 * package stays repo-shape-agnostic and can be reused by other workspaces.
 * The gateway bootstrap adapts its existing executors to this shape.
 */
export interface CacheSqlExecutor {
  first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
}

interface Row { value_json: string; expires_at: number }

/**
 * SQLite/D1-backed cache. Stores `(key, value_json, expires_at_ms)` with a
 * unique key. Reads filter expired rows in SQL so an unswept row past its TTL
 * still misses correctly. GC runs probabilistically on read: with probability
 * `gcProbability` (default 1%), a `DELETE WHERE expires_at < now` sweep fires
 * after the read completes. This avoids needing a cron worker while keeping
 * the table bounded.
 *
 * Why probabilistic instead of deterministic per N calls: a counter would need
 * to live somewhere mutable; in CFW that means another KV/D1 hop. Random GC is
 * memory-only and converges on the same amortized cost.
 */
export class D1Cache implements Cache {
  constructor(
    private exec: CacheSqlExecutor,
    private clock: () => number = () => Date.now(),
    private gcProbability: number = 0.01,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const now = this.clock()
    let row: Row | null = null
    try {
      row = await this.exec.first<Row>(
        'SELECT value_json, expires_at FROM cache_kv WHERE key = ?',
        [key],
      )
    } catch (err) {
      console.warn('[D1Cache] get failed', { key, err: String(err) })
      return null
    }
    this.maybeSweep(now)
    if (!row) return null
    if (row.expires_at <= now) return null
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    const expiresAt = this.clock() + ttlSec * 1000
    try {
      // SQLite UPSERT. D1 supports the same syntax.
      await this.exec.run(
        `INSERT INTO cache_kv (key, value_json, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at`,
        [key, JSON.stringify(value), expiresAt],
      )
    } catch (err) {
      console.warn('[D1Cache] set failed', { key, err: String(err) })
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.exec.run('DELETE FROM cache_kv WHERE key = ?', [key])
    } catch (err) {
      console.warn('[D1Cache] delete failed', { key, err: String(err) })
    }
  }

  private maybeSweep(now: number): void {
    if (Math.random() >= this.gcProbability) return
    // Fire-and-forget: we don't await so the read latency isn't affected, but
    // we still log failures.
    this.exec.run('DELETE FROM cache_kv WHERE expires_at < ?', [now]).catch((err) => {
      console.warn('[D1Cache] gc sweep failed', { err: String(err) })
    })
  }
}
```

- [ ] **Step 4: Re-run the test and confirm it passes**

```bash
cd packages/shared-cache && bun test src/__tests__/d1.test.ts
```

Expected: PASS — 7/7 tests.

- [ ] **Step 5: Run the full package test suite + typecheck**

```bash
cd packages/shared-cache && bun test && bun run typecheck
```

Expected: 18 tests pass (5 memory + 6 kv + 7 d1), no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-cache/src/d1.ts packages/shared-cache/src/__tests__/d1.test.ts
git commit -m "feat(shared-cache): D1Cache with lazy + probabilistic GC"
```

---

## Task 5 — D1 migration + bun:sqlite schema for `cache_kv`

**Files:**
- Create: `migrations/0031_cache_kv.sql` (repo root, sibling of `0030_responses_snapshots.sql`)
- Modify: `vnext/apps/gateway/src/shared/repo/sqlite.ts` (extend `INIT_SQL`)

- [ ] **Step 1: Create the D1 migration**

```sql
-- migrations/0031_cache_kv.sql
-- L2 cache shared between data-plane providers/registry and (future) other
-- modules. Values are stored as JSON text; `expires_at` is wall-clock ms so
-- D1Cache.get can filter past-TTL rows without scanning the body.

CREATE TABLE cache_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX cache_kv_expires_at ON cache_kv(expires_at);
```

> Note: this lives at the repo root `migrations/` directory (the path declared in `vnext/apps/gateway/wrangler.jsonc` as `migrations_dir: ../../migrations`). Wrangler will auto-apply it on the next `deploy:full` D1 push.

- [ ] **Step 2: Extend bun:sqlite `INIT_SQL`**

In `vnext/apps/gateway/src/shared/repo/sqlite.ts`, locate the end of the `INIT_SQL` template literal (after the `performance_latency_buckets` index, before the closing backtick) and append:

```sql

CREATE TABLE IF NOT EXISTS cache_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_kv_expires_at ON cache_kv (expires_at);
```

- [ ] **Step 3: Sanity-check the bun:sqlite path still initializes**

```bash
cd vnext && rm -f /tmp/cache-init-test.sqlite && \
  bun -e "import { Database } from 'bun:sqlite'; import { SqliteRepo } from './apps/gateway/src/shared/repo/sqlite.ts'; const db = new Database('/tmp/cache-init-test.sqlite'); new SqliteRepo(db); const rows = db.query(\"SELECT name FROM sqlite_master WHERE type='table' AND name='cache_kv'\").all(); console.log(rows);"
```

Expected: `[ { name: "cache_kv" } ]`.

- [ ] **Step 4: Run the existing gateway test suite to confirm nothing regressed**

```bash
cd vnext/apps/gateway && bun test
```

Expected: all 661 prior tests still pass (no behavioral change yet — table is added but unused).

- [ ] **Step 5: Commit**

```bash
git add migrations/0031_cache_kv.sql vnext/apps/gateway/src/shared/repo/sqlite.ts
git commit -m "feat(gateway): cache_kv schema (D1 migration + bun:sqlite INIT_SQL)"
```

---

## Task 6 — Gateway cache bootstrap (`shared/cache/index.ts`)

**Files:**
- Create: `vnext/apps/gateway/src/shared/cache/index.ts`
- Modify: `vnext/apps/gateway/package.json` (add `@vnext/shared-cache` dep)
- Create: `vnext/apps/gateway/tests/shared-cache-bootstrap.test.ts`

- [ ] **Step 1: Add the workspace dependency**

In `vnext/apps/gateway/package.json`, add to `dependencies`:

```json
    "@vnext/shared-cache": "workspace:*",
```

(Insert alphabetically between `@vnext/responses-store` and `@vnext/translate`.)

- [ ] **Step 2: Run install so Bun links the new workspace**

```bash
cd vnext && bun install
```

Expected: `+ @vnext/shared-cache@workspace:*` in the output.

- [ ] **Step 3: Write the failing test**

```ts
// vnext/apps/gateway/tests/shared-cache-bootstrap.test.ts
import { test, expect, afterEach } from 'bun:test'
import { MemoryCache } from '@vnext/shared-cache'
import {
  getCache,
  initCache,
  setCacheForTest,
  onCacheReset,
} from '../src/shared/cache/index.ts'

afterEach(() => setCacheForTest(null))

test('getCache throws when neither initCache nor setCacheForTest ran', () => {
  setCacheForTest(null)
  // After clearing, prior initCache state must not leak between tests; the
  // bootstrap module remembers _cache only via setCacheForTest in tests.
  expect(() => getCache()).toThrow(/Cache not initialized/)
})

test('initCache wires a default cache that getCache returns', () => {
  initCache(new MemoryCache())
  expect(getCache()).toBeInstanceOf(MemoryCache)
})

test('setCacheForTest overrides initCache without mutating the default', () => {
  initCache(new MemoryCache())
  const override = new MemoryCache()
  setCacheForTest(override)
  expect(getCache()).toBe(override)
  setCacheForTest(null)
  expect(getCache()).toBeInstanceOf(MemoryCache)
})

test('onCacheReset fires when setCacheForTest swaps the override', () => {
  initCache(new MemoryCache())
  let fired = 0
  onCacheReset(() => fired++)
  setCacheForTest(new MemoryCache())
  setCacheForTest(null)
  expect(fired).toBe(2)
})
```

- [ ] **Step 4: Run the test and confirm it fails**

```bash
cd vnext/apps/gateway && bun test tests/shared-cache-bootstrap.test.ts
```

Expected: FAIL — `Cannot find module '../src/shared/cache/index.ts'`.

- [ ] **Step 5: Create `src/shared/cache/index.ts`**

```ts
// vnext/apps/gateway/src/shared/cache/index.ts
//
// Mirror of `shared/repo/index.ts` but for the L2 cache. Lives outside the
// repo module so cache failures don't have to thread through every repo
// caller, and so subagent-driven tests can stub it independently.
import type { Cache } from '@vnext/shared-cache'

let _cache: Cache | null = null
let _override: Cache | null = null
const _onCacheReset: Array<() => void> = []

export function onCacheReset(cb: () => void): void {
  _onCacheReset.push(cb)
}

export function initCache(cache: Cache): void {
  _cache = cache
}

/** Test-only: swap the cache without touching the default registered by initCache. */
export function setCacheForTest(c: Cache | null): void {
  _override = c
  for (const cb of _onCacheReset) cb()
}

export function getCache(): Cache {
  if (_override) return _override
  if (!_cache) throw new Error('Cache not initialized')
  return _cache
}
```

- [ ] **Step 6: Re-run the test and confirm it passes**

```bash
cd vnext/apps/gateway && bun test tests/shared-cache-bootstrap.test.ts
```

Expected: PASS — 4/4 tests.

- [ ] **Step 7: Commit**

```bash
git add vnext/apps/gateway/package.json vnext/apps/gateway/src/shared/cache/index.ts vnext/apps/gateway/tests/shared-cache-bootstrap.test.ts
git commit -m "feat(gateway): shared/cache bootstrap (getCache/initCache/setCacheForTest)"
```

---

## Task 7 — Runtime factory (selects MemoryCache / KvCache / D1Cache)

**Files:**
- Create: `vnext/apps/gateway/src/shared/cache/factory.ts`
- Append to: `vnext/apps/gateway/tests/shared-cache-bootstrap.test.ts`

- [ ] **Step 1: Write the failing tests (append to the existing file from Task 6)**

```ts
// Append after the existing tests in tests/shared-cache-bootstrap.test.ts
import { createCacheFromEnv } from '../src/shared/cache/factory.ts'
import { KvCache, D1Cache } from '@vnext/shared-cache'

test('factory: CACHE_BACKEND=memory wins regardless of bindings', () => {
  const cache = createCacheFromEnv(
    { DB: {} as never, KV: {} as never },
    { CACHE_BACKEND: 'memory' },
  )
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('factory: CACHE_BACKEND=kv requires KV binding', () => {
  expect(() => createCacheFromEnv({}, { CACHE_BACKEND: 'kv' })).toThrow(/CACHE_BACKEND=kv but env\.KV is missing/)
})

test('factory: CACHE_BACKEND=d1 requires DB binding', () => {
  expect(() => createCacheFromEnv({}, { CACHE_BACKEND: 'd1' })).toThrow(/CACHE_BACKEND=d1 but env\.DB is missing/)
})

test('factory: no override + KV binding → KvCache', () => {
  const cache = createCacheFromEnv({ KV: {} as never }, {})
  expect(cache).toBeInstanceOf(KvCache)
})

test('factory: no override + only DB binding → D1Cache', () => {
  const cache = createCacheFromEnv({ DB: { prepare: () => ({ bind: () => ({}) }) } as never }, {})
  expect(cache).toBeInstanceOf(D1Cache)
})

test('factory: no override + no bindings → MemoryCache', () => {
  const cache = createCacheFromEnv({}, {})
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('factory: unknown CACHE_BACKEND value throws', () => {
  expect(() => createCacheFromEnv({}, { CACHE_BACKEND: 'redis' })).toThrow(/Unknown CACHE_BACKEND/)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd vnext/apps/gateway && bun test tests/shared-cache-bootstrap.test.ts
```

Expected: 7 new failures — `Cannot find module '../src/shared/cache/factory.ts'`.

- [ ] **Step 3: Create `src/shared/cache/factory.ts`**

```ts
// vnext/apps/gateway/src/shared/cache/factory.ts
//
// Picks a Cache implementation from runtime bindings + env. Decision tree:
//
//   CACHE_BACKEND=memory  → MemoryCache
//   CACHE_BACKEND=kv      → KvCache (requires env.KV)
//   CACHE_BACKEND=d1      → D1Cache (requires env.DB)
//   (unset, CFW with KV)  → KvCache  (KV is cheaper + lower latency than D1)
//   (unset, has DB only)  → D1Cache  (Docker multi-instance or CFW without KV)
//   (unset, neither)      → MemoryCache (single-process Docker / local bun)
//
// The KV-first preference on CFW is intentional: KV has built-in TTL, and
// our cache keys are eventually-consistent by design (they encode upstream.updatedAt
// so a stale read becomes a fresh miss as soon as the row updates).
import {
  D1Cache,
  KvCache,
  MemoryCache,
  type Cache,
  type CacheSqlExecutor,
  type KVLike,
} from '@vnext/shared-cache'

interface FactoryEnv {
  DB?: { prepare: (sql: string) => { bind: (...v: unknown[]) => unknown; first?: unknown; run?: unknown; all?: unknown } } | unknown
  KV?: KVLike | unknown
}

interface ProcEnv {
  CACHE_BACKEND?: string
}

export function createCacheFromEnv(env: FactoryEnv, proc: ProcEnv): Cache {
  const explicit = proc.CACHE_BACKEND?.trim().toLowerCase()
  if (explicit === 'memory') return new MemoryCache()
  if (explicit === 'kv') {
    if (!env.KV) throw new Error('CACHE_BACKEND=kv but env.KV is missing')
    return new KvCache(env.KV as KVLike)
  }
  if (explicit === 'd1') {
    if (!env.DB) throw new Error('CACHE_BACKEND=d1 but env.DB is missing')
    return new D1Cache(d1Executor(env.DB))
  }
  if (explicit !== undefined && explicit !== '') {
    throw new Error(`Unknown CACHE_BACKEND: ${proc.CACHE_BACKEND}`)
  }
  // No explicit override.
  if (env.KV) return new KvCache(env.KV as KVLike)
  if (env.DB) return new D1Cache(d1Executor(env.DB))
  return new MemoryCache()
}

// Adapts the D1Database `prepare/bind/first/run` shape to the CacheSqlExecutor
// expected by D1Cache. Mirrors the inline adapter in
// `apps/gateway/src/shared/runtime/responses-store-factory.ts`.
function d1Executor(db: unknown): CacheSqlExecutor {
  interface D1 { prepare(sql: string): D1Stmt }
  interface D1Stmt {
    bind(...values: unknown[]): D1Stmt
    first<T = unknown>(): Promise<T | null>
    run(): Promise<{ meta?: { changes?: number } }>
  }
  const d1 = db as D1
  const prep = (sql: string, binds: unknown[]): D1Stmt => {
    const s = d1.prepare(sql)
    return binds.length > 0 ? s.bind(...binds) : s
  }
  return {
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      return await prep(sql, binds).first<T>()
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const r = await prep(sql, binds).run()
      return { changes: r?.meta?.changes ?? 0 }
    },
  }
}
```

- [ ] **Step 4: Re-run the tests and confirm they pass**

```bash
cd vnext/apps/gateway && bun test tests/shared-cache-bootstrap.test.ts
```

Expected: PASS — 11/11 tests (4 from Task 6 + 7 from Task 7).

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/shared/cache/factory.ts vnext/apps/gateway/tests/shared-cache-bootstrap.test.ts
git commit -m "feat(gateway): cache factory (env-driven KV/D1/Memory selection)"
```

---

## Task 8 — Wire factory into Bun + CFW entries

**Files:**
- Modify: `vnext/apps/gateway/entry-bun.ts`
- Modify: `vnext/apps/gateway/src/app.ts`

- [ ] **Step 1: Update `entry-bun.ts` to initialize the cache**

Add the import alongside the existing `initRepo` import:

```ts
import { initCache } from './src/shared/cache/index.ts'
import { createCacheFromEnv } from './src/shared/cache/factory.ts'
```

After the `initRepo(new SqliteRepo(db))` line, append:

```ts
initCache(createCacheFromEnv({ /* no CFW bindings under bun */ }, process.env))
```

- [ ] **Step 2: Add CFW-side initialization middleware in `src/app.ts`**

Locate the existing middleware block (the one that wires `c.env.responsesStore`) and add a sibling block that initializes the cache once per worker boot. Replace lines 31-36 of `apps/gateway/src/app.ts`:

```ts
import { getCache, initCache } from './shared/cache/index.ts'
import { createCacheFromEnv } from './shared/cache/factory.ts'

// ...existing imports & Env interface remain unchanged...

let _cacheBootstrapped = false

app.use('*', async (c, next) => {
  if (c.env && !c.env.responsesStore && c.env.DB) {
    c.env.responsesStore = createD1ResponsesStore(c.env.DB)
  }
  if (!_cacheBootstrapped) {
    initCache(createCacheFromEnv(
      { DB: c.env?.DB, KV: c.env?.KV },
      { CACHE_BACKEND: (c.env as Env & { CACHE_BACKEND?: string }).CACHE_BACKEND },
    ))
    _cacheBootstrapped = true
  }
  await next()
})
```

Also extend the `Env` interface (currently `apps/gateway/src/app.ts:10-20`) by adding:

```ts
  CACHE_BACKEND?: 'memory' | 'kv' | 'd1'
```

right after the existing `GOOGLE_CLIENT_SECRET?: string` line.

- [ ] **Step 3: Sanity-check the bun entry boots and serves /health**

```bash
cd vnext/apps/gateway && bun run ../../entry-bun.ts &
BUN_PID=$!
sleep 1
curl -s http://localhost:8788/health
kill $BUN_PID
```

Expected: `{"status":"ok","service":"copilot-gateway-vnext"}` and no startup errors mentioning the cache.

- [ ] **Step 4: Run the full gateway test suite**

```bash
cd vnext/apps/gateway && bun test
```

Expected: all prior tests still pass (672 = 661 prior + 11 new bootstrap/factory tests).

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/entry-bun.ts vnext/apps/gateway/src/app.ts
git commit -m "feat(gateway): wire cache bootstrap into bun + CFW entries"
```

---

## Task 9 — Upgrade `registry.getCachedModels` to two-level cache

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/providers/registry.ts:154-177`
- Modify: `vnext/apps/gateway/tests/providers-registry.test.ts`

- [ ] **Step 1: Write the failing tests (append to providers-registry.test.ts)**

```ts
// Append to vnext/apps/gateway/tests/providers-registry.test.ts
import { MemoryCache } from '@vnext/shared-cache'
import { setCacheForTest } from '../src/shared/cache/index.ts'

test('L2: second call backfills L1 when L1 was cleared mid-life', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const l2 = new MemoryCache()
  setCacheForTest(l2)

  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount++
    return new Response(JSON.stringify({ object: 'list', data: [stubModel('gpt-4o')] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  // First call: both L1 and L2 are empty → fetch upstream + write both.
  await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(fetchCount).toBe(1)

  // Clear L1 only (simulating a CFW isolate restart). L2 still has the entry.
  _clearModelsMemoForTest()

  // Second call: L1 miss + L2 hit → no upstream fetch.
  await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(fetchCount).toBe(1)
})

test('L2: a failing get is treated as a miss, not a 5xx', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  setCacheForTest({
    async get() { throw new Error('kv down') },
    async set() {},
    async delete() {},
  })
  stubFetch([stubModel('gpt-4o')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id)).toEqual(['gpt-4o'])
})
```

Also extend the existing `afterEach` to clear the cache override:

```ts
afterEach(() => {
  globalThis.fetch = originalFetch
  setRepoForTest(null)
  setCacheForTest(null) // NEW
  _clearModelsMemoForTest()
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd vnext/apps/gateway && bun test tests/providers-registry.test.ts
```

Expected: the two new tests FAIL — `Cache not initialized` or upstream fetched twice (proving L2 isn't consulted yet).

- [ ] **Step 3: Update `getCachedModels` in `registry.ts`**

Replace the `getCachedModels` function (current lines 157-168) with this two-level version. Also add the cache import near the top:

```ts
// Add to imports near line 20:
import { getCache, onCacheReset } from '../../shared/cache/index.ts'
// (Existing `getRepo, onRepoReset` import stays.)
```

Replace `getCachedModels`:

```ts
const MODELS_L2_TTL_SEC = 120

async function getCachedModels(
  upstream: UpstreamRecord,
  provider: ModelProvider,
): Promise<ModelsResponse> {
  const key = `models:${upstream.id}@${upstream.updatedAt}`
  const now = Date.now()

  // L1: in-process memo (Map). Fast, isolate-local.
  const l1 = modelsMemo.get(key)
  if (l1 && l1.expiresAt > now) return l1.models

  // L2: distributed cache (KV/D1/Memory). Survives isolate restarts.
  let l2Hit: ModelsResponse | null = null
  try {
    l2Hit = await getCache().get<ModelsResponse>(key)
  } catch {
    // Bootstrap edge case: cache not yet initialized (e.g. a test that forgot
    // setCacheForTest). Behave as a miss so we fall back to upstream.
    l2Hit = null
  }
  if (l2Hit) {
    modelsMemo.set(key, { expiresAt: now + MODELS_MEMO_TTL_MS, models: l2Hit })
    return l2Hit
  }

  // Both miss: fetch upstream + write both layers.
  const models = await provider.getModels()
  modelsMemo.set(key, { expiresAt: now + MODELS_MEMO_TTL_MS, models })
  try {
    await getCache().set(key, models, MODELS_L2_TTL_SEC)
  } catch {
    // L2 write failure is non-fatal; L1 still serves this isolate.
  }
  return models
}
```

Also wire the cache-reset hook so test swaps clear L1 (parallel to the existing `onRepoReset` line):

```ts
// Below the existing onRepoReset line:
onCacheReset(() => modelsMemo.clear())
```

- [ ] **Step 4: Re-run the registry tests and confirm they pass**

```bash
cd vnext/apps/gateway && bun test tests/providers-registry.test.ts
```

Expected: PASS — all prior tests + 2 new ones.

- [ ] **Step 5: Run the full gateway suite**

```bash
cd vnext/apps/gateway && bun test
```

Expected: 674 passing (672 from Task 8 + 2 new L2 tests).

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/providers/registry.ts vnext/apps/gateway/tests/providers-registry.test.ts
git commit -m "feat(gateway): two-level cache in providers.getCachedModels (L1 → L2 → upstream)"
```

---

## Task 10 — Typecheck + lint everything end-to-end

**Files:** none changed.

- [ ] **Step 1: Typecheck the new package**

```bash
cd vnext/packages/shared-cache && bun run typecheck
```

Expected: no errors.

- [ ] **Step 2: Typecheck the gateway**

```bash
cd vnext/apps/gateway && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run full vnext test suite from the root**

```bash
cd vnext && bun test
```

Expected: all tests pass across all packages.

- [ ] **Step 4: No commit needed (verification only).**

---

## Out of scope

Explicitly NOT in this plan (deferred to follow-up plans):

- Wiring `cache.delete(...)` into control-plane upstream write handlers. Cache keys already include `upstream.updatedAt`, so any UPDATE auto-invalidates by producing a different key — eager deletion is an optimization, not a correctness fix.
- Using `@vnext/shared-cache` for anything other than `getCachedModels`. Other call sites (token-exchange cache, copilot-gateway parity probes, etc.) will adopt it incrementally in their own plans.
- A telemetry/observability hook for cache hit-rates. Add when the first dashboard need surfaces.
- Compression of cached payloads. /models responses are <50KB; gzip is premature.
