# Spec A — Plan A1: `@vnext/platform` package

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime-agnostic `@vnext/platform` workspace package that defines five injection seams (sql-database, file-provider, image-processor, env, background) with `initX()` / `getX()` accessors and a `__resetPlatformForTests()` hook. Pure addition — no existing code changes.

**Architecture:** Each seam lives in its own `<name>.ts` file with: (a) interface(s), (b) module-level `_x: T | null` slot, (c) `initX(impl)` setter, (d) `getX()` accessor that throws if uninitialized. A central `__resetPlatformForTests()` clears every slot. Index re-exports everything.

**Tech Stack:** TypeScript, Bun, no runtime deps. Tests via `bun test`.

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-14-platform-extraction-design.md` §1.

**Out of scope for A1:** Gateway code changes, platform app shells, migrations of existing `shared/{repo,cache,image}` files. Those are A2 / A3.

---

## File Structure

```
vnext/packages/platform/
├── package.json                   (new)
├── tsconfig.json                  (new, extends ../../tsconfig.base.json)
├── src/
│   ├── sql-database.ts            interface + init/get
│   ├── file-provider.ts           interface + init/get
│   ├── image-processor.ts         interface + init/get
│   ├── env.ts                     env(name) + initEnv
│   ├── background.ts              waitUntil() + initBackground
│   ├── reset.ts                   __resetPlatformForTests()
│   └── index.ts                   re-exports
└── tests/
    ├── sql-database.test.ts
    ├── file-provider.test.ts
    ├── image-processor.test.ts
    ├── env.test.ts
    ├── background.test.ts
    └── reset.test.ts
```

Each seam file is ~30-50 lines. No cross-seam imports inside `src/`.

---

## Task 1: Workspace package skeleton

**Files:**
- Create: `vnext/packages/platform/package.json`
- Create: `vnext/packages/platform/tsconfig.json`
- Create: `vnext/packages/platform/src/index.ts` (empty stub for now)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@vnext/platform",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Match the shape of an existing leaf package (e.g., copy from `vnext/packages/protocols/tsconfig.json` and tweak):

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create empty `src/index.ts`**

```ts
export {}
```

- [ ] **Step 4: Verify workspace pickup**

Run from `vnext/`:
```bash
bun install
```
Expected: `node_modules/@vnext/platform` symlink exists.

```bash
ls -la node_modules/@vnext/platform
```
Expected: symlink to `../../packages/platform`.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/package.json vnext/packages/platform/tsconfig.json vnext/packages/platform/src/index.ts
git commit -m "feat(platform): scaffold @vnext/platform workspace package"
```

---

## Task 2: `reset.ts` — test reset hook

The reset module must be authored first so other seams can register their reset callbacks into it.

**Files:**
- Create: `vnext/packages/platform/src/reset.ts`
- Create: `vnext/packages/platform/tests/reset.test.ts`

- [ ] **Step 1: Write the failing test**

`vnext/packages/platform/tests/reset.test.ts`:
```ts
import { test, expect } from "bun:test"
import { __registerPlatformReset, __resetPlatformForTests } from "../src/reset.ts"

test("__resetPlatformForTests calls every registered callback", () => {
  let a = 0
  let b = 0
  __registerPlatformReset(() => { a++ })
  __registerPlatformReset(() => { b++ })
  __resetPlatformForTests()
  expect(a).toBe(1)
  expect(b).toBe(1)
})

test("callbacks are deduplicated by identity", () => {
  let n = 0
  const fn = () => { n++ }
  __registerPlatformReset(fn)
  __registerPlatformReset(fn)
  __resetPlatformForTests()
  expect(n).toBe(1)
})
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
cd vnext && bun test packages/platform/tests/reset.test.ts
```
Expected: module not found / function not exported.

- [ ] **Step 3: Implement**

`vnext/packages/platform/src/reset.ts`:
```ts
const _resets = new Set<() => void>()

export function __registerPlatformReset(fn: () => void): void {
  _resets.add(fn)
}

export function __resetPlatformForTests(): void {
  for (const fn of _resets) fn()
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
cd vnext && bun test packages/platform/tests/reset.test.ts
```
Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/reset.ts vnext/packages/platform/tests/reset.test.ts
git commit -m "feat(platform): add __resetPlatformForTests registry"
```

---

## Task 3: `sql-database.ts`

**Files:**
- Create: `vnext/packages/platform/src/sql-database.ts`
- Create: `vnext/packages/platform/tests/sql-database.test.ts`

- [ ] **Step 1: Write the failing test**

`vnext/packages/platform/tests/sql-database.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test"
import {
  initSqlDatabase,
  getSqlDatabase,
  type SqlDatabase,
} from "../src/sql-database.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

const stubDb: SqlDatabase = {
  prepare: () => { throw new Error("stub") },
  exec: async () => undefined,
}

test("getSqlDatabase throws before init", () => {
  expect(() => getSqlDatabase()).toThrow(/SqlDatabase not initialized/)
})

