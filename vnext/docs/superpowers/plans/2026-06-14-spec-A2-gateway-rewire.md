# Spec A — Plan A2: gateway dependency-injection rewire

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace gateway's bespoke `_x | null + _override + onXReset` accessor pattern with `@vnext/platform` injection. Drop CFW-specific types from `Env` and remove the first-request bootstrap middleware. After A2, `apps/gateway` is runtime-agnostic at the source level — but its **directory location is unchanged** (still `apps/gateway/`). Physical relocation is A3.

**Architecture:** Gateway code reads runtime impls through `@vnext/platform` getters (`getSqlDatabase`, `getImageProcessor`, etc.). For seams not in the platform package (Repo, Cache, ResponsesStore), gateway keeps its own accessors but normalizes them to the same shape (`initX` / `getX` throws / registers via `__registerPlatformReset`). Tests use `__resetPlatformForTests()` + direct `initX()` calls. Production bootstrapping still happens via the existing `entry-bun.ts` and `entry-cloudflare.ts` shells (those become A3's new platform apps).

**Tech Stack:** Same as gateway today — Hono, Bun, Cloudflare Workers, `@vnext/shared-cache`, `@vnext/responses-store`.

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-14-platform-extraction-design.md` §2.

**Depends on:** Plan A1 (platform package must exist).

**Out of scope for A2:**
- Moving `apps/gateway/` to `packages/gateway/` (A3).
- Creating `apps/platform-{bun,cloudflare}/` (A3).
- Moving `d1.ts` / `sqlite.ts` / `cloudflare.ts` / `memory.ts` / `responses-store-factory.ts` out of gateway (A3).
- Moving `copilot-token-cache.ts` to provider-copilot (A3 or follow-up).
- Updating Dockerfile / wrangler / docker-compose / build:ui paths (A3).

---

## File Structure (changes only)

```
vnext/apps/gateway/
├── package.json                              add "@vnext/platform" dep
├── src/
│   ├── app.ts                                Env shrinks; first-request middleware deleted
│   ├── shared/
│   │   ├── repo/
│   │   │   └── index.ts                      drop _override / setRepoForTest / setRepoOverride / clearRepoOverride / onRepoReset; keep initRepo + getRepo; register reset callback
│   │   ├── cache/
│   │   │   └── index.ts                      same shape change as repo/index.ts
│   │   ├── image/
│   │   │   └── index.ts                      switch to platform's getImageProcessor; drop local registry
│   │   └── runtime/
│   │       └── responses-store.ts            NEW — initResponsesStore / getResponsesStore accessor (gateway-internal seam)
│   └── data-plane/routes.ts                  read from getResponsesStore() instead of c.env.responsesStore
├── entry-bun.ts                              call initRepo / initCache / initImageProcessor / initResponsesStore + initSqlDatabase / initBackground (no-op) up front
├── entry-cloudflare.ts                       call the same initX functions inside fetch()
└── tests/
    ├── _setup-platform.ts                    NEW — beforeEach helper that resets + bootstraps an in-memory stack
    └── *.test.ts                             ~41 files updated: replace setRepoForTest / setCacheForTest with initRepo / initCache + __resetPlatformForTests
```

**No file is moved or deleted.** Only edits, with one new file per location: `runtime/responses-store.ts` and `tests/_setup-platform.ts`.

---

## Task 1: Add `@vnext/platform` to gateway dependencies

**Files:**
- Modify: `vnext/apps/gateway/package.json`

- [ ] **Step 1: Add the dependency**

`vnext/apps/gateway/package.json` — add into `dependencies` (alphabetical):
```json
"@vnext/platform": "workspace:*",
```

- [ ] **Step 2: Refresh workspace install**

```bash
cd vnext && bun install
```
Expected: `vnext/apps/gateway/node_modules/@vnext/platform` symlink exists.

- [ ] **Step 3: Smoke import**

```bash
cd vnext/apps/gateway && bun -e 'import("@vnext/platform").then(m => console.log(Object.keys(m).sort()))'
```
Expected: array containing `__resetPlatformForTests`, `getSqlDatabase`, `getFileProvider`, `getImageProcessor`, `env`, `waitUntil`, etc.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/package.json vnext/bun.lock
git commit -m "chore(gateway): depend on @vnext/platform"
```

---

## Task 2: Rewire `shared/repo/index.ts` to platform-style accessor

**Why first:** Repo has the most callers and the most test surface. Getting the shape right here sets the pattern for cache/image/responses-store.

**Files:**
- Modify: `vnext/apps/gateway/src/shared/repo/index.ts`
- Test: `vnext/apps/gateway/tests/repo/index.test.ts` (NEW — verifies the new contract)

- [ ] **Step 1: Write the failing test**

`vnext/apps/gateway/tests/repo/index.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test"
import { initRepo, getRepo } from "../../src/shared/repo/index.ts"
import { __resetPlatformForTests } from "@vnext/platform"
import { SqliteRepo } from "../../src/shared/repo/sqlite.ts"
import { Database } from "bun:sqlite"

beforeEach(() => __resetPlatformForTests())

test("getRepo throws before init", () => {
  expect(() => getRepo()).toThrow(/Repo not initialized/)
})

test("init/get round-trip", () => {
  const repo = new SqliteRepo(new Database(":memory:"))
  initRepo(repo)
  expect(getRepo()).toBe(repo)
})

test("__resetPlatformForTests clears the slot", () => {
  initRepo(new SqliteRepo(new Database(":memory:")))
  __resetPlatformForTests()
  expect(() => getRepo()).toThrow(/Repo not initialized/)
})
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
cd vnext && bun test apps/gateway/tests/repo/index.test.ts
```
Expected: third test fails because reset doesn't currently clear `_repo`.

- [ ] **Step 3: Rewrite `shared/repo/index.ts`**

Replace the full file content with:
```ts
import type { Repo } from "./types"
import { __registerPlatformReset } from "@vnext/platform"

export type {
  Repo, ApiKey, GitHubAccount, GitHubUser, UpstreamRecord, UpstreamRepo,
  UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence,
  WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo,
} from "./types"
export { D1Repo } from "./d1"

let _repo: Repo | null = null
__registerPlatformReset(() => { _repo = null })

export function initRepo(repo: Repo): void {
  _repo = repo
}

export function getRepo(): Repo {
  if (!_repo) throw new Error("Repo not initialized; call initRepo() first")
  return _repo
}
```

Removed exports: `setRepoForTest`, `setRepoOverride`, `clearRepoOverride`, `onRepoReset`.

- [ ] **Step 4: Run test, verify PASS**

```bash
cd vnext && bun test apps/gateway/tests/repo/index.test.ts
```
Expected: 3 pass.

- [ ] **Step 5: Identify all callers of the removed exports**

```bash
cd vnext && rg -l "setRepoForTest|setRepoOverride|clearRepoOverride|onRepoReset" apps/gateway/
```
Save the list — Task 3 will fix every one.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/gateway/src/shared/repo/index.ts vnext/apps/gateway/tests/repo/index.test.ts
git commit -m "refactor(gateway/repo): drop _override path; use platform reset registry"
```

(Build will be broken at this commit — fix in Task 3. This is acceptable because we're working on a feature branch and the per-task commits make bisecting easier; the next commit restores green.)

---

## Task 3: Migrate every call-site from `setRepoForTest` / `setRepoOverride` / `clearRepoOverride` / `onRepoReset`

**Strategy:**
- `setRepoForTest(r)` and `setRepoOverride(r)` → `initRepo(r)` (after `__resetPlatformForTests()` if a clean slot is needed)
- `setRepoForTest(null)` / `clearRepoOverride()` → `__resetPlatformForTests()`
- `onRepoReset(cb)` callers — each was registering a cache invalidation. Inline the callback as: register the cb via `__registerPlatformReset(cb)` instead. (Only ~2-3 call sites — verify by grep.)

**Files:**
- Modify: every file from the Task 2 grep output (typically ~30-40 files in `tests/` plus a handful in `src/data-plane/`).

- [ ] **Step 1: Audit callers**

```bash
cd vnext && rg -n "setRepoForTest|setRepoOverride|clearRepoOverride|onRepoReset" apps/gateway/ > /tmp/repo-callers.txt
wc -l /tmp/repo-callers.txt
```

- [ ] **Step 2: Migrate `onRepoReset` (production code first, smallest)**

Look at each match. Each `onRepoReset(cb)` becomes:
```ts
import { __registerPlatformReset } from "@vnext/platform"
__registerPlatformReset(cb)
```

The semantics differ slightly: `onRepoReset` only fires when the repo swaps; `__registerPlatformReset` fires when *anything* in the platform resets. For the existing callers (cache invalidations keyed off repo state), this is fine — over-invalidating is safe.

- [ ] **Step 3: Verify by typecheck**

```bash
cd vnext/apps/gateway && bun run typecheck
```
Expected: no `setRepoForTest` / `setRepoOverride` / `clearRepoOverride` / `onRepoReset` errors. If typecheck reports remaining import errors for these names, finish migrating those files.

- [ ] **Step 4: Migrate test files in batch**

For each test file using `setRepoForTest(repo)`:
```ts
// before
import { setRepoForTest } from "../src/shared/repo/index.ts"
beforeEach(() => setRepoForTest(repo))

// after
import { initRepo } from "../src/shared/repo/index.ts"
import { __resetPlatformForTests } from "@vnext/platform"
beforeEach(() => {
  __resetPlatformForTests()
  initRepo(repo)
})
```

For `setRepoForTest(null)` or `clearRepoOverride()`:
```ts
afterEach(() => __resetPlatformForTests())
```

- [ ] **Step 5: Run all gateway tests**

```bash
cd vnext && bun test apps/gateway/tests
```
Expected: green (or same failures as on `vNext` HEAD before this PR — none new).

- [ ] **Step 6: Commit**

```bash
git add -A vnext/apps/gateway/
git commit -m "refactor(gateway): migrate all repo-injection call-sites to initRepo + platform reset"
```

---

## Task 4: Rewire `shared/cache/index.ts` (same shape as repo)

**Files:**
- Modify: `vnext/apps/gateway/src/shared/cache/index.ts`
- Modify: every file using `setCacheForTest` or `_resetCacheForTest` or `onCacheReset`
- Test: `vnext/apps/gateway/tests/shared-cache-bootstrap.test.ts` (already exists — adjust if needed)

- [ ] **Step 1: Inventory cache callers**

```bash
cd vnext && rg -n "setCacheForTest|_resetCacheForTest|onCacheReset" apps/gateway/
```

- [ ] **Step 2: Rewrite `shared/cache/index.ts`**

```ts
import type { Cache } from "@vnext/shared-cache"
import { __registerPlatformReset } from "@vnext/platform"

let _cache: Cache | null = null
__registerPlatformReset(() => { _cache = null })

export function initCache(cache: Cache): void {
  _cache = cache
}

export function getCache(): Cache {
  if (!_cache) throw new Error("Cache not initialized; call initCache() first")
  return _cache
}
```

Removed: `setCacheForTest`, `_resetCacheForTest`, `onCacheReset`.

- [ ] **Step 3: Migrate callers**

Same translation table as Task 3:
- `setCacheForTest(c)` → `initCache(c)` (with prior `__resetPlatformForTests()` if needed)
- `setCacheForTest(null)` / `_resetCacheForTest()` → `__resetPlatformForTests()`
- `onCacheReset(cb)` → `__registerPlatformReset(cb)`

- [ ] **Step 4: Typecheck + test**

```bash
cd vnext/apps/gateway && bun run typecheck
cd vnext && bun test apps/gateway/tests
```
Both green.

- [ ] **Step 5: Commit**

```bash
git add -A vnext/apps/gateway/
git commit -m "refactor(gateway/cache): use platform reset registry; drop _override slot"
```

---

## Task 5: Switch `shared/image/index.ts` to use `@vnext/platform`'s ImageProcessor accessor

**Why this is different:** ImageProcessor *is* one of the 5 platform seams. Gateway doesn't need its own accessor — it should import directly from `@vnext/platform`.

**Files:**
- Modify: `vnext/apps/gateway/src/shared/image/index.ts`
- Modify: every file calling the gateway's `initImageProcessor` or `getImageProcessor`

- [ ] **Step 1: Inventory image callers**

```bash
cd vnext && rg -n "from.*shared/image['\"]|initImageProcessor|getImageProcessor|hasImageProcessor" apps/gateway/
```

- [ ] **Step 2: Confirm interface compatibility**

The gateway's `ImageProcessor` interface (in `shared/image/types.ts`) and platform's `ImageProcessor` interface must be structurally identical. Read both files side by side. If they match, gateway's `index.ts` can re-export from platform. If they diverge, reconcile by editing platform's interface to match gateway's (gateway's existing callers are the ground truth).

- [ ] **Step 3: Rewrite `shared/image/index.ts` as a re-export façade**

```ts
import {
  initImageProcessor,
  getImageProcessor,
  type ImageProcessor,
  type CompressOpts,
  type CompressedImage,
} from "@vnext/platform"

export { initImageProcessor, getImageProcessor }
export type { ImageProcessor, CompressOpts, CompressedImage }

// Keep re-exports of gateway-local helpers
export { fitWithin, type SizeCaps } from "./size"
export {
  isBase64ImageDataUrl,
  compressBase64ImageToWebp,
  compressImageDataUrlToWebp,
} from "./inline"
// Note: createInMemoryImageProcessor, createCloudflareImageProcessor,
// ImagesBinding, ImageCacheKv, ImageDimensions, ImageSizeCalculator
// remain re-exported from their original modules — they move out in A3.
export { createInMemoryImageProcessor } from "./memory"
export {
  createCloudflareImageProcessor,
  type ImagesBinding,
  type ImageCacheKv,
} from "./cloudflare"
export type { ImageDimensions, ImageSizeCalculator } from "./types"
```

Drop `hasImageProcessor` — replace any caller with a try/catch on `getImageProcessor()`. Grep first; there are typically 0-2 call sites.

- [ ] **Step 4: Typecheck**

```bash
cd vnext/apps/gateway && bun run typecheck
```

- [ ] **Step 5: Run tests**

```bash
cd vnext && bun test apps/gateway/tests
```

- [ ] **Step 6: Commit**

```bash
git add -A vnext/apps/gateway/
git commit -m "refactor(gateway/image): delegate to @vnext/platform ImageProcessor seam"
```

---

## Task 6: Add gateway-internal `responses-store` accessor

**Why a gateway-internal seam (not platform):** The `ResponsesSnapshotStore` interface lives in `@vnext/responses-store` and is gateway-specific (no other consumer). Platform stays minimal — only the 5 universal seams.

**Files:**
- Create: `vnext/apps/gateway/src/shared/runtime/responses-store.ts`
- Test: `vnext/apps/gateway/tests/responses-store-accessor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test"
import {
  initResponsesStore,
  getResponsesStore,
} from "../src/shared/runtime/responses-store.ts"
import { __resetPlatformForTests } from "@vnext/platform"
import { InMemoryResponsesSnapshotStore } from "@vnext/responses-store"

beforeEach(() => __resetPlatformForTests())

test("getResponsesStore throws before init", () => {
  expect(() => getResponsesStore()).toThrow(/ResponsesStore not initialized/)
})

test("init/get round-trip", () => {
  const s = new InMemoryResponsesSnapshotStore()
  initResponsesStore(s)
  expect(getResponsesStore()).toBe(s)
})

test("reset clears", () => {
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  __resetPlatformForTests()
  expect(() => getResponsesStore()).toThrow()
})
```

- [ ] **Step 2: Implement**

`vnext/apps/gateway/src/shared/runtime/responses-store.ts`:
```ts
import type { ResponsesSnapshotStore } from "@vnext/responses-store"
import { __registerPlatformReset } from "@vnext/platform"

let _store: ResponsesSnapshotStore | null = null
__registerPlatformReset(() => { _store = null })

export function initResponsesStore(store: ResponsesSnapshotStore): void {
  _store = store
}

export function getResponsesStore(): ResponsesSnapshotStore {
  if (!_store) throw new Error("ResponsesStore not initialized; call initResponsesStore() first")
  return _store
}
```

- [ ] **Step 3: Run test, verify PASS**

```bash
cd vnext && bun test apps/gateway/tests/responses-store-accessor.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/shared/runtime/responses-store.ts vnext/apps/gateway/tests/responses-store-accessor.test.ts
git commit -m "feat(gateway): add initResponsesStore/getResponsesStore accessor"
```

---

## Task 7: Migrate `c.env.responsesStore` callers and tests to the new accessor

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts` (and any sub-route reading `c.env.responsesStore`)
- Modify: `vnext/apps/gateway/tests/responses-snapshot-id-roundtrip.test.ts`
- Modify: `vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`

- [ ] **Step 1: Inventory**

```bash
cd vnext && rg -n "responsesStore" apps/gateway/src apps/gateway/tests
```
Expected: handful of hits — the middleware in `app.ts`, route handlers in `data-plane/`, and 2 test files.

- [ ] **Step 2: Update production read sites**

Every `c.env.responsesStore` becomes `getResponsesStore()`:
```ts
// before
const store = c.env.responsesStore
if (!store) return c.json({ error: "..." }, 500)

// after
import { getResponsesStore } from "../shared/runtime/responses-store.ts"
const store = getResponsesStore()
```

Drop the null-check — `getResponsesStore()` throws if not bootstrapped, which is the correct production posture.

- [ ] **Step 3: Update test files**

Replace `(c.env as ...).responsesStore = store` with:
```ts
import { initResponsesStore } from "../src/shared/runtime/responses-store.ts"
beforeEach(() => initResponsesStore(store))
```

Place the `initResponsesStore` call after any `__resetPlatformForTests()` to avoid being clobbered.

- [ ] **Step 4: Typecheck + test**

```bash
cd vnext/apps/gateway && bun run typecheck
cd vnext && bun test apps/gateway/tests
```

- [ ] **Step 5: Commit**

```bash
git add -A vnext/apps/gateway/
git commit -m "refactor(gateway/responses): read store via getResponsesStore() accessor"
```

---

## Task 8: Drop CFW types and first-request middleware from `app.ts`

**Files:**
- Modify: `vnext/apps/gateway/src/app.ts`

- [ ] **Step 1: Read the new app.ts target shape** (already in spec §2.1)

- [ ] **Step 2: Replace `app.ts`**

```ts
import { Hono } from 'hono'
import { dataPlane } from './data-plane/routes.ts'
import { controlPlane } from './control-plane/routes.ts'
import { staticPages } from './shared/edge/static-pages.ts'
import { getRepo } from './shared/repo/index.ts'
import { devAuthMiddleware } from './shared/dev-auth.ts'
import { sessionAuthMiddleware } from './shared/session-auth.ts'

export interface Env {
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'copilot-gateway-vnext' }))

app.get('/debug/db/users-count', async (c) => {
  const users = await getRepo().users.list()
  return c.json({ users: users.length })
})

app.use('*', devAuthMiddleware)
app.use('*', sessionAuthMiddleware)

app.route('/', dataPlane)
app.route('/', controlPlane)
app.route('/', staticPages)
```

Removed:
- `D1Database` / `KVNamespace` / `ImagesBinding` types from `Env`
- `CACHE_BACKEND`, `responsesStore?` fields from `Env`
- `import { createD1ResponsesStore }` / `import { initCache, createCacheFromEnv }`
- The `let _cacheBootstrapped = false` block and the `app.use('*', async (c, next) => { ... })` middleware

- [ ] **Step 3: Run typecheck**

```bash
cd vnext/apps/gateway && bun run typecheck
```
Expect: typecheck might fail if any `c.env.DB` / `c.env.KV` / `c.env.IMAGES` reads remain elsewhere. Grep for those:
```bash
cd vnext && rg -n "c\.env\.(DB|KV|IMAGE_CACHE|IMAGES|CACHE_BACKEND|responsesStore)" apps/gateway/src
```
Each remaining read must switch to `getX()` — repo via `getRepo()`, cache via `getCache()`, image via `getImageProcessor()`, etc. (Most should already be migrated by Tasks 2–7. This catches stragglers.)

- [ ] **Step 4: Run tests**

```bash
cd vnext && bun test apps/gateway/tests
```

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/app.ts
git commit -m "refactor(gateway/app): drop CFW types from Env; remove first-request bootstrap"
```

---

## Task 9: Update production entry points to bootstrap synchronously

**Files:**
- Modify: `vnext/apps/gateway/entry-bun.ts`
- Modify: `vnext/apps/gateway/entry-cloudflare.ts`

These two files become the de-facto bootstrap shells until A3 splits them into proper platform apps. They MUST call every `initX` before `app.fetch` is reachable.

- [ ] **Step 1: Read current entry-bun.ts**

```bash
cat vnext/apps/gateway/entry-bun.ts
```

- [ ] **Step 2: Update `entry-bun.ts`**

Add at the top, before `Bun.serve`:
```ts
import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
} from "@vnext/platform"
import { initRepo } from "./src/shared/repo/index.ts"
import { initCache } from "./src/shared/cache/index.ts"
import { initResponsesStore } from "./src/shared/runtime/responses-store.ts"
import { SqliteRepo } from "./src/shared/repo/sqlite.ts"
import { createCacheFromEnv } from "./src/shared/cache/factory.ts"
import { createInMemoryImageProcessor } from "./src/shared/image/memory.ts"
import { createD1ResponsesStore } from "./src/shared/runtime/responses-store-factory.ts"
import { Database } from "bun:sqlite"

