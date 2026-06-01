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

    const { handleChatCompletions } = await import("~/routes/chat-completions")
    const response = await handleChatCompletions(ctx(body) as never)

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
