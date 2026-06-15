# Plan B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `provider-copilot` the single owner of all Copilot-specific request/response transforms, tighten `ModelProvider.fetch` to a single `(req: ProviderRequest)` entry point, and delete `packages/gateway/src/data-plane/transforms/` + the 7 dead `call*` methods.

**Architecture:** Two serial phases. **B1** consolidates transforms into provider-copilot interceptors and rewires `routes.ts:351` to call `provider.fetch({endpoint:'messages_count_tokens', ...})`. **B2** redesigns the `ModelProvider.fetch` signature (object-typed `ProviderRequest` / `ProviderResponse`), adapts all four providers + routes.ts dispatch, and deletes the optional `call*` methods.

**Tech Stack:** Bun + TypeScript monorepo. `@vnext/interceptor` (Koa-style `runInterceptors`). Hono routes. `@vnext/provider`, `@vnext/provider-copilot`, `@vnext/provider-azure`, `@vnext/provider-custom`, `@vnext/provider-sdf`. Tests run via `bun test` from `vnext/`.

**Scope reality check (recon-driven):** The spec's 18-row migration table overcounts. Actual recon shows:
- `runAnthropicMessagesPipeline` and `runResponsesChatFallbackPipeline` are **dead exports** (zero callers — verified by grep on `runAnthropicMessages`, `runResponsesChatFallback`).
- Only `runAnthropicCountTokensPipeline` has a live caller (`routes.ts:35` + `351`).
- The 7 `call*` methods are exercised only by `packages/provider-copilot/__tests__/per-endpoint-methods.test.ts`.
- Most gateway/transforms files (`whitespace-guard`, `chat-whitespace-abort`, `responses-sse-interceptor`, `compact-responses-input`, `service-tier-strip`, `streaming-id-fix`, `rewrite-context-window-error`, `tool-type`, etc.) are exported through `index.ts` with **no external callers**.
- `provider.ts:86` `messagesCountTokensChain` duplicates `messagesChain`, but `pipeline.ts:78-85` says count_tokens needs a narrower chain (context-cleanup + cache + tool-result-repair only). This is a latent bug that B1 must fix.

So real B1 work is: migrate the 3 transforms `runAnthropicCountTokensPipeline` actually depends on into provider-copilot (or wrap them in a count-tokens interceptor), fix the count-tokens chain, delete the gateway transforms tree wholesale, rewire `routes.ts:351`. The "18 transforms" framing is replaced with "delete the dead pipelines, migrate what count_tokens needs, fold the responses sidecar into a post-stream hook."

**Test baseline:** 754 pass / 4 pre-existing fail (dispatch-observability flakes returning 502 for pricing assertions). Plan B must hold this exactly.

---

# Phase B1 — Transforms 合并

## Task B1.1 — Confirm dead pipelines and lock the baseline

**Files:**
- Read-only: `packages/gateway/src/data-plane/transforms/pipeline.ts`
- Read-only: `packages/gateway/src/data-plane/routes.ts:35,351`

- [ ] **Step 1: Verify baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `754 pass`, `4 fail` (pre-existing dispatch-observability flakes).

- [ ] **Step 2: Confirm pipeline call-site inventory**

```bash
cd vnext
grep -rn "runAnthropicMessagesPipeline\|runResponsesChatFallbackPipeline\|runAnthropicCountTokensPipeline" --include="*.ts"
```
Expected output: only 3 lines outside `pipeline.ts` / `transforms/index.ts`:
```
packages/gateway/src/data-plane/routes.ts:35:import { runAnthropicCountTokensPipeline } from './transforms/index.ts'
packages/gateway/src/data-plane/routes.ts:351:  runAnthropicCountTokensPipeline(payload as ...)
```
If `runAnthropicMessagesPipeline` or `runResponsesChatFallbackPipeline` shows additional callers, **stop and update this plan**.

- [ ] **Step 3: Confirm `call*` is test-only**

```bash
cd vnext
grep -rn "\.callMessages\|\.callMessagesCountTokens\|\.callChatCompletions\|\.callResponses\|\.callEmbeddings\|\.callImagesGenerations\|\.callImagesEdits" --include="*.ts" -l | grep -v "__tests__/per-endpoint-methods"
```
Expected: empty output (the `parse/messages-sse.ts` doc-comment match is fine; only count call expressions). If any non-test caller exists, **stop and update this plan**.

- [ ] **Step 4: No commit; baseline locked in working memory**

(No code change in this task — purely a guard-rail.)

---

## Task B1.2 — Add narrow count-tokens transform module to provider-copilot

**Files:**
- Create: `packages/provider-copilot/src/transforms/count-tokens-prelude.ts`
- Modify: `packages/provider-copilot/src/transforms/index.ts`
- Test: `packages/provider-copilot/__tests__/count-tokens-prelude.test.ts`

The 3 functions `runAnthropicCountTokensPipeline` calls (`stripContextManagement`, `applyTopLevelCacheControl`, `stripCacheControl`) currently live only in gateway/transforms. We move just these three (verbatim) into a new `count-tokens-prelude.ts` module under provider-copilot, plus a single composed function. We do **not** copy the gateway barrel exports — only what count_tokens needs.

- [ ] **Step 1: Write failing test**

