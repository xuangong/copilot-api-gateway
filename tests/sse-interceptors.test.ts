import { describe, expect, test } from "bun:test"

import {
  createChatWhitespaceAbortStream,
  createResponsesInterceptorStream,
} from "../src/transforms"

const enc = new TextEncoder()
const dec = new TextDecoder()

async function pipeStringThrough(
  input: string,
  transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(input))
      c.close()
    },
  })
  const reader = stream.pipeThrough(transform).getReader()
  let out = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value)
  }
  return out
}

describe("createResponsesInterceptorStream", () => {
  test("synchronizes output_item ID across added/done", async () => {
    const input
      = `event: response.output_item.added\ndata: ${JSON.stringify({ output_index: 0, item: { id: "msg_orig" } })}\n\n`
      + `event: response.output_item.done\ndata: ${JSON.stringify({ output_index: 0, item: { id: "msg_changed" } })}\n\n`
    const out = await pipeStringThrough(input, createResponsesInterceptorStream())
    expect(out).toContain('"id":"msg_orig"')
    expect(out).not.toContain('"id":"msg_changed"')
  })

  test("aborts when whitespace deltas exceed threshold", async () => {
    const frames: Array<string> = []
    // Accumulate >20 whitespace chars across many small deltas at output_index 0.
    for (let i = 0; i < 8; i++) {
      frames.push(
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ output_index: 0, delta: "\n\n\n" })}\n\n`,
      )
    }
    frames.push(
      `event: response.output_item.done\ndata: ${JSON.stringify({ output_index: 0, item: { id: "should_not_appear" } })}\n\n`,
    )
    const out = await pipeStringThrough(frames.join(""), createResponsesInterceptorStream())
    expect(out).toContain("event: error")
    expect(out).toContain("excessive whitespace")
    expect(out).not.toContain("should_not_appear")
  })

  test("passes through unrelated events", async () => {
    const input = `event: response.created\ndata: ${JSON.stringify({ id: "resp_1" })}\n\n`
    const out = await pipeStringThrough(input, createResponsesInterceptorStream())
    expect(out).toBe(input)
  })
})

describe("createChatWhitespaceAbortStream", () => {
  test("aborts when tool_calls function.arguments overflows whitespace", async () => {
    const frames: Array<string> = []
    for (let i = 0; i < 8; i++) {
      const chunk = {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "\n\n\n" } }] },
        }],
      }
      frames.push(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "should_not_appear" } }] })}\n\n`)
    const out = await pipeStringThrough(frames.join(""), createChatWhitespaceAbortStream())
    expect(out).toContain('"error"')
    expect(out).toContain("[DONE]")
    expect(out).not.toContain("should_not_appear")
  })

  test("passes through normal content deltas", async () => {
    const chunk = { choices: [{ index: 0, delta: { content: "hello" } }] }
    const input = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
    const out = await pipeStringThrough(input, createChatWhitespaceAbortStream())
    expect(out).toBe(input)
  })
})
