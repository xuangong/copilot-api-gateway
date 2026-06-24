# Spec 8 Part 2 — Protocols Split + Frame Consumer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `@vnext/protocols` into `@vnext-llm/protocols` (rename + drop root export), rename the four LLM-specific result types to `Llm*`, and migrate every external consumer of the framework frame/parser primitives off the temporary re-exports.

**Architecture:** Three-phase hard cut, single PR per phase.
1. **Phase A — Rename to `@vnext-llm/protocols`.** Directory `packages/protocols/` → `packages/protocols-llm/`, package.json `name` flips, the dead `"."` export is deleted, and every consumer that wrote `from '@vnext/protocols/...'` (≈119 files for subpaths) is `sed`-rewritten to `@vnext-llm/protocols/...`.
2. **Phase B — Rename four LLM-result types.** `EventResult`/`ExecuteResult`/`eventResult()`/`internalErrorResult()` → `Llm*` variants inside `@vnext-llm/protocols/common/result.ts`, with a global identifier-level `sed` across ≈46 consumer files (the renamed file lives at `packages/protocols-llm/src/common/result.ts` post-Phase-A — Phase B operates on that path).
3. **Phase C — Migrate frame/parser consumers.** Anywhere outside `packages/protocols-llm/` that imports frame primitives (`ProtocolFrame`, `SseFrame`, `EventFrame`, `DoneFrame`, `SseCommentFrame`, `SseWritableFrame`, `eventFrame`, `doneFrame`, `sseFrame`, `sseCommentFrame`) or parsers (`parseSSEStream`, `parseTargetStreamFrames` + option/result types) through `@vnext-llm/protocols/common` switches to `@vnext-gateway/result` / `@vnext-gateway/result/parse` directly. The re-exports inside `protocols-llm/common` stay in place for safety — Part 3 deletes them.

After Part 2: the `@vnext-llm/protocols` package exists with subpath-only access; all four LLM result types carry `Llm` prefixes; framework primitives are imported directly from `@vnext-gateway/result` everywhere outside the LLM protocol package itself.

**Tech Stack:** Bun 1.x workspaces, TypeScript, `bun test`, `git mv`, `sed`.

**Working directory:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

**Spec reference:** `docs/superpowers/specs/2026-06-24-spec8-protocols-split.md` §3.2 (business scope), §3.4 (`@vnext-llm/protocols` layout), §3.5 (type renames), §5 steps 3–4.

**Prerequisite:** Spec 8 Part 1 complete. `@vnext-gateway/result` exists; `@vnext-gateway/{service, platform, http, cache}` are the framework package names; `@vnext/protocols` still has its old name and a `common/sse.ts` re-export shim + a `common/index.ts` stream re-export pointing at `@vnext-gateway/result/parse`.

**Counts (probed 2026-06-24):**
- Consumers of `@vnext/protocols/<subpath>` (ts files): ~119 — sed targets in Phase A
- Consumers of the four renamed identifiers (`EventResult`, `ExecuteResult`, `eventResult`, `internalErrorResult`): 46 files — sed targets in Phase B
- Consumers of frame/parser symbols outside `protocols`/`protocols-llm` and `result`: probed via `Step C.1` of Phase C

---

## File Structure

### Renamed directory + package

```
packages/protocols/        →  packages/protocols-llm/
  package.json:
    name "@vnext/protocols" → "@vnext-llm/protocols"
    exports map: REMOVE the "." entry; keep ./common, ./chat, ./messages, ./responses, ./gemini
    dependencies: "@vnext/service" → "@vnext-gateway/service" (already done in Part 1 sweep)
                  "@vnext-gateway/result" stays
  src/
    index.ts            DELETE (no root export per §3.4)
    common/
      result.ts         four type/factory renames (Phase B)
      sse.ts            stays as re-export shim of @vnext-gateway/result (Part 1 leftover)
      index.ts          re-exports get the Llm* names
      stream/           already empty (Part 1)
    chat/ messages/ responses/ gemini/   unchanged shape
```

