/**
 * Composition tests for gemini-via-responses: pumps a minimal Responses SSE
 * through createResponsesToGeminiSSEStream and asserts the resulting Gemini
 * SSE carries text + finishReason + usage.
 *
 * Also exercises translateResponsesToGeminiResponse on a non-streaming reply.
 */

import { describe, expect, test } from "bun:test"

import {
  createResponsesToGeminiSSEStream,
  translateResponsesToGeminiResponse,
} from "~/translators/gemini-via-responses"

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

describe("gemini-via-responses: SSE composition", () => {
  test("translates a Responses SSE stream into Gemini SSE", async () => {
    const pipe = createResponsesToGeminiSSEStream()
    const events = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-5" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi", output_index: 0 })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      })}\n\n`,
    ]
    const enc = new TextEncoder()
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(e))
        controller.close()
      },
    })
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
    const joined = frames
      .flatMap((f) => f.candidates ?? [])
      .flatMap((c) => c.content.parts.map((p) => p.text ?? ""))
      .join("")
    expect(joined).toContain("Hi")
    const last = frames.at(-1)!
    expect(last.candidates?.[0]?.finishReason).toBe("STOP")
    expect(last.usageMetadata?.promptTokenCount).toBe(4)
    expect(last.usageMetadata?.totalTokenCount).toBe(5)
  })
})

describe("gemini-via-responses: thinking round-trip", () => {
  test("Responses reasoning_summary_text SSE surfaces as Gemini thought parts", async () => {
    const pipe = createResponsesToGeminiSSEStream()
    const events = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-5" } })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "Pondering",
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: " deeply",
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.done", output_index: 0 })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Done", output_index: 1 })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 4, output_tokens: 7, total_tokens: 11 },
        },
      })}\n\n`,
    ]
    const enc = new TextEncoder()
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(e))
        controller.close()
      },
    })
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
    expect(thoughtText).toBe("Pondering deeply")
    expect(visibleText).toContain("Done")
  })
})

describe("gemini-via-responses: response composition", () => {
  test("maps text-only Responses reply into Gemini parts + usage", () => {
    const responsesResp = {
      id: "resp_1",
      model: "gpt-5",
      created_at: 1700,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3,
      },
    }
    const out = translateResponsesToGeminiResponse(
      responsesResp as unknown as Parameters<
        typeof translateResponsesToGeminiResponse
      >[0],
      "gpt-5",
    )
    expect(out.candidates?.[0]?.content.parts[0]).toEqual({ text: "hello" })
    expect(out.usageMetadata?.promptTokenCount).toBe(2)
    expect(out.usageMetadata?.candidatesTokenCount).toBe(1)
    expect(out.usageMetadata?.totalTokenCount).toBe(3)
  })

  test("non-streaming reasoning summary surfaces as thought part", () => {
    const responsesResp = {
      id: "resp_2",
      model: "gpt-5",
      created_at: 1700,
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "Step 1" },
            { type: "summary_text", text: " then step 2" },
          ],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "final" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
    }
    const out = translateResponsesToGeminiResponse(
      responsesResp as unknown as Parameters<
        typeof translateResponsesToGeminiResponse
      >[0],
      "gpt-5",
    )
    const parts = out.candidates?.[0]?.content.parts ?? []
    const thought = parts.find(
      (p) => (p as { thought?: boolean }).thought === true,
    ) as { text?: string } | undefined
    expect(thought?.text).toBe("Step 1 then step 2")
    const visible = parts.find(
      (p) => (p as { thought?: boolean }).thought !== true && "text" in p,
    ) as { text?: string } | undefined
    expect(visible?.text).toBe("final")
  })
})
