import { test, expect, describe } from "bun:test"
import { parseGeminiStream } from "~/ui/dashboard-app/tabs/models/streams/gemini"

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) {
        c.close()
        return
      }
      c.enqueue(enc.encode(chunks[i++]!))
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const deltas: string[] = []
  let usage: { input_tokens: number; output_tokens: number } | null = null
  for await (const ch of parseGeminiStream(body)) {
    if (ch.type === "delta") deltas.push(ch.text)
    else usage = ch.usage
  }
  return { text: deltas.join(""), usage }
}

describe("parseGeminiStream", () => {
  test("emits text deltas from candidates.content.parts", async () => {
    const fixture = [
      `data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n`,
      `data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n`,
      `data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}]}\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("Hello!")
  })

  test("concatenates multiple parts within one chunk", async () => {
    const fixture = [
      `data: {"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("ab")
  })

  test("skips malformed JSON lines silently", async () => {
    const fixture = [
      `data: {not json}\n\n`,
      `data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("ok")
  })

  test("error payload throws", async () => {
    const fixture = [`data: {"error":{"message":"boom"}}\n\n`]
    await expect(collect(streamOf(fixture))).rejects.toThrow("boom")
  })

  test("reassembles data: line split across chunks", async () => {
    const fixture = [
      `data: {"candidates":[{"content":{"parts":[{"text":"spl`,
      `it"}]}}]}\n\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("split")
  })

  test("handles multi-byte UTF-8 split across chunks", async () => {
    const enc = new TextEncoder()
    const full = enc.encode(
      `data: {"candidates":[{"content":{"parts":[{"text":"中文"}]}}]}\n\n`,
    )
    const mid = 35
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
      `data: {"candidates":[{"content":{"parts":[{"text":"crlf"}]}}]}\r\n\r\n`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("crlf")
  })

  test("flushes trailing data: line without final newline", async () => {
    const fixture = [
      `data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n`,
      `data: {"candidates":[{"content":{"parts":[{"text":"b"}]}}]}`,
    ]
    expect((await collect(streamOf(fixture))).text).toBe("ab")
  })

  test("emits usage from usageMetadata after all deltas", async () => {
    const fixture = [
      `data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n`,
      `data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":34,"totalTokenCount":46}}\n\n`,
    ]
    const { text, usage } = await collect(streamOf(fixture))
    expect(text).toBe("hi")
    expect(usage).toEqual({ input_tokens: 12, output_tokens: 34 })
  })
})
