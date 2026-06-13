# Spec A — Plan A3: physical split into gateway package + platform apps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/gateway/` to `packages/gateway/` (now a pure library); create `apps/platform-bun/` and `apps/platform-cloudflare/` as runtime shells; relocate runtime-specific impls (`d1.ts`, `sqlite.ts`, `cloudflare.ts`, `memory.ts`, `responses-store-factory.ts`, optional `copilot-token-cache.ts`) into the appropriate platform app or provider package; update Dockerfile / wrangler / docker-compose / build:ui paths to match.

**Architecture:** After A3, `packages/gateway` exports `app` (a Hono instance) plus the `initX` accessors. Each platform app provides a thin `bootstrap.ts` that builds runtime impls and calls each `initX`, then a server entry that calls `bootstrap` once and serves `app.fetch`. Tests still live in `packages/gateway/tests/` with `setupTestPlatform()` from A2 covering the in-memory stack.

**Tech Stack:** Same as A2.

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-14-platform-extraction-design.md` §3 + §6.

**Depends on:** Plan A2 complete (gateway uses platform accessors only; entries already bootstrap synchronously).

**Out of scope for A3:**
- New runtime impls (everything that exists today gets moved, not rewritten).
- Provider factory map / token-cache full relocation (Spec B). A3 includes the one-line `copilot-token-cache.ts` move noted in spec §2.6 only because it's leaving `shared/` either way; if it grows complications it gets deferred.
- Splitting `data-plane/routes.ts` (Spec B).

---

## File Structure (after A3)

```
vnext/
├── packages/
│   ├── gateway/                                ← renamed from apps/gateway
│   │   ├── package.json                        name unchanged: @vnext/gateway
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── app.ts                          unchanged from A2
│   │   │   ├── control-plane/                  unchanged
│   │   │   ├── data-plane/                     unchanged
│   │   │   └── shared/
│   │   │       ├── repo/
│   │   │       │   ├── index.ts                stays — accessor only
│   │   │       │   ├── types.ts                stays
│   │   │       │   ├── shared/                 stays — pure logic
│   │   │       │   ├── d1.ts                   REMOVED → apps/platform-cloudflare/
│   │   │       │   └── sqlite.ts               REMOVED → apps/platform-bun/
│   │   │       ├── cache/
│   │   │       │   ├── index.ts                stays
│   │   │       │   └── factory.ts              REMOVED → split between platform apps
│   │   │       ├── image/
│   │   │       │   ├── index.ts                stays — re-export façade
│   │   │       │   ├── inline.ts, size.ts, types.ts  stay
│   │   │       │   ├── cloudflare.ts           REMOVED → apps/platform-cloudflare/
│   │   │       │   └── memory.ts               REMOVED → apps/platform-bun/
│   │   │       └── runtime/
│   │   │           ├── responses-store.ts      stays — accessor (added in A2)
│   │   │           └── responses-store-factory.ts  REMOVED → apps/platform-cloudflare/
│   │   └── tests/                              moved verbatim
│   └── platform/                               (already exists, A1)
│
└── apps/
    ├── platform-cloudflare/                    ← NEW
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── wrangler.jsonc                      moved from apps/gateway/wrangler.jsonc
    │   └── src/
    │       ├── worker.ts                       export default { fetch }
    │       ├── bootstrap.ts                    bootstrapCloudflarePlatform(env, ctx)
    │       ├── d1-repo.ts                      moved from gateway shared/repo/d1.ts
    │       ├── cloudflare-image-processor.ts   moved from gateway shared/image/cloudflare.ts
    │       ├── cache-factory.ts                CFW slice of factory.ts
    │       └── responses-store-factory.ts      moved from gateway shared/runtime/responses-store-factory.ts
    │
    ├── platform-bun/                           ← NEW
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── Dockerfile                          moved from vnext/Dockerfile
    │   └── src/
    │       ├── server.ts                       Bun.serve entry
    │       ├── bootstrap.ts                    bootstrapBunPlatform(opts)
    │       ├── bun-sqlite-database.ts          NEW — adapts bun:sqlite Database to SqlDatabase
    │       ├── bun-sqlite-repo.ts              moved from gateway shared/repo/sqlite.ts
    │       ├── memory-image-processor.ts       moved from gateway shared/image/memory.ts
    │       ├── cache-factory.ts                Bun slice of factory.ts (memory-only)
    │       └── responses-store-factory.ts      thin wrapper using BunSqliteDatabase
    │
    └── dashboard/                              unchanged