test("getSqlDatabase returns the impl after init", () => {
  initSqlDatabase(stubDb)
  expect(getSqlDatabase()).toBe(stubDb)
})

test("__resetPlatformForTests clears the slot", () => {
  initSqlDatabase(stubDb)
  __resetPlatformForTests()
  expect(() => getSqlDatabase()).toThrow(/SqlDatabase not initialized/)
})
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
cd vnext && bun test packages/platform/tests/sql-database.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement**

`vnext/packages/platform/src/sql-database.ts`:
```ts
import { __registerPlatformReset } from "./reset.ts"

export interface SqlResultMeta {
  changes?: number
}
export interface SqlResult<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta: SqlResultMeta
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

let _db: SqlDatabase | null = null
__registerPlatformReset(() => { _db = null })

export function initSqlDatabase(db: SqlDatabase): void {
  _db = db
}

export function getSqlDatabase(): SqlDatabase {
  if (!_db) throw new Error("SqlDatabase not initialized; call bootstrap*Platform() first")
  return _db
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
cd vnext && bun test packages/platform/tests/sql-database.test.ts
```
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/sql-database.ts vnext/packages/platform/tests/sql-database.test.ts
git commit -m "feat(platform): add SqlDatabase seam"
```

---

## Task 4: `file-provider.ts`

**Files:**
- Create: `vnext/packages/platform/src/file-provider.ts`
- Create: `vnext/packages/platform/tests/file-provider.test.ts`

- [ ] **Step 1: Write the failing test**

`vnext/packages/platform/tests/file-provider.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test"
import {
  initFileProvider,
  getFileProvider,
  type FileProvider,
} from "../src/file-provider.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

const stub: FileProvider = {
  put: async () => undefined,
  get: async () => null,
  delete: async () => undefined,
}

test("getFileProvider throws before init", () => {
  expect(() => getFileProvider()).toThrow(/FileProvider not initialized/)
})

test("init/get round-trip", () => {
  initFileProvider(stub)
  expect(getFileProvider()).toBe(stub)
})

test("reset clears", () => {
  initFileProvider(stub)
  __resetPlatformForTests()
  expect(() => getFileProvider()).toThrow()
})
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
cd vnext && bun test packages/platform/tests/file-provider.test.ts
```

- [ ] **Step 3: Implement**

`vnext/packages/platform/src/file-provider.ts`:
```ts
import { __registerPlatformReset } from "./reset.ts"

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

let _fp: FileProvider | null = null
__registerPlatformReset(() => { _fp = null })

export function initFileProvider(fp: FileProvider): void {
  _fp = fp
}

