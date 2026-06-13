# Platform Extraction Design (Spec A)

**Date:** 2026-06-14
**Status:** Approved (pending user review of this doc)
**Scope:** Refactor only. No behavior change.

## Goal

Decouple `apps/gateway` from Cloudflare-specific runtime types and lazy
first-request bootstrap. After this work, the gateway is a runtime-agnostic
package that platform shells (Cloudflare Workers, Bun) wire concrete platform
implementations into via a single synchronous `bootstrap*Platform()` call.

## Motivation

Current gateway code carries CFW-specific types into core paths:

- `apps/gateway/src/app.ts:13-24` declares `Env { DB: D1Database; KV:
  KVNamespace; IMAGES: ImagesBinding; ... }` — the gateway's `Env` literally
  names CFW bindings.
- `apps/gateway/src/app.ts:35-49` initializes cache and responses store inside
  middleware on the first request, with `let _cacheBootstrapped = false` module
  state.
- `apps/gateway/src/shared/{repo,cache,image}/index.ts` each maintain
  `_x | null` + `_override | null` + `onXReset` callbacks — testing relies on
  override slots, runtime relies on lazy init.
- Adding a new runtime (e.g., a Node-native HTTP server, or a Deno deploy
  target) requires editing gateway code. There is no separate runtime app
  shell.

Compare `copilot-gateway` (`/Users/zhangxian/projects/copilot-gateway/`) which
already has this seam: `packages/platform` + `apps/platform-{cloudflare,node}`.

## Non-Goals

This spec does **not** cover:

- Tightening `ModelProvider` contract (Spec D).
- Moving Copilot-specific transforms into `provider-copilot` (Spec C).
- Provider factory map / token-cache relocation (Spec B).
- Splitting `data-plane/routes.ts` (Spec B).
- Adding `gemini-via-{chat-completions,responses}` translators.
- Adding `provider-codex`.

These remain queued as follow-up specs.

## Target Layout

```
vnext/
├── packages/
│   ├── platform/                  ← NEW
│   │   └── src/
│   │       ├── sql-database.ts
│   │       ├── file-provider.ts
│   │       ├── image-processor.ts
│   │       ├── env.ts
│   │       ├── background.ts
│   │       └── index.ts
│   ├── gateway/                   ← renamed from apps/gateway
│   │   └── src/
│   │       ├── app.ts             (no CFW types, no first-request init)
│   │       ├── control-plane/...
│   │       ├── data-plane/...
│   │       └── shared/...         (runtime impls extracted out)
│   ├── provider, provider-{copilot,azure,custom,sdf}, protocols, translate,
│   │   shared-cache, shared-http, responses-store, interceptor (unchanged)
│   └── ...
└── apps/
    ├── platform-bun/               ← NEW
    │   ├── src/
    │   │   ├── server.ts           (Bun.serve entry)
    │   │   ├── bootstrap.ts        (bootstrapBunPlatform)
    │   │   ├── bun-sqlite-database.ts
    │   │   ├── bun-sqlite-repo.ts
    │   │   ├── fs-file-provider.ts
    │   │   ├── memory-image-processor.ts
    │   │   └── d1-cache-adapters.ts (KV/D1 cache for Bun = nothing; memory)
    │   ├── package.json
    │   └── Dockerfile              ← moved from vnext/Dockerfile
    ├── platform-cloudflare/        ← NEW
    │   ├── src/
    │   │   ├── worker.ts           (export default { fetch })
    │   │   ├── bootstrap.ts        (bootstrapCloudflarePlatform)
    │   │   ├── d1-repo.ts
    │   │   ├── r2-file-provider.ts
    │   │   ├── cloudflare-image-processor.ts
    │   │   └── responses-store-factory.ts
    │   ├── package.json
    │   └── wrangler.jsonc          ← moved from apps/gateway/wrangler.jsonc
    └── dashboard/ (unchanged)
```

## §1 Platform package contracts (`@vnext/platform`)

Five interfaces, each paired with `initX(impl)` / `getX()` accessors. Accessors
throw `"X not initialized; call bootstrap*Platform() first"` when called before
init. No `_override` slots — tests call `initX()` directly in their setup, and
a `__resetPlatformForTests()` export is exposed for `beforeEach` cleanup.

### 1.1 SqlDatabase

```ts
export interface SqlResult<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: SqlResultMeta
}
export interface SqlResultMeta {
  changes?: number
}
export interface SqlPreparedStatement {
  bind(...values: unknown[]): SqlPreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>
  run(): Promise<SqlResult>
}
export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement
  batch?(stmts: SqlPreparedStatement[]): Promise<SqlResult[]>
  exec(sql: string): Promise<unknown>
}

export const initSqlDatabase: (db: SqlDatabase) => void
export const getSqlDatabase: () => SqlDatabase
```

`D1Database` already satisfies this shape directly. The bun:sqlite adapter
already exists in `packages/shared-cache/src/d1.ts` (the D1Cache backing) — we
will extract a generic `BunSqliteDatabase` in `apps/platform-bun/src/`.

### 1.2 FileProvider

