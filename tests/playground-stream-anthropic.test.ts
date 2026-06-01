import { test, expect, describe } from "bun:test"
import { parseAnthropicStream } from "~/ui/dashboard-app/tabs/models/streams/anthropic"

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

describe("parseAnthropicStream", () => {
  test("emits text from content_block_delta until message_stop", async () => {
    const fixture = [
      `event: message_start\ndata: {"type":"message_start"}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseAnthropicStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("Hi there")
  })

  test("event: error throws with message", async () => {
    const fixture = [
      `event: error\ndata: {"type":"error","error":{"message":"nope"}}\n\n`,
    ]
    await expect(async () => {
      for await (const _ of parseAnthropicStream(streamOf(fixture))) { void _ }
    }).toThrow("nope")
  })

  test("reassembles event/data across chunks", async () => {
    const fixture = [
      `event: content_block_delta\nda`,
      `ta: {"type":"content_block_delta","delta":{"type":"text_delta","text":"X"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseAnthropicStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("X")
  })

  test("handles multi-byte UTF-8 split across chunks", async () => {
    const enc = new TextEncoder()
    const full = enc.encode(
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
    )
    const mid = 80
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
    for await (const d of parseAnthropicStream(stream)) deltas.push(d)
    expect(deltas.join("")).toBe("你好")
  })

  test("handles CRLF line endings", async () => {
    const fixture = [
      `event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"crlf"}}\r\n\r\n`,
      `event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseAnthropicStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("crlf")
  })

  test("event field resets between blocks", async () => {
    const fixture = [
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n`,
      `event: ping\ndata: {"type":"ping"}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]
    const deltas: string[] = []
    for await (const d of parseAnthropicStream(streamOf(fixture))) deltas.push(d)
    expect(deltas.join("")).toBe("ab")
  })
})
