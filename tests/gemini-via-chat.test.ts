import { describe, expect, test } from "bun:test"

import {
  createChatToGeminiState,
  finalizeChatToGemini,
  translateChatCompletionsToGeminiResponse,
  translateChunkToGeminiResponses,
} from "~/translators/gemini-via-chat"
import { createChatToGeminiSSEStream } from "~/translators/gemini-via-chat/events"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/gemini/format-conversion"

function feedSSE(stream: ReadableStream<Uint8Array>, lines: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l))
      controller.close()
    },
  }).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
    }),
  ) // identity; actual transform is `stream` (placeholder param to silence lint)
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value)
  }
  return out
}

describe("gemini-via-chat: events state machine", () => {
  test("accumulates fragmented tool_call arguments and emits one functionCall", () => {
    const state = createChatToGeminiState()
    const mk = (
      delta: ChatCompletionChunk["choices"][number]["delta"],
      finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
    ): ChatCompletionChunk => ({
      id: "c", object: "chat.completion.chunk", created: 0, model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })

    translateChunkToGeminiResponses(state, mk({
      tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"q":' } }],
    }))
    translateChunkToGeminiResponses(state, mk({
      tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }],
    }))
    translateChunkToGeminiResponses(state, mk({}, "tool_calls"))

    const final = finalizeChatToGemini(state)
    expect(final?.candidates?.[0]?.finishReason).toBe("STOP")
    const parts = final?.candidates?.[0]?.content.parts ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({ functionCall: { name: "lookup", args: { q: "hi" } } })
  })

  test("text content emits a live candidate per chunk", () => {
    const state = createChatToGeminiState()
    const r1 = translateChunkToGeminiResponses(state, {
      id: "c", object: "chat.completion.chunk", created: 0, model: "m",
      choices: [{ index: 0, delta: { content: "He" }, finish_reason: null }],
    })
    const r2 = translateChunkToGeminiResponses(state, {
      id: "c", object: "chat.completion.chunk", created: 0, model: "m",
      choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }],
    })
    expect(r1[0]?.candidates?.[0]?.content.parts[0]).toEqual({ text: "He" })
    expect(r2[0]?.candidates?.[0]?.content.parts[0]).toEqual({ text: "llo" })
  })

  test("reasoning_text becomes a thought part", () => {
    const state = createChatToGeminiState()
    const r = translateChunkToGeminiResponses(state, {
      id: "c", object: "chat.completion.chunk", created: 0, model: "m",
      choices: [{ index: 0, delta: { reasoning_text: "ponder" } as unknown as ChatCompletionChunk["choices"][number]["delta"], finish_reason: null }],
    })
    expect(r[0]?.candidates?.[0]?.content.parts[0]).toEqual({ text: "ponder", thought: true } as unknown)
  })

  test("usage maps prompt/cached/reasoning tokens into Gemini metadata", () => {
    const state = createChatToGeminiState()
    translateChunkToGeminiResponses(state, {
      id: "c", object: "chat.completion.chunk", created: 0, model: "m",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 5 },
      } as unknown as ChatCompletionChunk["usage"],
    })
    const final = finalizeChatToGemini(state)
    expect(final?.usageMetadata).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
      cachedContentTokenCount: 30,
      thoughtsTokenCount: 5,
    } as unknown as typeof final["usageMetadata"])
  })

  test("length finish maps to MAX_TOKENS", () => {
    const state = createChatToGeminiState()
    translateChunkToGeminiResponses(state, {
      id: "c", object: "chat.completion.chunk", created: 0, model: "m",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: "length" }],
    })
    const final = finalizeChatToGemini(state)
    expect(final?.candidates?.[0]?.finishReason).toBe("MAX_TOKENS")
  })
})

describe("gemini-via-chat: SSE stream end-to-end", () => {
  test("translates a complete Chat Completions SSE into Gemini SSE", async () => {
    const transform = createChatToGeminiSSEStream()
    const chunks = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) controller.enqueue(enc.encode(c))
        controller.close()
      },
    })
    void feedSSE
    const piped = upstream.pipeThrough(transform)
    const text = await readAll(piped)
    const lines = text.split("\n\n").filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    const last = JSON.parse(lines.at(-1)!.replace(/^data: /, "")) as {
      candidates?: Array<{ finishReason?: string }>
      usageMetadata?: { totalTokenCount: number }
    }
    expect(last.candidates?.[0]?.finishReason).toBe("STOP")
    expect(last.usageMetadata?.totalTokenCount).toBe(5)
  })
})

describe("gemini-via-chat: response translator", () => {
  test("maps text + tool_calls into Gemini parts", () => {
    const resp: ChatCompletionResponse = {
      id: "r", object: "chat.completion", created: 1, model: "m",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "hi",
          tool_calls: [{ id: "c1", type: "function", function: { name: "do", arguments: '{"x":1}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }
    const out = translateChatCompletionsToGeminiResponse(resp, "m")
    const parts = out.candidates?.[0]?.content.parts ?? []
    expect(parts).toEqual([
      { text: "hi" },
      { functionCall: { name: "do", args: { x: 1 } } },
    ] as unknown as typeof parts)
    expect(out.candidates?.[0]?.finishReason).toBe("STOP")
    expect(out.usageMetadata?.totalTokenCount).toBe(7)
  })

  test("maps length finish to MAX_TOKENS", () => {
    const resp: ChatCompletionResponse = {
      id: "r", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "truncated" }, finish_reason: "length" }],
    }
    const out = translateChatCompletionsToGeminiResponse(resp, "m")
    expect(out.candidates?.[0]?.finishReason).toBe("MAX_TOKENS")
  })
})
