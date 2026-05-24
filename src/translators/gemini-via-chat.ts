/**
 * Translator: client speaks Google Gemini generateContent, we translate
 * to/from Chat Completions upstream.
 *
 * No native /v1beta path exists on Copilot, so every Gemini request flows
 * through chat-fallback. Streaming/non-streaming both supported via the
 * shared stream state machine.
 *
 * Re-exported from services/gemini for protocol-pair discoverability.
 */

export {
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  translateChunkToGemini,
  createStreamState,
} from "~/services/gemini"

export type {
  ChatCompletionsPayload,
  Message,
  ContentPart,
  Tool,
  ToolCall,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "~/services/gemini"
