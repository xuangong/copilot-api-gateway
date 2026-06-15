/**
 * Pair: Gemini generateContent ↔ OpenAI Responses.
 *
 * Direction:
 *   request = client → hub  (translateGeminiToResponses, request.ts)
 *   events  = hub → client  (translateResponsesToGeminiEvents, events.ts)
 *   body    = hub → client  (translateResponsesToGeminiBody, body.ts)
 *
 * Used when a gemini /v1beta client targets a model whose effective endpoint
 * resolves to /v1/responses (gpt-5/o*).
 */
export { translateGeminiToResponses, type TranslateGeminiToResponsesOptions } from './request.ts'
export { translateResponsesToGeminiEvents, type TranslateResponsesToGeminiEventsOptions } from './events.ts'
export { translateResponsesToGeminiBody, type TranslateResponsesToGeminiBodyOptions, type ResponsesBodyResponse } from './body.ts'
