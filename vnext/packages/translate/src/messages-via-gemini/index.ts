/**
 * Pair 6 (messages-via-gemini): Anthropic Messages ↔ Gemini generateContent.
 *
 * Direction:
 *   request = client → hub  (translateMessagesToGemini, request.ts)
 *   events  = hub → client  (translateGeminiToMessagesEvents, events.ts)
 *   body    = hub → client  (translateGeminiToMessagesBody, body.ts)
 *
 * Composed through `messages-via-chat-completions` (Pair 2). The Gemini SDK
 * shape is closest to OpenAI Chat Completions (parts[] mirrors messages[]
 * content parts), so we route Messages ↔ Chat through Pair 2 and then map
 * Chat ↔ Gemini inline. Reusing Pair 2 keeps role-merge logic, tool-call
 * accumulation, and reasoning_text/thinking handling consistent with the
 * other pair-1/pair-2 stacks.
 */
export { translateMessagesToGemini, type TranslateMessagesToGeminiOptions } from './request.ts'
export {
  translateGeminiToMessagesEvents,
  type TranslateGeminiToMessagesEventsOptions,
  type GeminiStreamResponse,
  type GeminiCandidate,
  type GeminiPart,
  type GeminiUsageMetadata,
} from './events.ts'
export { translateGeminiToMessagesBody, type TranslateGeminiToMessagesBodyOptions } from './body.ts'
