/**
 * Source-API → target-endpoint selector for the pairwise dispatch pipeline.
 *
 * Single fixed PREFERENCE table per source; deterministic and unit-testable.
 * Selector only inspects key presence in `ModelEndpoints` — it does not look
 * at the binding's catalog metadata, model kind, or upstream provider. That
 * keeps the routing primitive pure and reusable from any dispatch site.
 */
import type { EndpointKey, ModelEndpoints } from '@vnext-llm/protocols/common'

export type SourceApi = 'messages' | 'chat_completions' | 'responses' | 'gemini'

/**
 * Per-source preference chain. The first endpoint key in the chain that is
 * present in the given ModelEndpoints map wins.
 *
 * - messages           : messages → responses → chat_completions
 * - chat_completions   : chat_completions → messages → responses
 * - responses          : responses → messages → chat_completions
 * - gemini             : messages → responses → chat_completions
 *   (Gemini source pairs with any of the three hub endpoints via the
 *    gemini-via-{messages,responses,chat-completions} translators.)
 */
const PREFERENCE: Record<SourceApi, readonly EndpointKey[]> = {
  messages: ['messages', 'responses', 'chat_completions'],
  chat_completions: ['chat_completions', 'messages', 'responses'],
  responses: ['responses', 'messages', 'chat_completions'],
  gemini: ['messages', 'responses', 'chat_completions'],
}

/**
 * Returns the highest-priority endpoint the binding actually serves for the
 * given source API. Null means "the binding does not serve any endpoint this
 * client protocol can be paired to" — caller usually surfaces that as HTTP
 * 400 ("model does not support client protocol").
 */
export function selectPair(source: SourceApi, endpoints: ModelEndpoints): EndpointKey | null {
  for (const target of PREFERENCE[source]) {
    if (endpoints[target]) return target
  }
  return null
}
