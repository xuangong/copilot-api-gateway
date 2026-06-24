import type { EndpointKey } from '@vnext-llm/protocols/common'
import {
  parseMessagesSSEStream,
  parseChatSSEStream,
  parseResponsesSSEStream,
} from '@vnext/provider-copilot'

export function mapSourceApiToProviderRequest(
  src: 'messages' | 'chat_completions' | 'responses' | 'gemini',
): 'anthropic' | 'openai' | 'gemini' {
  if (src === 'messages') return 'anthropic'
  if (src === 'chat_completions') return 'openai'
  if (src === 'responses') return 'openai'
  return 'gemini'
}

/**
 * Parse an upstream SSE byte stream into typed events for the given target
 * endpoint. The translator's translateEvents consumes these typed events.
 */
export function parseTargetSSE(
  target: EndpointKey,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  if (target === 'messages') return parseMessagesSSEStream(body, signal)
  if (target === 'chat_completions') return parseChatSSEStream(body, signal)
  if (target === 'responses') return parseResponsesSSEStream(body, signal)
  return (async function* (): AsyncIterable<unknown> { /* empty */ })()
}
