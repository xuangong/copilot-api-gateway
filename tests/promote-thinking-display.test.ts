/**
 * Unit tests for promote-thinking-display transform and the matching
 * SSE thinking-delta stripper.
 */
import { describe, test, expect } from "bun:test"

import {
  promoteThinkingDisplayForStreaming,
  type AnthropicMessagesPayload,
} from "../src/transforms"
import { omitThinkingFromAnthropicSse } from "../src/lib/anthropic-sse-thinking-strip"

function basePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" },
    ...overrides,
  }
}

describe("promoteThinkingDisplayForStreaming", () => {
  test("promotes omitted → summarized for Claude 4.5 streaming", () => {
    const p = basePayload()
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(true)
    expect(r.originalDisplay).toBe("omitted")
    expect(p.thinking?.display).toBe("summarized")
  })

  test("promotes omitted → summarized for Claude 4.6", () => {
    const p = basePayload({ model: "claude-opus-4-6" })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(true)
    expect(p.thinking?.display).toBe("summarized")
  })

  test("promotes when display is unspecified", () => {
    const p = basePayload({
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(true)
    expect(p.thinking?.display).toBe("summarized")
  })

  test("no-op for non-streaming", () => {
    const p = basePayload({ stream: false })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(false)
    expect(p.thinking?.display).toBe("omitted")
  })

  test("no-op when no thinking", () => {
    const p = basePayload({ thinking: undefined })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(false)
  })

  test("no-op for Claude 4.7+ (handled separately)", () => {
    const p = basePayload({ model: "claude-sonnet-4-7" })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(false)
    expect(p.thinking?.display).toBe("omitted")
  })

  test("no-op for non-Claude / earlier models", () => {
    const p = basePayload({ model: "claude-sonnet-4" })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(false)
  })

  test("no-op if client already asked for summarized", () => {
    const p = basePayload({
      thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
    })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(false)
    expect(p.thinking?.display).toBe("summarized")
  })

  test("no-op if client asked for full", () => {
    const p = basePayload({
      thinking: { type: "enabled", budget_tokens: 1024, display: "full" },
    })
    const r = promoteThinkingDisplayForStreaming(p)
    expect(r.promoted).toBe(false)
    expect(p.thinking?.display).toBe("full")
  })
})

// --- SSE stripper -----------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

function frame(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe("omitThinkingFromAnthropicSse", () => {
  test("drops thinking_delta but preserves signature_delta + envelope", async () => {
    const input =
      frame("message_start", { type: "message_start" }) +
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "secret reasoning" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " more reasoning" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "abc=" },
      }) +
      frame("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }) +
      frame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello" },
      }) +
      frame("content_block_stop", { type: "content_block_stop", index: 1 }) +
      frame("message_stop", { type: "message_stop" })

    const result = await readAll(
      streamOf(input).pipeThrough(omitThinkingFromAnthropicSse()),
    )

    expect(result).not.toContain("secret reasoning")
    expect(result).not.toContain("more reasoning")
    expect(result).toContain("signature_delta")
    expect(result).toContain("abc=")
    expect(result).toContain("Hello")
    expect(result).toContain("content_block_start")
    expect(result).toContain("content_block_stop")
    expect(result).toContain("message_start")
    expect(result).toContain("message_stop")
  })

  test("does not touch text_delta in non-thinking blocks", async () => {
    const input =
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "regular reply" },
      }) +
      frame("content_block_stop", { type: "content_block_stop", index: 0 })

    const result = await readAll(
      streamOf(input).pipeThrough(omitThinkingFromAnthropicSse()),
    )
    expect(result).toContain("regular reply")
  })

  test("handles split chunks (frames concatenated across chunk boundaries)", async () => {
    const full =
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }) +
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "DROPME" },
      }) +
      frame("content_block_stop", { type: "content_block_stop", index: 0 })

    // Split the byte stream at the boundary between two frames (legal because
    // the upstream heartbeat wrapper guarantees this alignment in production).
    const splitAt = full.indexOf("\n\n") + 2
    const a = full.slice(0, splitAt)
    const b = full.slice(splitAt)

    const result = await readAll(
      streamOf(a, b).pipeThrough(omitThinkingFromAnthropicSse()),
    )
    expect(result).not.toContain("DROPME")
  })
})
