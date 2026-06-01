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
    supportedEndpoints: ["chat_completions", "responses"],
    fetch: async (endpoint: string) => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      if (endpoint !== "chat_completions" && endpoint !== "responses") {
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }
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
    apiKeys: {
      getById: async () => null,
      save: async () => {},
    },
    latency: {
      record: async () => {},
    },
    performance: {
      record: async () => {},
    },
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
    userAgent: "claude-code",
    request: new Request("http://localhost/v1/messages"),
  }
}

afterEach(() => {
  upstreamResponse = null
  setRepoForTest(null)
})

describe("GPT /v1/messages streaming fallbacks", () => {
  test("records usage from chat-completions upstream stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(sse([
      { id: "chatcmpl_1", model: "gpt-4o", choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 } },
    ]))

    const { handleMessagesViaChatCompletions } = await import("~/routes/messages/chat-completions-fallback")
    const response = await handleMessagesViaChatCompletions(
      ctx() as never,
      { model: "gpt-4o", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] } as never,
      () => 0,
    )
    await drain(response)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      model: "gpt-4o",
      inputTokens: 42,
      outputTokens: 9,
      upstream: "copilot:123",
    })
  })

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

  test("records usage from responses upstream stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    upstreamResponse = new Response(sse([
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hi" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "message" }],
          usage: {
            input_tokens: 50,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 30 },
          },
        },
      },
    ]))

    const { handleMessagesViaResponses } = await import("~/routes/messages/responses-fallback")
    const response = await handleMessagesViaResponses(
      ctx() as never,
      { model: "gpt-5.4", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] } as never,
      () => 0,
    )
    await drain(response)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      model: "gpt-5.4",
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 30,
      upstream: "copilot:123",
    })
  })

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

  test("records usage from chat-completions responses fallback stream", async () => {
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
            input_tokens: 80,
            output_tokens: 11,
            input_tokens_details: { cached_tokens: 48 },
          },
        },
      },
    ]))

    const { handleChatCompletionsViaResponses } = await import("~/routes/chat-completions-responses-fallback")
    const response = await handleChatCompletionsViaResponses(
      ctx() as never,
      { model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] } as never,
      () => 0,
    )
    await drain(response)
    await new Promise((resolve) => setTimeout(resolve, 20))

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
