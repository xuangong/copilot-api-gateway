# Spec 6 — Part 3: messages + responses wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan part-by-part.

**Goal:** Cut the `messages` and `responses` source attempts over to `traverseTranslation`. Wire each source `respond.ts` non-streaming branch to consult `translateBody`. Land integration tests for case §6.2.2 (responses → chat_completions) and a messages cross-protocol case.

**Depends on:** Part 1 (helper, types). Part 2 is independent at code level (different `attempt.ts` files) but is the proven pattern — replicate it.

**Architecture:** Mirror Part 2's pattern for `messages/attempt.ts` and `responses/attempt.ts`: replace 501 with `traverseTranslation`, merge `inheritedHeaders` into `Invocation`, honor `snapshotMode`, update `respond.ts` to use `translateBody`. The two attempts can be tackled in parallel by separate subagents.

**Tech Stack:** TypeScript, Bun.

---

## Task 1: messages — inheritedHeaders runtime usage + snapshotMode no-op

**Spec ref:** §3.5

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`
- Modify (test): `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.test.ts`

- [ ] **Step 1: Write the failing test** — same shape as Part 2 Task 1, asserting `inheritedHeaders` flows into the upstream provider request.

- [ ] **Step 2: Edit `messages/attempt.ts`** in the `generate` function. Change the `Invocation` literal at line 265:

```ts
const invocation: Invocation = {
  endpoint: 'messages',
  enabledFlags: new Set(),
  sourceApi: 'messages',
  payload: args.payload as Record<string, unknown>,
  headers: { ...(args.inheritedHeaders ?? {}) },
}
```

- [ ] **Step 3: Verify** `snapshotMode` is a no-op for messages (per §3.5 — "other protocols ignore the hint"). No code change required; document this in a 1-line comment near the args destructure.

- [ ] **Step 4: Run** the test, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.test.ts
git commit -m "feat(gateway/messages): merge inheritedHeaders into invocation"
```

---

## Task 2: messages — replace 501 with `traverseTranslation` + respond.ts translateBody

**Spec ref:** §3.4, §3.7

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/messages/events/reassemble.ts`
- Test: `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.cross.test.ts` (new)
- Test: `vnext/packages/gateway/src/data-plane/chat-flow/messages/respond.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (cross-protocol attempt + respond.ts translateBody, same shape as Part 2)

- [ ] **Step 2: Replace the 501 short-circuit** at `messages/attempt.ts:254-263`:

```ts
if (sel.targetEndpoint !== 'messages') {
  const hubAttempt = (args.hubAttemptOverride ?? pickHubAttempt)(sel.targetEndpoint)
  return await traverseTranslation({
    sourcePayload: args.payload as Record<string, unknown>,
    sourceProtocol: 'messages',
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

Add imports + `hubAttemptOverride` field (mirror Part 2 Task 2).

- [ ] **Step 3: Update `messages/respond.ts` non-streaming branch** to consult `translateBody`:

```ts
if (!ctx.stream) {
  const hubProtocol = result.modelIdentity.translatorPair?.hub ?? 'messages'
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

- [ ] **Step 4: Update `messages/events/reassemble.ts`** to accept optional `hubProtocol`:

```ts
export async function reassembleEventsToJson(
  events: AsyncIterable<unknown>,
  hubProtocol: 'chat_completions' | 'messages' | 'responses' = 'messages',
): Promise<unknown> {
  switch (hubProtocol) {
    case 'messages': return reassembleMessagesEventsToJsonImpl(events as never)
    case 'chat_completions': return reassembleChatCompletionsEventsToJson(events as never)
    case 'responses': return reassembleResponsesEventsToJson(events as never)
  }
}
```

- [ ] **Step 5: Run** all messages tests + typecheck.

```bash
bun test vnext/packages/gateway/src/data-plane/chat-flow/messages/
bun typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/messages/
git commit -m "feat(gateway/messages): route cross-protocol via traverseTranslation; respond.ts honors translateBody"
```

---

## Task 3: responses — inheritedHeaders + `snapshotMode === 'none'` skip

**Spec ref:** §3.5

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`
- Modify (test): `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.test.ts`

- [ ] **Step 1: Write failing tests**:
  1. `inheritedHeaders` flows into upstream provider request (same as Tasks 1 / Part 2).
  2. `snapshotMode === 'none'` skips the snapshot-sidecar write.

For test #2, locate the snapshot-sidecar write site in `responses/attempt.ts` (search for `snapshot` or related). Stub it so the test can assert it was not called when `snapshotMode === 'none'`.

- [ ] **Step 2: Edit `responses/attempt.ts`**.

In the `Invocation` literal:

```ts
const invocation: Invocation = {
  endpoint: 'responses',
  enabledFlags: new Set(),
  sourceApi: 'responses',
  payload: args.payload as Record<string, unknown>,
  headers: { ...(args.inheritedHeaders ?? {}) },
}
```

In the snapshot-sidecar write site (wherever `responses` writes its snapshot):

```ts
if (args.snapshotMode !== 'none') {
  // existing snapshot write logic
}
```

(If the snapshot logic doesn't yet exist in vNext — Spec 3 telemetry channel only added stream telemetry, not snapshots — this part is a no-op. Document with a 1-line comment: `// snapshotMode is reserved for future snapshot sidecar (spec 6 §3.5)`.)

- [ ] **Step 3: Run** the tests, expect PASS.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.test.ts
git commit -m "feat(gateway/responses): merge inheritedHeaders; honor snapshotMode='none'"
```

---

## Task 4: responses — replace 501 with `traverseTranslation`

**Spec ref:** §3.4

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`
- Test: `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.cross.test.ts` (new)

- [ ] **Step 1: Write failing tests** (cross-protocol attempt invokes hub via traverseTranslation, telemetryPair stamped).

- [ ] **Step 2: Replace 501** at `responses/attempt.ts:216-225`:

```ts
if (sel.targetEndpoint !== 'responses') {
  const hubAttempt = (args.hubAttemptOverride ?? pickHubAttempt)(sel.targetEndpoint)
  return await traverseTranslation({
    sourcePayload: args.payload as Record<string, unknown>,
    sourceProtocol: 'responses',
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
    requestId: args.requestId,
    userAgent: args.userAgent,
    signal: args.ctx.downstreamAbortSignal,
    fallbackMaxOutputTokens: (sel.binding as { upstreamMaxOutputTokens?: number }).upstreamMaxOutputTokens,
    model: sel.bareModel,
  })
}
```

Note `requestId` and `userAgent` flow through — `responses/attempt.ts` is the only one that exposes them in its args today, and the image-generation shortcut already ran before this branch.

- [ ] **Step 3: Run** tests + typecheck.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.cross.test.ts
git commit -m "feat(gateway/responses): route cross-protocol via traverseTranslation"
```

---

## Task 5: responses — respond.ts translateBody for non-streaming

**Spec ref:** §3.7

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/respond.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/events/reassemble.ts`
- Test: `vnext/packages/gateway/src/data-plane/chat-flow/responses/respond.test.ts` (extend)

- [ ] **Step 1: Write failing test** (responses non-streaming with `translateBody` set produces source-shaped JSON, not hub).

- [ ] **Step 2: Edit `respond.ts`** non-streaming branch (mirror Part 2 Task 4 pattern with `hubProtocol` default `'responses'`).

- [ ] **Step 3: Edit `events/reassemble.ts`** to accept optional `hubProtocol` (mirror Part 2 Task 4).

- [ ] **Step 4: Run** tests, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/responses/
git commit -m "feat(gateway/responses): respond.ts uses translateBody for cross-protocol non-streaming"
```

---

## Task 6: Integration test — responses → chat_completions

**Spec ref:** §6.2 case 2

**Files:**
- Create: `vnext/tests/integration/cross-protocol/responses-to-cc.test.ts`
- Create: `vnext/tests/integration/cross-protocol/messages-to-other.test.ts` (covers messages → cc and messages → responses)

- [ ] **Step 1: Identify** a `chat_completions`-only-upstream model for the responses → cc case. Per the spec, `gpt-4.1` should work.

- [ ] **Step 2: Write `responses-to-cc.test.ts`**

```ts
import { test, expect } from 'bun:test'

const BASE = process.env.TEST_API_BASE_URL ?? 'http://localhost:8787'
const MODEL = 'gpt-4.1'  // chat_completions-only upstream

test('responses → cc non-streaming returns 200', async () => {
  const res = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false,
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.output).toBeDefined()
})

test('responses → cc streaming returns 200 with SSE', async () => {
  const res = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('response.completed')
})
```

- [ ] **Step 3: Write `messages-to-other.test.ts`** — exercise messages source against both a `chat_completions`-only and a `responses`-only upstream.

- [ ] **Step 4: Run** integration suite (`bun run local` in another terminal first).

```bash
bun test vnext/tests/integration/cross-protocol/responses-to-cc.test.ts
bun test vnext/tests/integration/cross-protocol/messages-to-other.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vnext/tests/integration/cross-protocol/responses-to-cc.test.ts vnext/tests/integration/cross-protocol/messages-to-other.test.ts
git commit -m "test(integration): responses → cc + messages cross-protocol cases"
```

---

## Part 3 exit gate

- [ ] `messages/attempt.ts` and `responses/attempt.ts` no longer contain 501 short-circuits — `grep -rn 'cross-protocol attempts not yet supported' vnext/packages/gateway/` returns 0 lines (after Part 2 already removed the cc one)
- [ ] §6.2 case 2 (responses → cc, both stream modes) passes
- [ ] Messages cross-protocol cases pass for both stream modes
- [ ] All existing messages + responses unit tests pass
- [ ] `bun typecheck` clean

Move to Part 4.