### Renamed identifiers (Phase B — same file count of definitions in `result.ts`)

| Old → New | Kind |
|---|---|
| `EventResult<T>` → `LlmEventResult<T>` | interface |
| `ExecuteResult<T>` → `LlmExecuteResult<T>` | type alias |
| `eventResult()` → `llmEventResult()` | factory |
| `internalErrorResult()` → `llmInternalErrorResult()` | factory |

**Not renamed** (per §3.5): `UpstreamErrorResult`, `InternalErrorResult`, `TelemetryModelIdentity`, `PerformanceTelemetryContext`, `EventResultMetadata` (the struct type — its `modelIdentity` field name is unchanged), `TranslateBodyContext`, `readUpstreamError`, `upstreamErrorToResponse`, `decodeUpstreamErrorBody`. The three `*StreamInterceptor` aliases and `CopilotInterceptor` keep their names — they already carry LLM context.

### Phase C migration target

Outside `packages/protocols-llm/`, every `import { ProtocolFrame | EventFrame | DoneFrame | SseFrame | SseCommentFrame | SseWritableFrame | eventFrame | doneFrame | sseFrame | sseCommentFrame } from '@vnext-llm/protocols/common'` shifts to `'@vnext-gateway/result'`. Every `import { parseSSEStream | parseTargetStreamFrames | ParseSSEStreamOptions | ParseTargetStreamFramesOptions | ParsedTargetStreamFrame } from '@vnext-llm/protocols/common'` shifts to `'@vnext-gateway/result/parse'`. If a file imports both a frame symbol AND an LLM-only symbol (e.g. `Invocation`) from `@vnext-llm/protocols/common` in the same statement, the statement is split.

---

## Pre-flight

- [ ] **Step 0.1: Confirm Part 1 baseline**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -3
```
Expected: same pass count as Part 1 Step 9.4. If anything is failing, stop — Part 2 needs a clean baseline.

- [ ] **Step 0.2: Verify Part 1 invariants**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
node -e "console.log(require('./packages/result/package.json').name)"           # @vnext-gateway/result
node -e "console.log(require('./packages/service/package.json').name)"          # @vnext-gateway/service
node -e "console.log(require('./packages/protocols/package.json').name)"        # @vnext/protocols  (Part 2 will change this)
grep -c 'export \* from .@vnext-gateway/result.' packages/protocols/src/common/sse.ts  # 1
grep -c '@vnext-gateway/result/parse' packages/protocols/src/common/index.ts          # 1
```
If any line is off, Part 1 left work undone — fix before continuing.

- [ ] **Step 0.3: Note Phase B target file count**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln -E "\b(EventResult|ExecuteResult|eventResult|internalErrorResult)\b" packages apps --include='*.ts' | wc -l
```
Expected (probed 2026-06-24): 46. This number should be 0 after Phase B Step B.6 (excluding the new `Llm*` names).

---

# Phase A — Rename `@vnext/protocols` → `@vnext-llm/protocols`

## Task A1: Rename the directory and the package name

**Files:**
- Rename: `vnext/packages/protocols/` → `vnext/packages/protocols-llm/`
- Modify: `vnext/packages/protocols-llm/package.json` (`name` field, `exports` map)
- Delete: `vnext/packages/protocols-llm/src/index.ts`

- [ ] **Step A1.1: `git mv` the package directory**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
git mv packages/protocols packages/protocols-llm
```

- [ ] **Step A1.2: Edit package.json `name` and drop the `.` export**

Edit `vnext/packages/protocols-llm/package.json`. Change the `name` field from `"@vnext/protocols"` to `"@vnext-llm/protocols"`. In the `exports` block, delete the `".": "./src/index.ts"` line entirely. The result should be:

```json
{
  "name": "@vnext-llm/protocols",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./common": "./src/common/index.ts",
    "./messages": "./src/messages/index.ts",
    "./chat": "./src/chat/index.ts",
    "./responses": "./src/responses/index.ts",
    "./gemini": "./src/gemini/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vnext-gateway/result": "workspace:*",
    "@vnext-gateway/service": "workspace:*",
    "zod": "^4.4.3"
  }
}
```

