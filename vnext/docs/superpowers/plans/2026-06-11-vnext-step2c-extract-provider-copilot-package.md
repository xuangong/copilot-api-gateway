# vNext Step 2c: Extract `packages/provider-copilot` + Wire Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every Copilot-specific data-plane file out of `apps/gateway/src/data-plane/{providers,services}/copilot/` into a new workspace package `@vnext/provider-copilot`. Then replace the hardcoded `new FakeProvider()` in `apps/gateway/src/data-plane/routes.ts` with a real `listProviderBindings` lookup so the dispatcher serves real upstreams.

**Architecture:** `@vnext/provider-copilot` becomes the home for: the `CopilotProvider` class, all 22 interceptors, the shared HTTP/forward layer (`callCopilotAPI` + `repairToolResultPairs`), models listing (`getModels` + `ModelsResponse` + raw-models cache), variants resolver, cyber-policy retry, connection-mismatch detector. Gateway keeps `registry.ts` (it reads the repo) but imports `CopilotProvider`, `callCopilotAPI`, `ModelsResponse`, etc. from the new package. The dispatcher in `routes.ts` switches from `FakeProvider` to `listProviderBindings` walking real upstreams. Constants like `AccountType` and `createGithubHeaders` stay in `apps/gateway/src/shared/config/constants.ts` (used by control-plane as well) — the package depends on them via a small typed shim imported through workspace.

**Tech Stack:** TypeScript only; depends on `@vnext/protocols`, `@vnext/interceptor`, `@vnext/provider`. No new runtime libraries.

**Prereqs:** Step 2a (`@vnext/interceptor`) and Step 2b (`@vnext/provider`) merged.

---

## File Structure

- Create: `packages/provider-copilot/package.json` (`@vnext/provider-copilot`)
- Create: `packages/provider-copilot/tsconfig.json`
- Create: `packages/provider-copilot/src/index.ts` — barrel re-exports
- Create: `packages/provider-copilot/src/provider.ts` — the `CopilotProvider` class
- Create: `packages/provider-copilot/src/forward.ts` — `callCopilotAPI`, `repairToolResultPairs`
- Create: `packages/provider-copilot/src/models.ts` — `getModels`, `ModelsResponse`, `Model`
- Create: `packages/provider-copilot/src/raw-models-cache.ts`
- Create: `packages/provider-copilot/src/variants.ts`
- Create: `packages/provider-copilot/src/cyber-policy-retry.ts`
- Create: `packages/provider-copilot/src/connection-mismatch.ts`
- Create: `packages/provider-copilot/src/account-type.ts` — re-exports `AccountType` + `getCopilotBaseUrl` + `createGithubHeaders` from gateway's `shared/config/constants.ts` via a thin shim (see Task 2 Step 4)
- Create: `packages/provider-copilot/src/flags.ts` — re-exports `defaultsForUpstream` and the `EndpointKey` mapping the package needs (via shim)
- Create: `packages/provider-copilot/src/interceptors/messages/{index,with-structured-output-format-stripped,with-claude-agent-headers,with-compact-headers,with-vision-header,with-inline-images-compressed,with-interaction-id-header,with-cache-breakpoints-attached}.ts`
- Create: `packages/provider-copilot/src/interceptors/responses/{index,with-safety-identifier-stripped,with-vision-header,with-image-generation-stripped,with-inline-images-compressed,with-store-forced-false}.ts`
- Create: `packages/provider-copilot/src/interceptors/chat-completions/{index,with-vision-header,with-inline-images-compressed,with-cache-control-markers-attached}.ts`
- Create: `packages/provider-copilot/src/interceptors/embeddings/index.ts`
- Create: `packages/provider-copilot/src/interceptors/shared/{with-initiator-header,with-variant-and-beta-filtering}.ts`
- Delete: all files under `apps/gateway/src/data-plane/providers/copilot/`
- Delete: all files under `apps/gateway/src/data-plane/services/copilot/`
- Modify: `apps/gateway/package.json` — add `"@vnext/provider-copilot": "workspace:*"`
- Modify: `apps/gateway/src/data-plane/routes.ts` — replace FakeProvider with real registry walk
- Modify: `apps/gateway/src/data-plane/providers/registry.ts` — imports from `@vnext/provider-copilot`
- Modify: `apps/gateway/src/data-plane/models/routes.ts` — `ModelsResponse` from package
- Modify: `apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/interceptor.ts` — `createCopilotProvider` still routes via gateway registry (no change to source)
- Modify (~6 other src files & 4 test files) — see Task 5

