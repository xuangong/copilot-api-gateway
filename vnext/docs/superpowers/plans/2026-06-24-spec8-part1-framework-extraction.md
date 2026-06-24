# Spec 8 Part 1 — Framework Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the framework layer out of `@vnext/protocols/common` into a new `@vnext-gateway/result` package, and rename the four other framework packages (`service`, `platform`, `http`, `cache`) into the `@vnext-gateway/*` scope.

**Architecture:** Hard cut, dependency-topological order. Step 1 creates `@vnext-gateway/result` with `ProtocolFrame`/`Sse*Frame`/`EventFrame`/`DoneFrame` primitives + factories + the two SSE parsers, and keeps temporary re-exports inside `@vnext/protocols/common` so nothing breaks at call sites. Step 2 renames the four already-domain-neutral framework packages one at a time, sweeping every consumer import with `sed`, regenerating `bun.lock`, and running tests after each rename. At plan end the `@vnext-gateway/*` scope exists in package names; business packages still carry `@vnext/*` names (Part 2 handles those).

**Tech Stack:** Bun 1.x workspaces, TypeScript, `bun test`, `bun install` (lockfile regen).

**Working directory:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

**Spec reference:** `docs/superpowers/specs/2026-06-24-spec8-protocols-split.md` §3.1, §3.3, §5 steps 1–2.

**Counts (probed 2026-06-24, will guide expectations):**
- `@vnext/service` consumers (ts+json): 13 files
- `@vnext/platform` consumers: 85 files
- `@vnext/http` consumers: 9 files
- `@vnext/cache` consumers: 11 files
- `@vnext/protocols/common` consumers (will remain pointing at re-exports through Part 1): 119 files

---

## File Structure

### New package: `vnext/packages/result/`

```
packages/result/
  package.json        — name "@vnext-gateway/result", exports "." + "./parse"
  src/
    frame.ts          — moved from packages/protocols/src/common/sse.ts
                        Exports: SseFrame, SseCommentFrame, SseWritableFrame,
                                 EventFrame<TEvent>, DoneFrame, ProtocolFrame<TEvent>,
                                 sseFrame, sseCommentFrame, eventFrame, doneFrame
    parse-sse.ts      — moved from packages/protocols/src/common/stream/parse-sse.ts
                        import { type SseFrame, sseFrame } from './frame'
                        Exports: ParseSSEStreamOptions, parseSSEStream
    parse-events.ts   — moved from packages/protocols/src/common/stream/parse-events.ts
                        import type { SseFrame } from './frame'
                        Exports: ParseTargetStreamFramesOptions, ParsedTargetStreamFrame, parseTargetStreamFrames
    index.ts          — re-exports everything from ./frame
    parse.ts          — re-exports parseSSEStream, parseTargetStreamFrames and option/result types
  __tests__/
    parse-sse.test.ts    — moved from protocols/src/common/stream/__tests__/parse-sse.test.ts
                            import paths changed to '../src/parse-sse' etc.
    parse-events.test.ts — moved likewise
```

### Renamed packages (directory unchanged, only `package.json` `name` field flips)

| Directory | Old name | New name |
|---|---|---|
| `packages/service/` | `@vnext/service` | `@vnext-gateway/service` |
| `packages/platform/` | `@vnext/platform` | `@vnext-gateway/platform` |
| `packages/http/` | `@vnext/http` | `@vnext-gateway/http` |
| `packages/cache/` | `@vnext/cache` | `@vnext-gateway/cache` |

### Temporary re-exports inside `packages/protocols/`

`packages/protocols/src/common/index.ts` continues to export the same names; under the hood they come from `@vnext-gateway/result` instead of local files. This survives until Spec 8 Part 3 step 6.

### Files modified across consumer sweeps

For each rename in Task 6–9: every `.ts` / `.tsx` file in `packages/**` and `apps/**` that contains `from '@vnext/<old>'` or `from "@vnext/<old>"`, plus every `package.json` whose `dependencies`/`devDependencies` contains `"@vnext/<old>": "workspace:*"`. The lockfile `vnext/bun.lock` regenerates.

