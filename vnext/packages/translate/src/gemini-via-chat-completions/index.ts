/**
 * Pair: Gemini generateContent ↔ OpenAI Chat Completions.
 *
 * Direction:
 *   request = client → hub  (translateGeminiToChat, request.ts)
 *   events  = hub → client  (translateChatToGeminiEvents, events.ts)
 *   body    = hub → client  (translateChatToGeminiBody, body.ts)
 *
 * Used when a gemini /v1beta client targets a model whose effective endpoint
 * resolves to /v1/chat/completions.
 */
export { translateGeminiToChat, type TranslateGeminiToChatOptions } from './request.ts'
export { translateChatToGeminiEvents, type TranslateChatToGeminiEventsOptions } from './events.ts'
export {
  translateChatToGeminiBody,
  type TranslateChatToGeminiBodyOptions,
  type ChatCompletionsBodyResponse,
} from './body.ts'
