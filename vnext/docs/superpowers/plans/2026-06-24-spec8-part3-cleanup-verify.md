# Spec 8 — Part 3: Business-Scope Rename, Purity Gate, Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Spec 8 by (a) renaming every remaining business package + the three `apps/*` entries from `@vnext/*` to `@vnext-llm/*`, (b) deleting the temporary frame/parser re-exports left behind in Part 1, (c) writing the framework-purity enforcement script and wiring it into a root `test` script, and (d) updating the Bun Dockerfile for the renamed `protocols-llm/` directory and the new `result/` directory.

**Architecture:** Pure rename + cleanup + tooling. After Part 3:
- Every package in `vnext/packages/*` and `vnext/apps/*` is scoped either `@vnext-gateway/*` (framework) or `@vnext-llm/*` (business).
- `import` site alone reveals the layer.
- `vnext/scripts/check-framework-purity.ts` runs in CI before the test suite (via `bun run test`) and rejects any framework→business import or any un-scoped `@vnext/*` import.
- Docker image builds end-to-end from the renamed tree.

**Tech Stack:** Bun 1.x workspaces, `bun test`, `bun install` (lockfile regen), BSD `sed -i ''` (macOS), Docker.

**Predecessors:**
- Spec 8 design: `vnext/docs/superpowers/specs/2026-06-24-spec8-protocols-split.md` (§5 steps 5–8, §6 enforcement, §7 acceptance criteria A1–A6)
- Part 1: `vnext/docs/superpowers/plans/2026-06-24-spec8-part1-framework-extraction.md` (created `@vnext-gateway/result`, renamed service/platform/http/cache)
- Part 2: `vnext/docs/superpowers/plans/2026-06-24-spec8-part2-protocols-split.md` (renamed protocols→`@vnext-llm/protocols`, the 4 `Llm*` result renames, Phase C frame consumer migration)

---

## File Structure

**Renamed (directory unchanged, package.json `name` flipped):**
- `vnext/packages/translate/package.json` → `@vnext-llm/translate`
- `vnext/packages/responses-store/package.json` → `@vnext-llm/responses-store`
- `vnext/packages/provider/package.json` → `@vnext-llm/provider`
- `vnext/packages/provider-copilot/package.json` → `@vnext-llm/provider-copilot`
- `vnext/packages/provider-azure/package.json` → `@vnext-llm/provider-azure`
- `vnext/packages/provider-custom/package.json` → `@vnext-llm/provider-custom`
- `vnext/packages/provider-sdf/package.json` → `@vnext-llm/provider-sdf`
- `vnext/packages/gateway/package.json` → `@vnext-llm/gateway`
- `vnext/apps/platform-bun/package.json` → `@vnext-llm/platform-bun`
- `vnext/apps/platform-cloudflare/package.json` → `@vnext-llm/platform-cloudflare`
- `vnext/apps/dashboard/package.json` → `@vnext-llm/dashboard`

**Cleaned (delete temporary re-export shims from Part 1):**
- `vnext/packages/protocols-llm/src/common/sse.ts` — Part 1 left this as `export * from '@vnext-gateway/result'`; delete the file and remove its barrel re-exports from `src/common/index.ts`.
- `vnext/packages/protocols-llm/src/common/index.ts` — remove the `export { parseSSEStream, ... } from '@vnext-gateway/result/parse'` lines added in Part 1 step 3 (Part 2 Phase C already migrated every consumer).

**Created:**
- `vnext/scripts/check-framework-purity.ts` — Spec 8 §6 enforcement.

**Modified:**
- `vnext/package.json` — add `"test": "bun run scripts/check-framework-purity.ts && bun test"`.
- `vnext/apps/platform-bun/Dockerfile` — `packages/protocols/` → `packages/protocols-llm/`; add `COPY packages/result/package.json packages/result/`.

---

## Pre-flight

- [ ] **Step 0.1: Verify Part 2 acceptance gate is green.**

