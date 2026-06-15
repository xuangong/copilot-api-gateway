# Spec 2 — Part 4: serve.ts Rewrite + Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Parts 1-3 into the public `/v1/chat/completions` HTTP entry point and prove end-to-end that `withUsageStreamOptionsIncluded` actually mutates the upstream payload. After this part, the chat-completions same-protocol path no longer routes through `dispatch()`.

**Architecture:** Rewrite `chat-completions/serve.ts` to: parse payload → resolve auth/obsCtx → `chatCompletionsAttempt.generate({...})` → `respondChatCompletions(result, {wantsStream, includeUsageChunk})`. The cross-protocol bridge (`dispatchFallback`) calls the existing `dispatch(raw, {...})` helper. Validation: a new integration test drives a real HTTP request through the gateway with a `FakeProvider` and asserts the upstream payload contains `stream_options.include_usage: true`. The OpenAI SDK regression suite (`bun run test:integration:openai`) then confirms no behavioral drift.

**Tech Stack:** Bun + TypeScript, Hono. Uses every piece from Parts 1-3.

---

## Spec Reference

- Spec: `vnext/docs/superpowers/specs/2026-06-15-spec2-chat-completions-data-plane-wiring.md` §"Architecture Overview" + §"Acceptance Checklist"
- vnext files to edit/read:
  - `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts` (rewrite)
  - `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts` (unchanged — sanity check)
  - `vnext/packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts` (used as cross-protocol fallback)
  - `vnext/packages/gateway/src/data-plane/chat-flow/shared/gateway-ctx.ts` (`readAuth`, `readObsCtx`)

## File Structure

- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts` (rewrite to ~40 LOC)
- Create: `vnext/packages/gateway/tests/integration/include-usage-wiring.test.ts`
- Touch (optional): `vnext/packages/gateway/tests/fakes/fake-provider.ts` to add `lastRequest` getter if absent.

---

## Task 1 — Rewrite `chat-completions/serve.ts`

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`

### Step 1 — Re-read current implementation

- [ ] Read the current `serve.ts` (~23 LOC; delegates fully to `dispatch()`). Confirm shape of `ChatCompletionsServeArgs = { raw, auth, obsCtx }` and that callers (e.g. `http.ts`) pass these three fields only.

### Step 2 — Read helpers to wire

- [ ] Read `chat-flow/shared/gateway-ctx.ts` to confirm `readAuth`/`readObsCtx` signatures and `DispatchObsCtx { apiKeyId, userAgent, requestId }`.
- [ ] Read `routing/parse-chat-payload.ts` (or wherever `parseChatPayload` lives — check the import in current `serve.ts`).
- [ ] Confirm `dispatch(raw, options)` signature for the fallback bridge.

### Step 3 — Write failing unit test for the rewrite

- [ ] Create `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts`:

```ts
import { test, expect, mock } from 'bun:test'
import { serveChatCompletions } from '../../../../src/data-plane/chat-flow/chat-completions/serve'

const fakeAuth = { ownerId: 'o', copilot: false } as any
const fakeObsCtx = { apiKeyId: 'k', userAgent: 'ua', requestId: 'rid' } as any

test('rejects malformed JSON body with 400', async () => {
  const resp = await serveChatCompletions({
    raw: new Request('http://x/v1/chat/completions', { method: 'POST', body: '{not json' }),
    auth: fakeAuth, obsCtx: fakeObsCtx,
  })
  expect(resp.status).toBe(400)
})

test('passes wantsStream=true to respond when stream:true in body', async () => {
  // We assert end-to-end via the integration test in Task 2; this case
  // just ensures the rewritten serve.ts compiles + doesn't crash on a
  // happy-path stream request when the underlying attempt errors out
  // (model-not-found → 404).
  const resp = await serveChatCompletions({
    raw: new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'definitely-not-a-real-model-zzz', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }),
    auth: fakeAuth, obsCtx: fakeObsCtx,
  })
  expect([404, 400, 502]).toContain(resp.status)
})
```

### Step 4 — Run, see fail

- [ ] `bun test tests/data-plane/chat-flow/chat-completions/serve.test.ts` → FAIL (rewrite not done)

### Step 5 — Rewrite `serve.ts`

- [ ] Replace contents with:

```ts
import type { Auth } from '../shared/gateway-ctx'
import type { DispatchObsCtx } from '../shared/gateway-ctx'
import { dispatch } from '../shared/dispatch'
import { parseChatPayload, jsonErrorWrap } from '../shared/parse-chat-payload' // adjust path to match repo
import { chatCompletionsAttempt } from './attempt'
import { respondChatCompletions } from './respond'

export interface ChatCompletionsServeArgs {
  readonly raw: Request
  readonly auth: Auth
  readonly obsCtx: DispatchObsCtx
}

export const serveChatCompletions = async (args: ChatCompletionsServeArgs): Promise<Response> => {
  let payload: Record<string, unknown> & { model: string; stream?: boolean; stream_options?: { include_usage?: boolean } }
  try {
    payload = await parseChatPayload(args.raw.clone()) as never
  } catch (err) {
    return jsonErrorWrap(err)
  }

  const wantsStream = payload.stream === true
  const includeUsageChunk = payload.stream_options?.include_usage === true

  const result = await chatCompletionsAttempt.generate({
    payload,
    raw: args.raw,
    auth: { ownerId: args.auth.ownerId, copilot: args.auth.copilot, pin: args.auth.pin },
    ctx: { requestStartedAt: Date.now(), downstreamAbortSignal: args.raw.signal },
    dispatchFallback: (raw) => dispatch(raw, {
      parse: (r) => parseChatPayload(r) as never,
      modelOf: (p) => (p as { model?: string }).model ?? '',
      sourceApi: 'chat_completions',
      fallbackMaxOutputTokens: 4096,
      errorWrap: jsonErrorWrap,
      auth: args.auth,
      obsCtx: args.obsCtx,
    }),
  })

  return respondChatCompletions(result, { wantsStream, includeUsageChunk })
}
```

(Adjust imports for `parseChatPayload`, `jsonErrorWrap`, `Auth`, `DispatchObsCtx` to match the actual paths in vnext. The current `serve.ts` already imports them — copy the exact import lines.)

### Step 6 — Run unit test

- [ ] `bun test tests/data-plane/chat-flow/chat-completions/serve.test.ts` → PASS (2/2)

### Step 7 — Typecheck + full package tests

- [ ] `cd vnext/packages/gateway && bun x tsc --noEmit` → zero new errors
- [ ] `cd vnext/packages/gateway && bun test` → all green (existing chat-completions tests still pass; pre-existing failures tolerated only if they predate this branch)

### Step 8 — Commit

- [ ] `git commit -m "refactor(gateway/chat-completions): rewrite serve.ts onto attempt+respond chain (spec2 part4)"`

---

## Task 2 — End-to-end integration test (include_usage wiring proof)

**Files:**
- Create: `vnext/packages/gateway/tests/integration/include-usage-wiring.test.ts`
- Optional touch: `vnext/packages/gateway/tests/fakes/fake-provider.ts` (add `lastRequest` getter if absent)

### Step 1 — Inspect the FakeProvider helper

- [ ] Find the existing fake/mock provider in `vnext/packages/gateway/tests/`. If no `lastRequest` accessor exists, add one:

```ts
// in fakes/fake-provider.ts
export class FakeProvider {
  lastRequest: { payload: Record<string, unknown>; headers: Record<string, string> } | null = null
  async fetch(req: { payload: Record<string, unknown>; headers: Record<string, string>; signal?: AbortSignal }) {
    this.lastRequest = { payload: req.payload, headers: req.headers }
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Response(
        'data: {"id":"x","object":"chat.completion.chunk","model":"gpt-x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
      ).body!,
    }
  }
}
```

### Step 2 — Write the integration test

- [ ] Create `tests/integration/include-usage-wiring.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { FakeProvider } from '../fakes/fake-provider'
import { serveChatCompletions } from '../../src/data-plane/chat-flow/chat-completions/serve'
import { registerTestBinding, clearTestBindings } from '../helpers/test-bindings' // build if missing — see Step 3

const fakeAuth = { ownerId: 'test-owner', copilot: false } as any
const fakeObsCtx = { apiKeyId: 'test-key', userAgent: 'jest', requestId: 'r-1' } as any

test('streaming chat-completions request reaches upstream with stream_options.include_usage=true', async () => {
  const provider = new FakeProvider()
  registerTestBinding({
    model: 'fake-stream-model',
    targetEndpoint: 'chat_completions',
    provider,
    upstreamModel: 'fake-stream-model-upstream',
    ownerId: 'test-owner',
  })
  try {
    const raw = new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-stream-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        // intentionally NO stream_options — interceptor must add it
      }),
    })
    const resp = await serveChatCompletions({ raw, auth: fakeAuth, obsCtx: fakeObsCtx })
    expect(resp.status).toBe(200)
    await resp.text() // drain SSE
    expect(provider.lastRequest).not.toBeNull()
    expect(provider.lastRequest!.payload.stream_options).toEqual({ include_usage: true })
  } finally {
    clearTestBindings()
  }
})

test('preserves user-supplied stream_options siblings while forcing include_usage=true', async () => {
  const provider = new FakeProvider()
  registerTestBinding({
    model: 'fake-stream-model-2', targetEndpoint: 'chat_completions', provider,
    upstreamModel: 'fake-stream-model-2-upstream', ownerId: 'test-owner',
  })
  try {
    const raw = new Request('http://test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-stream-model-2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: false, foo: 'bar' },
      }),
    })
    const resp = await serveChatCompletions({ raw, auth: fakeAuth, obsCtx: fakeObsCtx })
    await resp.text()
    expect(provider.lastRequest!.payload.stream_options).toEqual({ include_usage: true, foo: 'bar' })
  } finally {
    clearTestBindings()
  }
})
```

