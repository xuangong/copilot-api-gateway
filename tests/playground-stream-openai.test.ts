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

async function collect(body: ReadableStream<Uint8Array>) {
  const deltas: string[] = []
  let usage: { input_tokens: number; output_tokens: number } | null = null
  for await (const ch of parseOpenAIStream(body)) {
    if (ch.type === "delta") deltas.push(ch.text)
    else usage = ch.usage
  }
  return { text: deltas.join(""), usage }
}

describe("parseOpenAIStream", () => {
  test("emits text deltas from data: lines and stops on [DONE]", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"!"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("Hello!")
  })

  test("skips malformed JSON lines silently", async () => {
    const fixture = [
      `data: {not json}\n\n`,
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("ok")
  })

  test("error payload throws", async () => {
    const fixture = [`data: {"error":{"message":"boom"}}\n\n`]
    await expect(collect(streamOf(fixture))).rejects.toThrow("boom")
  })

  test("reassembles data: line split across chunks", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"con`,
      `tent":"split"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("split")
  })

  test("handles multi-byte UTF-8 split across chunks", async () => {
    const enc = new TextEncoder()
    const full = enc.encode(`data: {"choices":[{"delta":{"content":"中文"}}]}\n\ndata: [DONE]\n\n`)
    const mid = 30
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(full.slice(0, mid))
        c.enqueue(full.slice(mid))
        c.close()
      },
    })
    expect((await collect(stream)).text).toBe("中文")
  })

  test("handles CRLF line endings", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n`,
      `data: [DONE]\r\n\r\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("crlf")
  })

  test("flushes trailing data: line without final newline", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"a"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"b"}}]}`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("ab")
  })

  test("emits usage chunk when present", async () => {
    const fixture = [
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const { text, usage } = await collect(streamOf(fixture))
    expect(text).toBe("hi")
    expect(usage).toEqual({ input_tokens: 12, output_tokens: 34 })
  })
})