const dbPath = process.env.VNEXT_DB_PATH ?? ".vnext-local.sqlite"
const sqliteDb = new Database(dbPath)

// Wire the 5 platform seams + 3 gateway-internal seams.
initSqlDatabase(sqliteDb as unknown as import("@vnext/platform").SqlDatabase)
initEnv((name) => process.env[name] ?? "")
initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
initImageProcessor(createInMemoryImageProcessor())
initRepo(new SqliteRepo(sqliteDb))
initCache(createCacheFromEnv({ DB: sqliteDb }, { CACHE_BACKEND: process.env.CACHE_BACKEND }))
initResponsesStore(createD1ResponsesStore(sqliteDb))
```

(NOTE: the `SqlDatabase` adapter cast is temporary; A3 introduces a proper `BunSqliteDatabase` wrapper.)

- [ ] **Step 3: Update `entry-cloudflare.ts`**

Wrap the `fetch` handler with synchronous bootstrap (idempotent via `_booted` guard):
```ts
import {
  initSqlDatabase,
  initImageProcessor,
  initEnv,
  initBackground,
} from "@vnext/platform"
import { initRepo } from "./src/shared/repo/index.ts"
import { initCache } from "./src/shared/cache/index.ts"
import { initResponsesStore } from "./src/shared/runtime/responses-store.ts"
import { D1Repo } from "./src/shared/repo/d1.ts"
import { createCacheFromEnv } from "./src/shared/cache/factory.ts"
import { createCloudflareImageProcessor } from "./src/shared/image/cloudflare.ts"
import { createD1ResponsesStore } from "./src/shared/runtime/responses-store-factory.ts"
import { app } from "./src/app.ts"

