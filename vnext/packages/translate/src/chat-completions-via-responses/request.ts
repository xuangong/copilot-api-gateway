import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface TranslateChatToResponsesOptions {
  fallbackMaxOutputTokens?: number
}

export interface ChatToResponsesRequestResult {
  target: ResponsesPayload
}

export function translateChatToResponses(
  _payload: ChatPayload,
  _options?: TranslateChatToResponsesOptions,
): ChatToResponsesRequestResult {
  throw new Error('translateChatToResponses: not implemented')
}