Run from `vnext/`:
```bash
bun test
```
Expected: all tests pass (post–Part 2 baseline). If any failures exist, stop and resolve before continuing.

- [ ] **Step 0.2: Confirm the two re-export shims still exist (will be deleted in Phase B).**

Run:
```bash
test -f vnext/packages/protocols-llm/src/common/sse.ts && \
  cat vnext/packages/protocols-llm/src/common/sse.ts
grep -nE "from '@vnext-gateway/result(/parse)?'" vnext/packages/protocols-llm/src/common/index.ts
```
Expected: `sse.ts` contains only re-exports from `@vnext-gateway/result`; `index.ts` shows the parser re-exports added in Part 1 step 3.

If either is already gone, mark Phase B steps `[~]` (skipped because already done) and move on.

- [ ] **Step 0.3: Snapshot the remaining `@vnext/*` consumer counts.**

Run:
```bash
for pkg in translate responses-store provider provider-copilot provider-azure provider-custom provider-sdf gateway platform-bun platform-cloudflare dashboard; do
  count=$(grep -rln "@vnext/${pkg}\\b" vnext/packages vnext/apps --include='*.ts' --include='*.json' 2>/dev/null | wc -l | tr -d ' ')
  echo "$pkg: $count files"
done
```
Record the output in your scratch notes — each rename task verifies its count matches the residual zero after sed.

---

## Phase A — Business package renames (`@vnext/*` → `@vnext-llm/*`)

Each task is the same shape: (1) edit `package.json` name, (2) sed every consumer, (3) `bun install`, (4) `bun test`, (5) commit. **One commit per package** so a `git bisect` can pin any regression to a single rename.

The rename order is dependency-leaf-first so consumers always compile against the new name. The dependency edges below were verified by reading each `package.json` after Part 1+2 land.

| Order | Package | Rationale |
|-------|---------|-----------|
| A1 | translate | depends on protocols-llm + service only |
| A2 | responses-store | leaf |
| A3 | provider | depends on protocols-llm, service |
| A4 | provider-copilot | depends on provider, protocols-llm, http, translate |
| A5 | provider-azure | depends on provider, protocols-llm, http, translate |
| A6 | provider-custom | depends on provider, protocols-llm, http, translate |
| A7 | provider-sdf | depends on provider, protocols-llm, http, translate |
| A8 | gateway | depends on all providers + protocols-llm + service + cache |
| A9 | platform-bun | depends on gateway, platform, responses-store, cache |
| A10 | platform-cloudflare | depends on gateway, platform, responses-store, cache |
| A11 | dashboard | depends on protocols-llm |

### Task A1 — Rename `@vnext/translate` → `@vnext-llm/translate`

**Files:**
- Modify: `vnext/packages/translate/package.json` (the `name` field)
- Modify: every `*.ts` / `*.json` under `vnext/packages` and `vnext/apps` that mentions `@vnext/translate`

- [ ] **A1.1: Edit package.json `name`.**

Open `vnext/packages/translate/package.json`. Change `"name": "@vnext/translate"` → `"name": "@vnext-llm/translate"`. Save.

- [ ] **A1.2: Sweep consumers.**

Run from `vnext/`:
```bash
grep -rl "@vnext/translate\\b" packages apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/translate|@vnext-llm/translate|g'
```

- [ ] **A1.3: Residue check.**

Run:
```bash
grep -rn "@vnext/translate\\b" vnext/packages vnext/apps --include='*.ts' --include='*.json'
```
Expected: zero output.

- [ ] **A1.4: Regenerate lockfile + test.**

Run from `vnext/`:
```bash
bun install
bun test
```
Expected: install completes; tests pass at the pre-rename count.

- [ ] **A1.5: Commit.**

Run from repo root:
```bash
git add vnext/packages/translate/package.json
git add -A vnext/packages vnext/apps vnext/bun.lock
git status   # sanity: only translate-rename touch points
git commit -m "refactor(vnext): rename @vnext/translate → @vnext-llm/translate"
```