let _booted = false
function bootstrap(env: Record<string, unknown>, ctx: ExecutionContext) {
  if (_booted) return
  initSqlDatabase(env.DB as import("@vnext/platform").SqlDatabase)
  initEnv((name) => String(env[name] ?? ""))
  initBackground({ waitUntil: (p) => ctx.waitUntil(p) })
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES, env.IMAGE_CACHE))
  initRepo(new D1Repo(env.DB as import("./src/shared/repo/d1.ts").D1Database))
  initCache(createCacheFromEnv({ DB: env.DB, KV: env.KV }, { CACHE_BACKEND: env.CACHE_BACKEND as string | undefined }))
  initResponsesStore(createD1ResponsesStore(env.DB as import("./src/shared/repo/d1.ts").D1Database))
  _booted = true
}

export default {
  fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    bootstrap(env, ctx)
    return app.fetch(req, env, ctx)
  },
}
```

- [ ] **Step 4: Sanity check**

```bash
cd vnext/apps/gateway && bun run typecheck
```

- [ ] **Step 5: Smoke run**

```bash
cd vnext/apps/gateway && PORT=8788 timeout 3 bun run entry-bun.ts || true
curl -s http://localhost:8788/health
```
(Timeout is expected because the server doesn't auto-shutdown.) The point is it bootstraps without throwing.

Alternative if `timeout 3` doesn't work cleanly: start in another terminal and curl manually.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/gateway/entry-bun.ts vnext/apps/gateway/entry-cloudflare.ts
git commit -m "refactor(gateway/entries): bootstrap platform seams synchronously"
```

