/**
 * Streaming translator: Anthropic Messages SSE → Gemini SSE/JSON events.
 *
 * Pure composition of the two well-tested hops:
 *   1. Messages SSE → Chat Completions SSE (chat-completions-via-messages)
 *   2. Chat Completions SSE → Gemini SSE/JSON (gemini-via-chat)
 */

import {
  createChatToGeminiJSONStream,
  createChatToGeminiSSEStream,
} from "~/translators/gemini-via-chat"
import { createMessagesToChatCompletionsStream } from "~/translators/chat-completions-via-messages"

export function createMessagesToGeminiSSEStream(
  model: string,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const first = createMessagesToChatCompletionsStream(model)
  const second = createChatToGeminiSSEStream()
  return {
    writable: first.writable,
    readable: first.readable.pipeThrough(second),
  }
}

export function createMessagesToGeminiJSONStream(
  model: string,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const first = createMessagesToChatCompletionsStream(model)
  const second = createChatToGeminiJSONStream()
  return {
    writable: first.writable,
    readable: first.readable.pipeThrough(second),
  }
}
