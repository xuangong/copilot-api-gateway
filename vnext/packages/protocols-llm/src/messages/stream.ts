// packages/protocols/src/messages/stream.ts
import type { MessagesStreamEvent } from './events'
import { doneFrame, eventFrame, type ProtocolFrame } from '@vnext-gateway/result'
import { parseTargetStreamFrames, parseSSEStream } from '@vnext-gateway/result/parse'

export interface ParseMessagesStreamOptions {
  signal?: AbortSignal
}

export const parseMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<MessagesStreamEvent>(
      parseSSEStream(body, options),
      { protocol: 'Messages', malformedJsonEventName: 'message' },
    )) {
      if (frame.type === 'done') {
        yield doneFrame()
        return
      }
      yield eventFrame(frame.data)
    }
  })()