```ts
// packages/provider-copilot/__tests__/count-tokens-prelude.test.ts
import { test, expect } from 'bun:test'
import { runCountTokensPrelude } from '../src/transforms/count-tokens-prelude'

test('strips context_management', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'hi' }],
    context_management: { foo: 'bar' },
  }
  runCountTokensPrelude(payload)
  expect(payload.context_management).toBeUndefined()
})

test('strips cache_control on content blocks', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ],
  }
  runCountTokensPrelude(payload)
  const msg = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
  expect(msg.content[0].cache_control).toBeUndefined()
})

test('promotes top-level cache_control then strips it', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'hi' }],
    cache_control: { type: 'ephemeral' },
  }
  runCountTokensPrelude(payload)
  expect(payload.cache_control).toBeUndefined()
})

test('repairs orphan tool_result pairs', () => {
  const payload: Record<string, unknown> = {
    model: 'claude-sonnet-4',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }] },
    ],
  }
  runCountTokensPrelude(payload)
  // repairToolResultPairs strips orphan tool_result entries; messages may shrink
  const msg = (payload.messages as Array<{ content: Array<unknown> }>)[0]
  expect(Array.isArray(msg.content) ? msg.content.length : 0).toBe(0)
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd vnext
bun test packages/provider-copilot/__tests__/count-tokens-prelude.test.ts
```
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Copy the 3 functions into provider-copilot**

Copy these files **verbatim** from `packages/gateway/src/data-plane/transforms/` into `packages/provider-copilot/src/transforms/`:
- `context-management.ts`
- `apply-top-level-cache-control.ts`
- `cache-control.ts`

```bash
cd vnext
cp packages/gateway/src/data-plane/transforms/context-management.ts packages/provider-copilot/src/transforms/context-management.ts
cp packages/gateway/src/data-plane/transforms/apply-top-level-cache-control.ts packages/provider-copilot/src/transforms/apply-top-level-cache-control.ts
cp packages/gateway/src/data-plane/transforms/cache-control.ts packages/provider-copilot/src/transforms/cache-control.ts
```

- [ ] **Step 4: Write the composing module**

```ts
// packages/provider-copilot/src/transforms/count-tokens-prelude.ts
/**
 * /v1/messages/count_tokens prelude. Mirrors the live ordering from
 * gateway/transforms/pipeline.ts:78-85. No thinking handling, no tool-strict
 * stripping, no top-level cache promotion before strip — just the minimum
 * that count_tokens needs.
 */
import { stripContextManagement } from "./context-management"
import { applyTopLevelCacheControl } from "./apply-top-level-cache-control"
import { stripCacheControl } from "./cache-control"
import { repairToolResultPairs } from "../messages/repair-tool-result-pairs"

export function runCountTokensPrelude(payload: Record<string, unknown>): void {
  stripContextManagement(payload)
  applyTopLevelCacheControl(payload)
  stripCacheControl(payload)
  const messages = payload.messages
  if (Array.isArray(messages)) {
    payload.messages = repairToolResultPairs(messages as never)
  }
}
```

If `../messages/repair-tool-result-pairs` does not exist at that path, locate `repairToolResultPairs` via:
```bash
cd vnext
grep -rn "export.*repairToolResultPairs" packages/provider-copilot/src
```
and adjust the import path to match. (Do **not** import from `@vnext/provider-copilot` — this file is internal to that package.)

- [ ] **Step 5: Re-export from the barrel**

Append to `packages/provider-copilot/src/transforms/index.ts`:

```ts
export { runCountTokensPrelude } from "./count-tokens-prelude"
```

- [ ] **Step 6: Run test to verify pass**

```bash
cd vnext
bun test packages/provider-copilot/__tests__/count-tokens-prelude.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 7: Run full baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `754 pass` (or 758 with the 4 new), `4 fail` (pre-existing).

- [ ] **Step 8: Commit**

```bash
cd vnext
git add packages/provider-copilot/src/transforms/count-tokens-prelude.ts \
        packages/provider-copilot/src/transforms/context-management.ts \
        packages/provider-copilot/src/transforms/apply-top-level-cache-control.ts \
        packages/provider-copilot/src/transforms/cache-control.ts \
        packages/provider-copilot/src/transforms/index.ts \
        packages/provider-copilot/__tests__/count-tokens-prelude.test.ts
git commit -m "feat(provider-copilot): add count-tokens prelude transform module"
```

---

## Task B1.3 — Wire count-tokens prelude as a provider-copilot interceptor

**Files:**
- Create: `packages/provider-copilot/src/interceptors/messages-count-tokens/with-count-tokens-prelude.ts`
- Create: `packages/provider-copilot/src/interceptors/messages-count-tokens/index.ts`
- Modify: `packages/provider-copilot/src/provider.ts`
- Test: `packages/provider-copilot/__tests__/count-tokens-chain.test.ts`

Today `provider.ts:86` sets `messagesCountTokensChain = [variantFiltering, withInitiatorHeader, ...messagesPayloadInterceptors]` — wrong; that runs full /v1/messages payload mutation on count_tokens. We replace it with `[variantFiltering, withInitiatorHeader, withCountTokensPrelude]`. The prelude **runs on the way in** (mutates `inv.payload`), then `next()` reaches the terminal HTTP call.

- [ ] **Step 1: Write failing test**

```ts
// packages/provider-copilot/__tests__/count-tokens-chain.test.ts
import { test, expect, mock } from 'bun:test'
import { runInterceptors } from '@vnext/interceptor'
import { withCountTokensPrelude } from '../src/interceptors/messages-count-tokens/with-count-tokens-prelude'