```

Removed from repo root: `vnext/Dockerfile`, `vnext/apps/gateway/` (entirely).

---

## Task 1: Rename `apps/gateway/` → `packages/gateway/`

**Why first:** Every downstream task references the new path. Doing the rename alone in one commit makes the diff readable and gives a clean bisection target.

**Files:**
- Move: every file under `vnext/apps/gateway/**` → `vnext/packages/gateway/**`

- [ ] **Step 1: Use git mv to preserve history**

```bash
cd vnext
git mv apps/gateway packages/gateway
```

- [ ] **Step 2: Verify move**

```bash
ls vnext/packages/gateway/
```
Expected: `package.json`, `src/`, `tests/`, `entry-bun.ts`, `entry-cloudflare.ts`, `wrangler.jsonc`, `tsconfig.json`.

- [ ] **Step 3: Update internal references inside the gateway package (none expected)**

```bash
cd vnext && rg "apps/gateway" packages/gateway/
```
Expected: empty (gateway code uses relative imports).

- [ ] **Step 4: Smoke install**

```bash
cd vnext && bun install
```
Expected: workspace re-resolves, `node_modules/@vnext/gateway` symlink now points at `packages/gateway`.

- [ ] **Step 5: Run gateway tests from new location**

```bash
cd vnext && bun test packages/gateway/tests
```
Expected: same green as before A3.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move apps/gateway to packages/gateway"
```

---

## Task 2: Scaffold `apps/platform-cloudflare/` and `apps/platform-bun/`

**Files:**
- Create: `vnext/apps/platform-cloudflare/package.json`, `tsconfig.json`, `src/` (empty)
- Create: `vnext/apps/platform-bun/package.json`, `tsconfig.json`, `src/` (empty)

- [ ] **Step 1: Create `apps/platform-cloudflare/package.json`**

```json
{
  "name": "@vnext/platform-cloudflare",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "deploy": "wrangler deploy",
    "deploy:dry": "wrangler deploy --dry-run --outdir dist"
  },
  "dependencies": {
    "@vnext/gateway": "workspace:*",
    "@vnext/platform": "workspace:*",
    "@vnext/responses-store": "workspace:*",
    "@vnext/shared-cache": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260602.1",
    "wrangler": "^4.97.0"
  }
}
```

- [ ] **Step 2: Create `apps/platform-cloudflare/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `apps/platform-bun/package.json`**

```json
{
  "name": "@vnext/platform-bun",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "start": "bun run src/server.ts"
  },
  "dependencies": {
    "@vnext/gateway": "workspace:*",
    "@vnext/platform": "workspace:*",
    "@vnext/responses-store": "workspace:*",
    "@vnext/shared-cache": "workspace:*"
  }
}
```

- [ ] **Step 4: Create `apps/platform-bun/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: Workspace install**

```bash
cd vnext && bun install
```
Expected: both new packages picked up.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/platform-cloudflare vnext/apps/platform-bun vnext/bun.lock
git commit -m "feat: scaffold platform-cloudflare and platform-bun apps"
```

---

## Task 3: Move CFW runtime impls into `apps/platform-cloudflare/src/`

**Files:**
- Move: `packages/gateway/src/shared/repo/d1.ts` → `apps/platform-cloudflare/src/d1-repo.ts`
- Move: `packages/gateway/src/shared/image/cloudflare.ts` → `apps/platform-cloudflare/src/cloudflare-image-processor.ts`
- Move: `packages/gateway/src/shared/runtime/responses-store-factory.ts` → `apps/platform-cloudflare/src/responses-store-factory.ts`
- Create: `apps/platform-cloudflare/src/cache-factory.ts` (CFW slice)

- [ ] **Step 1: Move d1-repo.ts**

```bash
cd vnext
git mv packages/gateway/src/shared/repo/d1.ts apps/platform-cloudflare/src/d1-repo.ts
```

- [ ] **Step 2: Update its internal imports**

`apps/platform-cloudflare/src/d1-repo.ts` likely imports `./types`, `./shared/executor`, `./shared/repos` — change to:
```ts
import type { Repo } from "@vnext/gateway/src/shared/repo/types.ts"
import type { SqlExecutor } from "@vnext/gateway/src/shared/repo/shared/executor.ts"
import { buildSharedRepo } from "@vnext/gateway/src/shared/repo/shared/repos.ts"
```

(If this triggers TypeScript path issues, alternative: gateway re-exports these as public surface — add to `packages/gateway/src/shared/repo/index.ts`. Decide based on what compiles cleanly.)

- [ ] **Step 3: Drop the dead `D1Repo` re-export from gateway's `repo/index.ts`**

`packages/gateway/src/shared/repo/index.ts` had `export { D1Repo } from "./d1"` — delete that line; gateway no longer knows about D1.

- [ ] **Step 4: Move cloudflare-image-processor.ts**

```bash
cd vnext
git mv packages/gateway/src/shared/image/cloudflare.ts apps/platform-cloudflare/src/cloudflare-image-processor.ts
```

- [ ] **Step 5: Update gateway's `shared/image/index.ts` re-exports**

Remove the `export { createCloudflareImageProcessor, type ImagesBinding, type ImageCacheKv } from "./cloudflare"` line. Platform apps import from their own location now.

- [ ] **Step 6: Move responses-store-factory.ts**

```bash
cd vnext
git mv packages/gateway/src/shared/runtime/responses-store-factory.ts apps/platform-cloudflare/src/responses-store-factory.ts
```

- [ ] **Step 7: Create CFW cache factory**

`apps/platform-cloudflare/src/cache-factory.ts`:
```ts
import {
  D1Cache,
  KvCache,
  MemoryCache,
  type Cache,
  type KVLike,
} from "@vnext/shared-cache"

export interface CloudflareEnv {
  DB?: unknown
  KV?: KVLike
  CACHE_BACKEND?: string
}

export function createCloudflareCache(env: CloudflareEnv): Cache {
  const explicit = env.CACHE_BACKEND?.trim().toLowerCase()
  if (explicit === "memory") return new MemoryCache()
  if (explicit === "kv") {
    if (!env.KV) throw new Error("CACHE_BACKEND=kv but env.KV is missing")
    return new KvCache(env.KV)
  }
  if (explicit === "d1") {
    if (!env.DB) throw new Error("CACHE_BACKEND=d1 but env.DB is missing")
    return new D1Cache(d1Executor(env.DB))
  }
  if (env.KV) return new KvCache(env.KV)
  if (env.DB) return new D1Cache(d1Executor(env.DB))
  return new MemoryCache()
}

// Inline d1Executor — the one currently in packages/gateway/src/shared/cache/factory.ts
function d1Executor(db: unknown): /* CacheSqlExecutor */ never {
  throw new Error("TODO: copy d1Executor from gateway/cache/factory.ts")
}
```

(Resolve the `d1Executor` TODO by copying the function body from `packages/gateway/src/shared/cache/factory.ts` — the bottom half of that file.)

- [ ] **Step 8: Verify gateway typechecks (it's now missing things d1.ts/cloudflare.ts/etc. used to export)**

```bash
cd vnext/packages/gateway && bun run typecheck
```
Fix any orphaned imports inside gateway. The expected fixes are limited to:
- `shared/repo/index.ts` — no longer re-exports `D1Repo`.
- `shared/image/index.ts` — no longer re-exports `createCloudflareImageProcessor`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: move CFW runtime impls to platform-cloudflare/"
```

