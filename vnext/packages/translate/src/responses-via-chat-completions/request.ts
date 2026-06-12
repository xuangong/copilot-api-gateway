import type { ChatPayload } from '@vnext/protocols/chat'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export interface ResponsesToChatRequestResult { target: ChatPayload }

export function translateResponsesToChat(_payload: ResponsesPayload): ResponsesToChatRequestResult {
  throw new Error('translateResponsesToChat: not implemented')
}
