# Streaming Usage All Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every real upstream streaming route records token usage even when the downstream client cancels before the terminal usage frame reaches the returned stream.

**Architecture:** Move usage extraction to an independent branch of the upstream SSE body before any downstream transform, heartbeat wrapper, filtering, or response return. Use `ReadableStream.tee()` plus existing `consumeStreamForUsage()` for all true upstream streaming paths, while leaving synthesized web-search replay streams on their existing non-streaming accounting path.

**Tech Stack:** Bun, TypeScript, Elysia route handlers, Web Streams, SSE, `bun:test`.

---

## File Structure

- Modify: `src/routes/responses/direct.ts`
  - Replace downstream `trackStreamingUsage()` on direct Responses stream with upstream `tee()` + `consumeStreamForUsage()`.
  - Keep native web-search SSE tap on the downstream/intercepted branch because it counts transformed Responses output items, not token usage.
- Modify: `src/routes/chat-completions-responses-fallback.ts`
  - Replace downstream `trackStreamingUsage()` with upstream `tee()` + `consumeStreamForUsage()` before Responses→Chat translation.
- Modify: `src/routes/messages/chat-completions-fallback.ts`
  - Replace downstream `trackStreamingUsage()` with upstream `tee()` + `consumeStreamForUsage()` before Chat→Messages translation.
- Modify: `src/routes/chat-completions.ts`
  - Replace downstream `trackStreamingUsage()` with upstream `tee()` + `consumeStreamForUsage()` before heartbeat, whitespace guard, optional injected-usage stripping.
- Modify: `src/routes/messages/direct.ts`
  - Replace downstream `trackStreamingUsage()` with upstream `tee()` + `consumeStreamForUsage()` before heartbeat and optional thinking stripping.
- Modify: `src/routes/responses/messages-fallback.ts`
  - Add upstream `tee()` + `consumeStreamForUsage()` before Messages→Responses translation.
- Modify: `src/routes/chat-completions-messages-fallback.ts`
  - Add upstream `tee()` + `consumeStreamForUsage()` before Messages→Chat translation.
- Modify: `src/routes/gemini-messages-fallback.ts`
  - Add upstream/heartbeated `tee()` + `consumeStreamForUsage()` before Messages→Gemini translation.
- Modify: `src/routes/gemini-responses-fallback.ts`
  - Add upstream/heartbeated `tee()` + `consumeStreamForUsage()` before Responses→Gemini translation.
- Modify: `tests/messages-gpt-stream-usage.test.ts`
  - Add a cancellation regression for `/v1/messages` via Chat Completions upstream.
- Modify: `tests/chat-completions-stream-usage.test.ts` (new file)
  - Cover direct Chat Completions cancellation and Chat→Responses fallback cancellation.
- Modify: `tests/responses-stream-usage.test.ts` (new file)
  - Cover direct Responses cancellation and Responses→Messages fallback usage tracking.
- Modify: `tests/gemini-stream-usage.test.ts` or add focused tests to an existing Gemini test file if helpers already exist.
  - Cover Gemini via Messages and Gemini via Responses streaming usage tracking.

## Task 1: Add reusable cancellation stream helpers in focused tests

**Files:**
- Modify: `tests/messages-gpt-stream-usage.test.ts`
- Create: `tests/chat-completions-stream-usage.test.ts`
- Create: `tests/responses-stream-usage.test.ts`

- [ ] **Step 1: Add delayed Chat Completions SSE helper to `tests/messages-gpt-stream-usage.test.ts`**

Add this helper after `delayedResponsesUsageStream()`:

```ts
function delayedChatUsageStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const timers: Array<ReturnType<typeof setTimeout>> = []

  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "chatcmpl_cancel",
        model: "gpt-4o",
        choices: [{ delta: { role: "assistant" } }],
      })}\n\n`))

      timers.push(setTimeout(() => {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          choices: [{ delta: { content: "hi" } }],
        })}\n\n`))
      }, 5))

      timers.push(setTimeout(() => {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 9,
            total_tokens: 51,
            prompt_tokens_details: { cached_tokens: 10 },
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

- [ ] **Step 2: Add messages via Chat cancellation regression**

Add this test inside `describe("GPT /v1/messages streaming fallbacks", () => { ... })` after `records usage from chat-completions upstream stream`:

```ts
test("records usage from chat-completions upstream even when downstream messages stream is canceled", async () => {
  const captured: CapturedUsage[] = []
  setRepoForTest(makeRepo(captured))
  upstreamResponse = new Response(delayedChatUsageStream())

  const { handleMessagesViaChatCompletions } = await import("~/routes/messages/chat-completions-fallback")
  const response = await handleMessagesViaChatCompletions(
    ctx() as never,
    { model: "gpt-4o", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] } as never,
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
    model: "gpt-4o",
    inputTokens: 32,
    outputTokens: 9,
    cacheReadTokens: 10,
    upstream: "copilot:123",
  })
})
```

- [ ] **Step 3: Create `tests/responses-stream-usage.test.ts` with direct Responses and Responses→Messages coverage**

Write this complete file:

```ts
import { afterEach, describe, expect, mock, test } from "bun:test"

import { setRepoForTest } from "~/repo"
import type { Repo } from "~/repo"

type CapturedUsage = {
  keyId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  upstream: string | null | undefined
}

let upstreamResponse: Response | null = null

mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    callMessages: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
    callResponses: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
  }),
}))

function responsesSse(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.enqueue(enc.encode("data: [DONE]\n\n"))
      c.close()
    },
  })
}

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

function messagesSse(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) return
  }
}

function makeRepo(captured: CapturedUsage[]): Repo {
  return {
    usage: {
      record: async (
        keyId: string,
        model: string,
        _hour: string,
        _requests: number,
        inputTokens: number,
        outputTokens: number,
        _client?: string,
        cacheReadTokens?: number,
        cacheCreationTokens?: number,
        upstream?: string | null,
      ) => {
        captured.push({
          keyId,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens ?? 0,
          cacheCreationTokens: cacheCreationTokens ?? 0,
          upstream,
        })
      },
    },
    apiKeys: { getById: async () => null, save: async () => {} },
    latency: { record: async () => {} },
    performance: { record: async () => {} },
    webSearchUsage: { record: async () => {} },
  } as unknown as Repo
}

function ctx() {
  return {
    state: {
      copilotToken: "token",
      accountType: "individual",
      tokenMiss: false,
      upstream: "copilot:123",
      enabledFlags: new Set<string>(),
    },
    apiKeyId: "key-1",
    colo: "local",
    requestId: "req-1",
    userAgent: "codex-cli",
    request: new Request("http://localhost/v1/responses"),
  }
}

afterEach(() => {
  upstreamResponse = null
  setRepoForTest(null)
})

describe("/v1/responses streaming usage", () => {
  test("records direct responses usage even when downstream stream is canceled", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(delayedResponsesUsageStream())

    const { handleDirectStreaming } = await import("~/routes/responses/direct")
    const response = await handleDirectStreaming(
      ctx() as never,
      { model: "gpt-5.5", stream: true, input: "hi" } as never,
      false,
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

  test("records messages upstream usage for responses via messages stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(messagesSse([
      { type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 15, cache_creation_input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]))

    const { handleResponsesViaMessages } = await import("~/routes/responses/messages-fallback")
    const response = await handleResponsesViaMessages(
      ctx() as never,
      { model: "claude-sonnet-4-6", stream: true, input: "hi" } as never,
      () => 0,
    )
    await drain(response)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      model: "claude-sonnet-4-6",
      inputTokens: 50,
      outputTokens: 8,
      cacheReadTokens: 15,
      cacheCreationTokens: 4,
      upstream: "copilot:123",
    })
  })
})
```

- [ ] **Step 4: Create `tests/chat-completions-stream-usage.test.ts` with direct and via-Responses coverage**

Write this complete file:

```ts
import { afterEach, describe, expect, mock, test } from "bun:test"