---

## Task 4: Move Bun runtime impls into `apps/platform-bun/src/`

**Files:**
- Move: `packages/gateway/src/shared/repo/sqlite.ts` → `apps/platform-bun/src/bun-sqlite-repo.ts`
- Move: `packages/gateway/src/shared/image/memory.ts` → `apps/platform-bun/src/memory-image-processor.ts`
- Create: `apps/platform-bun/src/bun-sqlite-database.ts` (adapter)
- Create: `apps/platform-bun/src/cache-factory.ts`
- Create: `apps/platform-bun/src/responses-store-factory.ts`

- [ ] **Step 1: Move sqlite.ts**

```bash
cd vnext
git mv packages/gateway/src/shared/repo/sqlite.ts apps/platform-bun/src/bun-sqlite-repo.ts
```

- [ ] **Step 2: Update its imports**

Same pattern as Task 3 step 2 — point `./types`, `./shared/executor`, `./shared/repos` at `@vnext/gateway/src/shared/repo/...`.

- [ ] **Step 3: Drop `SqliteRepo` from gateway's `entry-bun.ts` and `tests/_setup-platform.ts`**

(These get rewritten in Tasks 6 and 9. For now grep:)
```bash
cd vnext && rg "from.*shared/repo/sqlite" packages/gateway/
```
Each match needs eventual rewiring to import from `@vnext/platform-bun` or be removed.

- [ ] **Step 4: Move memory.ts**

```bash
cd vnext
git mv packages/gateway/src/shared/image/memory.ts apps/platform-bun/src/memory-image-processor.ts
```

- [ ] **Step 5: Update gateway's `shared/image/index.ts`**

Remove `export { createInMemoryImageProcessor } from "./memory"`. Tests that need it import from `@vnext/platform-bun` directly (handled in Task 9).

- [ ] **Step 6: Create `BunSqliteDatabase` adapter**