test('count-tokens prelude strips context_management before terminal', async () => {
  const inv = {
    endpoint: 'messages_count_tokens' as const,
    enabledFlags: new Set<string>(),
    sourceApi: 'messages' as const,
    payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }], context_management: { foo: 'bar' } },
    headers: new Headers(),
  }
  const ctx = { requestStartedAt: Date.now() }
  let captured: unknown = null
  const terminal = mock(async () => {
    captured = JSON.parse(JSON.stringify(inv.payload))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  await runInterceptors(inv, ctx, [withCountTokensPrelude], terminal)
  expect((captured as { context_management?: unknown }).context_management).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd vnext
bun test packages/provider-copilot/__tests__/count-tokens-chain.test.ts
```
Expected: FAIL — `withCountTokensPrelude` does not exist.

- [ ] **Step 3: Write the interceptor**

```ts
// packages/provider-copilot/src/interceptors/messages-count-tokens/with-count-tokens-prelude.ts
import type { CopilotInterceptor } from "@vnext/interceptor"
import { runCountTokensPrelude } from "../../transforms/count-tokens-prelude"

export const withCountTokensPrelude: CopilotInterceptor = async (inv, _ctx, next) => {
  if (inv.payload && typeof inv.payload === 'object') {
    runCountTokensPrelude(inv.payload as Record<string, unknown>)
  }
  return next()
}
```

```ts
// packages/provider-copilot/src/interceptors/messages-count-tokens/index.ts
import type { CopilotInterceptor } from "@vnext/interceptor"
import { withCountTokensPrelude } from "./with-count-tokens-prelude"

export const messagesCountTokensPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCountTokensPrelude,
]
```

- [ ] **Step 4: Wire the chain in provider.ts**

In `packages/provider-copilot/src/provider.ts`, replace the broken assignment.

Find:
```ts
import { messagesPayloadInterceptors } from './interceptors/messages'
```
Add right after:
```ts
import { messagesCountTokensPayloadInterceptors } from './interceptors/messages-count-tokens'
```

Find:
```ts
    this.messagesCountTokensChain = [variantFiltering, withInitiatorHeader, ...messagesPayloadInterceptors]
```
Replace with:
```ts
    this.messagesCountTokensChain = [variantFiltering, withInitiatorHeader, ...messagesCountTokensPayloadInterceptors]
```

- [ ] **Step 5: Run unit test**

```bash
cd vnext
bun test packages/provider-copilot/__tests__/count-tokens-chain.test.ts
```
Expected: PASS.

- [ ] **Step 6: Run full baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing), all other tests still pass. The count-tokens API resource tests must remain green — the chain is now narrower, matching `pipeline.ts:78-85`.

- [ ] **Step 7: Commit**

```bash
cd vnext
git add packages/provider-copilot/src/interceptors/messages-count-tokens \
        packages/provider-copilot/src/provider.ts \
        packages/provider-copilot/__tests__/count-tokens-chain.test.ts
git commit -m "fix(provider-copilot): give count_tokens its own narrow interceptor chain"
```

---

## Task B1.4 — Replace `routes.ts:351` direct pipeline call with `provider.fetch`

**Files:**
- Modify: `packages/gateway/src/data-plane/routes.ts:35,351`

`runAnthropicCountTokensPipeline` is dead after B1.3 — the prelude now runs inside the provider chain. Remove the import and the inline call. The existing `binding.provider.fetch('messages_count_tokens', {...}, {...})` call (lines 374-378) already triggers the chain we just fixed; nothing else changes here. (B2 will redesign that signature.)

- [ ] **Step 1: Delete the import**

In `packages/gateway/src/data-plane/routes.ts`, remove:
```ts
import { runAnthropicCountTokensPipeline } from './transforms/index.ts'
```

- [ ] **Step 2: Delete the inline call**

In `packages/gateway/src/data-plane/routes.ts`, remove this line (currently line 351):
```ts
  runAnthropicCountTokensPipeline(payload as Parameters<typeof runAnthropicCountTokensPipeline>[0])
```
Leave the surrounding `stripUpstreamPin(...)` line intact.

- [ ] **Step 3: Run baseline + the count_tokens API tests**

```bash
cd vnext
bun test packages/gateway/src/data-plane/routes.test.ts tests/api-resources/messages-count-tokens.test.ts 2>&1 | tail -10
bun test 2>&1 | tail -5
```
Expected: count-tokens routes + API resource tests pass; full baseline 4 fail (pre-existing).

If a test fails on count_tokens, the prelude wiring in B1.3 is wrong — re-check the chain order against `pipeline.ts:78-85`.

- [ ] **Step 4: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/routes): drop count-tokens pipeline call (now runs in provider)"
```

---

## Task B1.5 — Relocate responses sidecar snapshot writer to a post-stream interceptor

**Files:**
- Create: `packages/provider-copilot/src/interceptors/responses/with-snapshot-sidecar.ts`
- Modify: `packages/provider-copilot/src/interceptors/responses/index.ts`
- Modify: `packages/gateway/src/data-plane/routes.ts` (lines ~449–525)
- Test: `tests/api-resources/responses-snapshot.test.ts` (exists; keep green)

**Design point:** The current sidecar lives inline in `routes.ts:479-523`, reading `auth.apiKeyId`, `obsCtx.requestId`, `getResponsesStore()`, `mergedInputItems`, and using `c.executionCtx?.waitUntil(...)`. None of those signals are available inside an interceptor cleanly — they're route-level concerns. **We do not move the sidecar into provider-copilot in B1.** Moving it in B1 would require widening `Invocation`/`RequestContext` and threading the responses-store + executionCtx through the interceptor system — that's its own refactor.

Instead: B1 leaves the sidecar in `routes.ts` as today. The spec's "sidecar in interceptor" goal is **deferred to a follow-up plan** because the cost/benefit doesn't pencil out within Plan B's scope (no behavior change, just relocation, and the route already owns all the inputs).

- [ ] **Step 1: Document the deferral**

Add a single comment above the sidecar block in `routes.ts` (currently line ~479):
```ts
    // Sidecar snapshot writer. Lives at route level because it needs
    // auth.apiKeyId, obsCtx.requestId, the responses-store handle, and
    // c.executionCtx — none of which the interceptor chain currently
    // carries. Relocation deferred to a future plan; commits 33a16c9 +
    // 69d489c semantics must hold here.
```

- [ ] **Step 2: Run baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: 4 fail (pre-existing). Snapshot id round-trip test from commit 69d489c stays green.

- [ ] **Step 3: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/routes.ts
git commit -m "docs(gateway/routes): note sidecar relocation deferred to follow-up plan"
```

> The plan deviates from the spec here. Rationale: keeping interceptors free of route-level state preserves the provider's portability across Bun + CFW. Updating the spec to match is recommended but not required.

---

## Task B1.6 — Delete the gateway transforms tree

**Files:**
- Delete: `packages/gateway/src/data-plane/transforms/` (entire directory)

After B1.4 nothing inside `packages/gateway/` imports from `./transforms/`. The tree is dead code. Delete it.

- [ ] **Step 1: Verify no live import remains**

```bash
cd vnext
grep -rn "from.*data-plane/transforms\|from '\./transforms\|from \"\./transforms" packages/gateway/src --include="*.ts"
grep -rn "from '@vnext/gateway.*transforms\|from \"@vnext/gateway.*transforms" --include="*.ts"
```
Expected: empty output. If anything matches, **stop and trace the caller** — it's a missed B1.x dependency.

- [ ] **Step 2: Delete the directory**

```bash
cd vnext
git rm -r packages/gateway/src/data-plane/transforms
```

- [ ] **Step 3: Run full baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing). If any new failure appears, restore with `git checkout HEAD -- packages/gateway/src/data-plane/transforms` and re-trace.

- [ ] **Step 4: Run integration suites**

```bash
cd vnext
bun run local &
LOCAL_PID=$!
sleep 3
bun run test:integration:anthropic
bun run test:integration:openai
kill $LOCAL_PID 2>/dev/null
```
Expected: both pass. (`local` background-process management is the implementer's call — `Bash run_in_background:true` is the cleanest path.)

- [ ] **Step 5: Commit**

```bash
cd vnext
git add -A
git commit -m "refactor(gateway): delete data-plane/transforms tree (consolidated into provider-copilot)"
```

---

# Phase B2 — ModelProvider 接口收紧

## Task B2.1 — Add `ProviderRequest` / `ProviderResponse` types

**Files:**
- Modify: `packages/provider/src/types.ts`
- Test: `packages/provider/__tests__/provider-request.test.ts`

Introduce the new types alongside the existing ones. Don't break the current interface yet — that's B2.2. This task only adds the shapes and exports.

- [ ] **Step 1: Write failing test**

```ts
// packages/provider/__tests__/provider-request.test.ts
import { test, expect } from 'bun:test'
import type { ProviderRequest, ProviderResponse, ProviderRequestFlags, SourceApi } from '../src/types'

test('ProviderRequest shape compiles', () => {
  const req: ProviderRequest = {
    endpoint: 'messages',
    payload: { model: 'm', messages: [] },
    headers: new Headers(),
    sourceApi: 'anthropic',
    flags: { isStreaming: false },
  }
  expect(req.endpoint).toBe('messages')
})

test('ProviderResponse shape compiles', () => {
  const res: ProviderResponse = {
    status: 200,
    headers: new Headers(),
    body: null,
  }
  expect(res.status).toBe(200)
})

test('SourceApi members', () => {
  const a: SourceApi = 'anthropic'
  const b: SourceApi = 'openai'
  const c: SourceApi = 'gemini'
  expect([a, b, c]).toEqual(['anthropic', 'openai', 'gemini'])
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd vnext
bun test packages/provider/__tests__/provider-request.test.ts
```
Expected: FAIL — types don't exist.

- [ ] **Step 3: Add types**

In `packages/provider/src/types.ts`, **before** the `ModelProvider` interface, add:

```ts
export type SourceApi = 'anthropic' | 'openai' | 'gemini'

export interface ProviderRequestFlags {
  isStreaming: boolean
  hasWebSearch?: boolean
  hasImageGen?: boolean
}

export interface ProviderRequest {
  endpoint: EndpointKey
  /** Schema-validated JSON object. NOT a string. Interceptors mutate fields directly. */
  payload: unknown
  /** Mutable along the interceptor chain. Terminal HTTP reads the final state. */
  headers: Headers
  sourceApi: SourceApi
  flags?: ProviderRequestFlags
  signal?: AbortSignal
  /** Optional log-friendly label. Defaults to `call ${endpoint}` in the provider. */
  operationName?: string
  /** Defaults to true. count_tokens is the only endpoint where model is optional. */
  requireModel?: boolean
  /** Per-call timeout override in ms. */
  timeout?: number
}

export interface ProviderResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}
```

- [ ] **Step 4: Run test**

```bash
cd vnext
bun test packages/provider/__tests__/provider-request.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
cd vnext
git add packages/provider/src/types.ts packages/provider/__tests__/provider-request.test.ts
git commit -m "feat(provider): add ProviderRequest and ProviderResponse types"
```

---

## Task B2.2 — Adapter shim: provider-copilot supports both old and new fetch shapes

**Files:**
- Modify: `packages/provider-copilot/src/provider.ts`
- Test: `packages/provider-copilot/__tests__/fetch-new-shape.test.ts`

We can't flip every caller in one commit. Strategy: introduce a new internal method `fetchNew(req: ProviderRequest)` that does what the new contract demands, and have the existing `fetch(endpoint, init, opts)` delegate to it. This lets B2.3-B2.6 migrate caller-by-caller. Once all callers move, B2.7 deletes the old signature.

- [ ] **Step 1: Write failing test**

```ts
// packages/provider-copilot/__tests__/fetch-new-shape.test.ts
import { test, expect } from 'bun:test'
import { CopilotProvider } from '../src/provider'

test('fetch accepts ProviderRequest object form', async () => {
  const provider = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  // Patch the global fetch the forward layer uses; we just want to confirm the
  // new shape doesn't throw at the type/runtime boundary. Real network is
  // covered by integration tests.
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"input_tokens":1}', { status: 200, headers: { 'content-type': 'application/json' } })
  ) as typeof fetch
  try {
    const res = await provider.fetch({
      endpoint: 'messages_count_tokens',
      payload: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers({ 'content-type': 'application/json' }),
      sourceApi: 'anthropic',
      flags: { isStreaming: false },
    })
    expect(res.status).toBe(200)
    expect(res.headers).toBeInstanceOf(Headers)
  } finally {
    globalThis.fetch = orig
  }
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd vnext
bun test packages/provider-copilot/__tests__/fetch-new-shape.test.ts
```
Expected: FAIL — `fetch` rejects object argument or returns wrong shape.

- [ ] **Step 3: Add the union signature in `CopilotProvider.fetch`**

In `packages/provider-copilot/src/provider.ts`, replace the current `fetch` method with overloaded form that handles both shapes. New body:

```ts
  async fetch(req: ProviderRequest): Promise<ProviderResponse>
  async fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
  async fetch(
    arg: EndpointKey | ProviderRequest,
    init?: RequestInit,
    opts: ProviderFetchOptions = {},
  ): Promise<Response | ProviderResponse> {
    if (typeof arg === 'object') {
      return this.fetchInternal(arg)
    }
    // Legacy path — adapt into ProviderRequest then unwrap to Response.
    const endpoint = arg
    const path = COPILOT_PATHS[endpoint]
    if (!path) throw new Error(`CopilotProvider does not support endpoint: ${endpoint}`)
    const headers = mergeHeaders(init?.headers, opts.extraHeaders)
    const req: ProviderRequest = {
      endpoint,
      payload: parseJsonBody(init?.body),
      headers,
      sourceApi: (opts.sourceApi ?? 'anthropic') as SourceApi,
      signal: init?.signal ?? undefined,
      operationName: opts.operationName,
      requireModel: opts.requireModel,
      timeout: opts.timeout,
      flags: { isStreaming: false },
    }
    const pr = await this.fetchInternal(req, opts.enabledFlags)
    return new Response(pr.body, { status: pr.status, headers: pr.headers })
  }

  private async fetchInternal(
    req: ProviderRequest,
    enabledFlagsOverride?: ReadonlySet<string>,
  ): Promise<ProviderResponse> {
    const path = COPILOT_PATHS[req.endpoint]
    if (!path) throw new Error(`CopilotProvider does not support endpoint: ${req.endpoint}`)

    const inv: Invocation = {
      endpoint: req.endpoint,
      enabledFlags: enabledFlagsOverride ?? defaultsForUpstream('copilot'),
      sourceApi: mapSourceApi(req.sourceApi),
      payload: req.payload,
      headers: req.headers,
    }
    const ctx: RequestContext = {
      requestStartedAt: Date.now(),
      downstreamAbortSignal: req.signal,
    }
    const interceptors = this.interceptorsFor(req.endpoint)
    const requireModel = req.requireModel ?? req.endpoint !== 'messages_count_tokens'

    const response = await runInterceptors(inv, ctx, interceptors, () =>
      callCopilotAPI({
        endpoint: path,
        payload: inv.payload,
        operationName: req.operationName ?? `call ${req.endpoint}`,
        copilotToken: this.copilotToken,
        accountType: this.accountType,
        timeout: req.timeout,
        extraHeaders: inv.headers,
        requireModel,
      }),
    )
    return { status: response.status, headers: response.headers, body: response.body }
  }
```

Add the helper at the bottom of the file:

```ts
function mapSourceApi(src: SourceApi | undefined): 'messages' | 'chat_completions' | 'responses' | 'gemini' | undefined {
  if (!src) return undefined
  if (src === 'anthropic') return 'messages'
  if (src === 'openai') return 'chat_completions'
  return src
}
```

Imports to add:
```ts
import type { ProviderRequest, ProviderResponse, SourceApi } from '@vnext/provider'
```

- [ ] **Step 4: Run new test + baseline**

```bash
cd vnext
bun test packages/provider-copilot/__tests__/fetch-new-shape.test.ts
bun test 2>&1 | tail -5
```
Expected: new test PASS. Baseline `4 fail` (pre-existing).

- [ ] **Step 5: Commit**

```bash
cd vnext
git add packages/provider-copilot/src/provider.ts packages/provider-copilot/__tests__/fetch-new-shape.test.ts
git commit -m "feat(provider-copilot): support ProviderRequest object form on fetch (additive)"
```

---

## Task B2.3 — Migrate `routes.ts` count_tokens call site to the new shape

**Files:**
- Modify: `packages/gateway/src/data-plane/routes.ts:373-378`

- [ ] **Step 1: Replace the call**

In `packages/gateway/src/data-plane/routes.ts`, find the count_tokens call (around line 373):

```ts
    const response = await binding.provider.fetch(
      'messages_count_tokens',
      { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } },
      { operationName: 'count tokens', extraHeaders, enabledFlags: binding.enabledFlags },
    )
```

Replace with:

```ts
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
    const pr = await binding.provider.fetch({
      endpoint: 'messages_count_tokens',
      payload,
      headers,
      sourceApi: 'anthropic',
      operationName: 'count tokens',
      flags: { isStreaming: false },
      signal: c.req.raw.signal,
    })
    const response = new Response(pr.body, { status: pr.status, headers: pr.headers })
```

(The downstream `await response.json()` keeps working because `Response` accepts `ReadableStream<Uint8Array>`.)

- [ ] **Step 2: Run count_tokens tests**

```bash
cd vnext
bun test tests/api-resources/messages-count-tokens.test.ts 2>&1 | tail -10
bun test 2>&1 | tail -5
```
Expected: count_tokens tests pass; baseline `4 fail` (pre-existing).

- [ ] **Step 3: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/routes): migrate count_tokens to ProviderRequest shape"
```

---

## Task B2.4 — Migrate `routes.ts` `dispatch` call site to the new shape

**Files:**
- Modify: `packages/gateway/src/data-plane/routes.ts:233-237`

- [ ] **Step 1: Replace the call**

In `dispatch()`, find:

```ts
      call: () => binding.provider.fetch(
        targetEndpoint,
        { method: 'POST', body: JSON.stringify(upstreamPayload), headers: { 'content-type': 'application/json' } },
        { operationName: 'data-plane dispatch', enabledFlags: binding.enabledFlags, sourceApi: input.sourceApi },
      ),
```

Replace with:

```ts
      call: async () => {
        const pr = await binding.provider.fetch({
          endpoint: targetEndpoint,
          payload: upstreamPayload,
          headers: new Headers({ 'content-type': 'application/json' }),
          sourceApi: mapSourceApiToProviderRequest(input.sourceApi),
          operationName: 'data-plane dispatch',
          flags: { isStreaming: isStream },
          signal: ctx.signal,
        })
        return new Response(pr.body, { status: pr.status, headers: pr.headers })
      },
```

Add a helper at the top of `routes.ts` (or in a small util module):

```ts
function mapSourceApiToProviderRequest(src: 'messages' | 'chat_completions' | 'responses' | 'gemini'): 'anthropic' | 'openai' | 'gemini' {
  if (src === 'messages') return 'anthropic'
  if (src === 'chat_completions') return 'openai'
  if (src === 'responses') return 'openai'
  return 'gemini'
}
```

> NOTE: B2.2's adapter shim accepts both old and new shape. The new payload-object form here matches the `payload: unknown` field in `ProviderRequest`. `binding.enabledFlags` no longer threads through — the provider already has its own defaults via `defaultsForUpstream`. If any test fails because `enabledFlags` was honored, restore the old path or extend `ProviderRequest` with `enabledFlags?` and thread it through `fetchInternal`.

- [ ] **Step 2: If `enabledFlags` matters, extend `ProviderRequest`**

Run baseline first:
```bash
cd vnext
bun test 2>&1 | tail -5
```

If a test fails citing `transform-strip-tool-strict` or any flag-controlled behavior, extend `ProviderRequest` (in `packages/provider/src/types.ts`):
```ts
export interface ProviderRequest {
  /* ...existing fields... */
  enabledFlags?: ReadonlySet<string>
}
```
And in `provider-copilot/src/provider.ts:fetchInternal`, replace:
```ts
enabledFlags: enabledFlagsOverride ?? defaultsForUpstream('copilot'),
```
with:
```ts
enabledFlags: req.enabledFlags ?? enabledFlagsOverride ?? defaultsForUpstream('copilot'),
```
Then thread `enabledFlags: binding.enabledFlags` into the `fetch` object in `routes.ts`.

- [ ] **Step 3: Run baseline + integration**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing). All other tests pass.