(The `@vnext-gateway/service` dep is already in place from Part 1; same for `@vnext-gateway/result` from Part 1 Task 2.4.)

- [ ] **Step A1.3: Delete the dead root barrel**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
rm packages/protocols-llm/src/index.ts
```

A pre-Part-2 grep showed zero `from '@vnext/protocols'` (bare) imports, so this is a no-op at call sites — but enforces the §3.4 invariant.

- [ ] **Step A1.4: Verify zero bare-specifier imports exist anywhere**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rnE "from ['\"]@vnext/protocols['\"]" packages apps --include='*.ts'
grep -rnE "from ['\"]@vnext-llm/protocols['\"]" packages apps --include='*.ts'
```
Both expected: empty. If either is non-empty, fix by hand to use the appropriate subpath (`./common`, `./chat`, etc.) before continuing — there is no fallback root export anymore.

---

## Task A2: Sweep all `@vnext/protocols/<subpath>` consumers → `@vnext-llm/protocols/<subpath>`

**Files:**
- Sweep: every `.ts` / `.tsx` / `.json` under `packages/` and `apps/` containing `@vnext/protocols`
- Regenerate: `vnext/bun.lock`

- [ ] **Step A2.1: Inventory consumer files**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/protocols" packages apps --include='*.ts' --include='*.tsx' --include='*.json' | wc -l
grep -rln "@vnext/protocols" packages apps --include='*.ts' --include='*.tsx' --include='*.json' | head -10
```
Expected count: ~119 plus one or two `package.json` files. Note the count — it should drop to 0 after Step A2.4.

- [ ] **Step A2.2: Run the substitution**

`@vnext/protocols` has no sibling that starts with the same string, so a plain substring sed is safe:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rl "@vnext/protocols" packages apps --include='*.ts' --include='*.tsx' --include='*.json' \
  | xargs sed -i '' 's|@vnext/protocols|@vnext-llm/protocols|g'
```

(BSD `sed -i ''` for macOS. On Linux drop the empty arg.)

- [ ] **Step A2.3: Update the dependency in `packages/protocols-llm/package.json`**

The previous sed already rewrote the `name` field of `protocols-llm/package.json` to `"@vnext-llm/protocols"` if it was still on `@vnext/protocols` — but we already set it in A1.2, so this is a no-op there. Verify nothing inside `protocols-llm`'s sources self-imports the old name (shouldn't happen):

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/protocols" packages/protocols-llm
```
Expected: empty.

- [ ] **Step A2.4: Verify zero residue across the monorepo**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext/protocols" packages apps --include='*.ts' --include='*.tsx' --include='*.json'
```
Expected: empty. If anything remains, hand-edit.

- [ ] **Step A2.5: Regenerate lockfile**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```

- [ ] **Step A2.6: Run tests**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -3
```
Expected: same pass count as Step 0.1.