`apps/platform-bun/src/bun-sqlite-database.ts`:
```ts
import { Database } from "bun:sqlite"
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from "@vnext/platform"

export class BunSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: Database) {}

  prepare(query: string): SqlPreparedStatement {
    return new BunSqlitePrepared(this.db, query)
  }

  async exec(sql: string): Promise<unknown> {
    this.db.exec(sql)
    return undefined
  }

  raw(): Database {
    return this.db
  }
}

class BunSqlitePrepared implements SqlPreparedStatement {
  private values: unknown[] = []
  constructor(private readonly db: Database, private readonly sql: string) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    this.values = values
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql)
    return (stmt.get(...this.values) as T | null) ?? null
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const stmt = this.db.prepare(this.sql)
    const results = stmt.all(...this.values) as T[]
    return { results, success: true, meta: {} }
  }

  async run(): Promise<SqlResult> {
    const stmt = this.db.prepare(this.sql)
    const result = stmt.run(...this.values)
    return { results: [], success: true, meta: { changes: result.changes } }
  }
}
```

This is the wrapper that lets `@vnext/platform`'s `SqlDatabase` interface work over `bun:sqlite` without leaking the bun type into gateway.

- [ ] **Step 7: Create Bun cache factory**

`apps/platform-bun/src/cache-factory.ts`:
```ts
import {
  D1Cache,
  MemoryCache,
  type Cache,
  type CacheSqlExecutor,
} from "@vnext/shared-cache"
import type { BunSqliteDatabase } from "./bun-sqlite-database.ts"

export interface BunCacheEnv {
  db?: BunSqliteDatabase
  backend?: string
}

export function createBunCache(env: BunCacheEnv): Cache {
  const explicit = env.backend?.trim().toLowerCase()
  if (explicit === "memory") return new MemoryCache()
  if (explicit === "d1") {
    if (!env.db) throw new Error("CACHE_BACKEND=d1 but Bun database is not available")
    return new D1Cache(toCacheExecutor(env.db))
  }
  if (env.backend && explicit !== "") {
    throw new Error(`Unknown CACHE_BACKEND for Bun: ${env.backend}`)
  }
  return env.db ? new D1Cache(toCacheExecutor(env.db)) : new MemoryCache()
}

function toCacheExecutor(db: BunSqliteDatabase): CacheSqlExecutor {
  // Adapter shape — copy from the existing d1Executor body in
  // gateway's old cache/factory.ts; both paths funnel through SqlDatabase
  // now, so the adapter is a thin wrapper.
  throw new Error("TODO: implement against BunSqliteDatabase")
}
```

(Resolve TODO by adapting the existing `d1Executor` to call `db.prepare(sql).bind(...)` directly — same pattern as the CFW cache-factory.)

- [ ] **Step 8: Create Bun responses-store factory**

`apps/platform-bun/src/responses-store-factory.ts`:
```ts
import { SqliteResponsesSnapshotStore, type ResponsesSnapshotStore, type SqlExecutor } from "@vnext/responses-store"
import type { BunSqliteDatabase } from "./bun-sqlite-database.ts"

export function createBunResponsesStore(db: BunSqliteDatabase): ResponsesSnapshotStore {
  return new SqliteResponsesSnapshotStore(toExecutor(db))
}

function toExecutor(db: BunSqliteDatabase): SqlExecutor {
  // Same shape as the CFW responses-store-factory's d1Executor — both wrap
  // a SqlDatabase. Copy the body and adapt to BunSqliteDatabase's prepare/bind.
  throw new Error("TODO: implement")
}
```

- [ ] **Step 9: Verify gateway still typechecks**

```bash
cd vnext/packages/gateway && bun run typecheck
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: move Bun runtime impls to platform-bun/; add BunSqliteDatabase adapter"
```

---

## Task 5: Delete `packages/gateway/src/shared/cache/factory.ts`

After both platform apps own their own cache-factory, the gateway's copy is dead.

**Files:**
- Delete: `packages/gateway/src/shared/cache/factory.ts`
- Modify: any remaining import of `createCacheFromEnv` from gateway

- [ ] **Step 1: Inventory remaining callers**

```bash
cd vnext && rg "createCacheFromEnv|shared/cache/factory" packages/gateway/ apps/
```

- [ ] **Step 2: Migrate**

Each caller in `packages/gateway/` is either in `entry-bun.ts` or `entry-cloudflare.ts` (both rewritten in Tasks 6 and 7) or in a test (rewritten in Task 9). After Tasks 6/7/9 land, the only remaining matches should be in `apps/platform-{bun,cloudflare}/`.

- [ ] **Step 3: Delete**

```bash
cd vnext
git rm packages/gateway/src/shared/cache/factory.ts
```

- [ ] **Step 4: Verify**