import { setRepoForTest } from "~/repo"
import type { Repo } from "~/repo"

type CapturedUsage = {
  keyId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  upstream: string | null | undefined
}

let upstreamResponse: Response | null = null

mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    callChatCompletions: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
    callResponses: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
  }),
}))

function delayedChatUsageStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const timers: Array<ReturnType<typeof setTimeout>> = []
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "chatcmpl_cancel",
        model: "gpt-4o",
        choices: [{ delta: { role: "assistant" } }],
      })}\n\n`))
      timers.push(setTimeout(() => {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`))
      }, 5))
      timers.push(setTimeout(() => {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 70,
            completion_tokens: 12,
            total_tokens: 82,
            prompt_tokens_details: { cached_tokens: 20 },
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

function makeRepo(captured: CapturedUsage[]): Repo {
  return {
    usage: {
      record: async (
        keyId: string,
        model: string,
        _hour: string,
        _requests: number,
        inputTokens: number,
        outputTokens: number,
        _client?: string,
        cacheReadTokens?: number,
        cacheCreationTokens?: number,
        upstream?: string | null,
      ) => {
        captured.push({
          keyId,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens ?? 0,
          cacheCreationTokens: cacheCreationTokens ?? 0,
          upstream,
        })
      },
    },
    apiKeys: { getById: async () => null, save: async () => {} },
    latency: { record: async () => {} },
    performance: { record: async () => {} },
    webSearchUsage: { record: async () => {} },
  } as unknown as Repo
}

function ctx(body: unknown = {}) {
  return {
    state: {
      copilotToken: "token",
      accountType: "individual",
      tokenMiss: false,
      upstream: "copilot:123",
      enabledFlags: new Set<string>(),
    },
    body,
    apiKeyId: "key-1",
    colo: "local",
    requestId: "req-1",
    userAgent: "openai-node",
    request: new Request("http://localhost/v1/chat/completions"),
  }
}

afterEach(() => {
  upstreamResponse = null
  setRepoForTest(null)
})

describe("/v1/chat/completions streaming usage", () => {
  test("records direct chat usage even when downstream stream is canceled", async () => {
    const captured: CapturedUsage[] = []
    const body = { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(delayedChatUsageStream())

    const { chatCompletionsRoute } = await import("~/routes/chat-completions")
    const response = await chatCompletionsRoute.handle(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), ctx(body) as never)

    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      model: "gpt-4o",
      inputTokens: 50,
      outputTokens: 12,
      cacheReadTokens: 20,
      upstream: "copilot:123",
    })
  })

  test("records responses upstream usage for chat completions via responses even when downstream stream is canceled", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(delayedResponsesUsageStream())

    const { handleChatCompletionsViaResponses } = await import("~/routes/chat-completions-responses-fallback")
    const response = await handleChatCompletionsViaResponses(
      ctx() as never,
      { model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] } as never,
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
})
```

- [ ] **Step 5: Run new/changed focused tests and confirm failures before implementation**

Run:

```bash
bun test tests/messages-gpt-stream-usage.test.ts tests/chat-completions-stream-usage.test.ts tests/responses-stream-usage.test.ts
```

Expected before implementation:
- The existing messages→responses cancellation test passes.
- New cancellation tests for direct Responses, Chat→Responses, Messages→Chat, and direct Chat fail with `captured` length `0`.
- Responses→Messages stream usage test fails with `captured` length `0`.

## Task 2: Fix direct Responses streaming usage

**Files:**
- Modify: `src/routes/responses/direct.ts`

- [ ] **Step 1: Change usage import**

Replace:

```ts
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Tee upstream body before heartbeat/interceptor**

In `handleDirectStreaming()`, replace the block from `const heartbeated = wrapOpenAIHeartbeat(response.body)` through `const intercepted = ...` with:

```ts
let responseBody = response.body
if (apiKeyId && responseBody) {
  const [usageBranch, forwardBranch] = responseBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  responseBody = forwardBranch
}

const heartbeated = wrapOpenAIHeartbeat(responseBody)
const intercepted = heartbeated
  ? heartbeated.pipeThrough(createResponsesInterceptorStream())
  : null
```

- [ ] **Step 3: Return stream without downstream usage wrapper**

Replace the final return:

```ts
return apiKeyId ? trackStreamingUsage(streamResponse, apiKeyId, model, client, state.upstream) : streamResponse
```

with:

```ts
return streamResponse
```

- [ ] **Step 4: Run Responses focused tests**

Run:

```bash
bun test tests/responses-stream-usage.test.ts
```

Expected after this task:
- Direct Responses cancellation test passes.
- Responses→Messages stream usage test may still fail until Task 6.

## Task 3: Fix Chat Completions via Responses streaming usage

**Files:**
- Modify: `src/routes/chat-completions-responses-fallback.ts`

- [ ] **Step 1: Change usage import**

Replace:

```ts
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Tee upstream Responses stream before translation**

Replace:

```ts
const usageTracked = apiKeyId
  ? trackStreamingUsage(upstream, apiKeyId, model, client, state.upstream)
  : upstream
const translated = usageTracked.body?.pipeThrough(createResponsesToChatCompletionsStream(model))
```

with:

```ts
let translateBody = upstream.body
if (apiKeyId && translateBody) {
  const [usageBranch, responseBranch] = translateBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  translateBody = responseBranch
}
const translated = translateBody?.pipeThrough(createResponsesToChatCompletionsStream(model))
```

- [ ] **Step 3: Run Chat Completions focused tests**

Run:

```bash
bun test tests/chat-completions-stream-usage.test.ts
```

Expected after this task:
- Chat→Responses cancellation test passes.
- Direct Chat cancellation test may still fail until Task 5.

## Task 4: Fix Messages via Chat Completions streaming usage

**Files:**
- Modify: `src/routes/messages/chat-completions-fallback.ts`

- [ ] **Step 1: Change usage import**

Replace:

```ts
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Tee upstream Chat stream before translation**

Replace:

```ts
const usageTracked = apiKeyId
  ? trackStreamingUsage(upstream, apiKeyId, model, client, state.upstream)
  : upstream
const translated = usageTracked.body?.pipeThrough(createChatCompletionsToMessagesStream(model))
```

with:

```ts
let translateBody = upstream.body
if (apiKeyId && translateBody) {
  const [usageBranch, responseBranch] = translateBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  translateBody = responseBranch
}
const translated = translateBody?.pipeThrough(createChatCompletionsToMessagesStream(model))
```

- [ ] **Step 3: Run Messages GPT focused tests**

Run:

```bash
bun test tests/messages-gpt-stream-usage.test.ts
```

Expected after this task:
- Existing messages→responses cancellation test still passes.
- New messages→chat cancellation test passes.
- Existing non-cancel usage tests still pass.

## Task 5: Fix direct Chat Completions streaming usage

**Files:**
- Modify: `src/routes/chat-completions.ts`

- [ ] **Step 1: Change usage import**

Replace:

```ts
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Tee upstream Chat stream before heartbeat and guard**

In the direct `if (payload.stream === true)` branch, replace:

```ts
const heartbeated = wrapOpenAIHeartbeat(response.body)
```

with:

```ts
let responseBody = response.body
if (apiKeyId && responseBody) {
  const [usageBranch, forwardBranch] = responseBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, payload.model, client, state.upstream)
  responseBody = forwardBranch
}
const heartbeated = wrapOpenAIHeartbeat(responseBody)
```

- [ ] **Step 3: Remove downstream usage wrapper**

Replace:

```ts
const tracked = apiKeyId
  ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client, state.upstream)
  : streamResponse

