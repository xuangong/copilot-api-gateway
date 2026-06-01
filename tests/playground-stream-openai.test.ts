import { test, expect, describe } from "bun:test"
import { parseOpenAIStream } from "~/ui/dashboard-app/tabs/models/streams/openai"

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) {
        c.close()
        return
      }
      c.enqueue(enc.encode(chunks[i++]))
    },
  })
}

describe("parseOpenAIStream", () => {
  test("emits text deltas from data: lines and stops on [DONE]", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"!"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("Hello!")
  })

  test("skips malformed JSON lines silently", async () => {
    const fixture = [
      `data: {not json}\n\n`,
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("ok")
  })

  test("error payload throws", async () => {
    const fixture = [`data: {"error":{"message":"boom"}}\n\n`]
    await expect(async () => {
      for await (const _ of parseOpenAIStream(streamOf(fixture))) { void _ }
    }).toThrow("boom")
  })

  test("reassembles data: line split across chunks", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"con`,
      `tent":"split"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("split")
  })

  test("handles multi-byte UTF-8 split across chunks", async () => {
    const enc = new TextEncoder()
    const full = enc.encode(`data: {"choices":[{"delta":{"content":"中文"}}]}\n\ndata: [DONE]\n\n`)
    const mid = 30
    const a = full.slice(0, mid)
    const b = full.slice(mid)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(a)
        c.enqueue(b)
        c.close()
      },
    })
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(stream)) deltas.push(d)
    expect(deltas.join("")).toBe("中文")
  })

  test("handles CRLF line endings", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n`,
      `data: [DONE]\r\n\r\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("crlf")
  })

  test("flushes trailing data: line without final newline", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"a"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"b"}}]}`,
    ]
    const deltas: string[] = []
    for await (const d of parseOpenAIStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("ab")
  })
})