```bash
cd vnext && bun run typecheck 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: drop gateway/shared/cache/factory.ts (moved to platform apps)"
```

(This task can land any time after Tasks 6+7. Order it later if dependencies bite.)

---

## Task 6: `apps/platform-cloudflare/src/{worker,bootstrap}.ts`

**Files:**
- Create: `apps/platform-cloudflare/src/worker.ts`
- Create: `apps/platform-cloudflare/src/bootstrap.ts`
- Delete: `packages/gateway/entry-cloudflare.ts`

- [ ] **Step 1: Implement `bootstrap.ts`**

`apps/platform-cloudflare/src/bootstrap.ts`:
```ts
import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
  type SqlDatabase,
} from "@vnext/platform"
import { initRepo } from "@vnext/gateway/src/shared/repo/index.ts"
import { initCache } from "@vnext/gateway/src/shared/cache/index.ts"
import { initResponsesStore } from "@vnext/gateway/src/shared/runtime/responses-store.ts"
import { D1Repo } from "./d1-repo.ts"
import { createCloudflareImageProcessor } from "./cloudflare-image-processor.ts"
import { createCloudflareCache } from "./cache-factory.ts"
import { createD1ResponsesStore } from "./responses-store-factory.ts"

export interface CloudflareEnv {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  CACHE_BACKEND?: string
}

let _booted = false

export function bootstrapCloudflarePlatform(env: CloudflareEnv, ctx: ExecutionContext): void {
  if (_booted) return
  if (!env.DB) throw new Error("CFW bootstrap: env.DB binding missing")
  if (!env.KV) throw new Error("CFW bootstrap: env.KV binding missing")
  if (!env.IMAGES) throw new Error("CFW bootstrap: env.IMAGES binding missing")

  initSqlDatabase(env.DB as unknown as SqlDatabase)
  initEnv((name) => String((env as Record<string, unknown>)[name] ?? ""))
  initBackground({ waitUntil: (p) => ctx.waitUntil(p) })
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES, env.IMAGE_CACHE))
  initRepo(new D1Repo(env.DB))
  initCache(createCloudflareCache({ DB: env.DB, KV: env.KV, CACHE_BACKEND: env.CACHE_BACKEND }))
  initResponsesStore(createD1ResponsesStore(env.DB))
  _booted = true
}
```

- [ ] **Step 2: Implement `worker.ts`**

`apps/platform-cloudflare/src/worker.ts`:
```ts
import { app } from "@vnext/gateway/src/app.ts"
import { bootstrapCloudflarePlatform, type CloudflareEnv } from "./bootstrap.ts"

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    return app.fetch(req, env, ctx)
  },
} satisfies ExportedHandler<CloudflareEnv>
```

- [ ] **Step 3: Move `wrangler.jsonc`**

```bash
cd vnext
git mv packages/gateway/wrangler.jsonc apps/platform-cloudflare/wrangler.jsonc
```

Edit `apps/platform-cloudflare/wrangler.jsonc`:
- `"main": "src/worker.ts"` (was `"entry-cloudflare.ts"`)
- `"migrations_dir": "../../migrations"` — confirm this still resolves (was `../../migrations` from `apps/gateway/`, now `../../migrations` from `apps/platform-cloudflare/` → same depth, OK).

- [ ] **Step 4: Delete the old entry**

```bash
cd vnext
git rm packages/gateway/entry-cloudflare.ts
```

- [ ] **Step 5: Move CFW devDeps off gateway**

Edit `packages/gateway/package.json` — remove `@cloudflare/workers-types` and `wrangler` from `devDependencies`. Both already exist in `apps/platform-cloudflare/package.json` (Task 2).

- [ ] **Step 6: Wrangler dry-run**

```bash
cd vnext && bun install
cd vnext/apps/platform-cloudflare && bunx wrangler deploy --dry-run --outdir dist 2>&1 | tail -10
```
Expected: bundles successfully.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(platform-cloudflare): add worker.ts + bootstrap.ts; move wrangler.jsonc"
```

---

## Task 7: `apps/platform-bun/src/{server,bootstrap}.ts`

**Files:**
- Create: `apps/platform-bun/src/server.ts`
- Create: `apps/platform-bun/src/bootstrap.ts`
- Delete: `packages/gateway/entry-bun.ts`

- [ ] **Step 1: Implement `bootstrap.ts`**

`apps/platform-bun/src/bootstrap.ts`:
```ts
import { Database } from "bun:sqlite"
import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
} from "@vnext/platform"
import { initRepo } from "@vnext/gateway/src/shared/repo/index.ts"
import { initCache } from "@vnext/gateway/src/shared/cache/index.ts"
import { initResponsesStore } from "@vnext/gateway/src/shared/runtime/responses-store.ts"
import { BunSqliteDatabase } from "./bun-sqlite-database.ts"
import { BunSqliteRepo } from "./bun-sqlite-repo.ts"
import { createInMemoryImageProcessor } from "./memory-image-processor.ts"
import { createBunCache } from "./cache-factory.ts"
import { createBunResponsesStore } from "./responses-store-factory.ts"

