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
})
