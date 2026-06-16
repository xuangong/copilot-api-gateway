# Spec 6 — Part 2: chat-completions wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan part-by-part.

**Goal:** Cut the `chat_completions` source attempt over to `traverseTranslation` for cross-protocol targets. Wire the source `respond.ts` non-streaming path to consult `result.translateBody`. Land integration tests for cases §6.2.1 (cc → responses) and §6.2.3 (cc → messages).

**Depends on:** Part 1 complete (helper, types, error class).

**Architecture:** Replace the 501 short-circuit at `chat-completions/attempt.ts:79-88` with a `traverseTranslation` call. Honor `args.inheritedHeaders` and `args.snapshotMode` when present (this attempt is also called as inner from messages/responses sources in Part 3). Update `chat-completions/respond.ts` non-streaming branch to use `translateBody` when set.

**Tech Stack:** TypeScript, Bun.

---

## Task 1: Add `inheritedHeaders` runtime usage in chat-completions attempt

**Spec ref:** §3.5

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`
- Modify (test): `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.test.ts`

- [ ] **Step 1: Write the failing test** that asserts inherited headers reach the upstream provider request

```ts
// attempt.test.ts (append)
import { test, expect } from 'bun:test'
import { chatCompletionsAttempt } from './attempt.ts'

test('inheritedHeaders are merged into invocation before terminal', async () => {
  const captured: Record<string, string> = {}
  // Stub selectBinding to return a fake provider that records headers
  const fakeProvider = {
    fetch: async (req: { headers: Headers }) => {
      req.headers.forEach((v, k) => { captured[k] = v })
      return { status: 200, headers: new Headers(), body: new ReadableStream() }
    },
    getPricingForModelKey: () => null,
  }
  // ... build a minimal MessagesAttemptArgs with `inheritedHeaders: { 'x-trace-id': 'abc' }`
  //     and assert captured['x-trace-id'] === 'abc'
})
```

(Adapt the stub to whatever shape the existing `attempt.test.ts` uses for `selectBinding`. The point is: when `args.inheritedHeaders` is set, `invocation.headers` ← merged value before terminal runs.)

- [ ] **Step 2: Run** the test, expect FAIL (header not propagated).

- [ ] **Step 3: Edit `chat-completions/attempt.ts`** in the `generate` function, just after the `Invocation` literal:

```ts
const invocation: Invocation = {
  endpoint: 'chat_completions',
  enabledFlags: new Set(),
  sourceApi: 'chat_completions',
  payload: args.payload as Record<string, unknown>,
  headers: { ...(args.inheritedHeaders ?? {}) },
}
```

(This sets inherited headers as the baseline; downstream interceptors can still override.)

- [ ] **Step 4: Run** the test, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.test.ts
git commit -m "feat(gateway/chat-completions): merge inheritedHeaders into invocation"
```

---

## Task 2: Replace 501 with `traverseTranslation` in chat-completions

**Spec ref:** §3.4

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`
- Test: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.cross.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// attempt.cross.test.ts
import { test, expect, mock } from 'bun:test'
import { chatCompletionsAttempt } from './attempt.ts'

test('cross-protocol cc → responses dispatches via traverseTranslation', async () => {
  // Stub selectBinding so that targetEndpoint = 'responses', returning a stub translator
  // Stub responsesAttempt.generate (via dependency injection or by spying on
  // pickHubAttempt) to return a known eventResult.
  // Assert: result.modelIdentity.translatorPair = { source: 'chat_completions', hub: 'responses' }
  // Assert: result.type === 'events'
})

test('cross-protocol cc → messages returns 501-replacement events with translatorPair', async () => {
  // Same shape, but targetEndpoint = 'messages'.
})
```

(Use the existing `attempt.test.ts` patterns for stubbing `selectBinding` — pass `args.selectBinding` directly. For the inner attempt, prefer injecting a fake by exporting a `__forTest_setHubAttemptOverride` setter, or restructure the attempt to accept `args.hubAttemptOverride`. Pick the lighter-touch option: extend `ChatCompletionsAttemptArgs` with `readonly hubAttemptOverride?: (p: HubAttemptProtocol) => typeof chatCompletionsAttempt` for testability — production code falls back to `pickHubAttempt`.)

- [ ] **Step 2: Run** the test, expect FAIL (still hits 501 branch).

- [ ] **Step 3: Replace the 501 short-circuit**

In `chat-completions/attempt.ts`, replace lines 79-88 (`if (sel.targetEndpoint !== 'chat_completions') { ... }`) with:

```ts
if (sel.targetEndpoint !== 'chat_completions') {
  const hubAttempt = (args.hubAttemptOverride ?? pickHubAttempt)(sel.targetEndpoint)
  return await traverseTranslation({
    sourcePayload: args.payload as Record<string, unknown>,
    sourceProtocol: 'chat_completions',
    hubProtocol: sel.targetEndpoint,
    translator: sel.translator,
    innerAttempt: async (innerArgs) => {
      return (await hubAttempt.generate({
        payload: innerArgs.payload as never,
        auth: innerArgs.auth as never,
        ctx: { downstreamAbortSignal: innerArgs.signal } as never,
        telemetryCtx: innerArgs.inheritedTelemetryCtx,
        inheritedHeaders: innerArgs.inheritedHeaders,
        snapshotMode: innerArgs.snapshotMode,
      } as never)) as never
    },
    inheritedHeaders: args.inheritedHeaders ?? {},
    inheritedTelemetryCtx: args.telemetryCtx,
    auth: args.auth,
    signal: args.ctx.downstreamAbortSignal,
    fallbackMaxOutputTokens: (sel.binding as { upstreamMaxOutputTokens?: number }).upstreamMaxOutputTokens,
    model: sel.bareModel,
  })
}
```

Add imports at top:

```ts
import { traverseTranslation } from '../shared/traverse-translation.ts'
import { pickHubAttempt, type HubAttemptProtocol } from '../shared/hub-attempt-dispatch.ts'
```

Add to `ChatCompletionsAttemptArgs`:

```ts
readonly hubAttemptOverride?: (p: HubAttemptProtocol) => { generate: (a: never) => Promise<never> }
```

- [ ] **Step 4: Run** the test, expect PASS for both cases.

- [ ] **Step 5: Run** `bun typecheck` and existing `attempt.test.ts`

Expected: PASS — identity-target path is unchanged.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.cross.test.ts
git commit -m "feat(gateway/chat-completions): route cross-protocol attempts through traverseTranslation"
```

---

## Task 3: Verify `respond.ts` streaming path works with translatorPair

**Spec ref:** §3.7 (streaming portion is no-op; this task confirms)

**Files:**
- Read-only verify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`

- [ ] **Step 1: Read `respond.ts`** end to end. Confirm the streaming branch consumes `result.events` and emits SSE without inspecting `modelIdentity` shape — the new `translatorPair` field is additive and has no streaming impact.

- [ ] **Step 2: If the streaming branch already passes events through unmodified**, no edit needed; document in this task: "verified, no change."

- [ ] **Step 3: If the streaming branch type-narrows `modelIdentity`**, widen the type to accept the new optional field. Adjust as needed.

(Most likely outcome: no change. The SSE encoder in vNext consumes only `events` + `finalMetadata`; modelIdentity is plumbed to telemetry only.)

---

## Task 4: Update chat-completions `respond.ts` non-streaming branch for translateBody

**Spec ref:** §3.7

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`
- Modify (test): `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// respond.test.ts (append)
test('non-streaming uses translateBody when present', async () => {
  // Build an EventResult with:
  //   - events: hub-protocol frames (e.g., responses frames)
  //   - modelIdentity.translatorPair = { source: 'chat_completions', hub: 'responses' }
  //   - translateBody: (hubJson) => ({ id: 'cc-shaped', from: hubJson })
  // Call chatCompletionsRespond(result, { stream: false, ... }).
  // Assert: response body JSON has shape `{ id: 'cc-shaped', ... }`, NOT the
  // raw responses-shaped JSON.
})
```

- [ ] **Step 2: Run** the test, expect FAIL.

- [ ] **Step 3: Edit `respond.ts`** non-streaming branch.

Locate the branch that today reassembles events to source JSON. Wrap it:

```ts
if (!ctx.stream) {
  const hubProtocol = result.modelIdentity.translatorPair?.hub ?? 'chat_completions'
  const reassembled = await reassembleEventsToJson(result.events, hubProtocol)
  const finalJson = result.translateBody
    ? await result.translateBody(reassembled, {
        signal: ctx.signal,
        fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
        model: result.modelIdentity.model,
      })
    : reassembled
  return jsonResponse(finalJson, finalizeTelemetry(result))
}
```

If `reassembleEventsToJson` doesn't yet accept a `hubProtocol` argument, add an optional second parameter that switches the reassembly state machine to the hub's frame taxonomy. For Part 2, the hub options are `messages` and `responses` — both already have reassemblers that can be reused.

Concrete change for `events/reassemble.ts`:

```ts
// chat-completions/events/reassemble.ts (or wherever it lives)
import { reassembleMessagesEventsToJson } from '../../messages/events/reassemble.ts'
import { reassembleResponsesEventsToJson } from '../../responses/events/reassemble.ts'

