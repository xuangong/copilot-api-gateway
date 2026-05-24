/**
 * Request translator: client speaks Google Gemini generateContent, upstream
 * serves OpenAI Responses.
 *
 * Composition: gemini → chat-completions → messages → responses. The
 * intermediate hops are pure functions; this keeps Gemini-specific quirks
 * (inline_data, function_response) confined to translateGeminiToOpenAI.
 *
 * Note: per the planner, Gemini source prefers chat → messages → responses.
 * This module covers the lowest-preference fallback path; it's primarily
 * useful when the binding only exposes /v1/responses.
 */

import { translateChatCompletionsToMessages } from "~/translators/chat-completions-via-messages/request"
import { translateMessagesToResponses } from "~/translators/messages-via-responses/request"
import { translateGeminiToOpenAI } from "~/services/gemini"
import type { GeminiGenerateContentRequest } from "~/services/gemini/types"
import type { ResponsesPayload } from "~/transforms/types"

export function translateGeminiToResponses(
  request: GeminiGenerateContentRequest,
  model: string,
  options: { fallbackMaxOutputTokens?: number } = {},
): ResponsesPayload {
  const chat = translateGeminiToOpenAI(request, model)
  const messages = translateChatCompletionsToMessages(chat, options)
  return translateMessagesToResponses(messages)
}
