// packages/protocols/src/chat/stream.ts
import { chatCompletionsErrorPayloadMessage } from './errors'
import type { ChatCompletionsStreamEvent } from './events'
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse'
import { parseTargetStreamFrames } from '../common/stream/parse-events'
import { parseSSEStream } from '../common/stream/parse-sse'

export interface ParseChatCompletionsStreamOptions {
  signal?: AbortSignal
}

export const parseChatCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseChatCompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<ChatCompletionsStreamEvent>(
      parseSSEStream(body, options),
      { protocol: 'Chat Completions' },
    )) {
      if (frame.type === 'done') {
        yield doneFrame()
        return
      }
      const errorMessage = chatCompletionsErrorPayloadMessage(frame.data)
      if (errorMessage) throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`)
      yield eventFrame(frame.data)
    }
  })()