export async function reassembleEventsToJson(
  events: AsyncIterable<unknown>,
  hubProtocol: 'chat_completions' | 'messages' | 'responses' = 'chat_completions',
): Promise<unknown> {
  switch (hubProtocol) {
    case 'chat_completions': return reassembleChatCompletionsEventsToJsonImpl(events as never)
    case 'messages': return reassembleMessagesEventsToJson(events as never)
    case 'responses': return reassembleResponsesEventsToJson(events as never)
  }
}
```

- [ ] **Step 4: Run** the test, expect PASS.

- [ ] **Step 5: Run** `bun test vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/`

Expected: PASS for all chat-completions tests.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.test.ts vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/reassemble.ts
git commit -m "feat(gateway/chat-completions): respond.ts uses translateBody for cross-protocol non-streaming"
```

---

## Task 5: Drop in fallback for unknown frame from translator-error

**Spec ref:** §3.3 (translator iterator error handling)

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts` (or its frame encoder)

- [ ] **Step 1: Add a guard** in the SSE encoder so a `kind: 'translator-error'` frame from `traverseTranslation` is rendered as a final OpenAI-shaped error chunk (`{ error: { message } }`) instead of silently terminating.

```ts
// in the SSE event loop:
if ((frame as { kind?: string }).kind === 'translator-error') {
  yield encodeSSEError(frame as { error: string })
  return
}
```

- [ ] **Step 2: Add a unit test** for the guard.

- [ ] **Step 3: Run** tests, commit.

```bash
git commit -m "feat(gateway/chat-completions): render translator-error frame as terminal SSE error chunk"
```

---

## Task 6: Integration tests — cc → responses, cc → messages

**Spec ref:** §6.2 cases 1, 3

**Files:**
- Create: `vnext/tests/integration/cross-protocol/cc-to-responses.test.ts`
- Create: `vnext/tests/integration/cross-protocol/cc-to-messages.test.ts`

- [ ] **Step 1: Identify** a chat_completions-source / responses-only-upstream model in the binding table.

```bash
grep -rn "endpoints" vnext/packages/gateway/src/control-plane/upstreams/ | head -20
```

Use the spec's example: `gpt-5.4-mini` (responses-only). If the binding table doesn't have it on the test fixture, pick any model whose upstream config exposes only `responses`. Document the chosen model at the top of the test file.

- [ ] **Step 2: Write `cc-to-responses.test.ts`**

```ts
import { test, expect, beforeAll } from 'bun:test'

const BASE = process.env.TEST_API_BASE_URL ?? 'http://localhost:8787'
const MODEL = 'gpt-5.4-mini'  // responses-only upstream

test('cc → responses non-streaming returns 200', async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.choices?.[0]?.message).toBeDefined()
})

test('cc → responses streaming returns 200 with SSE chunks', async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('data:')
  expect(text).toContain('[DONE]')
})
```

- [ ] **Step 3: Write `cc-to-messages.test.ts`** (analogous, using `claude-3-7` or whatever messages-upstream model is configured).

- [ ] **Step 4: Run integration tests** (requires `bun run local` running locally)

```bash
# Terminal 1
bun run local
# Terminal 2
bun test vnext/tests/integration/cross-protocol/cc-to-responses.test.ts
bun test vnext/tests/integration/cross-protocol/cc-to-messages.test.ts
```

Expected: PASS, both stream and non-stream variants for both cases.

- [ ] **Step 5: Run** `bun typecheck` + targeted unit tests

```bash
bun typecheck
bun test vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vnext/tests/integration/cross-protocol/
git commit -m "test(integration): cc → responses + cc → messages cross-protocol cases"
```

---

## Part 2 exit gate

- [ ] `chat-completions/attempt.ts` no longer contains the 501 short-circuit (`grep` confirms 1 fewer site)
- [ ] §6.2 case 1 (cc → responses, both stream modes) passes
- [ ] §6.2 case 3 (cc → messages, both stream modes) passes
- [ ] All existing chat-completions unit tests still pass
- [ ] `bun typecheck` clean

Move to Part 3.