---

## Task 10: Add a centralized test bootstrap helper

**Why:** Most test files now repeat `__resetPlatformForTests()` + `initRepo(new SqliteRepo(...))` in their `beforeEach`. Centralize.

**Files:**
- Create: `vnext/apps/gateway/tests/_setup-platform.ts`

- [ ] **Step 1: Implement helper**

```ts
import {
  __resetPlatformForTests,
  initImageProcessor,
  initEnv,
  initBackground,
  initSqlDatabase,
} from "@vnext/platform"
import { initRepo } from "../src/shared/repo/index.ts"
import { initCache } from "../src/shared/cache/index.ts"
import { initResponsesStore } from "../src/shared/runtime/responses-store.ts"
import { SqliteRepo } from "../src/shared/repo/sqlite.ts"
import { createInMemoryImageProcessor } from "../src/shared/image/memory.ts"
import { MemoryCache } from "@vnext/shared-cache"
import { InMemoryResponsesSnapshotStore } from "@vnext/responses-store"
import { Database } from "bun:sqlite"

export interface SetupOptions {
  envLookup?: (name: string) => string
}

export function setupTestPlatform(opts: SetupOptions = {}): {
  db: Database
  repo: SqliteRepo
} {
  __resetPlatformForTests()
  const db = new Database(":memory:")
  const repo = new SqliteRepo(db)
  initSqlDatabase(db as unknown as import("@vnext/platform").SqlDatabase)
  initEnv(opts.envLookup ?? (() => ""))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initImageProcessor(createInMemoryImageProcessor())
  initRepo(repo)
  initCache(new MemoryCache())
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  return { db, repo }
}
```

