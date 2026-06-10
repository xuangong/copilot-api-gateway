# vNext Step 2a: Extract `packages/interceptor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the generic interceptor runner (`runInterceptors` + types) out of `apps/gateway/src/data-plane/interceptors/runner.ts` into a new workspace package `@vnext/interceptor`, and rewrite every import site to use it.

**Architecture:** New package mirrors the Floway reference (`/Users/zhangxian/projects/copilot-gateway/packages/interceptor`): a single `src/index.ts` exporting `Interceptor`, `InterceptorRun`, `runInterceptors`, plus the gateway-specific `Invocation`/`RequestContext`/`CopilotInterceptor` typedefs. The package has zero runtime deps. Gateway imports change from `../../interceptors/runner.ts` to `@vnext/interceptor`.

**Tech Stack:** TypeScript only, no runtime code beyond the runner; Bun workspace via root `package.json` `workspaces: ["packages/*"]`.

---

## File Structure

- Create: `packages/interceptor/package.json` (`@vnext/interceptor`)
- Create: `packages/interceptor/tsconfig.json`
- Create: `packages/interceptor/src/index.ts` (the runner + types)
- Delete: `apps/gateway/src/data-plane/interceptors/runner.ts`
- Delete: `apps/gateway/src/data-plane/interceptors/` (empty after runner deletion)
- Modify: `apps/gateway/package.json` (add `"@vnext/interceptor": "workspace:*"`)
- Modify (25 files, import-only rewrites):
  - `apps/gateway/src/data-plane/providers/copilot/provider.ts`
  - `apps/gateway/src/data-plane/providers/copilot/interceptors/messages/{index,with-structured-output-format-stripped,with-claude-agent-headers,with-compact-headers,with-vision-header,with-inline-images-compressed,with-interaction-id-header,with-cache-breakpoints-attached}.ts`
  - `apps/gateway/src/data-plane/providers/copilot/interceptors/responses/{index,with-safety-identifier-stripped,with-vision-header,with-image-generation-stripped,with-inline-images-compressed,with-store-forced-false}.ts`
  - `apps/gateway/src/data-plane/providers/copilot/interceptors/chat-completions/{index,with-vision-header,with-inline-images-compressed,with-cache-control-markers-attached}.ts`
  - `apps/gateway/src/data-plane/providers/copilot/interceptors/embeddings/index.ts`
  - `apps/gateway/src/data-plane/providers/copilot/interceptors/shared/{with-initiator-header,with-variant-and-beta-filtering}.ts`
  - `apps/gateway/tests/interceptors.test.ts`

---

### Task 1: Create the `@vnext/interceptor` package skeleton

**Files:**
- Create: `packages/interceptor/package.json`
- Create: `packages/interceptor/tsconfig.json`

- [ ] **Step 1: Write package.json**

`packages/interceptor/package.json`:
```json
{
  "name": "@vnext/interceptor",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

`packages/interceptor/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Verify Bun picks up the workspace**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install`
Expected: Lockfile updates; no errors; `node_modules/@vnext/interceptor` symlink exists.

---

### Task 2: Move the runner source into the new package

**Files:**
- Create: `packages/interceptor/src/index.ts`

- [ ] **Step 1: Create `packages/interceptor/src/index.ts` with the runner content**

This is the verbatim content from the existing `apps/gateway/src/data-plane/interceptors/runner.ts`, but with the `EndpointKey` import switched to the package-qualified path (since the file now lives outside `apps/gateway`):

```ts
/**
 * Interceptor runner — Koa-style middleware chain.
 *
 * Generic `runInterceptors` plus the gateway's per-request typedefs
 * (`Invocation`, `RequestContext`, `CopilotInterceptor`). Providers compose
 * payload/header rewrites by stacking `CopilotInterceptor` functions; the
 * terminal handler issues the upstream fetch.
 */
import type { EndpointKey } from '@vnext/protocols/common'

/**
 * Mutable snapshot of a single proxy request. Interceptors read and write
 * this object; mutations are visible to every subsequent interceptor and to
 * the terminal handler because all parties share the same reference.
 */
export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  readonly sourceApi?: 'messages' | 'chat_completions' | 'responses'
  payload: Record<string, unknown>
  headers: Record<string, string>
}