```ts
export interface PutOpts {
  contentType?: string
  metadata?: Record<string, string>
}
export interface FileGetResult {
  body: ReadableStream
  size?: number
  contentType?: string
}
export interface FileProvider {
  put(key: string, body: ReadableStream | Uint8Array | string, opts?: PutOpts): Promise<void>
  get(key: string): Promise<FileGetResult | null>
  delete(key: string): Promise<void>
  list?(prefix: string): Promise<string[]>
}
export const initFileProvider: (fp: FileProvider) => void
export const getFileProvider: () => FileProvider
```

vNext currently has zero callers. We still ship the interface and full impls
(R2, FS) so future spill code uses it from day one. Cloudflare app refuses to
boot if `FILES` binding is missing (same posture as `copilot-gateway`).

### 1.3 ImageProcessor

Extracted from `apps/gateway/src/shared/image/types.ts`. Public shape:

```ts
export interface CompressOpts {
  maxBytes?: number
  format?: 'auto' | 'webp' | 'jpeg'
}
export interface CompressedImage {
  bytes: Uint8Array
  format: string
  bytesIn: number
  bytesOut: number
}
export interface ImageProcessor {
  compress(input: Uint8Array, opts: CompressOpts): Promise<CompressedImage>
}
export const initImageProcessor: (ip: ImageProcessor) => void
export const getImageProcessor: () => ImageProcessor
```

Cloudflare impl wraps `ImagesBinding` (existing `shared/image/cloudflare.ts`).
Bun impl is a `memoryImageProcessor` that returns input passthrough — no sharp
dependency yet (existing `shared/image/memory.ts` already does this).

### 1.4 env

```ts
export const initEnv: (lookup: (name: string) => string) => void
export const env: (name: string) => string
```

Replaces ad-hoc `process.env.X ?? c.env?.X` patterns. Cloudflare bootstraps
with `name => String(env[name] ?? '')`; Bun with `name => process.env[name] ?? ''`.

### 1.5 background

```ts
export interface BackgroundExecutor {
  waitUntil(promise: Promise<unknown>): void
}
export const initBackground: (b: BackgroundExecutor) => void
export const waitUntil: (p: Promise<unknown>) => void
```

Cloudflare wraps `ctx.waitUntil`. Bun uses a no-op (`p.catch(() => {})` to
suppress unhandled rejections). Code paths in gateway that currently take
`ctx?: ExecutionContext` parameters will read `waitUntil()` from platform.

## §2 Gateway package (`@vnext/gateway`)

`apps/gateway/src/*` moves verbatim to `packages/gateway/src/*`, with these
edits:

### 2.1 `app.ts`

Before:
```ts
export interface Env {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  CACHE_BACKEND?: 'memory' | 'kv' | 'd1'
  responsesStore?: ResponsesSnapshotStore
}
```

After:
```ts
export interface Env {
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}
```

Drop the `app.use('*', async (c, next) => { ... initCache ... })` block at
`app.ts:35-49` entirely. `responsesStore`, `repo`, `cache`, `imageProcessor`
are accessed via `getX()` accessors only.

### 2.2 `shared/repo/`

Stays in gateway:
- `index.ts` (accessors `getRepo`/`initRepo`)
- `types.ts`
- `shared/` (pure logic helpers)

Moves out:
- `d1.ts` → `apps/platform-cloudflare/src/d1-repo.ts`
- `sqlite.ts` → `apps/platform-bun/src/bun-sqlite-repo.ts`

### 2.3 `shared/cache/`

Stays in gateway:
- `index.ts` (accessors `getCache`/`initCache`)

Moves out:
- `factory.ts` (CFW-specific) splits between platform apps. Gateway no longer
  decides cache backend — bootstrap does.

### 2.4 `shared/image/`

Stays in gateway:
- `index.ts` (accessors), `inline.ts`, `size.ts`, `types.ts`

Moves out:
- `cloudflare.ts` → `apps/platform-cloudflare/src/cloudflare-image-processor.ts`
- `memory.ts` → `apps/platform-bun/src/memory-image-processor.ts`

### 2.5 `shared/runtime/responses-store-factory.ts`

Moves out → `apps/platform-cloudflare/src/responses-store-factory.ts`. Gateway
never calls `createD1ResponsesStore` directly; it goes through
`getResponsesStore()` after bootstrap.

### 2.6 `shared/copilot-token-cache.ts`

Moves to `packages/provider-copilot/src/token-cache.ts`. The provider exports
`getCachedCopilotToken` from there; `data-plane/providers/registry.ts` imports
from the provider package, not from a `shared/` location. (This was queued
under Spec B but it's a one-line move that's cleaner to do alongside extraction
than after, since the file is leaving `shared/` either way.)

### 2.7 Test layout

`apps/gateway/tests/*` → `packages/gateway/tests/*`. Test setup files use
`__resetPlatformForTests()` + `initRepo(new MemorySqliteRepo(...))` patterns
explicitly; no `_override` slot magic.

## §3 Platform apps

### 3.1 `apps/platform-cloudflare/`

