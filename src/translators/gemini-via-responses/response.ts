/**
 * Response translator: OpenAI Responses JSON → Gemini generateContent JSON.
 *
 * Composes responses→chat-completions and chat→gemini so non-streaming
 * Gemini-over-Responses returns the same shape as the streaming path.
 */

import { translateResponsesToChatCompletionsResponse } from "~/translators/chat-completions-via-responses"
import { translateChatCompletionsToGeminiResponse } from "~/translators/gemini-via-chat"
import type { ChatCompletionResponse } from "~/services/gemini/format-conversion"
import type { GeminiGenerateContentResponse } from "~/services/gemini/types"

export function translateResponsesToGeminiResponse(
  resp: Parameters<typeof translateResponsesToChatCompletionsResponse>[0],
  model: string,
): GeminiGenerateContentResponse {
  const chat = translateResponsesToChatCompletionsResponse(resp, model)
  return translateChatCompletionsToGeminiResponse(
    chat as unknown as ChatCompletionResponse,
    model,
  )
}
