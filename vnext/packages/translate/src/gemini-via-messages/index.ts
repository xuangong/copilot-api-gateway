/**
 * Pair 5 (gemini-via-messages): Gemini generateContent ↔ Anthropic Messages.
 *
 * Direction:
 *   request = client → hub  (translateGeminiToMessages, request.ts)
 *   events  = hub → client  (translateMessagesToGeminiEvents, events.ts)
 *   body    = hub → client  (translateMessagesToGeminiBody, body.ts)
 *
 * Composed through `chat-completions-via-messages` because the Gemini SDK
 * shape is closest to OpenAI Chat Completions (parts[] mirrors messages[]
 * content parts). Reusing Pair 1 keeps the Anthropic-prefix cache
 * breakpoint logic and reasoning_effort mapping in one place.
 */
export { translateGeminiToMessages, type TranslateGeminiToMessagesOptions } from './request.ts'
export { translateMessagesToGeminiEvents, type TranslateMessagesToGeminiEventsOptions } from './events.ts'
export { translateMessagesToGeminiBody, type TranslateMessagesToGeminiBodyOptions } from './body.ts'
