import { chatCompletionsAttempt } from '../chat-completions/attempt.ts'
import { messagesAttempt } from '../messages/attempt.ts'
import { responsesAttempt } from '../responses/attempt.ts'

export type HubAttemptProtocol = 'chat_completions' | 'messages' | 'responses'

export function pickHubAttempt(p: HubAttemptProtocol) {
  switch (p) {
    case 'chat_completions':
      return chatCompletionsAttempt
    case 'messages':
      return messagesAttempt
    case 'responses':
      return responsesAttempt
    default: {
      const _exhaustive: never = p
      throw new Error(`no hub attempt for protocol: ${String(_exhaustive)}`)
    }
  }
}