- [ ] **Step A2.7: Commit Phase A**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): rename @vnext/protocols -> @vnext-llm/protocols; drop dead root export"
```

---

# Phase B — Rename four LLM result types to `Llm*`

The four renames affect:
- 1 file of definitions: `packages/protocols-llm/src/common/result.ts`
- 1 file of re-exports: `packages/protocols-llm/src/common/index.ts`
- Internal protocols use sites: `packages/protocols-llm/src/common/invocation.ts` and the four sub-protocol `stream.ts` files
- External consumers: 46 files (probed in Pre-flight Step 0.3)

We do the definition file by hand (4 targeted edits), the re-export file by hand (4 targeted edits), then a single `sed` sweep handles every consumer in one pass. Because the four identifiers (`EventResult`, `ExecuteResult`, `eventResult`, `internalErrorResult`) are all distinct from `UpstreamErrorResult` / `InternalErrorResult` / `EventResultMetadata` (which we keep), a plain word-boundary sed is safe — provided we anchor it.

## Task B1: Rename in the definition file

**Files:**
- Modify: `vnext/packages/protocols-llm/src/common/result.ts`

- [ ] **Step B1.1: Rename `EventResult` → `LlmEventResult`**

Edit `vnext/packages/protocols-llm/src/common/result.ts`. Replace the interface declaration:

```ts
export interface EventResult<T> {
```
with:
```ts
export interface LlmEventResult<T> {
```

Also rewrite the two internal `EventResult<T>['translateBody']` / `EventResult<T>['translateEvents']` references later in the same interface body — they appear as `readonly translateBody?: EventResult<T>['translateBody']` and `readonly translateEvents?: EventResult<T>['translateEvents']` — to use `LlmEventResult<T>['translateBody']` / `LlmEventResult<T>['translateEvents']`.

(Read the file before editing to confirm exact line numbers; the snippet above is the literal text to find/replace.)

- [ ] **Step B1.2: Rename `ExecuteResult` → `LlmExecuteResult`**

In the same file, replace:
```ts
export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult
```
with:
```ts
export type LlmExecuteResult<T> =
  | LlmEventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult
```

- [ ] **Step B1.3: Rename `eventResult()` → `llmEventResult()`**

In the same file, replace the factory signature:
```ts
export const eventResult = <T>(
```
with:
```ts
export const llmEventResult = <T>(
```

And update its return-type annotation from `): EventResult<T> => ({` to `): LlmEventResult<T> => ({`.

The `translateBody?: EventResult<T>['translateBody']` and `translateEvents?: EventResult<T>['translateEvents']` parameter annotations inside the same signature also flip to `LlmEventResult<T>['…']`.

- [ ] **Step B1.4: Rename `internalErrorResult()` → `llmInternalErrorResult()`**

In the same file, replace:
```ts
export const internalErrorResult = (
```
with:
```ts
export const llmInternalErrorResult = (
```

(The return type is `InternalErrorResult` — that's the struct, not renamed.)

- [ ] **Step B1.5: Smoke-check the file**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -nE "\b(EventResult|ExecuteResult|eventResult|internalErrorResult)\b" packages/protocols-llm/src/common/result.ts
```
Expected: empty (only `EventResultMetadata` remains, which contains `EventResult` as a substring but the `\b` after `Result` ensures it's not flagged — verify by hand that the only matches are unrelated). If the grep is non-empty and the matches aren't part of `EventResultMetadata`, the rename missed something.

Actually `\b` after `Result` doesn't separate `Result` from `Metadata`, so `EventResultMetadata` won't match `\bEventResult\b`. Good — the grep is correct.

---

## Task B2: Rename in the common re-export barrel

**Files:**
- Modify: `vnext/packages/protocols-llm/src/common/index.ts`

- [ ] **Step B2.1: Update the type re-export**

Edit `vnext/packages/protocols-llm/src/common/index.ts`. Find the block:

```ts
export type {
  EventResult,
  UpstreamErrorResult,
  InternalErrorResult,
  ExecuteResult,
  TelemetryModelIdentity,
  PerformanceTelemetryContext,
  EventResultMetadata,
  TranslateBodyContext,
} from './result'
```

Replace `EventResult,` (the first line inside the braces) with `LlmEventResult,` and `ExecuteResult,` with `LlmExecuteResult,`. Other names stay. Result:

```ts
export type {
  LlmEventResult,
  UpstreamErrorResult,
  InternalErrorResult,
  LlmExecuteResult,
  TelemetryModelIdentity,
  PerformanceTelemetryContext,
  EventResultMetadata,
  TranslateBodyContext,
} from './result'
```

- [ ] **Step B2.2: Update the factory re-export**

In the same file, find:
```ts
export {
  eventResult,
  internalErrorResult,
  readUpstreamError,
  upstreamErrorToResponse,
  decodeUpstreamErrorBody,
} from './result'
```

Replace `eventResult,` with `llmEventResult,` and `internalErrorResult,` with `llmInternalErrorResult,`. Result:

```ts
export {
  llmEventResult,
  llmInternalErrorResult,
  readUpstreamError,
  upstreamErrorToResponse,
  decodeUpstreamErrorBody,
} from './result'
```

---

## Task B3: Sweep external consumers

**Files:**
- Sweep: every `.ts` / `.tsx` under `packages/` and `apps/` except `packages/protocols-llm/src/common/{result,index}.ts` (handled by B1/B2). The 46 files probed in Pre-flight Step 0.3.

- [ ] **Step B3.1: Use word-anchored sed to rename the four identifiers**

The four identifiers don't appear as substrings of other names (verified: `EventResult` is not in `EventResultMetadata` after `\b`; `eventResult` lowercase doesn't appear elsewhere; `internalErrorResult` is distinct from `InternalErrorResult`). Run four separate sed passes for clarity and grep verifiability:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext

# pass 1: EventResult -> LlmEventResult  (skip EventResultMetadata via \b)
grep -rlE "\bEventResult\b" packages apps --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E 's/\bEventResult\b/LlmEventResult/g'

# pass 2: ExecuteResult -> LlmExecuteResult
grep -rlE "\bExecuteResult\b" packages apps --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E 's/\bExecuteResult\b/LlmExecuteResult/g'

# pass 3: eventResult( -> llmEventResult(   (lowercase factory, anchor on '(' to avoid
#         touching a hypothetical `eventResult` variable name — none today)
grep -rl "eventResult(" packages apps --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' 's/eventResult(/llmEventResult(/g'

# pass 4: internalErrorResult( -> llmInternalErrorResult(
grep -rl "internalErrorResult(" packages apps --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' 's/internalErrorResult(/llmInternalErrorResult(/g'
```

- [ ] **Step B3.2: Also rewrite named imports of the lowercase factories**

The `(` anchor in passes 3 and 4 misses pure import-only references like `import { eventResult } from '@vnext-llm/protocols/common'` — those have no immediate `(`. Catch them:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rlE "\beventResult\b" packages apps --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E 's/\beventResult\b/llmEventResult/g'
grep -rlE "\binternalErrorResult\b" packages apps --include='*.ts' --include='*.tsx' \
  | xargs sed -i '' -E 's/\binternalErrorResult\b/llmInternalErrorResult/g'
```

These passes are idempotent — anywhere already renamed by Step B3.1 won't match `\beventResult\b` (it's now `llmEventResult`).

- [ ] **Step B3.3: Verify zero residue of old names anywhere**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rnE "\b(EventResult|ExecuteResult|eventResult|internalErrorResult)\b" packages apps --include='*.ts' --include='*.tsx'
```
Expected: empty. (`EventResultMetadata` survives — the `\b…\b` boundary correctly excludes it.)

- [ ] **Step B3.4: Verify new names look reasonable in result.ts**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -nE "\b(LlmEventResult|LlmExecuteResult|llmEventResult|llmInternalErrorResult)\b" packages/protocols-llm/src/common/result.ts
```
Expected: each name appears at least once.

- [ ] **Step B3.5: Run tests**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -3
```
Expected: same pass count as Step A2.6.

- [ ] **Step B3.6: Commit Phase B**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps
git commit -m "refactor(vnext/protocols-llm): rename EventResult/ExecuteResult/eventResult/internalErrorResult to Llm* per Spec 8 §3.5"
```

---

# Phase C — Migrate frame/parser consumers off the `@vnext-llm/protocols/common` re-exports

After Part 1 + Phase A, every frame primitive and parser is still accessible via `from '@vnext-llm/protocols/common'` because Part 1 Task 2.3 (`common/sse.ts` shim re-exports `@vnext-gateway/result`) and Task 3.5 (`common/index.ts` re-exports `@vnext-gateway/result/parse`) preserved the surface.

Phase C is the explicit consumer migration that Spec 8 §5 step 4 demands so Part 3's deletion of the re-exports has migration backing. The re-exports themselves stay in this part (Part 3 deletes them).

The 12 symbols to migrate are:
- Frame primitives (target: `@vnext-gateway/result`): `ProtocolFrame`, `EventFrame`, `DoneFrame`, `SseFrame`, `SseCommentFrame`, `SseWritableFrame`, `eventFrame`, `doneFrame`, `sseFrame`, `sseCommentFrame`
- Parsers (target: `@vnext-gateway/result/parse`): `parseSSEStream`, `parseTargetStreamFrames` + their option/result types `ParseSSEStreamOptions`, `ParseTargetStreamFramesOptions`, `ParsedTargetStreamFrame`

## Task C1: Inventory the consumer files

**Files:** (read-only inventory)

- [ ] **Step C1.1: List every external consumer**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "@vnext-llm/protocols/common" packages apps --include='*.ts' --include='*.tsx' \
  | grep -v '^packages/protocols-llm/' \
  | sort -u
```

This is the candidate set. Many of these files import LLM symbols (`Invocation`, `RequestContext`, `LlmExecuteResult`, etc.) and are out of scope — we only care about the 12 symbols listed above.

- [ ] **Step C1.2: Within those files, find which import the 12 symbols**

For each file from Step C1.1, look at every `import { … } from '@vnext-llm/protocols/common'` statement. Mark which named imports fall into:
- **Frame set:** `ProtocolFrame`, `EventFrame`, `DoneFrame`, `SseFrame`, `SseCommentFrame`, `SseWritableFrame`, `eventFrame`, `doneFrame`, `sseFrame`, `sseCommentFrame`
- **Parser set:** `parseSSEStream`, `parseTargetStreamFrames`, `ParseSSEStreamOptions`, `ParseTargetStreamFramesOptions`, `ParsedTargetStreamFrame`
- **LLM set (stays where it is):** anything else (e.g. `Invocation`, `LlmExecuteResult`, `TelemetryModelIdentity`)

You can grep for them across all candidates in one shot:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln -E "(ProtocolFrame|EventFrame|DoneFrame|SseFrame|SseCommentFrame|SseWritableFrame|eventFrame|doneFrame|sseFrame|sseCommentFrame|parseSSEStream|parseTargetStreamFrames|ParseSSEStreamOptions|ParseTargetStreamFramesOptions|ParsedTargetStreamFrame)" packages apps --include='*.ts' --include='*.tsx' \
  | grep -v '^packages/protocols-llm/' \
  | grep -v '^packages/result/' \
  | sort -u
```

The output is the migration target set. Note the count.

---

## Task C2: Migrate the import statements

For each file in the target set, the migration is mechanical:

- If the only imported symbols from `@vnext-llm/protocols/common` are frame primitives → change the specifier to `@vnext-gateway/result`.
- If the only imported symbols are parsers/parser-types → change the specifier to `@vnext-gateway/result/parse`.
- If the import is **mixed** (some frame/parser symbols + some LLM symbols), split into two statements: one targeting the framework module, the other still hitting `@vnext-llm/protocols/common`.
- If a single statement mixes **both** frame and parser symbols, split into three: frame from `@vnext-gateway/result`, parser from `@vnext-gateway/result/parse`, LLM rest from `@vnext-llm/protocols/common`.

Because the exact split per file depends on what the file imports, run this as a per-file manual edit pass — not a single sed sweep.

- [ ] **Step C2.1: Add `@vnext-gateway/result` as a dependency where consumers live**

Any package that gains a `from '@vnext-gateway/result'` or `from '@vnext-gateway/result/parse'` import needs `@vnext-gateway/result` in its `dependencies`. The candidates (based on Task C1 inventory) include at minimum: `gateway`, `translate`, `provider-copilot`. Run:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
for pkg in gateway translate provider-copilot provider-azure provider-custom provider-sdf responses-store; do
  echo "=== $pkg ==="
  grep '"@vnext-gateway/result"' packages/$pkg/package.json || echo "(missing dep)"
done
```

For each `(missing dep)` package whose source actually imports a frame/parser symbol after Task C2.2 below, add `"@vnext-gateway/result": "workspace:*"` to its `dependencies` block. Don't preemptively add it to packages that never import the symbols.

- [ ] **Step C2.2: Migrate each file**

Walk the candidate list from Task C1.2. For each file, open it, locate every `from '@vnext-llm/protocols/common'` statement, and rewrite per the rules above. Concrete worked examples:

**Pure frame consumer** (representative: `packages/gateway/src/data-plane/chat-flow/chat-completions/events/to-sse.ts`)

Before:
```ts
import { type ProtocolFrame, sseFrame } from '@vnext-llm/protocols/common'
```
After:
```ts
import { type ProtocolFrame, sseFrame } from '@vnext-gateway/result'
```

**Pure parser consumer**

Before:
```ts
import { parseSSEStream, parseTargetStreamFrames } from '@vnext-llm/protocols/common'
```
After:
```ts
import { parseSSEStream, parseTargetStreamFrames } from '@vnext-gateway/result/parse'
```

**Mixed frame + LLM consumer** (representative: `packages/gateway/src/data-plane/chat-flow/shared/attempt-helpers.ts`)

Before:
```ts
import {
  type ExecuteResult,
  type ProtocolFrame,
  eventFrame,
  type Invocation,
} from '@vnext-llm/protocols/common'
```
After (Phase B already renamed `ExecuteResult` → `LlmExecuteResult`, so the LLM line uses the new name):
```ts
import { type ProtocolFrame, eventFrame } from '@vnext-gateway/result'
import { type LlmExecuteResult, type Invocation } from '@vnext-llm/protocols/common'
```

**Mixed frame + parser + LLM consumer**

Before:
```ts
import {
  type Invocation,
  parseSSEStream,
  type SseFrame,
} from '@vnext-llm/protocols/common'
```
After:
```ts
import { type SseFrame } from '@vnext-gateway/result'
import { parseSSEStream } from '@vnext-gateway/result/parse'
import { type Invocation } from '@vnext-llm/protocols/common'
```

If a `type` keyword is on the import statement (`import type { … }`), preserve it on each split.

Iterate one file at a time; commit per package (next step) to keep blast radius small.

- [ ] **Step C2.3: After every 5–10 files, run typecheck for the touched packages**

For the package that owns the files you just edited, run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/<pkg>
bun run typecheck
```
Expected: exits 0 (or no NEW errors beyond pre-existing baseline). Fix typos before continuing.

---

## Task C3: Phase C verification gate

**Files:** (verification only)

- [ ] **Step C3.1: The gate from Spec 8 §5 step 4**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rnE "from ['\"]@vnext-llm/protocols/common['\"]" packages apps --include='*.ts' --include='*.tsx' \
  | grep -v '^packages/protocols-llm/' \
  | grep -E "(ProtocolFrame|EventFrame|DoneFrame|SseFrame|SseCommentFrame|SseWritableFrame|eventFrame|doneFrame|sseFrame|sseCommentFrame|parseSSEStream|parseTargetStreamFrames|ParseSSEStreamOptions|ParseTargetStreamFramesOptions|ParsedTargetStreamFrame)"
```

This pipeline looks for any external file that still imports one of the 12 framework symbols from the LLM module. Expected: **empty**. If non-empty, those files still need migration — return to Task C2.2.

- [ ] **Step C3.2: Confirm consumers now reference the framework package**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rln "from '@vnext-gateway/result'" packages apps --include='*.ts' --include='*.tsx' | wc -l
grep -rln "from '@vnext-gateway/result/parse'" packages apps --include='*.ts' --include='*.tsx' | wc -l
```

Expected: both counts > 0 (the migration moved consumers to these specifiers).

- [ ] **Step C3.3: Regenerate lockfile if any package.json changed in C2.1**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun install
```
If no `package.json` files changed (no new `@vnext-gateway/result` deps were needed), `bun install` is a no-op.

- [ ] **Step C3.4: Run tests**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -3
```
Expected: same pass count as Step B3.5.

- [ ] **Step C3.5: Commit Phase C**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add -A vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): migrate frame/parser consumers off @vnext-llm/protocols/common re-exports per Spec 8 §5 step 4"
```

---

## Task C4: Part 2 acceptance gate

**Files:** (verification only)

- [ ] **Step C4.1: Package shape**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
node -e "console.log(require('./packages/protocols-llm/package.json').name)"
node -e "const e = require('./packages/protocols-llm/package.json').exports; console.log(JSON.stringify(e, null, 2))"
test ! -f packages/protocols-llm/src/index.ts && echo "ok: no src/index.ts" || echo "FAIL: src/index.ts still exists"
```
Expected:
```
@vnext-llm/protocols
{
  "./common": "./src/common/index.ts",
  "./messages": "./src/messages/index.ts",
  "./chat": "./src/chat/index.ts",
  "./responses": "./src/responses/index.ts",
  "./gemini": "./src/gemini/index.ts"
}
ok: no src/index.ts
```

- [ ] **Step C4.2: Old identifiers gone monorepo-wide**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
grep -rnE "\b(EventResult|ExecuteResult|eventResult|internalErrorResult)\b" packages apps --include='*.ts' --include='*.tsx'
grep -rln "@vnext/protocols" packages apps --include='*.ts' --include='*.tsx' --include='*.json'
```
Both expected: empty.

- [ ] **Step C4.3: Per-package typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
for d in result service platform http cache protocols-llm provider-copilot gateway; do
  echo "=== typecheck $d ==="
  (cd packages/$d && bun run typecheck) || echo "FAILED: $d"
done
```
Expected: no `FAILED:` lines for those 8 packages. Pre-existing baseline failures in `translate`, `provider-azure`, `provider-custom`, `provider-sdf` are still allowed (Spec §A2).

- [ ] **Step C4.4: Full test suite**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -5
```
Expected: same pass count as Step 0.1. If the count changed, do not proceed to Part 3 — diagnose.

- [ ] **Step C4.5: Commit verification artifacts (if any)**

If Steps C4.1–C4.4 produced no fixes, nothing to commit. Otherwise:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git status --short
git add -A vnext/
git commit -m "fix(vnext): resolve stragglers after Spec 8 Part 2 protocols split"
```

---

## Out of scope for Part 2

- Rename of business packages other than `protocols`: `translate`, `responses-store`, `provider*`, `gateway`, `apps/*` keep their `@vnext/*` names (Part 3).
- Removal of the temporary re-exports inside `packages/protocols-llm/src/common/sse.ts` and the stream block in `packages/protocols-llm/src/common/index.ts` — they're still in place at end of Part 2 (Part 3 step 6).
- `scripts/check-framework-purity.ts` (Part 3 step 7).
- Dockerfile (Part 3 step 8).

The re-exports in `protocols-llm/common` are now decorative — Task C ensured no external consumer relies on them — but deleting them is Part 3's job so this PR stays focused on the protocols split + identifier rename.

---

## Risks specific to Part 2

| Risk | Mitigation |
|---|---|
| Phase B sed inadvertently flips `EventResultMetadata` | `\bEventResult\b` does NOT match `EventResultMetadata` because `M` is a word character — Step B1.5 explicitly grep-confirms. Pass 1 uses `\bEventResult\b`. |
| Pure import-only `eventResult`/`internalErrorResult` references missed by `(`-anchored sed | Step B3.2 runs a second word-anchored pass that catches them; idempotent against B3.1. |
| Phase A breaks something that imported `@vnext/protocols` (bare specifier) | Step A1.4 grep-confirms zero bare-specifier imports anywhere; the `.` export deletion is otherwise a true no-op. |
| Phase C consumer migration is per-file manual — easy to miss one | Step C3.1 is the explicit gate from Spec 8 §5 step 4; CI cannot proceed to Part 3 until the gate passes. |
| Adding `@vnext-gateway/result` deps inflates lockfile churn | Step C2.1 enforces "add the dep only if the source actually uses the symbol" — lockfile only churns when needed. |