### Task A2 — Rename `@vnext/responses-store` → `@vnext-llm/responses-store`

Same shape as A1. Substitute `translate` → `responses-store` in every command above. Commit message: `refactor(vnext): rename @vnext/responses-store → @vnext-llm/responses-store`.

- [ ] A2.1 — edit `vnext/packages/responses-store/package.json` `name`
- [ ] A2.2 — sed `@vnext/responses-store` → `@vnext-llm/responses-store`
- [ ] A2.3 — residue check returns zero
- [ ] A2.4 — `bun install && bun test` green
- [ ] A2.5 — commit

### Task A3 — Rename `@vnext/provider` → `@vnext-llm/provider`

**Sed safety note:** `@vnext/provider` is a substring of `@vnext/provider-copilot` etc. Use a terminator class to avoid mis-matching the longer names:

```bash
grep -rlE "@vnext/provider([\"'/])" vnext/packages vnext/apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' -E "s|@vnext/provider([\"'/])|@vnext-llm/provider\\1|g"
```

The `([\"'/])` capture matches the closing quote (in import specifiers) or the subpath slash (in `@vnext/provider/foo` exports), preserving the boundary and skipping `@vnext/provider-copilot`.

- [ ] A3.1 — edit `vnext/packages/provider/package.json` `name` to `@vnext-llm/provider`
- [ ] A3.2 — run the terminator-anchored sed above
- [ ] A3.3 — residue check: `grep -rnE "@vnext/provider([\"'/])" vnext/packages vnext/apps --include='*.ts' --include='*.json'` returns zero
- [ ] A3.4 — `bun install && bun test` green
- [ ] A3.5 — commit: `refactor(vnext): rename @vnext/provider → @vnext-llm/provider`

### Tasks A4–A7 — Rename the four provider-* packages

Same A1 shape. The names `provider-copilot`, `provider-azure`, `provider-custom`, `provider-sdf` are unambiguous (no substring collisions with anything else), so the simple word-boundary sed works:

```bash
grep -rl "@vnext/provider-copilot\\b" vnext/packages vnext/apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/provider-copilot|@vnext-llm/provider-copilot|g'
```

For each `<name>` in `provider-copilot`, `provider-azure`, `provider-custom`, `provider-sdf`:

- [ ] A4–A7.1 — edit `vnext/packages/<name>/package.json` `name` → `@vnext-llm/<name>`
- [ ] A4–A7.2 — sed `@vnext/<name>` → `@vnext-llm/<name>`
- [ ] A4–A7.3 — residue check returns zero
- [ ] A4–A7.4 — `bun install && bun test` green
- [ ] A4–A7.5 — commit: `refactor(vnext): rename @vnext/<name> → @vnext-llm/<name>`

### Task A8 — Rename `@vnext/gateway` → `@vnext-llm/gateway`

**Sed safety note:** `@vnext/gateway` is unambiguous (no longer-name collisions). The simple boundary sed is safe:

```bash
grep -rl "@vnext/gateway\\b" vnext/packages vnext/apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/gateway|@vnext-llm/gateway|g'
```

- [ ] A8.1 — edit `vnext/packages/gateway/package.json` `name` → `@vnext-llm/gateway`
- [ ] A8.2 — run the sed
- [ ] A8.3 — residue check
- [ ] A8.4 — `bun install && bun test` green
- [ ] A8.5 — commit

### Task A9 — Rename `@vnext/platform-bun` → `@vnext-llm/platform-bun`

**Sed safety note:** `@vnext/platform-bun` is a substring of nothing, but it is a longer form of `@vnext-gateway/platform` (already renamed in Part 1). Confirm Part 1 already migrated `@vnext/platform` so the sweep below cannot collide:

```bash
grep -rn "@vnext/platform\\b" vnext/packages vnext/apps --include='*.ts' --include='*.json'
```
Expected: zero matches (Part 1 already turned `@vnext/platform` into `@vnext-gateway/platform`).

Then:

```bash
grep -rl "@vnext/platform-bun" vnext/packages vnext/apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/platform-bun|@vnext-llm/platform-bun|g'
```

This catches both the package specifier `@vnext/platform-bun` and the deep test imports `@vnext/platform-bun/src/...` (gateway tests deep-import via `@vnext/platform-bun/src/bun-sqlite-repo.ts` etc. — verified by grep at Spec writing time).

- [ ] A9.1 — pre-check above returns zero
- [ ] A9.2 — edit `vnext/apps/platform-bun/package.json` `name` → `@vnext-llm/platform-bun`
- [ ] A9.3 — sed `@vnext/platform-bun` → `@vnext-llm/platform-bun`
- [ ] A9.4 — residue check: `grep -rn "@vnext/platform-bun" vnext/packages vnext/apps --include='*.ts' --include='*.json'` returns zero
- [ ] A9.5 — `bun install && bun test` green (the deep-import gateway tests must still find `BunSqliteRepo`, `createBunCache`, etc.)
- [ ] A9.6 — commit

### Task A10 — Rename `@vnext/platform-cloudflare` → `@vnext-llm/platform-cloudflare`

Same A1 shape, no collisions:

- [ ] A10.1 — edit `vnext/apps/platform-cloudflare/package.json` `name`
- [ ] A10.2 — sed
- [ ] A10.3 — residue check
- [ ] A10.4 — `bun install && bun test` green
- [ ] A10.5 — commit

### Task A11 — Rename `@vnext/dashboard` → `@vnext-llm/dashboard`

Same shape:

- [ ] A11.1 — edit `vnext/apps/dashboard/package.json` `name`
- [ ] A11.2 — sed
- [ ] A11.3 — residue check
- [ ] A11.4 — `bun install && bun test` green
- [ ] A11.5 — commit

### Task A12 — Final A4 residue gate (Spec §7 acceptance)

- [ ] **A12.1: Zero `@vnext/*` left in source.**

Run:
```bash
grep -rnE "@vnext/" vnext/packages vnext/apps --include='*.ts' --include='*.json'
```
Expected: **zero output**. Any hit is a missed consumer — fix it in the relevant Task A* re-run, then re-check.

Permitted historical mentions (allowlisted by the future purity script) live under `vnext/docs/superpowers/`; this grep intentionally excludes that directory.

---

## Phase B — Delete temporary re-export shims from Part 1

Part 1 step 1 wrote two compile-time bridges inside `protocols-llm`:
1. `src/common/sse.ts` — became `export * from '@vnext-gateway/result'`
2. lines in `src/common/index.ts` re-exporting `parseSSEStream`, `parseTargetStreamFrames`, the option types, and the frame factories from `@vnext-gateway/result(/parse)`

Part 2 Phase C migrated every external consumer off these re-exports. Now delete them.

### Task B1 — Remove the SSE-shim file

- [ ] **B1.1: Delete the file.**

```bash
git rm vnext/packages/protocols-llm/src/common/sse.ts
```

- [ ] **B1.2: Remove the barrel re-export of frame primitives.**

Open `vnext/packages/protocols-llm/src/common/index.ts`. Find and delete the line(s) that re-export from `./sse` (Part 1 step 2 left a `export * from './sse'` or equivalent). After this edit, no symbol from `@vnext-gateway/result` should leak through the `protocols-llm/common` barrel.

- [ ] **B1.3: Verify no internal consumer of `./sse` remains.**

```bash
grep -rn "from './sse'" vnext/packages/protocols-llm/src
grep -rn 'from "./sse"' vnext/packages/protocols-llm/src
grep -rn "from '\\.\\./common/sse'" vnext/packages/protocols-llm/src
```
Expected: zero. If anything still imports the deleted file, switch it to import from `@vnext-gateway/result` directly.