---

## Pre-flight

These checks bound the work and verify the starting state.

- [ ] **Step 0.1: Confirm baseline tests pass**

Run from `/Users/zhangxian/projects/copilot-api-gateway/vnext/`:
```bash
bun test 2>&1 | tail -3
```
Expected: ends with a "Ran NNN tests" / "X pass" line and exit 0 (no failing tests). If anything is failing here, stop and investigate before any rename — `bun test` is the safety net for every subsequent step.

- [ ] **Step 0.2: Note current consumer counts**

```bash
grep -rln "@vnext/service" packages apps --include='*.ts' --include='*.json' | wc -l
grep -rln "@vnext/platform" packages apps --include='*.ts' --include='*.json' | wc -l
grep -rln "@vnext/http" packages apps --include='*.ts' --include='*.json' | wc -l
grep -rln "@vnext/cache" packages apps --include='*.ts' --include='*.json' | wc -l
```
Expected (probed 2026-06-24): 13 / 85 / 9 / 11. These numbers should drop to 0 after their respective rename tasks.

---

## Task 1: Create `@vnext-gateway/result` package skeleton

**Files:**
- Create: `vnext/packages/result/package.json`

- [ ] **Step 1.1: Write package.json**

Create `vnext/packages/result/package.json` with this exact content:

```json
{
  "name": "@vnext-gateway/result",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./parse": "./src/parse.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

No runtime dependencies — `frame.ts` is pure types/factories, parsers use only Web standard `ReadableStream` and `TextDecoder`.

- [ ] **Step 1.2: Add tsconfig.json mirroring siblings**

Read `vnext/packages/service/tsconfig.json` to see the project pattern, then create `vnext/packages/result/tsconfig.json` with identical content. (We're matching existing convention, not inventing config.)

- [ ] **Step 1.3: Commit the empty package shell**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/result/package.json vnext/packages/result/tsconfig.json
git commit -m "feat(vnext/result): scaffold @vnext-gateway/result package shell"
```

Bun's workspaces glob is `packages/*`, so this commit makes the new package visible to `bun install` even before sources exist — but we don't run install yet, sources land in the next tasks.

---

## Task 2: Move frame primitives into `@vnext-gateway/result`

**Files:**
- Move: `vnext/packages/protocols/src/common/sse.ts` → `vnext/packages/result/src/frame.ts`
- Create: `vnext/packages/result/src/index.ts`
- Modify: `vnext/packages/protocols/src/common/sse.ts` (becomes a thin re-export shim)
- Modify: `vnext/packages/protocols/package.json` (add `@vnext-gateway/result` dep)

