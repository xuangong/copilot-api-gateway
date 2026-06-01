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
    supportedEndpoints: ["chat_completions", "responses", "messages"],
    fetch: async (endpoint: string) => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      if (
        endpoint !== "chat_completions" &&
        endpoint !== "responses" &&
        endpoint !== "messages"
      ) {
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }
      return upstreamResponse
    },
  }),
}))

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