export function getFileProvider(): FileProvider {
  if (!_fp) throw new Error("FileProvider not initialized; call bootstrap*Platform() first")
  return _fp
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/file-provider.ts vnext/packages/platform/tests/file-provider.test.ts
git commit -m "feat(platform): add FileProvider seam"
```

---

## Task 5: `image-processor.ts`

**Files:**
- Create: `vnext/packages/platform/src/image-processor.ts`
- Create: `vnext/packages/platform/tests/image-processor.test.ts`

- [ ] **Step 1: Write the failing test**

`vnext/packages/platform/tests/image-processor.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test"
import {
  initImageProcessor,
  getImageProcessor,
  type ImageProcessor,
} from "../src/image-processor.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

const stub: ImageProcessor = {
  compress: async (input) => ({
    bytes: input,
    format: "webp",
    bytesIn: input.byteLength,
    bytesOut: input.byteLength,
  }),
}

test("getImageProcessor throws before init", () => {
  expect(() => getImageProcessor()).toThrow(/ImageProcessor not initialized/)
})

test("init/get round-trip", () => {
  initImageProcessor(stub)
  expect(getImageProcessor()).toBe(stub)
})
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd vnext && bun test packages/platform/tests/image-processor.test.ts
```

- [ ] **Step 3: Implement**

`vnext/packages/platform/src/image-processor.ts`:
```ts
import { __registerPlatformReset } from "./reset.ts"

export interface CompressOpts {
  maxBytes?: number
  format?: "auto" | "webp" | "jpeg"
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

let _ip: ImageProcessor | null = null
__registerPlatformReset(() => { _ip = null })

export function initImageProcessor(ip: ImageProcessor): void {
  _ip = ip
}

export function getImageProcessor(): ImageProcessor {
  if (!_ip) throw new Error("ImageProcessor not initialized; call bootstrap*Platform() first")
  return _ip
}
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/image-processor.ts vnext/packages/platform/tests/image-processor.test.ts
git commit -m "feat(platform): add ImageProcessor seam"
```

---

## Task 6: `env.ts`

**Files:**
- Create: `vnext/packages/platform/src/env.ts`
- Create: `vnext/packages/platform/tests/env.test.ts`

- [ ] **Step 1: Write the failing test**

`vnext/packages/platform/tests/env.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test"
import { initEnv, env } from "../src/env.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

test("env throws before init", () => {
  expect(() => env("FOO")).toThrow(/env not initialized/)
})

test("env reads from injected lookup", () => {
  initEnv((name) => (name === "FOO" ? "bar" : ""))
  expect(env("FOO")).toBe("bar")
  expect(env("MISSING")).toBe("")
})
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd vnext && bun test packages/platform/tests/env.test.ts
```

- [ ] **Step 3: Implement**

`vnext/packages/platform/src/env.ts`:
```ts
import { __registerPlatformReset } from "./reset.ts"

let _lookup: ((name: string) => string) | null = null
__registerPlatformReset(() => { _lookup = null })

export function initEnv(lookup: (name: string) => string): void {
  _lookup = lookup
}

export function env(name: string): string {
  if (!_lookup) throw new Error("env not initialized; call bootstrap*Platform() first")
  return _lookup(name)
}
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/env.ts vnext/packages/platform/tests/env.test.ts
git commit -m "feat(platform): add env() seam"
```

---

## Task 7: `background.ts`

**Files:**
- Create: `vnext/packages/platform/src/background.ts`
- Create: `vnext/packages/platform/tests/background.test.ts`

- [ ] **Step 1: Write the failing test**

`vnext/packages/platform/tests/background.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test"
import {
  initBackground,
  waitUntil,
  type BackgroundExecutor,
} from "../src/background.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

test("waitUntil throws before init", () => {
  expect(() => waitUntil(Promise.resolve())).toThrow(/Background not initialized/)
})

test("waitUntil delegates to injected executor", () => {
  const seen: Promise<unknown>[] = []
  const exec: BackgroundExecutor = { waitUntil: (p) => { seen.push(p) } }
  initBackground(exec)
  const p = Promise.resolve(42)
  waitUntil(p)
  expect(seen).toEqual([p])
})
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

`vnext/packages/platform/src/background.ts`:
```ts
import { __registerPlatformReset } from "./reset.ts"

export interface BackgroundExecutor {
  waitUntil(promise: Promise<unknown>): void
}

let _bg: BackgroundExecutor | null = null
__registerPlatformReset(() => { _bg = null })

export function initBackground(b: BackgroundExecutor): void {
  _bg = b
}

export function waitUntil(p: Promise<unknown>): void {
  if (!_bg) throw new Error("Background not initialized; call bootstrap*Platform() first")
  _bg.waitUntil(p)
}
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/background.ts vnext/packages/platform/tests/background.test.ts
git commit -m "feat(platform): add background.waitUntil seam"
```

---

## Task 8: `index.ts` re-exports + final typecheck

**Files:**
- Modify: `vnext/packages/platform/src/index.ts`

- [ ] **Step 1: Replace the empty stub**

`vnext/packages/platform/src/index.ts`:
```ts
export * from "./sql-database.ts"
export * from "./file-provider.ts"
export * from "./image-processor.ts"
export * from "./env.ts"
export * from "./background.ts"
export { __resetPlatformForTests, __registerPlatformReset } from "./reset.ts"
```

- [ ] **Step 2: Typecheck the package**

```bash
cd vnext/packages/platform && bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Run all platform tests**

```bash
cd vnext && bun test packages/platform/tests
```
Expected: ~13 tests pass, 0 fail.

- [ ] **Step 4: Run full repo test suite (smoke)**

```bash
cd vnext && bun test
```
Expected: same number of pass/fail as on the parent commit (this PR adds tests, removes none).

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/platform/src/index.ts
git commit -m "feat(platform): re-export all seams from index"
```

---

## Self-Review Checklist (run before handing off)

- [ ] Every seam follows the same shape: `interface` + `_x: T | null` + `initX` + `getX` (throws) + `__registerPlatformReset` callback
- [ ] No seam imports another seam (zero coupling inside `src/`)
- [ ] `index.ts` re-exports every seam
- [ ] `__resetPlatformForTests` clears every slot (each seam test verifies this directly or transitively)
- [ ] Error messages in `getX()` are specific (mention which seam) so future debugging is easier
- [ ] Workspace install picks up the package (`node_modules/@vnext/platform` symlink)

## Acceptance Criteria

- `vnext/packages/platform/` exists with `package.json`, `tsconfig.json`, `src/`, `tests/`.
- `bun run typecheck` passes inside the package.
- `bun test` from `vnext/` includes the new tests and they all pass.
- No file under `vnext/apps/` or `vnext/packages/{gateway,provider*,protocols,...}` was modified.
- `git log` shows ~8 commits, one per task.

## Hand-off

After A1 lands, the next plan is **A2 — gateway internal refactor** (rename `apps/gateway` → `packages/gateway`, drop CFW types from `Env`, drop first-request middleware, switch `shared/{repo,cache,image}` to platform accessors, move runtime impl files to a temporary staging spot for A3 to pick up).