- [ ] **Step 2.1: Move sse.ts → result/src/frame.ts**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
mkdir -p packages/result/src
git mv packages/protocols/src/common/sse.ts packages/result/src/frame.ts
```

- [ ] **Step 2.2: Create result/src/index.ts**

Create `vnext/packages/result/src/index.ts` with this exact content:

```ts
export * from './frame.ts'
```

- [ ] **Step 2.3: Re-create protocols/src/common/sse.ts as a re-export shim**

Re-create `vnext/packages/protocols/src/common/sse.ts` with this exact content (so every existing `from '../sse'` import inside `packages/protocols/src/**` still resolves):

```ts
export * from '@vnext-gateway/result'
```

- [ ] **Step 2.4: Add @vnext-gateway/result dep to protocols package.json**

Edit `vnext/packages/protocols/package.json`. Change the `dependencies` block from:

```json
  "dependencies": {
    "@vnext/service": "workspace:*",
    "zod": "^4.4.3"
  }
```

to:

```json
  "dependencies": {
    "@vnext-gateway/result": "workspace:*",
    "@vnext/service": "workspace:*",
    "zod": "^4.4.3"
  }
```

- [ ] **Step 2.5: Regenerate lockfile**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```
Expected: lockfile updates; no errors.

- [ ] **Step 2.6: Run tests**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 0.1 (no behavior change — `sse.ts` now re-exports from the new package, but the symbol set is identical).

- [ ] **Step 2.7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/result/ vnext/packages/protocols/src/common/sse.ts vnext/packages/protocols/package.json vnext/bun.lock
git commit -m "refactor(vnext/result): move ProtocolFrame primitives from protocols/common/sse to @vnext-gateway/result"
```

---

## Task 3: Move SSE parsers into `@vnext-gateway/result`

**Files:**
- Move: `vnext/packages/protocols/src/common/stream/parse-sse.ts` → `vnext/packages/result/src/parse-sse.ts`
- Move: `vnext/packages/protocols/src/common/stream/parse-events.ts` → `vnext/packages/result/src/parse-events.ts`
- Move: `vnext/packages/protocols/src/common/stream/__tests__/parse-sse.test.ts` → `vnext/packages/result/__tests__/parse-sse.test.ts`
- Move: `vnext/packages/protocols/src/common/stream/__tests__/parse-events.test.ts` → `vnext/packages/result/__tests__/parse-events.test.ts`
- Create: `vnext/packages/result/src/parse.ts`
- Modify: `vnext/packages/protocols/src/common/index.ts` (re-export from `@vnext-gateway/result/parse` instead of local stream/)

- [ ] **Step 3.1: Move parser sources**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
mkdir -p packages/result/__tests__
git mv packages/protocols/src/common/stream/parse-sse.ts packages/result/src/parse-sse.ts
git mv packages/protocols/src/common/stream/parse-events.ts packages/result/src/parse-events.ts
git mv packages/protocols/src/common/stream/__tests__/parse-sse.test.ts packages/result/__tests__/parse-sse.test.ts
git mv packages/protocols/src/common/stream/__tests__/parse-events.test.ts packages/result/__tests__/parse-events.test.ts
```

- [ ] **Step 3.2: Update import paths inside the moved parser files**

In `vnext/packages/result/src/parse-sse.ts`, change the top import from:

```ts
import { type SseFrame, sseFrame } from '../sse'
```

to:

```ts
import { type SseFrame, sseFrame } from './frame'
```

In `vnext/packages/result/src/parse-events.ts`, change the top import from:

```ts
import type { SseFrame } from '../sse'
```

to:

```ts
import type { SseFrame } from './frame'
```

- [ ] **Step 3.3: Update import paths inside the moved test files**

Open `vnext/packages/result/__tests__/parse-sse.test.ts` and `vnext/packages/result/__tests__/parse-events.test.ts`. Any import that referenced `'../parse-sse'`, `'../parse-events'`, `'../../sse'`, or `'../../index'` was relative to the old location (`packages/protocols/src/common/stream/__tests__/`). Update each to its equivalent under the new home:

- `'../parse-sse'` → `'../src/parse-sse'`
- `'../parse-events'` → `'../src/parse-events'`
- `'../../sse'` → `'../src/frame'`

Do not invent new imports — only adjust existing ones. If you see anything else, leave it (`bun:test`, `node:stream`, etc. resolve the same from any directory).

- [ ] **Step 3.4: Create result/src/parse.ts**

Create `vnext/packages/result/src/parse.ts` with this exact content:

```ts
export type { ParseSSEStreamOptions } from './parse-sse.ts'
export { parseSSEStream } from './parse-sse.ts'
export type { ParseTargetStreamFramesOptions, ParsedTargetStreamFrame } from './parse-events.ts'
export { parseTargetStreamFrames } from './parse-events.ts'
```

- [ ] **Step 3.5: Rewrite the protocols/common stream re-export**

Read `vnext/packages/protocols/src/common/index.ts`. Locate the block that re-exports stream parsers (look for `parseSSEStream` / `parseTargetStreamFrames`). Replace the current export form — whatever it is (likely `export * from './stream/parse-sse.ts'` and `./stream/parse-events.ts`) — with a single line that pulls from the new package:

```ts
export * from '@vnext-gateway/result/parse'
```

The empty `packages/protocols/src/common/stream/` directory left behind has no remaining files. Remove it:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
rmdir packages/protocols/src/common/stream/__tests__ packages/protocols/src/common/stream
```

- [ ] **Step 3.6: Run tests**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 2.6. The 4 parser test files now run from their new home; everything else is unaffected.

- [ ] **Step 3.7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages/result/ vnext/packages/protocols/src/common/
git commit -m "refactor(vnext/result): move parseSSEStream/parseTargetStreamFrames + tests to @vnext-gateway/result/parse"
```

---

## Task 4: Per-package typecheck of the new `@vnext-gateway/result`

**Files:** (verification only)

- [ ] **Step 4.1: Run typecheck on the new package**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/result
bun run typecheck
```
Expected: exits 0, no errors. If it fails, the most likely cause is a stale relative import inside `frame.ts` (it shouldn't have any — it was self-contained), or `tsconfig.json` mismatch.

- [ ] **Step 4.2: Re-typecheck protocols (consumer of result)**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/protocols
bun run typecheck
```
Expected: exits 0. Confirms the temporary re-export shim in `common/sse.ts` + `common/index.ts` resolves the new package correctly.

No commit — this is a verification gate.

---

## Task 5: Rename `@vnext/service` → `@vnext-gateway/service`

**Files:**
- Modify: `vnext/packages/service/package.json` (name field)
- Sweep: 13 files that contain `@vnext/service` (see Step 5.1)
- Regenerate: `vnext/bun.lock`

- [ ] **Step 5.1: Inventory the consumer files**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/service" packages apps --include='*.ts' --include='*.json'
```
Expected (probed 2026-06-24): 13 paths. Note them — they're the targets of the sed sweep.

- [ ] **Step 5.2: Flip the `name` field**

Edit `vnext/packages/service/package.json`. Change `"name": "@vnext/service"` to `"name": "@vnext-gateway/service"`.

- [ ] **Step 5.3: Sweep every consumer import**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rl "@vnext/service" packages apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/service|@vnext-gateway/service|g'
```

(`sed -i ''` is BSD syntax — works on macOS as shipped. If running on Linux, drop the empty arg: `sed -i 's|...|...|g'`.)

- [ ] **Step 5.4: Verify zero residue**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/service" packages apps --include='*.ts' --include='*.json'
```
Expected: empty output. If anything remains, hand-edit it.

- [ ] **Step 5.5: Regenerate lockfile**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```
Expected: lockfile updates; `bun install` does not complain about missing workspaces.

- [ ] **Step 5.6: Run tests**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 3.6.

- [ ] **Step 5.7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): rename @vnext/service -> @vnext-gateway/service"
```

---

## Task 6: Rename `@vnext/platform` → `@vnext-gateway/platform`

**Files:**
- Modify: `vnext/packages/platform/package.json` (name field)
- Sweep: 85 files that contain `@vnext/platform` (largest sweep in this plan)
- Regenerate: `vnext/bun.lock`

Note: 85 files is the biggest sweep — make sure the prior task's tests are still green before starting.

- [ ] **Step 6.1: Inventory the consumer files**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/platform" packages apps --include='*.ts' --include='*.json' | wc -l
```
Expected (probed 2026-06-24): 85.

- [ ] **Step 6.2: Flip the `name` field**

Edit `vnext/packages/platform/package.json`. Change `"name": "@vnext/platform"` to `"name": "@vnext-gateway/platform"`. Leave `main` / `types` / `exports` untouched — they're relative paths.

- [ ] **Step 6.3: Sweep every consumer import**

The substring `@vnext/platform` is also a prefix of `@vnext/platform-bun` and `@vnext/platform-cloudflare` (which are app names that stay `@vnext/` through Part 1 — they get renamed in Part 3). A naive sed would corrupt those into `@vnext-gateway/platform-bun`. Use a word-boundary terminator on `'` or `"` to scope the substitution:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rl "@vnext/platform[\"']" packages apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' "s|@vnext/platform\\([\"']\\)|@vnext-gateway/platform\\1|g"
```

This replaces `@vnext/platform"` → `@vnext-gateway/platform"` and `@vnext/platform'` → `@vnext-gateway/platform'`, leaving `@vnext/platform-bun"` and `@vnext/platform-cloudflare"` alone.

If a consumer uses a subpath import like `from '@vnext/platform/foo'` the substring before `/` is the next-character terminator; widen the sed pattern if any such hits exist. Check first:

```bash
grep -rln "@vnext/platform/" packages apps --include='*.ts'
```
If non-empty, add a second pass:
```bash
grep -rl "@vnext/platform/" packages apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/platform/|@vnext-gateway/platform/|g'
```

(Today, the probe shows no subpath imports — `@vnext/platform` only exports `.`. Still safe to run; the substitution is a no-op if there's nothing to match.)

- [ ] **Step 6.4: Verify zero residue (and no platform-bun corruption)**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/platform[\"'/]" packages apps --include='*.ts' --include='*.json'
grep -rln "@vnext-gateway/platform-bun\|@vnext-gateway/platform-cloudflare" packages apps --include='*.ts' --include='*.json'
```
First command expected: empty. Second command expected: empty (the app names must NOT have been touched). If the second fires, hand-revert those files: change `@vnext-gateway/platform-bun` back to `@vnext/platform-bun` etc.

- [ ] **Step 6.5: Regenerate lockfile**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```

- [ ] **Step 6.6: Run tests**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 5.6.

- [ ] **Step 6.7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): rename @vnext/platform -> @vnext-gateway/platform"
```

---

## Task 7: Rename `@vnext/http` → `@vnext-gateway/http`

**Files:**
- Modify: `vnext/packages/http/package.json` (name field)
- Sweep: 9 files that contain `@vnext/http`
- Regenerate: `vnext/bun.lock`

- [ ] **Step 7.1: Inventory**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/http" packages apps --include='*.ts' --include='*.json' | wc -l
```
Expected: 9.

- [ ] **Step 7.2: Flip the `name` field**

Edit `vnext/packages/http/package.json`. Change `"name": "@vnext/http"` to `"name": "@vnext-gateway/http"`.

- [ ] **Step 7.3: Sweep**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rl "@vnext/http" packages apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/http|@vnext-gateway/http|g'
```

(No collision risk here — `@vnext/http` has no sibling like `@vnext/http-foo`.)

- [ ] **Step 7.4: Verify zero residue**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/http" packages apps --include='*.ts' --include='*.json'
```
Expected: empty.

- [ ] **Step 7.5: Regenerate lockfile**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```

- [ ] **Step 7.6: Run tests**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 6.6.

- [ ] **Step 7.7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): rename @vnext/http -> @vnext-gateway/http"
```

---

## Task 8: Rename `@vnext/cache` → `@vnext-gateway/cache`

**Files:**
- Modify: `vnext/packages/cache/package.json` (name field)
- Sweep: 11 files that contain `@vnext/cache`
- Regenerate: `vnext/bun.lock`

- [ ] **Step 8.1: Inventory**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/cache" packages apps --include='*.ts' --include='*.json' | wc -l
```
Expected: 11.

- [ ] **Step 8.2: Flip the `name` field**

Edit `vnext/packages/cache/package.json`. Change `"name": "@vnext/cache"` to `"name": "@vnext-gateway/cache"`.

- [ ] **Step 8.3: Sweep**

`@vnext/cache` has subpath exports (`./memory`, `./kv`, `./d1`), so consumers may write `from '@vnext/cache/kv'`. The plain substring substitution is still safe — `@vnext/cache` is not a prefix of any other workspace name. Run:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rl "@vnext/cache" packages apps --include='*.ts' --include='*.json' \
  | xargs sed -i '' 's|@vnext/cache|@vnext-gateway/cache|g'
```

- [ ] **Step 8.4: Verify zero residue**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/cache" packages apps --include='*.ts' --include='*.json'
```
Expected: empty.

- [ ] **Step 8.5: Regenerate lockfile**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```

- [ ] **Step 8.6: Run tests**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 7.6.

- [ ] **Step 8.7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): rename @vnext/cache -> @vnext-gateway/cache"
```

---

## Task 9: Part 1 acceptance gate

**Files:** (verification only)

- [ ] **Step 9.1: Zero remaining framework-package references under the old scope**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rlnE "@vnext/(service|platform|http|cache)([\"'/])" packages apps --include='*.ts' --include='*.json'
```
Expected: empty.

- [ ] **Step 9.2: Framework package names land under `@vnext-gateway/*`**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
for d in result service platform http cache; do
  echo "=== $d ==="
  node -e "console.log(require('./packages/$d/package.json').name)"
done
```
Expected:
```
=== result ===
@vnext-gateway/result
=== service ===
@vnext-gateway/service
=== platform ===
@vnext-gateway/platform
=== http ===
@vnext-gateway/http
=== cache ===
@vnext-gateway/cache
```

- [ ] **Step 9.3: Per-package typecheck for every framework package**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
for d in result service platform http cache; do
  echo "=== typecheck $d ==="
  (cd packages/$d && bun run typecheck) || echo "FAILED: $d"
done
```
Expected: each section ends without `FAILED`. No new errors introduced; pre-existing baseline errors (translate / provider-azure / provider-custom / provider-sdf — they're business packages, untouched in Part 1) are not part of this gate.

- [ ] **Step 9.4: Full test suite**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -5
```
Expected: same pass count as Step 0.1. **If the count dropped, do not proceed to Part 2** — diagnose and fix first.

- [ ] **Step 9.5: Final commit of any verification artifacts**

If Steps 9.1–9.4 produced no changes, there's nothing to commit. If they did (e.g. you had to hand-fix a missed import), commit it:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git status --short
# If non-empty:
git add -A vnext/
git commit -m "fix(vnext): resolve straggler imports after framework scope rename"
```

---

## Out of scope for Part 1

These belong to later parts of Spec 8 — do not touch them here:

- Splitting `@vnext/protocols` into `@vnext-llm/protocols` (Part 2)
- Renaming `EventResult` → `LlmEventResult` and the 128-file consumer sweep (Part 2)
- Migrating frame/parser consumers off `@vnext/protocols/common` re-exports (Part 2)
- Renaming any business package: `translate`, `responses-store`, `provider*`, `gateway`, `apps/*` (Part 3)
- Removing the temporary re-exports introduced in Tasks 2–3 (Part 3)
- Writing `scripts/check-framework-purity.ts` and the root `test` script (Part 3)
- Dockerfile changes (Part 3)

The `@vnext/protocols/common` re-exports added in Task 2 (`sse.ts` shim) and Task 3 (stream re-export from `@vnext-gateway/result/parse`) MUST remain in place at the end of Part 1. They are load-bearing for the 119 protocol consumers that still write `from '@vnext/protocols/common'` — Part 2 migrates them.

---

## Risks specific to Part 1

| Risk | Mitigation |
|---|---|
| Platform rename sed corrupts `@vnext/platform-bun` / `@vnext/platform-cloudflare` app names | Task 6 uses a quote/slash-terminated sed pattern + an explicit post-check (Step 6.4 second `grep`). |
| Parser tests fail to find their new neighbor files | Step 3.3 enumerates exactly which relative imports to rewrite; Step 3.6 catches any miss. |
| `bun install` lockfile drift causes container regressions later | Each rename task regenerates `bun.lock` and is committed with the workspace change in the same commit; Part 3's Docker check (Spec §A5) is the integration backstop. |
| Working directory accidentally committed (sqlite, plan files) | Each commit uses `git add -A vnext/packages vnext/apps vnext/bun.lock` (explicit subset) instead of `git add -A` at repo root. |
