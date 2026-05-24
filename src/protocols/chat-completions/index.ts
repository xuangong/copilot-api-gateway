/**
 * OpenAI Chat Completions protocol types.
 *
 * Today these are re-exported from the services tree where the original
 * definitions live alongside the translators. Future cleanup may move
 * the definitions here once a second consumer materializes.
 */

export type {
  ChatCompletionsPayload,
  Message,
  ContentPart,
  Tool,
  ToolCall,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "~/services/gemini"
