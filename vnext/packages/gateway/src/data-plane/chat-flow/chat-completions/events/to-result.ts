import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { ProtocolFrame } from '@vnext/protocols/common'
import { reassembleChatCompletions, type ChatCompletionsResult } from './reassemble'

export const CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE =
  'Chat Completions stream ended without [DONE] terminal frame'

export const chatCompletionsEventsUntilDone = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
): AsyncGenerator<ChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return
    yield frame.event
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE)
}

export const collectChatCompletionsProtocolEventsToResult = async (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<ChatCompletionsResult> => reassembleChatCompletions(chatCompletionsEventsUntilDone(frames))