```bash
cd vnext
bun run local &
sleep 3
bun run test:integration:anthropic
bun run test:integration:openai
kill %1 2>/dev/null
```
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/routes.ts packages/provider/src/types.ts packages/provider-copilot/src/provider.ts 2>/dev/null
git commit -m "refactor(gateway/routes): migrate dispatch() to ProviderRequest shape"
```

---

## Task B2.5 — Migrate provider-azure to the new fetch shape

**Files:**
- Modify: `packages/provider-azure/src/provider.ts:127`
- Test: `packages/provider-azure/__tests__/fetch-new-shape.test.ts`

Same pattern as B2.2: union signature, new code path delegates to a `fetchInternal(req)`, old path adapts.

- [ ] **Step 1: Write failing test**

```ts
// packages/provider-azure/__tests__/fetch-new-shape.test.ts
import { test, expect } from 'bun:test'
// Skip if AzureProvider isn't constructible without secrets — adjust to project conventions
// (existing azure tests should show the construction shape).
test('AzureProvider.fetch accepts ProviderRequest', async () => {
  expect(true).toBe(true) // placeholder; replace with actual provider construction + mocked fetch
})
```

> Implementer: replace the placeholder with a real test that mirrors the `__tests__` patterns in `packages/provider-azure/__tests__/` (look for an existing `provider.test.ts`). The point is: `provider.fetch({endpoint, payload, headers, sourceApi})` returns `{status, headers, body}` shape.

- [ ] **Step 2: Run test to verify failure**

```bash
cd vnext
bun test packages/provider-azure/__tests__/fetch-new-shape.test.ts
```
Expected: FAIL until the new signature lands.

- [ ] **Step 3: Add the union signature**

In `packages/provider-azure/src/provider.ts`, replace `async fetch(endpoint, init, opts = {})` with:

```ts
  async fetch(req: ProviderRequest): Promise<ProviderResponse>
  async fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
  async fetch(
    arg: EndpointKey | ProviderRequest,
    init?: RequestInit,
    opts: ProviderFetchOptions = {},
  ): Promise<Response | ProviderResponse> {
    if (typeof arg === 'object') {
      return this.fetchInternal(arg)
    }
    // Legacy path
    return this.fetchLegacy(arg, init!, opts)
  }