- [ ] **B1.4: Test.**

```bash
cd vnext && bun test
```
Expected: green.

- [ ] **B1.5: Commit.**

```bash
git add vnext/packages/protocols-llm
git commit -m "refactor(vnext/protocols-llm): drop @vnext-gateway/result frame re-export shim"
```

### Task B2 — Remove the parser re-export lines

- [ ] **B2.1: Edit `protocols-llm/src/common/index.ts`.**

Delete the lines added in Part 1 step 3 that re-export `parseSSEStream`, `parseTargetStreamFrames`, `ParseSSEStreamOptions`, `ParseTargetStreamFramesOptions`, `ParsedTargetStreamFrame` from `@vnext-gateway/result/parse`. (If a single combined `export { ... } from '@vnext-gateway/result/parse'` line covers all five symbols, delete that one line.)

- [ ] **B2.2: Verify external consumers are clean.**

Run:
```bash
grep -rn "from '@vnext-llm/protocols/common'" vnext/packages vnext/apps --include='*.ts' | \
  grep -E "(parseSSEStream|parseTargetStreamFrames|ParseSSEStreamOptions|ParseTargetStreamFramesOptions|ParsedTargetStreamFrame|ProtocolFrame|EventFrame|DoneFrame|SseFrame|SseCommentFrame|SseWritableFrame|eventFrame|doneFrame|sseFrame|sseCommentFrame)"
```
Expected: zero output. (This is Spec 8 §5 step 4's gate, re-asserted after the bridge is gone.)

- [ ] **B2.3: Test.**

```bash
cd vnext && bun test
```
Expected: green. If any test/source still tries to import a parser or frame symbol from `@vnext-llm/protocols/common`, it will fail at type-check; migrate that import to `@vnext-gateway/result` or `@vnext-gateway/result/parse` and re-test.

- [ ] **B2.4: Commit.**

```bash
git add vnext/packages/protocols-llm/src/common/index.ts
git commit -m "refactor(vnext/protocols-llm): drop parser re-exports — consumers go through @vnext-gateway/result/parse"
```

---

## Phase C — Framework-purity enforcement script

Spec 8 §6. This is the durable mechanism that prevents future drift — without it the scope split is decorative.

### Task C1 — Write the script

**Files:**
- Create: `vnext/scripts/check-framework-purity.ts`

- [ ] **C1.1: Write the script.**

Create `vnext/scripts/check-framework-purity.ts` with the following content:

```ts
#!/usr/bin/env bun
/**
 * Framework-purity gate. Run before the test suite via `bun run test`.
 *
 * Rejects two classes of violation:
 *
 *   1. Any package whose name starts with `@vnext-gateway/` must NOT import
 *      anything from `@vnext-llm/*` — neither in `.ts`/`.tsx` source nor in
 *      its package.json dependencies. This enforces Charter §6 framework
 *      purity.
 *
 *   2. Any source file under `vnext/packages/*` or `vnext/apps/*` must NOT
 *      import an un-scoped `@vnext/*` specifier. After Spec 8, every package
 *      is `@vnext-gateway/*` or `@vnext-llm/*`. A bare `@vnext/foo` import
 *      is a habit-revert from the pre-rename naming and is always a bug.
 *
 * Exit code: 0 if clean, 1 if any violation. Prints `file:line  →  matched
 * substring` for each violation so the offending import is grep-jumpable.
 *
 * Allowlist: vnext/scripts/, vnext/docs/, vnext/package.json. Historical
 * mentions of @vnext/* in design docs are expected and permitted.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PACKAGE_ROOTS = [join(ROOT, 'packages'), join(ROOT, 'apps')]
const SOURCE_EXTS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage'])

interface Violation {
  file: string
  line: number
  matched: string
  reason: string
}

const violations: Violation[] = []

function walk(dir: string, visit: (file: string) => void) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, visit)
    else visit(full)
  }
}

function scanFile(file: string, predicate: (line: string) => string | null, reason: string) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hit = predicate(lines[i])
    if (hit) {
      violations.push({
        file: relative(ROOT, file),
        line: i + 1,
        matched: hit,
        reason,
      })
    }
  }
}

// Pattern 1: any source file importing an un-scoped @vnext/* specifier.
// Matches: from '@vnext/foo', from "@vnext/foo", import('@vnext/foo'),
// import '@vnext/foo' (side-effect), export ... from '@vnext/foo'.
const UNSCOPED_VNEXT = /(?:from|import)\s*\(?\s*['"]@vnext\/[a-z0-9-]+/i

// Pattern 2: @vnext-gateway/* package importing @vnext-llm/*.
const LLM_IMPORT = /(?:from|import)\s*\(?\s*['"]@vnext-llm\/[a-z0-9-]+/i

for (const root of PACKAGE_ROOTS) {
  for (const pkgDir of readdirSync(root)) {
    const pkgPath = join(root, pkgDir)
    if (!statSync(pkgPath).isDirectory()) continue

    const manifestPath = join(pkgPath, 'package.json')
    let manifest: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }

    const isFramework = manifest.name?.startsWith('@vnext-gateway/')

    // Manifest check: framework packages must not depend on @vnext-llm/*
    if (isFramework) {
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const deps = manifest[key] ?? {}
        for (const dep of Object.keys(deps)) {
          if (dep.startsWith('@vnext-llm/')) {
            violations.push({
              file: relative(ROOT, manifestPath),
              line: 0,
              matched: `${key}: ${dep}`,
              reason: `${manifest.name} (framework) depends on ${dep} (business)`,
            })
          }
        }
      }
    }

    // Source check
    walk(pkgPath, (file) => {
      const dot = file.lastIndexOf('.')
      if (dot < 0) return
      if (!SOURCE_EXTS.has(file.slice(dot))) return

      scanFile(
        file,
        (line) => {
          const m = line.match(UNSCOPED_VNEXT)
          return m ? m[0] : null
        },
        'un-scoped @vnext/* import (use @vnext-gateway/* or @vnext-llm/*)',
      )

      if (isFramework) {
        scanFile(
          file,
          (line) => {
            const m = line.match(LLM_IMPORT)
            return m ? m[0] : null
          },
          `${manifest.name} (framework) imports @vnext-llm/* (business)`,
        )
      }
    })
  }
}

if (violations.length === 0) {
  console.log('[framework-purity] OK')
  process.exit(0)
}

console.error('[FRAMEWORK PURITY VIOLATION]')
for (const v of violations) {
  const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file
  console.error(`  ${loc}  →  ${v.matched}`)
  console.error(`    ${v.reason}`)
}
process.exit(1)
```

- [ ] **C1.2: Run it standalone and expect it to pass.**

```bash
cd vnext && bun run scripts/check-framework-purity.ts
```
Expected: `[framework-purity] OK`, exit 0.

If it reports violations, treat each as a real bug — either a missed Phase A rename or an un-migrated import — and fix in the relevant package.

- [ ] **C1.3: Smoke-test the negative case.**

Add a deliberate violation in any framework package, e.g. in `vnext/packages/result/src/frame.ts` insert at the top:
```ts
import type {} from '@vnext-llm/protocols/common'
```
Run the script — it must exit 1 and print the file/line. Remove the deliberate violation. Confirm exit 0 again.

This proves the script actually catches the case it's there to catch (a script that always passes is worse than no script).

- [ ] **C1.4: Commit.**

```bash
git add vnext/scripts/check-framework-purity.ts
git commit -m "feat(vnext/scripts): add framework-purity check (Spec 8 §6)"
```

### Task C2 — Wire it into `bun run test`

**Files:**
- Modify: `vnext/package.json`

- [ ] **C2.1: Add the root `test` script.**

Open `vnext/package.json`. The `scripts` block currently reads:
```json
"scripts": {
  "typecheck": "bun run --filter '*' typecheck",
  "lint": "eslint .",
  "build:ui": "bun scripts/build-dashboard.ts"
},
```

Change it to:
```json
"scripts": {
  "test": "bun run scripts/check-framework-purity.ts && bun test",
  "typecheck": "bun run --filter '*' typecheck",
  "lint": "eslint .",
  "build:ui": "bun scripts/build-dashboard.ts"
},
```

The order matters: the purity gate runs *before* `bun test` so a violation fails fast without burning test time.

- [ ] **C2.2: Run the new script.**

```bash
cd vnext && bun run test
```
Expected: `[framework-purity] OK`, then the full test suite passes.

- [ ] **C2.3: Commit.**

```bash
git add vnext/package.json
git commit -m "build(vnext): wire framework-purity gate into bun run test"
```

---

## Phase D — Dockerfile update + image build verification (Spec §7 A5)

### Task D1 — Update Dockerfile

**Files:**
- Modify: `vnext/apps/platform-bun/Dockerfile`

- [ ] **D1.1: Edit the COPY lines.**

Open `vnext/apps/platform-bun/Dockerfile`. Find this block (lines ~14–29):

```dockerfile
COPY apps/platform-bun/package.json apps/platform-bun/
COPY apps/platform-cloudflare/package.json apps/platform-cloudflare/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/gateway/package.json packages/gateway/
COPY packages/platform/package.json packages/platform/
COPY packages/protocols/package.json packages/protocols/
COPY packages/service/package.json packages/service/
COPY packages/provider/package.json packages/provider/
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-copilot/package.json packages/provider-copilot/
COPY packages/provider-custom/package.json packages/provider-custom/
COPY packages/provider-sdf/package.json packages/provider-sdf/
COPY packages/responses-store/package.json packages/responses-store/
COPY packages/cache/package.json packages/cache/
COPY packages/http/package.json packages/http/
COPY packages/translate/package.json packages/translate/
```

Make two changes:

1. Replace the `protocols/` line with the renamed directory:
   ```dockerfile
   COPY packages/protocols-llm/package.json packages/protocols-llm/
   ```
2. Add a line for the new `result/` package (created in Part 1 Task 1):
   ```dockerfile
   COPY packages/result/package.json packages/result/
   ```

Keep the rest unchanged — every other package's *directory* name is unchanged (only `package.json` `name` flipped), so the `COPY` paths still resolve.

- [ ] **D1.2: Build the image.**

Run from repo root:
```bash
docker build -f vnext/apps/platform-bun/Dockerfile vnext/
```
Expected: image builds end-to-end. The `bun install --frozen-lockfile` step must succeed (proves the regenerated `bun.lock` matches the renamed manifests), and the `bun run build:ui` step must succeed (proves dashboard package wiring still resolves).

If `bun install --frozen-lockfile` fails with "lockfile drift", re-run `bun install` locally inside `vnext/`, re-commit the updated `bun.lock`, and rebuild.

- [ ] **D1.3: Commit.**

```bash
git add vnext/apps/platform-bun/Dockerfile
git commit -m "build(vnext/platform-bun): COPY packages/protocols-llm + packages/result"
```

---

## Phase E — Spec 8 acceptance gate

Final verification against the spec's §7 acceptance criteria. No new code; just re-run the gates and record outcomes.

### Task E1 — Run every gate

- [ ] **E1.1 (A1): `bun run test` is green.**

```bash
cd vnext && bun run test
```
Expected: purity gate `OK`, then 981+ tests pass.

- [ ] **E1.2 (A2): per-package typecheck is green for the listed packages.**

```bash
cd vnext
for pkg in result service platform http cache protocols-llm provider-copilot gateway; do
  echo "=== $pkg ==="
  (cd packages/$pkg && bun run typecheck) || true
done
for app in platform-bun platform-cloudflare dashboard; do
  echo "=== app/$app ==="
  (cd apps/$app && bun run typecheck) || true
done
```

Expected: clean for all listed packages **except** the pre-existing baselines noted in Spec §7 A2:
- `translate/src/gemini-via-responses/body.ts` — 3 hits, pre-existing
- `provider-azure`, `provider-custom`, `provider-sdf` typecheck failures noted in Spec 7 §8.1, pre-existing

No *new* typecheck errors should appear. If you see new errors, they must be fixed before declaring acceptance.

- [ ] **E1.3 (A3): purity script exits 0.**

```bash
cd vnext && bun run scripts/check-framework-purity.ts
echo "exit=$?"
```
Expected: `[framework-purity] OK` and `exit=0`.

- [ ] **E1.4 (A4): zero `@vnext/*` left in source.**

```bash
grep -rnE "@vnext/" vnext/packages vnext/apps --include='*.ts' --include='*.json'
```
Expected: zero output.

- [ ] **E1.5 (A5): Docker image builds end-to-end.**

Already done in D1.2; re-run if anything has changed since:
```bash
docker build -f vnext/apps/platform-bun/Dockerfile vnext/
```
Expected: image builds without error.

- [ ] **E1.6 (A6): no behaviour change — manual smoke.**

This is a manual gate. Boot the renamed platform-bun against a local provider key and confirm a chat-completions / messages / responses / gemini call returns the same byte stream as a pre-Spec-8 baseline (use any pre-Spec-8 commit's response as the reference).

If the user opts to skip the live-call smoke (it requires real credentials), record the decision and note that A6 is verified-via-tests instead — `bun run test` covering 981 cases is the proxy.

### Task E2 — Final summary commit / branch tag

- [ ] **E2.1: Note completion in Spec 8 progress.**

No additional code change. Optionally add a one-line note to the spec footer:
```bash
# Open vnext/docs/superpowers/specs/2026-06-24-spec8-protocols-split.md
# At the bottom, append: "**Status (2026-06-24):** Implementation complete — see plans Part 1/2/3."
```

- [ ] **E2.2: Tag the branch (optional, for easy rollback target).**

If the user wants a rollback marker:
```bash
git tag -a spec8-complete -m "Spec 8 — protocols split + scope layering complete"
```
Skip this if the user prefers to tag only at merge time.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| A Phase A sed misses a consumer (e.g. an import inside a template literal or a comment) | Every Task A* ends with a strict residue grep; CI's purity gate (`bun run test`) catches any leftover `@vnext/*` going forward. |
| Substring collision sed eats a longer name (`@vnext/provider` → `@vnext-llm/provider-copilot`) | A3 uses the explicit terminator pattern `([\"'/])`; A9 verifies `@vnext/platform` is already migrated before sweeping `@vnext/platform-bun`. |
| Phase B deletes a re-export some test still depends on | B1.3 and B2.2 grep for any residual import path before deleting; `bun test` between B1 and B2 catches type errors. |
| Purity script has false positives on tooling files | Allowlist: only `vnext/packages/*` and `vnext/apps/*` are scanned. `vnext/scripts/`, `vnext/docs/`, top-level `vnext/package.json` are excluded by construction. |
| Purity script silently passes everything | C1.3 explicitly inserts a deliberate violation and confirms the script catches it. |
| Dockerfile `bun install --frozen-lockfile` drifts | D1.2 re-runs `bun install` locally if needed and re-commits the lockfile. The image build itself is the acceptance check (A5). |
| Stray files swept into a commit (e.g. `apps/platform-bun/.vnext-local.sqlite`, generated docs) | Every commit uses `git add -A vnext/packages vnext/apps vnext/bun.lock` scoped paths, plus a `git status` sanity check before commit. Never `git add -A` from repo root. |
| Future contributor reverts to `@vnext/*` names | The purity script rejects any un-scoped `@vnext/*` import; CI runs it before every test invocation. |