---

### Task 1: Create the `@vnext/provider-copilot` package skeleton

**Files:**
- Create: `packages/provider-copilot/package.json`
- Create: `packages/provider-copilot/tsconfig.json`

- [x] **Step 1: Write package.json**

`packages/provider-copilot/package.json`:
```json
{
  "name": "@vnext/provider-copilot",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./models": "./src/models.ts",
    "./forward": "./src/forward.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [x] **Step 2: Write tsconfig.json**

`packages/provider-copilot/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Wire workspace**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install`
Expected: `node_modules/@vnext/provider-copilot` symlink exists.

---

### Task 2: Decide how the new package consumes gateway-side constants

The package needs `AccountType`, `getCopilotBaseUrl`, `createGithubHeaders` (currently in `apps/gateway/src/shared/config/constants.ts`) and `defaultsForUpstream` + `flagToBetaHeader` etc. (currently in `apps/gateway/src/data-plane/flags/catalog.ts` / `index.ts`).

These constants are reused by the control-plane, so they must stay in gateway. The cleanest approach: introduce a tiny **inversion-of-control shim** in the package that defines the abstract surface, and have gateway pass the concrete implementations in when constructing a provider.

For Step 2c we keep scope tight: **inline-copy the constants the package needs** (account-type union + `getCopilotBaseUrl` formula + `createGithubHeaders` helper + the flag set names) into `packages/provider-copilot/src/account-type.ts` and `flags.ts`. Re-export the same names from gateway so the existing import paths in control-plane keep working. This duplicates ~30 LOC of static config and is the only acceptable trade-off; a proper IoC contract can be retrofitted later without touching call sites.

- [ ] **Step 1: Read gateway constants and flags**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
cat apps/gateway/src/shared/config/constants.ts | head -80 && \
echo === && \
cat apps/gateway/src/data-plane/flags/catalog.ts && \
echo === && \
cat apps/gateway/src/data-plane/flags/index.ts
```
Expected output: shows `AccountType`, `getCopilotBaseUrl`, `createGithubHeaders`, `GITHUB_CLIENT_ID`, `ADMIN_EMAILS`, plus `defaultsForUpstream`, `resolveEffectiveFlags`. Identify the EXACT subset the soon-to-move Copilot files use (grep target list in next step).

- [ ] **Step 2: Author `packages/provider-copilot/src/account-type.ts`**

Copy ONLY the symbols the Copilot files import (typically `AccountType`, `getCopilotBaseUrl`, `createGithubHeaders`). Keep declaration verbatim so the union strings stay byte-identical.

Example shape (verify against the actual gateway file before writing):
```ts
export type AccountType = "individual" | "business" | "enterprise"

export const getCopilotBaseUrl = (accountType: AccountType): string => {
  // Verbatim copy from apps/gateway/src/shared/config/constants.ts
  // (replace with actual body from Step 1).
}

export const createGithubHeaders = (token: string): Record<string, string> => {
  // Verbatim copy from apps/gateway/src/shared/config/constants.ts
  // (replace with actual body from Step 1).
}
```

- [ ] **Step 3: Author `packages/provider-copilot/src/flags.ts`**

Copy ONLY `defaultsForUpstream` and any helpers the Copilot provider/interceptors call (e.g. `resolveEffectiveFlags`, plus the flag-name string constants). Same verbatim policy. Example:

```ts
import type { UpstreamKind } from '@vnext/protocols/common'

// Verbatim copy of the relevant block from
// apps/gateway/src/data-plane/flags/catalog.ts and flags/index.ts.
export function defaultsForUpstream(kind: UpstreamKind): ReadonlySet<string> {
  // ...
}
```

NOTE: If `defaultsForUpstream` references a larger catalog object literal, copy the literal as well. Do NOT re-derive — bit-exact copy only.

- [ ] **Step 4: Verify the gateway-side originals still typecheck unchanged**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS — at this point nothing imports the new package yet, but the new package itself must compile.

---

### Task 3: Port the leaf services into the new package (verbatim, no behavior changes)