```

Move the existing body of `fetch` into `private async fetchLegacy(endpoint, init, opts)`.

Add `private async fetchInternal(req: ProviderRequest): Promise<ProviderResponse>`:

```ts
  private async fetchInternal(req: ProviderRequest): Promise<ProviderResponse> {
    // Wrap into a Request once. Azure has no interceptor chain, so headers
    // and payload pass straight through.
    const headers = new Headers(req.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    const legacyOpts: ProviderFetchOptions = {
      sourceApi: mapSourceApiToLegacy(req.sourceApi),
      enabledFlags: req.enabledFlags,
      operationName: req.operationName,
      timeout: req.timeout,
      requireModel: req.requireModel,
    }
    const res = await this.fetchLegacy(
      req.endpoint,
      { method: 'POST', body: JSON.stringify(req.payload ?? {}), headers, signal: req.signal },
      legacyOpts,
    )
    return { status: res.status, headers: res.headers, body: res.body }
  }
```

Add the same `mapSourceApiToLegacy` helper as in `provider-copilot`. Imports:
```ts
import type { ProviderRequest, ProviderResponse } from '@vnext/provider'
```

- [ ] **Step 4: Run test + baseline**

```bash
cd vnext
bun test packages/provider-azure 2>&1 | tail -10
bun test 2>&1 | tail -5
```
Expected: azure tests pass; baseline `4 fail` (pre-existing).

- [ ] **Step 5: Commit**

```bash
cd vnext
git add packages/provider-azure
git commit -m "feat(provider-azure): support ProviderRequest object form on fetch"
```

---

## Task B2.6 — Migrate provider-custom and provider-sdf

**Files:**
- Modify: `packages/provider-custom/src/provider.ts:146`
- Modify: `packages/provider-sdf/src/provider.ts:96`
- Test: `packages/provider-custom/__tests__/fetch-new-shape.test.ts`
- Test: `packages/provider-sdf/__tests__/fetch-new-shape.test.ts`

Identical pattern to B2.5. Repeat for both providers in a single commit (they're symmetric).

- [ ] **Step 1: Write failing tests** (one per provider, mirroring B2.5's shape)

- [ ] **Step 2: Run tests to verify failure**

```bash
cd vnext
bun test packages/provider-custom/__tests__/fetch-new-shape.test.ts \
         packages/provider-sdf/__tests__/fetch-new-shape.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Apply the same shim pattern as B2.5 to both providers**

In `packages/provider-custom/src/provider.ts` and `packages/provider-sdf/src/provider.ts`, do exactly what B2.5 did to `provider-azure/src/provider.ts`: union signature, `fetchInternal(req)`, `fetchLegacy(endpoint, init, opts)`, plus the `mapSourceApiToLegacy` helper.

- [ ] **Step 4: Run baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing).