### Step 3 — Build the test-binding helper if missing

- [ ] If `tests/helpers/test-bindings.ts` doesn't exist, create a minimal helper that injects bindings into the routing registry used by `enumerateBindingCandidates`. Inspect `vnext/packages/gateway/src/routing/candidates.ts` and any existing in-memory registry to model after. Keep the helper test-only (no production impact).

### Step 4 — Run integration test

- [ ] `cd vnext/packages/gateway && bun test tests/integration/include-usage-wiring.test.ts` → PASS (2/2)

### Step 5 — Commit

- [ ] `git commit -m "test(gateway/chat-completions): e2e include-usage wiring proof (spec2 part4)"`

---

## Task 3 — SDK regression: OpenAI suite

### Step 1 — Start local server

- [ ] Run: `bun run local` (per project CLAUDE.md — local dev server with proxy)

### Step 2 — Run OpenAI SDK integration tests

- [ ] In a separate terminal: `bun run test:integration:openai`
- [ ] Expected: all green; specifically chat-completions streaming + non-streaming both pass.

### Step 3 — If regressions surface

- [ ] Read the failing test output carefully. Common causes and fixes:
  - **SSE format drift** (extra/missing newline) → check `respond.ts` `encodeSseFrame` formatting matches reference output byte-for-byte.
  - **Missing usage chunk in stream** → confirm `includeUsageChunk` is `true` when the client explicitly set `stream_options.include_usage: true`.
  - **JSON envelope differs for errors** → align `respondChatCompletions` error envelope keys with the legacy `dispatch()` output.

### Step 4 — Cross-check other SDKs (no regression expected)

- [ ] Run: `bun run test:integration:anthropic` and `bun run test:integration:gemini` — both should still pass unchanged (they don't touch `chat-completions/serve.ts`).

### Step 5 — Final commit (if any fixes were needed) + push

- [ ] If Step 3 forced fixes, commit them under `fix(gateway/chat-completions): align respond.ts with SDK expectations (spec2 part4)`.
- [ ] Final typecheck: `cd vnext/packages/gateway && bun x tsc --noEmit`

---

## Acceptance (matches Spec 2 §"Acceptance Checklist")

- [ ] `bun x tsc --noEmit` clean across `gateway`, `protocols`, `interceptor`
- [ ] `bun test` in `gateway` — zero new failures
- [ ] `bun test` in `protocols` — all green
- [ ] All Part 1-3 unit tests green (9 + 14 + 12 = 35)
- [ ] Part 4 unit test + integration test green (2 + 2 = 4)
- [ ] `bun run test:integration:openai` green
- [ ] `bun run test:integration:anthropic` / `:gemini` green (no regression on untouched endpoints)
- [ ] `chat-completions/serve.ts` no longer imports `dispatch` for the same-protocol path (still uses it via `dispatchFallback` for cross-protocol)
- [ ] `routes.ts` ≤40 lines (unchanged — Part 4 doesn't touch routes.ts)
- [ ] Zero modifications under `chat-flow/messages/`, `chat-flow/responses/`, `chat-flow/gemini/`, `chat-flow/count-tokens/`
- [ ] Zero modifications to `provider.fetch` signature, `runInterceptors` implementation, `ExecuteResult` type shape
- [ ] `runConversationAttempt` still exists and is still called by `dispatch.ts`
- [ ] Cross-protocol bridge works: a chat-completions request targeting a messages-only model still returns a valid response (via `dispatchFallback`)
- [ ] Every chat-completions request observed in the integration test sent `stream_options.include_usage: true` upstream

---

## Wrap-up

After Part 4 lands:

- Use **superpowers:finishing-a-development-branch** to verify tests, then merge / push / PR.
- Spec 3 (Messages endpoint migration) starts from the same template — clone this 4-part structure for that endpoint.
