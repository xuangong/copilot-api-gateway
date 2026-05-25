/**
 * Streaming translator: OpenAI Responses SSE → Gemini SSE/JSON events.
 *
 * Pure composition of:
 *   1. Responses SSE → Chat Completions SSE (chat-completions-via-responses)
 *   2. Chat Completions SSE → Gemini SSE/JSON (gemini-via-chat)
 */

import {
  createChatToGeminiJSONStream,
  createChatToGeminiSSEStream,
} from "~/translators/gemini-via-chat"
import { createResponsesToChatCompletionsStream } from "~/translators/chat-completions-via-responses"

export function createResponsesToGeminiSSEStream(): ReadableWritablePair<
  Uint8Array,
  Uint8Array
> {
  const first = createResponsesToChatCompletionsStream()
  const second = createChatToGeminiSSEStream()
  return {
    writable: first.writable,
    readable: first.readable.pipeThrough(second),
  }
}

export function createResponsesToGeminiJSONStream(): ReadableWritablePair<
  Uint8Array,
  Uint8Array
> {
  const first = createResponsesToChatCompletionsStream()
  const second = createChatToGeminiJSONStream()
  return {
    writable: first.writable,
    readable: first.readable.pipeThrough(second),
  }
}