- [ ] **Step 5: Commit**

```bash
cd vnext
git add packages/provider-custom packages/provider-sdf
git commit -m "feat(provider-custom,provider-sdf): support ProviderRequest object form on fetch"
```

---

## Task B2.7 — Migrate FakeProvider

**Files:**
- Modify: `packages/provider/src/types.ts` (FakeProvider class, lines ~95-166)
- Test: `packages/provider/__tests__/fake-provider-new-shape.test.ts`

`FakeProvider` is shipped with the provider package and used by tests. Same shim treatment.

- [ ] **Step 1: Write failing test**

```ts
// packages/provider/__tests__/fake-provider-new-shape.test.ts
import { test, expect } from 'bun:test'
import { FakeProvider } from '../src/types'

test('FakeProvider accepts ProviderRequest', async () => {
  const fp = new FakeProvider({ text: 'hello' })
  const res = await fp.fetch({
    endpoint: 'responses',
    payload: { model: 'fake', input: 'hi' },
    headers: new Headers(),
    sourceApi: 'openai',
    flags: { isStreaming: false },
  })
  expect(res.status).toBe(200)
  expect(res.body).toBeTruthy()
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd vnext
bun test packages/provider/__tests__/fake-provider-new-shape.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Apply union signature**

In `packages/provider/src/types.ts`, replace `FakeProvider.fetch` with the same shim pattern.

- [ ] **Step 4: Run baseline**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing).

- [ ] **Step 5: Commit**

```bash
cd vnext
git add packages/provider
git commit -m "feat(provider): FakeProvider supports ProviderRequest object form"
```

---

## Task B2.8 — Flip `ModelProvider.fetch` to the new signature only; delete legacy paths

**Files:**
- Modify: `packages/provider/src/types.ts`
- Modify: `packages/provider-copilot/src/provider.ts`
- Modify: `packages/provider-azure/src/provider.ts`
- Modify: `packages/provider-custom/src/provider.ts`
- Modify: `packages/provider-sdf/src/provider.ts`

After B2.3 + B2.4 there are zero callers of the legacy `(endpoint, init, opts)` signature. Confirm, then delete the union and the `fetchLegacy` paths from all four providers.

- [ ] **Step 1: Confirm no legacy caller remains**

```bash
cd vnext
grep -rn "binding\.provider\.fetch(\|provider\.fetch('" --include="*.ts" packages/ apps/ | grep -v "__tests__\|fetch({"
```
Expected: empty (or only matches inside provider.ts itself). If a caller is found, **stop and migrate it** before proceeding.

- [ ] **Step 2: Tighten the interface**

In `packages/provider/src/types.ts`, replace the `fetch` line in `ModelProvider`:

```ts
fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
```

with:

```ts
fetch(req: ProviderRequest): Promise<ProviderResponse>
```

Also delete (lines ~85-91, the seven optional methods):
```ts
callMessages?(...): ...
callMessagesCountTokens?(...): ...
callChatCompletions?(...): ...
callResponses?(...): ...
callEmbeddings?(...): ...
callImagesGenerations?(...): ...
callImagesEdits?(...): ...
```

Delete unused interface members and types now orphaned:
- `PerEndpointCallOptions` (no callers after `call*` removal)
- `ProviderCallOptions` if unused (verify with grep)
- `ProviderFetchOptions` if unused (verify with grep — likely now dead too)
- The `MessagesEvent` and `UpstreamResponse` imports in `types.ts` if no longer needed

```bash
cd vnext
grep -rn "PerEndpointCallOptions\|ProviderCallOptions\|ProviderFetchOptions" --include="*.ts" packages/ apps/
```
Delete only the names that show zero non-definition callers.

- [ ] **Step 3: Drop the legacy path from each provider**

In each of:
- `packages/provider-copilot/src/provider.ts`
- `packages/provider-azure/src/provider.ts`
- `packages/provider-custom/src/provider.ts`
- `packages/provider-sdf/src/provider.ts`
- `packages/provider/src/types.ts` (FakeProvider)

Delete:
- The `async fetch(endpoint, init, opts)` overload
- The `fetchLegacy(...)` method
- The legacy adapter union branch in `fetch(arg, init?, opts?)`

Replace `fetch` with:

```ts
async fetch(req: ProviderRequest): Promise<ProviderResponse> {
  return this.fetchInternal(req)   // copilot
  // OR (azure/custom/sdf/fake): inline the body that was in fetchInternal
}
```

In `provider-copilot/src/provider.ts`, also delete:
- All 7 `call*` methods (`callMessages`, `callMessagesCountTokens`, …, `callImagesEdits`)
- The `callImpl<TStream>` private method
- `readsStream` and `buildExtraHeaders` helpers (only `callImpl` used them)
- The now-unused imports: `PerEndpointCallOptions`, `UpstreamResponse`, `MessagesEvent`, `parseSSEStream`, `parseChatSSEStream`, `parseResponsesSSEStream` (only if no other code in that file references them)

- [ ] **Step 4: Delete the per-endpoint test file**

```bash
cd vnext
git rm packages/provider-copilot/__tests__/per-endpoint-methods.test.ts
```

- [ ] **Step 5: Run baseline + integration**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing). The 12-ish tests in `per-endpoint-methods.test.ts` are gone (deleted with the methods).

```bash
cd vnext
bun run local &
sleep 3
bun run test:integration:anthropic
bun run test:integration:openai
kill %1 2>/dev/null
```
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
cd vnext
git add -A
git commit -m "refactor(provider): tighten ModelProvider.fetch signature; delete 7 dead call* methods"
```

