import { describe, expect, test } from 'bun:test'
import { parseMessagesStream } from '../stream'

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

describe('parseMessagesStream', () => {
  test('passes through events and emits done on [DONE]', async () => {
    const body = streamFromString(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseMessagesStream(body))
    expect(out[0]).toEqual({ type: 'event', event: { type: 'message_start', message: { id: 'm1' } } as any })
    expect(out[1]).toEqual({ type: 'done' })
  })

  test('throws on malformed JSON tagged with Messages protocol', async () => {
    const body = streamFromString('event: message_start\ndata: not-json\n\n')
    await expect(collect(parseMessagesStream(body))).rejects.toThrow(
      /Malformed upstream Messages SSE JSON for event "message_start"/,
    )
  })
})
