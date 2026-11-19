import type { SseFrame, SseReadableFrame } from './frame'

export interface ParseTargetStreamFramesOptions {
  protocol: string
  malformedJsonEventName?: string
}

export type ParsedTargetStreamFrame<TEvent> =
  | { type: 'done' }
  | { type: 'sse-json'; data: TEvent; frame: SseFrame }

export const parseTargetStreamFrames = async function* <TEvent>(
  frames: AsyncIterable<SseReadableFrame>,
  options: ParseTargetStreamFramesOptions,
): AsyncGenerator<ParsedTargetStreamFrame<TEvent>> {
  for await (const frame of frames) {
    // An unframed payload is not an event of this protocol; it is how some
    // upstreams report a late failure. Fail the stream rather than end cleanly.
    if (frame.type === 'sse-raw') {
      throw new Error(`Upstream ${options.protocol} stream sent an unframed payload: ${frame.data.trim()}`)
    }
    const data = frame.data.trim()
    if (!data) continue
    if (data === '[DONE]') {
      yield { type: 'done' }
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data) as unknown
    } catch (error) {
      const eventName = frame.event ?? options.malformedJsonEventName
      const eventContext = eventName ? ` for event "${eventName}"` : ''
      throw new Error(
        `Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`,
        { cause: error },
      )
    }
    yield { type: 'sse-json', data: parsed as TEvent, frame }
  }
}