if (clientWantsUsage) {
  return tracked
}

return new Response(stripInjectedUsageChunk(tracked.body!), {
  status: tracked.status,
  headers: tracked.headers,
})
```

with:

```ts
if (clientWantsUsage) {
  return streamResponse
}

return new Response(stripInjectedUsageChunk(streamResponse.body!), {
  status: streamResponse.status,
  headers: streamResponse.headers,
})
```

- [ ] **Step 4: Run Chat Completions focused tests**

Run:

```bash
bun test tests/chat-completions-stream-usage.test.ts
```

Expected: all tests in this file pass.

## Task 6: Fix direct Messages streaming usage

**Files:**
- Modify: `src/routes/messages/direct.ts`

- [ ] **Step 1: Change usage import**

Replace:

```ts
import { trackNonStreamingUsage, trackStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Tee upstream Messages stream before heartbeat/thinking strip**

Replace:

```ts
let heartbeated = wrapAnthropicHeartbeat(response.body)
```

with:

```ts
let responseBody = response.body
if (apiKeyId && responseBody) {
  const [usageBranch, forwardBranch] = responseBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, payload.model, client, state.upstream)
  responseBody = forwardBranch
}
let heartbeated = wrapAnthropicHeartbeat(responseBody)
```

- [ ] **Step 3: Return stream without downstream usage wrapper**

Replace:

```ts
return apiKeyId
  ? trackStreamingUsage(streamResponse, apiKeyId, payload.model, client, state.upstream)
  : streamResponse
```

with:

```ts
return streamResponse
```

- [ ] **Step 4: Run existing usage tracker and messages tests**

Run:

```bash
bun test tests/usage-tracker.test.ts tests/messages-gpt-stream-usage.test.ts
```

Expected: all tests pass.

## Task 7: Add/fix Messages-upstream fallback streaming usage

**Files:**
- Modify: `src/routes/responses/messages-fallback.ts`
- Modify: `src/routes/chat-completions-messages-fallback.ts`

- [ ] **Step 1: Add `consumeStreamForUsage` import to `responses/messages-fallback.ts`**

Replace:

```ts
import { trackNonStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 2: Tee Messages upstream body in `responses/messages-fallback.ts`**

Replace:

```ts
const translated = upstream.body?.pipeThrough(createMessagesToResponsesStream(model))
```

with:

```ts
let translateBody = upstream.body
if (apiKeyId && translateBody) {
  const [usageBranch, responseBranch] = translateBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  translateBody = responseBranch
}
const translated = translateBody?.pipeThrough(createMessagesToResponsesStream(model))
```

- [ ] **Step 3: Add `consumeStreamForUsage` import to `chat-completions-messages-fallback.ts`**

Replace:

```ts
import { trackNonStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 4: Tee Messages upstream body in `chat-completions-messages-fallback.ts`**

Replace:

```ts
const translated = upstream.body?.pipeThrough(
  createMessagesToChatCompletionsStream(model),
)
```

with:

```ts
let translateBody = upstream.body
if (apiKeyId && translateBody) {
  const [usageBranch, responseBranch] = translateBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  translateBody = responseBranch
}
const translated = translateBody?.pipeThrough(
  createMessagesToChatCompletionsStream(model),
)
```

- [ ] **Step 5: Run Responses focused tests**

Run:

```bash
bun test tests/responses-stream-usage.test.ts tests/chat-completions-via-messages.test.ts
```

Expected: all tests pass, including the new Responses→Messages stream usage test.

## Task 8: Add/fix Gemini fallback streaming usage

**Files:**
- Modify: `src/routes/gemini-messages-fallback.ts`
- Modify: `src/routes/gemini-responses-fallback.ts`
- Modify or create: `tests/gemini-stream-usage.test.ts`

- [ ] **Step 1: Add focused Gemini streaming usage tests**

Create `tests/gemini-stream-usage.test.ts` with this complete file:

```ts
import { afterEach, describe, expect, mock, test } from "bun:test"

import { setRepoForTest } from "~/repo"
import type { Repo } from "~/repo"

type CapturedUsage = {
  keyId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  upstream: string | null | undefined
}

let upstreamResponse: Response | null = null

mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    callMessages: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
    callResponses: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
  }),
}))

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.enqueue(enc.encode("data: [DONE]\n\n"))
      c.close()
    },
  })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) return
  }
}

function makeRepo(captured: CapturedUsage[]): Repo {
  return {
    usage: {
      record: async (
        keyId: string,
        model: string,
        _hour: string,
        _requests: number,
        inputTokens: number,
        outputTokens: number,
        _client?: string,
        cacheReadTokens?: number,
        cacheCreationTokens?: number,
        upstream?: string | null,
      ) => {
        captured.push({
          keyId,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens ?? 0,
          cacheCreationTokens: cacheCreationTokens ?? 0,
          upstream,
        })
      },
    },
    apiKeys: { getById: async () => null, save: async () => {} },
    latency: { record: async () => {} },
    performance: { record: async () => {} },
  } as unknown as Repo
}

function ctx() {
  return {
    state: {
      copilotToken: "token",
      accountType: "individual",
      tokenMiss: false,
      upstream: "copilot:123",
      enabledFlags: new Set<string>(),
    },
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    apiKeyId: "key-1",
    colo: "local",
    requestId: "req-1",
    userAgent: "google-genai",
  }
}

afterEach(() => {
  upstreamResponse = null
  setRepoForTest(null)
})

describe("Gemini fallback streaming usage", () => {
  test("records messages upstream usage for Gemini via messages stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(sse([
      { type: "message_start", message: { usage: { input_tokens: 60, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 13 } },
      { type: "message_stop" },
    ]))

    const { handleGeminiViaMessages } = await import("~/routes/gemini-messages-fallback")
    const response = await handleGeminiViaMessages(ctx() as never, "claude-sonnet-4-6", { kind: "stream", useSSE: true }, () => 0)
    await drain(response)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      model: "claude-sonnet-4-6",
      inputTokens: 60,
      outputTokens: 13,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      upstream: "copilot:123",
    })
  })

  test("records responses upstream usage for Gemini via responses stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(sse([
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hi" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "message" }],
          usage: {
            input_tokens: 90,
            output_tokens: 16,
            input_tokens_details: { cached_tokens: 40 },
          },
        },
      },
    ]))

    const { handleGeminiViaResponses } = await import("~/routes/gemini-responses-fallback")
    const response = await handleGeminiViaResponses(ctx() as never, "gpt-5.5", { kind: "stream", useSSE: true }, () => 0)
    await drain(response)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      model: "gpt-5.5",
      inputTokens: 50,
      outputTokens: 16,
      cacheReadTokens: 40,
      upstream: "copilot:123",
    })
  })
})
```

- [ ] **Step 2: Run Gemini focused test and verify it fails before route changes**

Run:

```bash
bun test tests/gemini-stream-usage.test.ts
```

Expected before implementation: both tests fail with `captured` length `0`.

- [ ] **Step 3: Import `consumeStreamForUsage` in `gemini-messages-fallback.ts`**

Replace:

```ts
import { trackNonStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 4: Tee Gemini via Messages stream before translator pipe**

Replace:

```ts
const heartbeated = mode.useSSE
  ? wrapOpenAIHeartbeat(upstream.body)
  : upstream.body
if (heartbeated) {
  heartbeated.pipeTo(pipe.writable).catch(() => {})
}
```

with:

```ts
const heartbeated = mode.useSSE
  ? wrapOpenAIHeartbeat(upstream.body)
  : upstream.body
let pipeBody = heartbeated
if (apiKeyId && pipeBody) {
  const [usageBranch, responseBranch] = pipeBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  pipeBody = responseBranch
}
if (pipeBody) {
  pipeBody.pipeTo(pipe.writable).catch(() => {})
}
```

- [ ] **Step 5: Import `consumeStreamForUsage` in `gemini-responses-fallback.ts`**

Replace:

```ts
import { trackNonStreamingUsage } from "~/middleware/usage"
```

with:

```ts
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
```

- [ ] **Step 6: Tee Gemini via Responses stream before translator pipe**

Replace:

```ts
const heartbeated = mode.useSSE
  ? wrapOpenAIHeartbeat(upstream.body)
  : upstream.body
if (heartbeated) {
  heartbeated.pipeTo(pipe.writable).catch(() => {})
}
```

with:

```ts
const heartbeated = mode.useSSE
  ? wrapOpenAIHeartbeat(upstream.body)
  : upstream.body
let pipeBody = heartbeated
if (apiKeyId && pipeBody) {
  const [usageBranch, responseBranch] = pipeBody.tee()
  consumeStreamForUsage(usageBranch, apiKeyId, model, client, state.upstream)
  pipeBody = responseBranch
}
if (pipeBody) {
  pipeBody.pipeTo(pipe.writable).catch(() => {})
}
```

- [ ] **Step 7: Run Gemini focused test**

Run:

```bash
bun test tests/gemini-stream-usage.test.ts
```

Expected: all tests pass.

## Task 9: Full focused verification

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: Run all focused streaming usage tests**

Run:

```bash
bun test tests/messages-gpt-stream-usage.test.ts tests/chat-completions-stream-usage.test.ts tests/responses-stream-usage.test.ts tests/gemini-stream-usage.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run shared usage tracker tests**

Run:

```bash
bun test tests/usage-tracker.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run adjacent translator tests**

Run:

```bash
bun test tests/chat-completions-via-responses.test.ts tests/messages-via-chat-completions.test.ts tests/responses-via-messages.test.ts tests/gemini-via-messages.test.ts tests/gemini-via-responses.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run type checking**

Run:

```bash
bun run typecheck
```

Expected: TypeScript exits successfully with no type errors.

## Task 10: Final review

**Files:**
- Review all modified route files and new/modified tests.

- [ ] **Step 1: Confirm every real upstream stream has independent usage consumption**

Run:

```bash
grep -rn "trackStreamingUsage" src/routes src/middleware --include="*.ts"
```

Expected: only `src/middleware/usage.ts` defines `trackStreamingUsage`; no route imports or calls it.

- [ ] **Step 2: Confirm all `consumeStreamForUsage` route call sites are before downstream transforms**

Run:

```bash
grep -rn "consumeStreamForUsage" src/routes --include="*.ts"
```

Expected: every call appears immediately after a `tee()` of the upstream or heartbeated upstream stream and before `pipeThrough()`, `pipeTo()`, `stripInjectedUsageChunk()`, or response return.

- [ ] **Step 3: Confirm no synthesized web-search stream was changed to stream tracking**

Review:

```bash
git diff -- src/routes/messages/web-search.ts src/routes/responses/web-search.ts src/routes/gemini.ts
```

Expected: no change to the synchronous web-search replay accounting paths except any unrelated Gemini fallback import/route changes in `src/routes/gemini.ts` should be absent.

- [ ] **Step 4: Review full diff**

Run:

```bash
git diff -- src/routes tests
```

Expected: only route usage-tracking changes and focused regression tests are present. No migrations, pricing changes, dashboard changes, or historical usage backfill scripts.

## Self-Review

- Spec coverage: This plan covers every route found during debugging that either used downstream `trackStreamingUsage()` or had no streaming usage extraction on a real upstream stream. Synthesized web-search streams remain on non-streaming accounting.
- Placeholder scan: No TBD/TODO/fill-later placeholders remain; each code-changing step includes exact replacement code.
- Type consistency: All new route calls use the existing `consumeStreamForUsage(upstreamBody, keyId, model, client, upstream)` signature and keep existing `trackNonStreamingUsage` behavior unchanged.