`worker.ts`:
```ts
import { app } from '@vnext/gateway'
import { bootstrapCloudflarePlatform, type CloudflareEnv } from './bootstrap.ts'

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    bootstrapCloudflarePlatform(env, ctx)
    return app.fetch(req, env, ctx)
  },
} satisfies ExportedHandler<CloudflareEnv>
```

`bootstrap.ts` validates required bindings (`DB`, `KV`, `IMAGE_CACHE`, `IMAGES`,
`FILES`) and calls each `initX`. `_booted` flag makes it idempotent.

`wrangler.jsonc` moves from `apps/gateway/wrangler.jsonc` to here. `main`
points at `src/worker.ts`.

`package.json` deps: `@vnext/platform`, `@vnext/gateway`. The platform shell
imports nothing provider-specific — provider packages remain accessed via the
factory map inside `@vnext/gateway`.

### 3.2 `apps/platform-bun/`

`server.ts`:
```ts
import { app } from '@vnext/gateway'
import { bootstrapBunPlatform } from './bootstrap.ts'

bootstrapBunPlatform({
  dbPath: process.env.VNEXT_DB_PATH ?? '.vnext-local.sqlite',
  filesDir: process.env.VNEXT_FILES_DIR ?? '.vnext-files',
})

// Docker compose sets PORT=41415; bare local runs fall back to 8788.
const port = Number(process.env.PORT ?? 8788)
Bun.serve({ port, fetch: app.fetch })
```

`bootstrap.ts` builds `BunSqliteDatabase`, `BunSqliteRepo`, `FsFileProvider`,
`memoryImageProcessor`, `MemoryCache`, `InMemoryResponsesSnapshotStore`,
no-op `BackgroundExecutor`, and calls each `initX`.

`Dockerfile` moves from `vnext/Dockerfile` to `apps/platform-bun/Dockerfile`.
The `WORKDIR` and final `CMD` change to point at this app.

## §4 Migration mode

**Single PR.** Estimated ~150 import-path edits. Risk mitigated by:

1. Running `bun test` (gateway package) and existing CI smoke (Bun + CFW deploy)
   as the PR gate.
2. No behavior changes — pure file moves + dependency injection rewires.
3. Can keep `apps/gateway/` as an empty re-export shim for one commit if
   external CI / Docker Compose still references the old path; remove in a
   follow-up. (Decision: skip the shim — Docker Compose lives in the same
   repo and gets updated in the same PR.)

## §5 Test/build pipeline

- Root `package.json` workspace globs already cover `apps/*` and `packages/*`.
  No change needed.
- `bun test` from repo root continues to discover all package tests.
- `wrangler dev` invocation moves from `apps/gateway/` to
  `apps/platform-cloudflare/`.
- `docker-compose.vnext.yml` build context: change Dockerfile path to
  `vnext/apps/platform-bun/Dockerfile`. Build context stays at `vnext/`.
- `tsconfig.base.json` paths: no change required. `@vnext/*` resolution goes
  through workspace symlinks + each package's `package.json` `name` field, not
  through tsconfig `paths`.

## §6 Risks

1. **Test setup churn.** Every test that did `setRepoForTesting(...)` or
   relied on `_override` will need a small change. Mitigation: provide a
   `setupTestPlatform({ repo, cache?, ... })` helper in `@vnext/platform`'s
   test entry that wraps the `initX` calls.

2. **Bootstrap idempotency.** CFW workers are reused across requests; the
   `_booted` guard must hold. Risk if an env binding shape changes between
   deploys but the worker isn't reloaded — covered by CFW's deploy semantics
   (new code = new isolate = new module state).

3. **Dashboard build artifacts.** Existing `dashboard-app/dist/dashboard.{js,css}.txt`
   stubs and the build emitting non-stub `.js`/`.css` files — current
   `build:ui` target lives in repo root and emits to
   `apps/gateway/src/shared/edge/ui-pages/dashboard-app/dist/`. After move,
   target path becomes `packages/gateway/src/shared/edge/ui-pages/...`.
   Update `build:ui` script and verify Dockerfile still picks up the bundle.

4. **CFW worker `package.json`.** Wrangler builds from the directory containing
   `wrangler.jsonc`. Confirm wrangler can resolve workspace deps when building
   from `apps/platform-cloudflare/` — should work because workspace install
   sets up symlinks at the root `node_modules`.

## §7 Acceptance criteria

- `packages/platform/` exists, exports the 5 interface modules.
- `packages/gateway/src/app.ts` has no `D1Database` / `KVNamespace` / `ImagesBinding`
  type references.
- `packages/gateway/src/app.ts` has no first-request lazy init middleware.
- `apps/platform-bun/` and `apps/platform-cloudflare/` exist with their own
  package.json, source dirs, and configs (Dockerfile / wrangler.jsonc).
- `bun test` passes for all packages.
- `wrangler deploy --dry-run` (or local build) succeeds from
  `apps/platform-cloudflare/`.
- Bun container builds and starts via the moved Dockerfile.
- `apps/gateway/` directory is removed from the repo.

## §8 Out of scope (already noted)

Specs B/C/D queued separately. This PR is platform extraction only.
