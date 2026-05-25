/**
 * Composition tests for gemini-via-messages: pumps a minimal Messages SSE
 * stream through createMessagesToGeminiSSEStream and asserts the resulting
 * Gemini SSE carries the expected text + finishReason + usage.
 *
 * Also exercises translateMessagesToGeminiResponse on a non-streaming reply.
 */

import { describe, expect, test } from "bun:test"

import {
  createMessagesToGeminiSSEStream,
  translateMessagesToGeminiResponse,
} from "~/translators/gemini-via-messages"

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

function feedSSE(lines: Array<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      controller.close()
    },
  })
}

describe("gemini-via-messages: SSE composition", () => {
  test("translates a complete Messages SSE into Gemini SSE", async () => {
    const pipe = createMessagesToGeminiSSEStream("claude-sonnet-4-6")
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]

    const upstream = feedSSE(events)
    upstream.pipeTo(pipe.writable).catch(() => {})
    const text = await readAll(pipe.readable)
    const frames = text
      .split("\n\n")
      .filter((s) => s.startsWith("data: "))
      .map((s) => JSON.parse(s.slice("data: ".length)) as {
        candidates?: Array<{
          content: { parts: Array<{ text?: string }> }
          finishReason?: string
        }>
        usageMetadata?: { totalTokenCount?: number; promptTokenCount?: number }
      })
    expect(frames.length).toBeGreaterThan(0)
    const joinedText = frames
      .flatMap((f) => f.candidates ?? [])
      .flatMap((c) => c.content.parts.map((p) => p.text ?? ""))
      .join("")
    expect(joinedText).toContain("Hi")
    expect(joinedText).toContain("there")
    const last = frames.at(-1)!
    expect(last.candidates?.[0]?.finishReason).toBe("STOP")
    expect(last.usageMetadata?.promptTokenCount).toBe(7)
  })
})

describe("gemini-via-messages: thinking round-trip", () => {
  test("Messages thinking SSE surfaces as Gemini thought parts", async () => {
    const pipe = createMessagesToGeminiSSEStream("claude-sonnet-4-6")
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" about it"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const upstream = feedSSE(events)
    upstream.pipeTo(pipe.writable).catch(() => {})
    const text = await readAll(pipe.readable)
    const frames = text
      .split("\n\n")
      .filter((s) => s.startsWith("data: "))
      .map((s) => JSON.parse(s.slice("data: ".length)) as {
        candidates?: Array<{
          content: { parts: Array<{ text?: string; thought?: boolean }> }
        }>
      })
    const allParts = frames
      .flatMap((f) => f.candidates ?? [])
      .flatMap((c) => c.content.parts)
    const thoughtText = allParts
      .filter((p) => p.thought === true)
      .map((p) => p.text ?? "")
      .join("")
    const visibleText = allParts
      .filter((p) => p.thought !== true && p.text)
      .map((p) => p.text ?? "")
      .join("")
    expect(thoughtText).toBe("Let me think about it")
    expect(visibleText).toContain("Answer")
  })
})

describe("gemini-via-messages: response composition", () => {
  test("maps text content + usage into Gemini response", () => {
    const messagesResp = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 1 },
    }
    const out = translateMessagesToGeminiResponse(
      messagesResp as unknown as Parameters<
        typeof translateMessagesToGeminiResponse
      >[0],
      "claude-sonnet-4-6",
    )
    expect(out.candidates?.[0]?.content.parts[0]).toEqual({ text: "hello" })
    expect(out.candidates?.[0]?.finishReason).toBe("STOP")
    expect(out.usageMetadata?.promptTokenCount).toBe(4)
    expect(out.usageMetadata?.candidatesTokenCount).toBe(1)
  })

  test("non-streaming thinking block surfaces as thought part", () => {
    const messagesResp = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "thinking", thinking: "internal monologue" },
        { type: "text", text: "visible" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    }
    const out = translateMessagesToGeminiResponse(
      messagesResp as unknown as Parameters<
        typeof translateMessagesToGeminiResponse
      >[0],
      "claude-sonnet-4-6",
    )
    const parts = out.candidates?.[0]?.content.parts ?? []
    const thought = parts.find(
      (p) => (p as { thought?: boolean }).thought === true,
    ) as { text?: string } | undefined
    expect(thought?.text).toBe("internal monologue")
    const visible = parts.find(
      (p) => (p as { thought?: boolean }).thought !== true && "text" in p,
    ) as { text?: string } | undefined
    expect(visible?.text).toBe("visible")
  })
})
