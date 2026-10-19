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

test.each([[], ['message'], null].map(marker => ({ marker })))('fast-path expansion preserves function encryption marker %j', async ({ marker }) => {
  const item = {
    type: 'function_call', id: 'fc_1', call_id: 'call_1', namespace: 'collaboration',
    name: 'send_message', arguments: '{"message":"opaque"}', status: 'completed', encrypted_function_args: marker,
  }
  const response = { id: 'r', object: 'response', model: 'test', status: 'completed', error: null, incomplete_details: null, output: [item] }
  const frames = await collect(parseResponsesStream(streamFromString(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`)))
  const events = frames.flatMap(frame => frame.type === 'event' ? [frame.event] : [])
  expect(events.find(event => event.type === 'response.output_item.added')).toMatchObject({
    item: { namespace: 'collaboration', encrypted_function_args: marker },
  })
  expect(events.find(event => event.type === 'response.function_call_arguments.done')).toMatchObject({ encrypted_function_args: marker })
})