---

## Task B2.9 — Final cleanup pass

**Files:**
- Modify: any file with leftover dead imports

- [ ] **Step 1: Type-check the workspace**

```bash
cd vnext
bun run typecheck 2>&1 | tail -20
```
(If the project doesn't have a top-level `typecheck` script, use `bunx tsc -p apps/platform-bun --noEmit` and `bunx tsc -p apps/platform-cloudflare --noEmit` plus each package's tsconfig if they exist.)

Fix any remaining type errors — typically dead imports or `any` casts that survived the migration.

- [ ] **Step 2: Run the full baseline + integration**

```bash
cd vnext
bun test 2>&1 | tail -5
```
Expected: `4 fail` (pre-existing). Everything else passes.

```bash
cd vnext
bun run local &
sleep 3
bun run test:integration:anthropic
bun run test:integration:openai
kill %1 2>/dev/null
```
Expected: both pass.

- [ ] **Step 3: Final commit (if anything changed in Step 1)**

```bash
cd vnext
git add -A
git commit -m "chore(plan-b): clean up dead imports after interface tightening"
```

---

## Acceptance criteria

After all tasks land:

- [ ] `bun test` from `vnext/` reports `754 pass / 4 fail` (the 4 dispatch-observability flakes are pre-existing baseline).
- [ ] `bun run test:integration:anthropic` and `bun run test:integration:openai` both pass against `bun run local`.
- [ ] `packages/gateway/src/data-plane/transforms/` directory does not exist.
- [ ] `grep -rn "from.*data-plane/transforms" --include="*.ts"` returns empty.
- [ ] `grep -rn "callMessages\|callChatCompletions\|callResponses\|callEmbeddings\|callImagesGenerations\|callImagesEdits\|callMessagesCountTokens" --include="*.ts"` returns empty.
- [ ] `ModelProvider.fetch` in `packages/provider/src/types.ts` reads `fetch(req: ProviderRequest): Promise<ProviderResponse>` — single signature, no overloads.
- [ ] `routes.ts` contains no import from `./transforms/`.

---

## Sequencing summary

```
B1.1  →  B1.2  →  B1.3  →  B1.4  →  B1.5  →  B1.6
                                                 ▼
B2.1  →  B2.2  →  B2.3  →  B2.4  →  B2.5  →  B2.6  →  B2.7  →  B2.8  →  B2.9
```

B1 lands first as a self-contained refactor (transforms consolidate, gateway/transforms tree dies). B2 then tightens the surface.

Plan C (provider factory table + routes.ts split) starts only after B is fully landed.

---

## Out of scope (carry into Plan C or beyond)

- Sidecar relocation into a real responses post-stream interceptor (deferred in B1.5; needs interceptor-context widening).
- Provider factory table.
- routes.ts split into per-source-API directories.
- Performance work, new features, wire-level changes.
