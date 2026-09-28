import { describe, expect, test } from 'bun:test'
import { parseSSEStream } from '../src/parse-sse'

const streamFromString = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s))
      controller.close()
    },
  })

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseSSEStream', () => {
  test('emits one frame per data: line', async () => {
    const stream = streamFromString('data: {"a":1}\n\ndata: {"a":2}\n\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([
      { type: 'sse', event: undefined, data: '{"a":1}' },
      { type: 'sse', event: undefined, data: '{"a":2}' },
    ])
  })

  test('captures event: header and pairs it with the next data line', async () => {
    const stream = streamFromString('event: message_start\ndata: {"x":1}\n\ndata: {"y":2}\n\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([
      { type: 'sse', event: 'message_start', data: '{"x":1}' },
      { type: 'sse', event: undefined, data: '{"y":2}' },
    ])
  })

  test('handles CRLF line endings', async () => {
    const stream = streamFromString('data: hello\r\n\r\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([{ type: 'sse', event: undefined, data: 'hello' }])
  })

  test('flushes a final frame with no trailing blank line', async () => {
    const stream = streamFromString('data: tail\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([{ type: 'sse', event: undefined, data: 'tail' }])
  })

  test('aborts via signal and stops yielding', async () => {
    const ctrl = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\n'))
        await new Promise((r) => setTimeout(r, 5))
        ctrl.abort()
        controller.enqueue(new TextEncoder().encode('data: 2\n\n'))
        controller.close()
      },
    })
    const frames = await collect(parseSSEStream(stream, { signal: ctrl.signal }))
    expect(frames.length).toBeLessThanOrEqual(1)
  })
})

test("SSE accepts optional spacing, multiline fields, comments and empty event reset", async () => {
  const source = "event:stale\n\nevent:message\ndata:hello\ndata: world\n: keepalive\ndata:  indented\n\ndata\n\ndata:tail"
  expect(await collect(parseSSEStream(streamFromString(source)))).toEqual([
    { type: "sse", event: "message", data: "hello\nworld\n indented" },
    { type: "sse", data: "" },
    { type: "sse", data: "tail" },
  ])
})

test("SSE handles split UTF-8 and every CR/LF boundary", async () => {
  const bytes = new TextEncoder().encode("\ufeffevent:message\rdata:你好\r\n\r\ndata:second\r\r")
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
  expect(await collect(parseSSEStream(stream))).toEqual([
    { type: "sse", event: "message", data: "你好" },
    { type: "sse", data: "second" },
  ])
})

test("SSE abort releases a pending read without dispatching unfinished data", async () => {
  const abort = new AbortController()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("data:partial\n")) },
    cancel() { cancelled = true },
  })
  const result = collect(parseSSEStream(stream, { signal: abort.signal }))
  await Bun.sleep(1)
  abort.abort()
  expect(await result).toEqual([])
  expect(cancelled).toBe(true)
})
