/**
 * Pairwise translator: client speaks OpenAI Chat Completions, hub speaks
 * OpenAI Responses.
 *
 * Used when a Chat Completions client targets a Responses-only model
 * (e.g. gpt-5.x). Re-exports the three translation functions that the
 * dispatch pipeline composes per request: request (client → hub), events
 * (hub SSE → Chat SSE), body (hub JSON → Chat JSON).
 */
export { translateChatToResponses, type TranslateChatToResponsesOptions } from './request.ts'
export { translateResponsesToChatSSE } from './events.ts'
export { translateResponsesToChatBody } from './body.ts'