export interface BunPlatformOptions {
  dbPath: string
  cacheBackend?: string
}

let _booted = false

export function bootstrapBunPlatform(opts: BunPlatformOptions): { db: BunSqliteDatabase } {
  if (_booted) throw new Error("bootstrapBunPlatform already called")
  const sqliteDb = new Database(opts.dbPath)
  const db = new BunSqliteDatabase(sqliteDb)

  initSqlDatabase(db)
  initEnv((name) => process.env[name] ?? "")
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initImageProcessor(createInMemoryImageProcessor())
  initRepo(new BunSqliteRepo(sqliteDb))
  initCache(createBunCache({ db, backend: opts.cacheBackend }))
  initResponsesStore(createBunResponsesStore(db))
  _booted = true
  return { db }
}
```

(Note: gateway's old `SqliteRepo` is renamed `BunSqliteRepo` when moved in Task 4 — class name follows file name.)

- [ ] **Step 2: Implement `server.ts`**

`apps/platform-bun/src/server.ts`:
```ts
import { app } from "@vnext/gateway/src/app.ts"
import { bootstrapBunPlatform } from "./bootstrap.ts"

const dbPath = process.env.VNEXT_DB_PATH ?? ".vnext-local.sqlite"
bootstrapBunPlatform({
  dbPath,
  cacheBackend: process.env.CACHE_BACKEND,
})

// Docker compose sets PORT=41415; bare local runs fall back to 8788.
const port = Number(process.env.PORT ?? 8788)
Bun.serve({ port, fetch: app.fetch })
console.log(`vnext gateway (bun) listening on http://localhost:${port}`)
console.log(`  sqlite file: ${dbPath}`)
```

- [ ] **Step 3: Delete the old entry**

```bash
cd vnext
git rm packages/gateway/entry-bun.ts
```

- [ ] **Step 4: Smoke run**

```bash
cd vnext/apps/platform-bun && PORT=8788 VNEXT_DB_PATH=/tmp/a3-smoke.sqlite bun run src/server.ts &
sleep 1
curl -fsS http://localhost:8788/health
kill %1
rm -f /tmp/a3-smoke.sqlite
```
Expected: `{"status":"ok","service":"copilot-gateway-vnext"}`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform-bun): add server.ts + bootstrap.ts; remove gateway/entry-bun.ts"
```

---

## Task 8: Move `Dockerfile` and update `docker-compose.vnext.yml`

**Files:**
- Move: `vnext/Dockerfile` → `vnext/apps/platform-bun/Dockerfile`
- Modify: `docker-compose.vnext.yml`
- Modify: the Dockerfile contents (paths shift)

- [ ] **Step 1: Move and edit Dockerfile**

```bash
git mv vnext/Dockerfile vnext/apps/platform-bun/Dockerfile
```

Edits inside `vnext/apps/platform-bun/Dockerfile`:
1. Build context will still be `./vnext` (unchanged), so `COPY` paths starting with `apps/`, `packages/`, `scripts/` keep working.
2. Add per-package manifest copies for the new packages:
   ```
   COPY apps/platform-bun/package.json apps/platform-bun/
   COPY apps/platform-cloudflare/package.json apps/platform-cloudflare/
   COPY packages/gateway/package.json packages/gateway/
   COPY packages/platform/package.json packages/platform/
   ```
3. Remove the old `COPY apps/gateway/package.json apps/gateway/` line.
4. Final `WORKDIR` and `CMD`:
   ```
   WORKDIR /app/apps/platform-bun
   CMD ["bun", "run", "src/server.ts"]
   ```
5. Comment about dashboard build output path — update from `apps/gateway/src/shared/edge/...` to `packages/gateway/src/shared/edge/...`.

- [ ] **Step 2: Edit `docker-compose.vnext.yml`**

```yaml
build:
  context: ./vnext
  dockerfile: apps/platform-bun/Dockerfile
```

- [ ] **Step 3: Build + run**