**Files:**
- Create: `packages/provider-copilot/src/models.ts`
- Create: `packages/provider-copilot/src/raw-models-cache.ts`
- Create: `packages/provider-copilot/src/variants.ts`
- Create: `packages/provider-copilot/src/cyber-policy-retry.ts`
- Create: `packages/provider-copilot/src/connection-mismatch.ts`
- Create: `packages/provider-copilot/src/forward.ts`

- [x] **Step 1: Port the 6 service files**

For each of the 6 files below, copy the content verbatim from `apps/gateway/src/data-plane/services/copilot/` into `packages/provider-copilot/src/`. Adjust only `import` paths:
- Imports that were `'../../../shared/config/constants.ts'` → `'./account-type'`
- Imports that were `'../../flags/catalog.ts'` or `'../../flags/index.ts'` → `'./flags'`
- Cross-file imports stay relative (e.g. `forward.ts` imports `models.ts` as `'./models'`)
- Imports of `@vnext/protocols/*` keep the package-qualified path

Files to port:
1. `models.ts` (68 LOC) → `packages/provider-copilot/src/models.ts`
2. `raw-models-cache.ts` (60 LOC) → `packages/provider-copilot/src/raw-models-cache.ts`
3. `variants.ts` (419 LOC) → `packages/provider-copilot/src/variants.ts`
4. `cyber-policy-retry.ts` (189 LOC) → `packages/provider-copilot/src/cyber-policy-retry.ts`
5. `connection-mismatch.ts` (200 LOC) → `packages/provider-copilot/src/connection-mismatch.ts`
6. `forward.ts` (170 LOC) → `packages/provider-copilot/src/forward.ts`

Per file: read the original, write the copy with adjusted imports, then run `bun run typecheck` inside the package to catch missed paths early.

- [x] **Step 2: Typecheck the package after each file is added**

