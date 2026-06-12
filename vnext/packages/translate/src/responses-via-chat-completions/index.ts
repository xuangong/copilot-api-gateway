/**
 * Pairwise translator: client speaks OpenAI Responses, hub speaks
 * OpenAI Chat Completions.
 *
 * Used when a Responses client targets a Chat Completions-only model.
 * Re-exports the three translation functions that the dispatch pipeline
 * composes per request: request (client → hub), events (hub Chat SSE →
 * Responses event stream), body (hub Chat JSON → Responses JSON).
 */
export { translateResponsesToChat } from './request.ts'
export { translateChatToResponsesEvents } from './events.ts'
export { translateChatToResponsesBody } from './body.ts'
