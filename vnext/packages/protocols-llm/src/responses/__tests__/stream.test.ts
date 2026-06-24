import { describe, expect, test } from 'bun:test'
import { parseResponsesStream } from '../stream'

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

describe('parseResponsesStream', () => {
  test('reattaches event header onto JSON missing type', async () => {
    const body = streamFromString(
      'event: response.created\ndata: {"response":{"id":"r1","object":"response","status":"in_progress"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    expect(out[0]).toMatchObject({
      type: 'event',
      event: { type: 'response.created', sequence_number: 0 },
    })
    expect(out.at(-1)).toEqual({ type: 'done' })
  })

  test('skips ping frames', async () => {
    const body = streamFromString(
      'data: {"type":"ping"}\n\nevent: response.in_progress\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    expect(out.find((f) => f.type === 'event' && (f.event as { type: string }).type === 'ping')).toBeUndefined()
  })

  test('stamps monotonic sequence_number when missing', async () => {
    const body = streamFromString(
      'event: response.created\ndata: {"response":{"id":"r"}}\n\nevent: response.in_progress\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    const seqs = out
      .filter((f) => f.type === 'event')
      .map((f) => (f.event as { sequence_number?: number }).sequence_number)
    expect(seqs).toEqual([0, 1])
  })

  test('adopts upstream sequence_number and continues past it', async () => {
    const body = streamFromString(
      'event: response.created\ndata: {"sequence_number":7,"response":{"id":"r"}}\n\nevent: response.in_progress\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    const seqs = out
      .filter((f) => f.type === 'event')
      .map((f) => (f.event as { sequence_number?: number }).sequence_number)
    expect(seqs).toEqual([7, 8])
  })
})