- [ ] **Step 2: Optionally migrate 1-2 simple test files to use the helper**

Pick 2 small test files (e.g. `repo-usage.test.ts`, `api-keys.test.ts`). Replace their bespoke setup with `const { repo } = setupTestPlatform()`. This proves the helper works in practice; bulk migration of all 41 files is out of scope for A2 (purely cosmetic — the per-file `beforeEach` setup written in Task 3 is functionally equivalent).

- [ ] **Step 3: Run tests**

```bash
cd vnext && bun test apps/gateway/tests
```

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/tests/_setup-platform.ts
git commit -m "test(gateway): add setupTestPlatform helper"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full repo typecheck**

```bash
cd vnext && bun run typecheck 2>&1 | tail -30
```
Expect: clean (or pre-existing errors only).

- [ ] **Step 2: Full repo test**

```bash
cd vnext && bun test 2>&1 | tail -10
```
Expect: same pass count as before A2 ± the new tests added in A2 (each new test file adds 2-3 passing tests).

- [ ] **Step 3: Verify deliberate API removals didn't leak back**

```bash
cd vnext && rg "setRepoForTest|setRepoOverride|clearRepoOverride|onRepoReset|setCacheForTest|_resetCacheForTest|onCacheReset|hasImageProcessor|c\.env\.responsesStore|c\.env\.DB|c\.env\.KV|c\.env\.IMAGES|c\.env\.IMAGE_CACHE|c\.env\.CACHE_BACKEND" apps/gateway/
```
Expected: empty.