After each file is created, run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot && bun run typecheck
```
Expected: PASS. Errors usually mean an import path was not rewritten — fix and rerun.

---

### Task 4: Port the 22 interceptors

**Files:**
- All 22 files under `packages/provider-copilot/src/interceptors/{messages,responses,chat-completions,embeddings,shared}/`

- [x] **Step 1: Port the interceptors verbatim**

For each file under `apps/gateway/src/data-plane/providers/copilot/interceptors/`, copy to the same relative path under `packages/provider-copilot/src/interceptors/`. Adjust only:
- `import type { CopilotInterceptor } from "../../../../interceptors/runner"` → `from "@vnext/interceptor"`
- Any import of `services/copilot/*` → `'../../forward'` / `'../../models'` / `'../../variants'` (the new locations within the same package)
- Constants imports → `'../../account-type'` / `'../../flags'`

There are 22 files spanning 5 subdirectories. The diff per file is import-only; bodies are unchanged.

- [x] **Step 2: Typecheck**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot && bun run typecheck
```
Expected: PASS.

---

### Task 5: Port `provider.ts` and write the package `index.ts`

**Files:**
- Create: `packages/provider-copilot/src/provider.ts`
- Create: `packages/provider-copilot/src/index.ts`

- [x] **Step 1: Port `provider.ts`**

Copy `apps/gateway/src/data-plane/providers/copilot/provider.ts` to `packages/provider-copilot/src/provider.ts`. Adjust imports:
- `'../../../shared/config/constants.ts'` (`AccountType`) → `'./account-type'`
- `'../../flags/catalog.ts'` (`defaultsForUpstream`) → `'./flags'`
- `'../../services/copilot/forward.ts'` → `'./forward'`
- `'../../services/copilot/models.ts'` → `'./models'`
- `'../../interceptors/runner.ts'` → `'@vnext/interceptor'`
- `'../types.ts'` (`ModelProvider`, `ProbeResult`, `ProviderFetchOptions`) → `'@vnext/provider'`
- `'../probe.ts'` (`probeViaModels`) → `'@vnext/provider'`
- `'./interceptors/...'` → `'./interceptors/...'` (paths within the same new package, unchanged relative)

- [x] **Step 2: Write the package barrel `index.ts`**

`packages/provider-copilot/src/index.ts`:
```ts
export { CopilotProvider } from './provider'
export type { CopilotProviderConfig } from './provider'
export { callCopilotAPI, repairToolResultPairs } from './forward'
export { getModels } from './models'
export type { Model, ModelsResponse } from './models'
```

NOTE: Confirm `CopilotProviderConfig` is the exact exported name in `provider.ts`; adjust if the verbatim port used a different name.

- [x] **Step 3: Typecheck the package end-to-end**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot && bun run typecheck`
Expected: PASS.

---

### Task 6: Wire `@vnext/provider-copilot` into gateway and rewrite imports

**Files:**
- Modify: `apps/gateway/package.json` — add dependency
- Modify: `apps/gateway/src/data-plane/providers/registry.ts`
- Modify: `apps/gateway/src/data-plane/models/routes.ts`
- Modify: `apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/interceptor.ts`
- Modify: `apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts`
- Modify: `apps/gateway/src/control-plane/upstreams/routes.ts`
- Modify: any other site grepped in Step 2

- [x] **Step 1: Add the dependency**

In `apps/gateway/package.json` dependencies block, add (alphabetical order):
```json
"@vnext/provider-copilot": "workspace:*",
```
Then: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install`

- [x] **Step 2: Find every gateway site importing from the soon-to-be-deleted paths**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
grep -rn "from.*data-plane/providers/copilot\|from.*data-plane/services/copilot\|services/copilot/forward\|services/copilot/models\|services/copilot/variants\|services/copilot/index" --include="*.ts" apps/
```
Expected: list of ~10–15 files. Each one needs an import-path rewrite to `@vnext/provider-copilot` (or to its `./models` / `./forward` subpath exports).

- [x] **Step 3: Mechanical import rewrite**

For each match in Step 2, replace the local relative path with one of:
- `@vnext/provider-copilot` (for `CopilotProvider`, `callCopilotAPI`, `getModels`, `repairToolResultPairs`, `Model`, `ModelsResponse`)
- `@vnext/provider-copilot/models` (when a file imports `ModelsResponse` as a leaf type only, optional)

Suggested perl rewrite (apply, then audit by hand):
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
grep -rln "data-plane/providers/copilot\|data-plane/services/copilot\|services/copilot/" --include="*.ts" apps/ | \
xargs perl -i -pe 's|from\s+'\''(\.\./)+providers/copilot/provider(\.ts)?'\''|from "@vnext/provider-copilot"|g; s|from\s+"(\.\./)+providers/copilot/provider(\.ts)?"|from "@vnext/provider-copilot"|g; s|from\s+'\''(\.\./)+services/copilot(/index)?(\.ts)?'\''|from "@vnext/provider-copilot"|g; s|from\s+"(\.\./)+services/copilot(/index)?(\.ts)?"|from "@vnext/provider-copilot"|g; s|from\s+'\''(\.\./)+services/copilot/forward(\.ts)?'\''|from "@vnext/provider-copilot"|g; s|from\s+"(\.\./)+services/copilot/forward(\.ts)?"|from "@vnext/provider-copilot"|g; s|from\s+'\''(\.\./)+services/copilot/models(\.ts)?'\''|from "@vnext/provider-copilot"|g; s|from\s+"(\.\./)+services/copilot/models(\.ts)?"|from "@vnext/provider-copilot"|g'
```

- [x] **Step 4: Verify**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
grep -rn "data-plane/providers/copilot\|data-plane/services/copilot" --include="*.ts" apps/ packages/ | grep -v "tests/" || echo OK
```
Expected: `OK` (no remaining non-test relative imports). Any line that prints means a manual fix is required.

- [x] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS.

---

### Task 7: Replace the FakeProvider dispatcher with real `listProviderBindings`

**Files:**
- Modify: `apps/gateway/src/data-plane/routes.ts`

- [x] **Step 1: Read the current dispatcher**

Run: `cat /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/gateway/src/data-plane/routes.ts`
Expected output: shows the file. Locate the line `const provider = new FakeProvider()` and the surrounding handler context (endpoint, requested model, source api).

- [x] **Step 2: Implement real binding resolution**

Replace the FakeProvider construction with a call to the existing `resolveBinding` helper (`apps/gateway/src/data-plane/routing/binding-resolver.ts`), which is already what `embeddings/routes.ts` and `images/routes.ts` use. The dispatcher now follows the same shape:

```ts
import { resolveBinding, stripUpstreamPin } from './routing/binding-resolver.ts'
// (remove the FakeProvider import)

// inside the handler, replacing `const provider = new FakeProvider()`:
const binding = await resolveBinding({
  endpoint,             // EndpointKey already in scope
  modelId: requestedModelId,
  sourceApi,            // 'messages' | 'chat_completions' | 'responses' | 'gemini'
  // pass copilot fallback opts if present in scope (per existing patterns)
})
if (!binding) {
  return c.json({ error: { message: `no upstream serves model "${requestedModelId}" on endpoint "${endpoint}"` } }, 404)
}
const provider = binding.provider
const enabledFlags = binding.enabledFlags
// then call provider.fetch(...) with the existing init / options
```

The exact variable names in scope (`endpoint`, `requestedModelId`, `sourceApi`, etc.) must be read from the current `routes.ts` body. Match its existing style and reuse `stripUpstreamPin` to strip any `upstream:` prefix the same way `embeddings/routes.ts` does (look at that file as the reference implementation).

- [x] **Step 3: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS.

---

### Task 8: Delete the old copilot directories from gateway

**Files:**
- Delete: `apps/gateway/src/data-plane/providers/copilot/` (recursive)
- Delete: `apps/gateway/src/data-plane/services/copilot/` (recursive)

- [x] **Step 1: Confirm nothing in gateway still imports from these directories**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
grep -rn "data-plane/providers/copilot\|data-plane/services/copilot" --include="*.ts" apps/ packages/ || echo OK
```
Expected: `OK`. (Tests under `apps/gateway/tests/` referencing internal paths should now go through `@vnext/provider-copilot`; if any are still pointing at the old paths, rewrite them now.)

- [x] **Step 2: Delete the directories**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
rm -r apps/gateway/src/data-plane/providers/copilot apps/gateway/src/data-plane/services/copilot
```

- [x] **Step 3: Typecheck after deletion**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS.

---

### Task 9: Run the gateway test suite

- [x] **Step 1: Run all tests**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test`
Expected: 237 pass / 0 fail / 0 error.

If a test fails because it imports an internal path like `'../src/data-plane/providers/copilot/...'`, rewrite the test's import to `@vnext/provider-copilot` (the public surface). Do NOT add re-export shims in gateway to keep deleted paths alive — the migration must be clean.

NOTE: Per user decision (Plan A), the four legacy e2e files (`messages.e2e.test.ts`, `chat.e2e.test.ts`, `responses.e2e.test.ts`, `gemini.e2e.test.ts`) were rewritten to the same stub-upstream pattern as `data-plane-models-embeddings-images.test.ts`: stub repo with one Copilot upstream, stub `globalThis.fetch` to canned `/models` + `/responses` responses, wrap the real Hono app with a tiny Hono shim that pre-populates `auth.copilot`. The wire-shape assertions (event names, JSON fields, stop_reason mapping, SSE chunking) are preserved verbatim — only the hard-coded "FakeProvider" literal is replaced by the upstream's "Hello from upstream" stub text.

---

### Task 10: Smoke-check the dispatcher against a real Copilot upstream

This is a manual sanity check, not an automated test, because the dispatcher now hits a real provider.

- [ ] **Step 1: Boot the worker dev server**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run dev`
Expected: server starts on the configured port without errors.

- [ ] **Step 2: Hit one of the four protocols with a known-good API key bound to a Copilot upstream**

Example (Anthropic Messages shape):
```bash
curl -s -X POST http://localhost:8788/v1/messages \
  -H "x-api-key: <dev-api-key>" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```
Expected: HTTP 200, valid Anthropic Messages JSON. Any 5xx means the dispatcher swap regressed something; revert Task 7 changes and inspect.

- [ ] **Step 3: Stop the dev server**

`Ctrl+C` in the dev server terminal.

---

### Task 11: Commit

- [x] **Step 1: Stage and commit**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
git add packages/provider-copilot apps/gateway/package.json \
       apps/gateway/src/data-plane/routes.ts \
       apps/gateway/src/data-plane/providers/registry.ts \
       apps/gateway/src/data-plane/models/routes.ts \
       apps/gateway/src/data-plane/orchestrator \
       apps/gateway/src/control-plane/upstreams/routes.ts \
       apps/gateway/tests && \
git rm -r apps/gateway/src/data-plane/providers/copilot \
          apps/gateway/src/data-plane/services/copilot && \
git commit -m "refactor(vnext): extract Copilot provider into @vnext/provider-copilot and wire real dispatcher"
```

Expected: clean commit with the new package added, gateway directories removed, dispatcher swapped to real bindings.
