import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"

import { invalidateUpstreamListCache } from "~/providers/registry"
import { setRepoForTest } from "~/repo"
import type { Repo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"

type CapturedUsage = {
  keyId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  upstream: string | null | undefined
}

const originalFetch = globalThis.fetch

function modelsResponse(ids: string[]): Response {
  return Response.json({
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      name: id,
      vendor: id.startsWith("claude-") ? "Anthropic" : "OpenAI",
      version: id,
      model_picker_enabled: true,
      preview: false,
      capabilities: {
        family: id.startsWith("claude-") ? "claude" : "gpt",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })),
  })
}

function installFetchMock(modelIds: string[], upstreamBody: ReadableStream<Uint8Array>): void {
  globalThis.fetch = mock(async (url: RequestInfo | URL) => {
    const href = String(url)
    if (href.endsWith("/models")) return modelsResponse(modelIds)
    if (
      href.endsWith("/chat/completions") ||
      href.endsWith("/responses") ||
      href.endsWith("/v1/messages") ||
      href.endsWith("/v1/messages/count_tokens")
    ) {
      return new Response(upstreamBody)
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

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

beforeEach(() => {
  setRepoForTest(new SqliteRepo(new Database(":memory:")))
  invalidateUpstreamListCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setRepoForTest(null)
  invalidateUpstreamListCache()
})

describe("Gemini fallback streaming usage", () => {
  test("records messages upstream usage for Gemini via messages stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    installFetchMock(["claude-sonnet-4-6"], sse([
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
      model: "claude-sonnet-4.6",
      inputTokens: 60,
      outputTokens: 13,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      upstream: "copilot:request",
    })
  })

  test("records responses upstream usage for Gemini via responses stream", async () => {
    const captured: CapturedUsage[] = []
    setRepoForTest(makeRepo(captured))
    installFetchMock(["gpt-5.5"], sse([
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
      upstream: "copilot:request",
    })
  })
})
