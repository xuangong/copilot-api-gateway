# Messages Responses Stream Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `/v1/messages` requests routed to the Responses upstream record `gpt-5.x` streaming token usage even when the downstream Anthropic stream is canceled before the terminal usage frame reaches the client.

**Architecture:** The streaming fallback will decouple usage extraction from the client response pipeline. It will `tee()` the raw upstream Responses SSE body: one branch is consumed by `consumeStreamForUsage()` for best-effort usage persistence, while the other branch is translated to Anthropic Messages SSE and returned to the client.

**Tech Stack:** Bun, TypeScript, Elysia route handlers, Web Streams, SSE, `bun:test`.

---

## File Structure

- Modify: `tests/messages-gpt-stream-usage.test.ts`
  - Add a regression test that cancels the downstream Anthropic response before the upstream `response.completed` frame is emitted.
  - The test should fail before the route change because `trackStreamingUsage()` is tied to the canceled downstream pipeline.
- Modify: `src/routes/messages/responses-fallback.ts`
  - Replace streaming-path `trackStreamingUsage()` usage with `consumeStreamForUsage()` on a `tee()` branch of the raw upstream body.
  - Keep non-streaming usage tracking unchanged.
  - Keep latency recording unchanged because latency measures upstream response start, not terminal token accounting.

## Task 1: Add the regression test

**Files:**
- Modify: `tests/messages-gpt-stream-usage.test.ts`

- [ ] **Step 1: Add a delayed upstream Responses SSE helper**

Add this helper after the existing `sse(events: unknown[])` helper in `tests/messages-gpt-stream-usage.test.ts`:

```ts
function delayedResponsesUsageStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const timers: Array<ReturnType<typeof setTimeout>> = []

  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_cancel", model: "gpt-5.5" },
      })}\n\n`))

      timers.push(setTimeout(() => {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "hi",
        })}\n\n`))
      }, 5))

      timers.push(setTimeout(() => {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "message" }],
            usage: {
              input_tokens: 80,
              output_tokens: 11,
              input_tokens_details: { cached_tokens: 48 },
            },
          },
        })}\n\n`))
        c.enqueue(enc.encode("data: [DONE]\n\n"))
        c.close()
      }, 10))
    },
    cancel() {
      for (const timer of timers) clearTimeout(timer)
    },
  })
}
```

- [ ] **Step 2: Add the failing cancellation test**

Add this test inside `describe("GPT /v1/messages streaming fallbacks", () => { ... })`, after the existing `records usage from responses upstream stream` test:

```ts
test("records usage from responses upstream even when downstream messages stream is canceled", async () => {
  const captured: CapturedUsage[] = []
  setRepoForTest(makeRepo(captured))
  upstreamResponse = new Response(delayedResponsesUsageStream())

  const { handleMessagesViaResponses } = await import("~/routes/messages/responses-fallback")
  const response = await handleMessagesViaResponses(
    ctx() as never,
    { model: "gpt-5.5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] } as never,
    () => 0,
  )

  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  await reader.cancel()

  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(captured).toHaveLength(1)
  expect(captured[0]).toMatchObject({
    keyId: "key-1",
    model: "gpt-5.5",
    inputTokens: 32,
    outputTokens: 11,
    cacheReadTokens: 48,
    upstream: "copilot:123",
  })
})
```

- [ ] **Step 3: Run the test file and verify the new test fails**

Run:

```bash
bun test tests/messages-gpt-stream-usage.test.ts
```

Expected result before implementation: the new cancellation test fails with `expect(captured).toHaveLength(1)` because `captured` remains empty. Existing tests in the file may pass.

## Task 2: Decouple streaming usage extraction from downstream consumption

**Files:**
- Modify: `src/routes/messages/responses-fallback.ts`

- [ ] **Step 1: Change the usage import**

Replace this import:

```ts
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Replace the streaming usage pipeline**

In `handleMessagesViaResponses()`, replace the streaming branch code that creates `usageTracked`, `translated`, and `heartbeated`:

```ts
const usageTracked = apiKeyId
  ? trackStreamingUsage(upstream, apiKeyId, model, client, state.upstream)
  : upstream

// Pipe: upstream Responses bytes → translator (already frame-aware) →
// Anthropic heartbeat wrapper for client-side keepalive.
const translated = usageTracked.body?.pipeThrough(createResponsesToMessagesStream())
const heartbeated = wrapAnthropicHeartbeat(translated ?? null)
```

with:

```ts
let translateBody = upstream.body
if (apiKeyId && translateBody) {
  const [usageBranch, responseBranch] = translateBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  translateBody = responseBranch
}

const translated = translateBody?.pipeThrough(createResponsesToMessagesStream())
const heartbeated = wrapAnthropicHeartbeat(translated ?? null)
```

- [ ] **Step 3: Remove the stale streaming usage comment**

Delete this stale comment block from the same streaming branch because usage will now be handled by the independent `consumeStreamForUsage()` branch:

```ts
// Streaming usage extraction lives in middleware/usage and is wired
// for native Anthropic SSE — since we produced the SSE ourselves above
// and already know it terminates with message_delta + usage, defer
// exact accounting to non-stream sync (which still goes through
// trackNonStreamingUsage). For now, just stream.
```

- [ ] **Step 4: Run the focused regression test file and verify it passes**

Run:

```bash
bun test tests/messages-gpt-stream-usage.test.ts
```

Expected result after implementation: all tests in `tests/messages-gpt-stream-usage.test.ts` pass, including the cancellation regression.

## Task 3: Run adjacent usage verification

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: Run usage tracker tests**

Run:

```bash
bun test tests/usage-tracker.test.ts
```

Expected result: all tests pass. This verifies the shared `consumeStreamForUsage()` and `trackStreamingUsage()` semantics were not broken.

- [ ] **Step 2: Run both focused test files together**

Run:

```bash
bun test tests/messages-gpt-stream-usage.test.ts tests/usage-tracker.test.ts
```

Expected result: all tests pass.

- [ ] **Step 3: Run TypeScript type checking**

Run:

```bash
bun run typecheck
```

Expected result: TypeScript exits successfully with no type errors.

## Task 4: Final review

**Files:**
- Review: `src/routes/messages/responses-fallback.ts`
- Review: `tests/messages-gpt-stream-usage.test.ts`

- [ ] **Step 1: Confirm the fix is scoped**

Check that only the confirmed route path changed:

```bash
git diff -- src/routes/messages/responses-fallback.ts tests/messages-gpt-stream-usage.test.ts
```

Expected result: the diff only adds the cancellation regression test and replaces the streaming usage path with `tee() + consumeStreamForUsage()` in `messages/responses-fallback.ts`.

- [ ] **Step 2: Confirm no historical backfill was added**

Review the diff and verify there is no migration, no SQL update, and no script attempting to reconstruct missing token usage from latency. The missing terminal usage data is not recoverable from existing latency rows.

- [ ] **Step 3: Report verification evidence**

When reporting completion, include the exact commands run and whether they passed:

```text
bun test tests/messages-gpt-stream-usage.test.ts
bun test tests/usage-tracker.test.ts
bun test tests/messages-gpt-stream-usage.test.ts tests/usage-tracker.test.ts
bun run typecheck
```

## Self-Review

- Spec coverage: The plan covers the approved design: only `messages → responses` streaming fallback changes, usage is extracted from an independent upstream branch, latency remains unchanged, and no historical backfill is attempted.
- Placeholder scan: No placeholders, TODOs, or unspecified test steps remain.
- Type consistency: The plan consistently uses the existing `consumeStreamForUsage(upstreamBody, keyId, model, client, upstream)` signature and existing `CapturedUsage` shape.