```bash
docker compose -f docker-compose.vnext.yml build gateway-vnext
docker compose -f docker-compose.vnext.yml up -d gateway-vnext
sleep 3
curl -fsS http://localhost:41415/health
docker compose -f docker-compose.vnext.yml down
```
Expected: `{"status":"ok"}`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build: move Dockerfile to apps/platform-bun/; update docker-compose path"
```

---

## Task 9: Update `scripts/build-dashboard.ts` output path + tests using moved impls

**Files:**
- Modify: `vnext/scripts/build-dashboard.ts`
- Modify: `packages/gateway/tests/_setup-platform.ts` (created in A2)
- Modify: any test file that imports from removed gateway-internal modules

- [ ] **Step 1: Update build-dashboard.ts**

Line 10: change
```ts
const out = `${root}/apps/gateway/src/shared/edge/ui-pages/dashboard-app/dist`
```
to
```ts
const out = `${root}/packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist`
```

- [ ] **Step 2: Build dashboard once and verify outputs land at the new path**

```bash
cd vnext && bun run build:ui
ls packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/
```
Expected: `dashboard.js`, `dashboard.css`, `dashboard.js.txt`, `dashboard.css.txt`.

- [ ] **Step 3: Update `_setup-platform.ts`**

The helper currently imports from gateway-local paths that have moved:
- `import { SqliteRepo } from "../src/shared/repo/sqlite.ts"` → `import { BunSqliteRepo } from "@vnext/platform-bun/src/bun-sqlite-repo.ts"` (test wires Bun directly — gateway tests run under Bun)
- `import { createInMemoryImageProcessor } from "../src/shared/image/memory.ts"` → `import { createInMemoryImageProcessor } from "@vnext/platform-bun/src/memory-image-processor.ts"`

Add `@vnext/platform-bun` as a `devDependency` in `packages/gateway/package.json`:
```json
"devDependencies": {
  "@vnext/platform-bun": "workspace:*"
}
```

- [ ] **Step 4: Inventory tests still importing relocated modules**

```bash
cd vnext && rg "shared/repo/sqlite|shared/repo/d1|shared/image/cloudflare|shared/image/memory|shared/runtime/responses-store-factory|shared/cache/factory" packages/gateway/tests/
```

- [ ] **Step 5: Migrate each match**

Each test gets its import retargeted at `@vnext/platform-bun/...` (since tests run on Bun). For tests that previously poked at `D1Repo`/`createCloudflareImageProcessor` directly (CFW-specific paths), check whether they actually need to: most likely they were generic. If a test really targets CFW specifics, it can import from `@vnext/platform-cloudflare/...` — that's allowed in dev-only test deps.

- [ ] **Step 6: Run all tests**

```bash
cd vnext && bun test 2>&1 | tail -15
```
Expected: same green as before A3.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test+build: retarget tests and build:ui at new package paths"
```

---

## Task 10: Optional — relocate `copilot-token-cache.ts`

Per spec §2.6.

**Files:**
- Move: `packages/gateway/src/shared/copilot-token-cache.ts` → `packages/provider-copilot/src/token-cache.ts`

- [ ] **Step 1: Inventory callers**

```bash
cd vnext && rg "copilot-token-cache|getCachedCopilotToken" packages/gateway/ packages/provider-copilot/
```

- [ ] **Step 2: Move**

```bash
cd vnext
git mv packages/gateway/src/shared/copilot-token-cache.ts packages/provider-copilot/src/token-cache.ts
```

- [ ] **Step 3: Update its internal imports**

`packages/provider-copilot/src/token-cache.ts` imports `./config/constants.ts` from gateway. Either:
- (a) Re-export the needed constants from gateway: add to `packages/gateway/src/shared/config/constants.ts` as named exports, then `import { GITHUB_API_BASE_URL, ... } from "@vnext/gateway/src/shared/config/constants.ts"`.
- (b) Inline the constants into provider-copilot.

Pick (a) if the constants are small (3-5 names) — preserves single source of truth.

- [ ] **Step 4: Add provider-copilot dep on gateway (if (a) chosen)**

This may create a cycle (gateway already depends on provider-copilot). Check:
```bash
cd vnext && rg "@vnext/provider-copilot" packages/gateway/package.json packages/provider-copilot/package.json
```
If gateway depends on provider-copilot, and provider-copilot also imports from gateway, we have a cycle. **In that case use option (b)** — copy 3-5 constants into provider-copilot.

- [ ] **Step 5: Update gateway callers**

```bash
cd vnext && rg "from.*shared/copilot-token-cache" packages/gateway/
```
Each match → `import { getCachedCopilotToken } from "@vnext/provider-copilot/src/token-cache.ts"`.

- [ ] **Step 6: Tests + commit**

```bash
cd vnext && bun test 2>&1 | tail -10
git add -A
git commit -m "refactor: move copilot-token-cache to @vnext/provider-copilot"
```

