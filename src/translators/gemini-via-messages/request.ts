/**
 * Request translator: client speaks Google Gemini generateContent, upstream
 * serves Anthropic Messages.
 *
 * Composition: gemini → chat-completions → messages. The intermediate
 * Chat-Completions shape is a faithful, well-tested representation of
 * Gemini's contents/parts model and avoids duplicating the
 * function_call/inline_data/role-merge plumbing.
 */

import { translateChatCompletionsToMessages } from "~/translators/chat-completions-via-messages/request"
import { translateGeminiToOpenAI } from "~/services/gemini"
import type { GeminiGenerateContentRequest } from "~/services/gemini/types"
import type { AnthropicMessagesPayload } from "~/transforms/types"

export function translateGeminiToMessages(
  request: GeminiGenerateContentRequest,
  model: string,
  options: { fallbackMaxOutputTokens?: number } = {},
): AnthropicMessagesPayload {
  const chat = translateGeminiToOpenAI(request, model)
  return translateChatCompletionsToMessages(chat, options)
}
