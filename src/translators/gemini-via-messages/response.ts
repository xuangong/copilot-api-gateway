/**
 * Response translator: Anthropic Messages JSON → Gemini generateContent JSON.
 *
 * Composes the two existing translators end-to-end so both shape and usage
 * accounting stay consistent with their streaming counterparts.
 */

import { translateMessagesToChatCompletionsResponse } from "~/translators/chat-completions-via-messages"
import { translateChatCompletionsToGeminiResponse } from "~/translators/gemini-via-chat"
import type { ChatCompletionResponse } from "~/services/gemini/format-conversion"
import type { GeminiGenerateContentResponse } from "~/services/gemini/types"

export function translateMessagesToGeminiResponse(
  messages: Parameters<typeof translateMessagesToChatCompletionsResponse>[0],
  model: string,
): GeminiGenerateContentResponse {
  const chat = translateMessagesToChatCompletionsResponse(messages)
  return translateChatCompletionsToGeminiResponse(
    chat as unknown as ChatCompletionResponse,
    model,
  )
}
