import { describe, expect, test } from 'bun:test'
import { parseTargetStreamFrames } from '../src/parse-events'
import type { SseFrame } from '../src/frame'

const sseSource = (frames: SseFrame[]): AsyncIterable<SseFrame> => ({
  async *[Symbol.asyncIterator]() {
    for (const f of frames) yield f
  },
})

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseTargetStreamFrames', () => {
  test('parses JSON frames into typed events', async () => {
    const src = sseSource([
      { type: 'sse', data: '{"k":1}' },
      { type: 'sse', data: '{"k":2}' },
    ])
    const out = await collect(parseTargetStreamFrames<{ k: number }>(src, { protocol: 'Test' }))
    expect(out).toEqual([
      { type: 'sse-json', data: { k: 1 }, frame: { type: 'sse', data: '{"k":1}' } },
      { type: 'sse-json', data: { k: 2 }, frame: { type: 'sse', data: '{"k":2}' } },
    ])
  })

  test('emits done on [DONE] sentinel', async () => {
    const src = sseSource([
      { type: 'sse', data: '{"k":1}' },
      { type: 'sse', data: '[DONE]' },
    ])
    const out = await collect(parseTargetStreamFrames<{ k: number }>(src, { protocol: 'Test' }))
    expect(out[1]).toEqual({ type: 'done' })
  })

  test('skips empty data lines', async () => {
    const src = sseSource([
      { type: 'sse', data: '   ' },
      { type: 'sse', data: '{"k":1}' },
    ])
    const out = await collect(parseTargetStreamFrames<{ k: number }>(src, { protocol: 'Test' }))
    expect(out).toHaveLength(1)
  })

  test('throws with protocol-tagged message on malformed JSON', async () => {
    const src = sseSource([{ type: 'sse', data: 'not json', event: 'message' }])
    await expect(collect(parseTargetStreamFrames(src, { protocol: 'Test' }))).rejects.toThrow(
      /Malformed upstream Test SSE JSON for event "message": not json/,
    )
  })

  test('falls back to malformedJsonEventName when frame.event missing', async () => {
    const src = sseSource([{ type: 'sse', data: 'oops' }])
    await expect(
      collect(parseTargetStreamFrames(src, { protocol: 'Test', malformedJsonEventName: 'fallback' })),
    ).rejects.toThrow(/for event "fallback"/)
  })
})