If this task hits dependency-cycle issues, **abort the move** — drop a one-line note in the spec saying it's deferred to Spec B and revert with `git restore`. The rest of A3 stands without this.

---

## Task 11: Final verification

- [ ] **Step 1: Verify directory layout**

```bash
cd vnext
test ! -d apps/gateway && echo "OK: apps/gateway removed"
test -d packages/gateway && echo "OK: packages/gateway exists"
test -d apps/platform-bun && echo "OK: platform-bun exists"
test -d apps/platform-cloudflare && echo "OK: platform-cloudflare exists"
test -f apps/platform-bun/Dockerfile && echo "OK: Dockerfile relocated"
test -f apps/platform-cloudflare/wrangler.jsonc && echo "OK: wrangler relocated"
test ! -f Dockerfile && echo "OK: vnext/Dockerfile gone"
test ! -f packages/gateway/entry-bun.ts && echo "OK: entry-bun gone"
test ! -f packages/gateway/entry-cloudflare.ts && echo "OK: entry-cloudflare gone"
```

- [ ] **Step 2: Verify gateway has no CFW or Bun runtime types**

```bash
cd vnext && rg "D1Database|KVNamespace|ImagesBinding|bun:sqlite" packages/gateway/src/
```
Expected: empty. (Tests in `packages/gateway/tests/` may still reference Bun for in-memory setup — those are fine; this check targets `src/` only.)

- [ ] **Step 3: Verify orphan check**

```bash
cd vnext && rg "shared/repo/d1|shared/repo/sqlite|shared/image/cloudflare|shared/image/memory|shared/runtime/responses-store-factory|shared/cache/factory" .
```
Expected: empty (nothing imports the moved files via their old paths).

- [ ] **Step 4: Full repo test**

```bash
cd vnext && bun test 2>&1 | tail -10
```
Expected: same pass count as before A3.

- [ ] **Step 5: Wrangler dry-run from new location**

```bash
cd vnext/apps/platform-cloudflare && bunx wrangler deploy --dry-run --outdir dist 2>&1 | tail -10
```
Expected: bundle successful.

- [ ] **Step 6: Bun smoke from new location**

```bash
cd vnext/apps/platform-bun && PORT=8788 VNEXT_DB_PATH=/tmp/a3-final.sqlite bun run src/server.ts &
sleep 1
curl -fsS http://localhost:8788/health && echo
kill %1
rm -f /tmp/a3-final.sqlite
```

- [ ] **Step 7: Docker build + run**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
docker compose -f docker-compose.vnext.yml build gateway-vnext
docker compose -f docker-compose.vnext.yml up -d gateway-vnext
sleep 5
curl -fsS http://localhost:41415/health && echo
docker compose -f docker-compose.vnext.yml down
```

- [ ] **Step 8: Confirm all spec §7 acceptance criteria are green**

Walk through `vnext/docs/superpowers/specs/2026-06-14-platform-extraction-design.md` §7 line by line. Every box should be checkable.

---

## Self-Review Checklist

- [ ] `apps/gateway/` directory does not exist.
- [ ] `packages/gateway/src/` contains no `D1Database` / `KVNamespace` / `ImagesBinding` / `bun:sqlite` references.
- [ ] `packages/gateway/src/shared/repo/d1.ts` / `sqlite.ts` removed; `shared/image/cloudflare.ts` / `memory.ts` removed; `shared/runtime/responses-store-factory.ts` removed; `shared/cache/factory.ts` removed.
- [ ] `apps/platform-cloudflare/` and `apps/platform-bun/` are the only places with CFW / Bun runtime imports.
- [ ] `vnext/Dockerfile` removed; `vnext/apps/platform-bun/Dockerfile` exists.
- [ ] `wrangler.jsonc` lives only at `apps/platform-cloudflare/wrangler.jsonc`.
- [ ] `docker-compose.vnext.yml` points at `apps/platform-bun/Dockerfile`.
- [ ] `scripts/build-dashboard.ts` writes to `packages/gateway/...`.
- [ ] `bun test` passes from `vnext/`.
- [ ] `wrangler deploy --dry-run` passes from `apps/platform-cloudflare/`.
- [ ] `docker compose build` + `up` works end-to-end with `/health` returning 200.

## Acceptance Criteria

Same as spec §7 — every bullet there is testable in this plan via the checks in Task 11. If any is red, A3 isn't done.

## Hand-off

After A3 lands, Spec A is complete. Queued follow-ups:

- **Spec B:** Provider factory map + token-cache full relocation + `data-plane/routes.ts` split.
- **Spec C:** Move Copilot-specific transforms into `provider-copilot`.
- **Spec D:** Tighten `ModelProvider` contract.
