import { describe, expect, test } from 'bun:test'
import { parseChatCompletionsStream } from '../stream'

const streamFromString = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseChatCompletionsStream', () => {
  test('passes through normal events and emits done on [DONE]', async () => {
    const body = streamFromString(
      'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"m","choices":[]}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseChatCompletionsStream(body))
    expect(out).toEqual([
      {
        type: 'event',
        event: { id: 'a', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [] },
      },
      { type: 'done' },
    ])
  })

  test('throws on mid-stream error payload', async () => {
    const body = streamFromString(
      'data: {"error":{"type":"server_error","message":"boom"}}\n\n',
    )
    await expect(collect(parseChatCompletionsStream(body))).rejects.toThrow(
      /Upstream Chat Completions SSE error: server_error: boom/,
    )
  })

  test('throws on error payload without type', async () => {
    const body = streamFromString('data: {"error":{"message":"plain"}}\n\n')
    await expect(collect(parseChatCompletionsStream(body))).rejects.toThrow(/plain/)
  })
})