export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
}

export type InterceptorRun<R> = () => Promise<R>

export type Interceptor<TInv, TCtx, R> = (
  inv: TInv,
  ctx: TCtx,
  run: InterceptorRun<R>,
) => Promise<R>

export const runInterceptors = async <TInv, TCtx, R>(
  inv: TInv,
  ctx: TCtx,
  interceptors: readonly Interceptor<TInv, TCtx, R>[],
  terminal: InterceptorRun<R>,
): Promise<R> => {
  const run = (index: number): Promise<R> =>
    index < interceptors.length
      ? interceptors[index]!(inv, ctx, () => run(index + 1))
      : terminal()
  return run(0)
}

export type CopilotInterceptor = Interceptor<Invocation, RequestContext, Response>
```

- [ ] **Step 2: Typecheck the new package in isolation**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/interceptor && bun run typecheck`
Expected: PASS, 0 errors. Note: `@vnext/protocols` resolution depends on the workspace symlink Bun set up in Task 1 Step 3.

---

### Task 3: Add `@vnext/interceptor` as a dependency of `apps/gateway`

**Files:**
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: Read current `apps/gateway/package.json`**

Run: `cat /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/gateway/package.json`
Expected output: shows existing `dependencies` block including `@vnext/protocols` (or similar workspace deps).

- [ ] **Step 2: Add the workspace dependency**

In the `dependencies` block, add (keeping alphabetical order):
```json
"@vnext/interceptor": "workspace:*",
```

- [ ] **Step 3: Reinstall to refresh symlinks**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install`
Expected: lockfile updates; `apps/gateway/node_modules/@vnext/interceptor` symlink exists.

---

### Task 4: Rewrite all 25 import sites to use `@vnext/interceptor`

**Files:** All 25 files listed in "File Structure" above (24 src + 1 test).

- [ ] **Step 1: Mechanical rewrite of all interceptor imports**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
grep -rln "interceptors/runner" --include="*.ts" apps/ | \
xargs perl -i -pe 's|from\s+"[^"]*interceptors/runner"|from "@vnext/interceptor"|g; s|from\s+'\''[^'\'']*interceptors/runner[^'\'']*'\''|from "@vnext/interceptor"|g; s|from\s+'\''[^'\'']*interceptors/runner\.ts'\''|from "@vnext/interceptor"|g'
```

- [ ] **Step 2: Verify zero remaining old imports**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && grep -rn "interceptors/runner" --include="*.ts" apps/ packages/ || echo OK`
Expected: `OK` (no matches).

- [ ] **Step 3: Verify all rewritten imports landed correctly**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && grep -rln '@vnext/interceptor' --include="*.ts" apps/ | wc -l`
Expected: `25` (24 src + 1 test).

---

### Task 5: Delete the old runner file and its empty directory

**Files:**
- Delete: `apps/gateway/src/data-plane/interceptors/runner.ts`
- Delete: `apps/gateway/src/data-plane/interceptors/` directory

- [ ] **Step 1: Delete the file**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && rm apps/gateway/src/data-plane/interceptors/runner.ts`

- [ ] **Step 2: Remove the empty directory if empty**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && rmdir apps/gateway/src/data-plane/interceptors 2>/dev/null && echo "removed" || echo "not empty (inspect contents)"`
Expected: `removed`. If "not empty" appears, list the directory and decide per-file (none expected at this stage).

---

### Task 6: Typecheck + test the workspace

- [ ] **Step 1: Typecheck across the workspace**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS in every workspace package, 0 errors.

- [ ] **Step 2: Run the gateway tests**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test`
Expected: 237 pass / 0 fail / 0 error (matches the Step 1 baseline established in CUTOVER_AUDIT.md).

---

### Task 7: Commit

- [ ] **Step 1: Stage and commit**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
git add packages/interceptor apps/gateway/package.json \
       apps/gateway/src/data-plane/providers/copilot \
       apps/gateway/tests/interceptors.test.ts && \
git rm apps/gateway/src/data-plane/interceptors/runner.ts && \
git commit -m "refactor(vnext): extract runInterceptors into @vnext/interceptor"
```

Expected: clean commit with the new package added, runner.ts deleted, 25 import sites rewritten.