- [ ] **Step 4: Verify Env shape**

```bash
cd vnext && rg "^\s*DB:|^\s*KV:|^\s*IMAGES:|^\s*IMAGE_CACHE:|^\s*CACHE_BACKEND:" apps/gateway/src/app.ts
```
Expected: empty.

- [ ] **Step 5: Verify first-request middleware is gone**

```bash
cd vnext && rg "_cacheBootstrapped|createD1ResponsesStore" apps/gateway/src/app.ts
```
Expected: empty.

- [ ] **Step 6: Local Bun smoke**

```bash
cd vnext/apps/gateway && bun run entry-bun.ts &
sleep 1
curl -fsS http://localhost:8788/health
kill %1
```
Expected: `{"status":"ok","service":"copilot-gateway-vnext"}` then process killed.

- [ ] **Step 7: Wrangler dry-run**

```bash
cd vnext/apps/gateway && bunx wrangler deploy --dry-run --outdir /tmp/wrangler-out 2>&1 | tail -10
```
Expected: bundles successfully (we're not actually deploying, just verifying the entry compiles for CFW).

If wrangler-dry-run isn't available locally, skip — CI will catch it.

---

## Self-Review Checklist

- [ ] No remaining `setRepoForTest` / `setRepoOverride` / `clearRepoOverride` / `onRepoReset` / `setCacheForTest` / `_resetCacheForTest` / `onCacheReset` / `hasImageProcessor` references anywhere in `apps/gateway/`.
- [ ] No `c.env.DB` / `c.env.KV` / `c.env.IMAGES` / `c.env.IMAGE_CACHE` / `c.env.CACHE_BACKEND` / `c.env.responsesStore` reads outside `entry-cloudflare.ts`.
- [ ] `app.ts`'s `Env` interface declares only string-typed optional fields (`ACCOUNT_TYPE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
- [ ] `app.ts` has no `app.use('*', ...)` block that does runtime initialization (only auth middleware remains).
- [ ] `entry-bun.ts` and `entry-cloudflare.ts` both call all 8 `initX` functions before `app.fetch` runs.
- [ ] `bun test` passes from `vnext/`.
- [ ] No file under `apps/gateway/src/shared/{repo,cache,image,runtime}` was moved or deleted (file moves are A3).

## Acceptance Criteria

- All gateway tests pass (`bun test apps/gateway/tests`).
- `apps/gateway/src/app.ts` matches the spec §2.1 "after" snippet.
- Production CFW path (`entry-cloudflare.ts`) bootstraps synchronously inside `fetch` with an idempotent guard.
- Production Bun path (`entry-bun.ts`) bootstraps once at module load.
- Test helper `setupTestPlatform()` exists and is usable.
- ~11 commits, one per task.

## Hand-off

After A2 lands, A3 picks up:
1. Move `apps/gateway/` → `packages/gateway/`.
2. Create `apps/platform-cloudflare/` (absorbs `entry-cloudflare.ts` + `shared/{repo/d1.ts,image/cloudflare.ts,runtime/responses-store-factory.ts}`).
3. Create `apps/platform-bun/` (absorbs `entry-bun.ts` + `shared/{repo/sqlite.ts,image/memory.ts}`, plus a new `BunSqliteDatabase` wrapper).
4. Move `vnext/Dockerfile` → `apps/platform-bun/Dockerfile` and update `WORKDIR`/`CMD`.
5. Move `apps/gateway/wrangler.jsonc` → `apps/platform-cloudflare/wrangler.jsonc`; update `main`.
6. Update `vnext/scripts/build-dashboard.ts` output path.
7. Update `docker-compose.vnext.yml` `dockerfile:` path.
8. Optional: move `shared/copilot-token-cache.ts` → `provider-copilot/src/token-cache.ts`.
