/**
 * Pairwise translator registry.
 *
 * Looks up a `PairTranslator` for a given (sourceApi, targetEndpoint) pair.
 * The dispatch pipeline uses this to wrap a single fetch call with a
 * translateRequest (client → hub) and translateEvents/translateBody
 * (hub → client) on either side.
 *
 * The registry exposes three shapes:
 *
 *  - PairTranslator      : uniform interface dispatch consumes
 *  - IDENTITY_TRANSLATOR : the messages→messages fast path; returns inputs
 *                           verbatim so the gateway pays nothing for the
 *                           Messages-native route
 *  - getTranslator()     : O(1) table lookup; returns null for unsupported
 *                           pairs (e.g. messages→embeddings) — the caller
 *                           treats null as "no pair available" (HTTP 400)
 *
 * Individual translator modules under `@vnext/translate/<pair>` export plain
 * functions whose names vary per pair (translateChatToMessages,
 * translateMessagesToResponses, …). We wrap each set into the uniform
 * PairTranslator shape here. Two pairs (messages-via-responses and
 * responses-via-messages) wrap their `translateRequest` output in a
 * `{ target }` envelope; the registry unwraps that here so dispatch sees a
 * bare payload uniformly.
 */
import type { EndpointKey } from '@vnext/protocols/common'
import type { SourceApi } from './pair-selector.ts'

// Pair 1: client = chat_completions, hub = messages
import {
  translateChatToMessages,
  translateMessagesToChatSSE,
  translateMessagesToChatBody,
} from '@vnext/translate/chat-completions-via-messages'

// Pair 2: client = messages, hub = chat_completions
import {
  translateMessagesToChat,
  translateChatSSEToMessagesEvents,
  translateChatBodyToMessages,
} from '@vnext/translate/messages-via-chat-completions'

// Pair 3: client = responses, hub = messages
import {
  translateResponsesToMessages,
  translateMessagesToResponsesEvents,
  translateMessagesToResponsesBody,
} from '@vnext/translate/responses-via-messages'

// Pair 4: client = messages, hub = responses
import {
  translateMessagesToResponses,
  translateResponsesEventsToMessagesEvents,
  translateResponsesToMessagesBody,
} from '@vnext/translate/messages-via-responses'

// Pair 5: client = gemini, hub = messages
import {
  translateGeminiToMessages,
  translateMessagesToGeminiEvents,
  translateMessagesToGeminiBody,
} from '@vnext/translate/gemini-via-messages'

// Pair 6: client = messages, hub = gemini
import {
  translateMessagesToGemini,
  translateGeminiToMessagesEvents,
  translateGeminiToMessagesBody,
} from '@vnext/translate/messages-via-gemini'

/** Translation context passed through both directions. */
export interface TranslateContext {
  signal: AbortSignal
  /** Optional fallback for translators that need a model-side default. */
  fallbackMaxOutputTokens?: number
  /** Optional model name override (only used by Gemini pairs). */
  model?: string
}

/**
 * Uniform pair translator.
 *
 * - translateRequest: client payload → hub payload (sync or async)
 * - translateEvents:  hub event stream → client event stream
 * - translateBody:    hub non-streaming JSON → client non-streaming JSON
 *
 * `translateRequest` may be async because some translators (and future
 * Gemini → Messages path) may need to pre-fetch resources; the registry
 * keeps the signature flexible.
 */
export interface PairTranslator {
  translateRequest(payload: unknown, ctx: TranslateContext): unknown | Promise<unknown>
  translateEvents(
    events: AsyncIterable<unknown>,
    ctx: TranslateContext,
  ): AsyncIterable<unknown>
  translateBody(body: unknown, ctx: TranslateContext): unknown | Promise<unknown>
}

/** messages→messages fast path: pass everything through verbatim. */
export const IDENTITY_TRANSLATOR: PairTranslator = {
  translateRequest: (payload) => payload,
  translateEvents: (events) => events,
  translateBody: (body) => body,
}

// ─── Per-pair wrappers ───────────────────────────────────────────────────

/** Pair 1: OpenAI Chat Completions client → Anthropic Messages hub. */
const PAIR_CHAT_TO_MESSAGES: PairTranslator = {
  translateRequest: (payload, ctx) =>
    translateChatToMessages(payload as never, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events) => translateMessagesToChatSSE(events as never),
  translateBody: (body) => translateMessagesToChatBody(body as never),
}

/** Pair 2: Anthropic Messages client → OpenAI Chat Completions hub. */
const PAIR_MESSAGES_TO_CHAT: PairTranslator = {
  translateRequest: (payload) => translateMessagesToChat(payload as never),
  translateEvents: (events) => translateChatSSEToMessagesEvents(events as never),
  translateBody: (body) => translateChatBodyToMessages(body as never),
}

/** Pair 3: OpenAI Responses client → Anthropic Messages hub. */
const PAIR_RESPONSES_TO_MESSAGES: PairTranslator = {
  translateRequest: (payload) => {
    const result = translateResponsesToMessages(payload as never)
    return result.target
  },
  translateEvents: (events) => translateMessagesToResponsesEvents(events as never),
  translateBody: (body) => translateMessagesToResponsesBody(body as never),
}

/** Pair 4: Anthropic Messages client → OpenAI Responses hub. */
const PAIR_MESSAGES_TO_RESPONSES: PairTranslator = {
  translateRequest: (payload) => {
    const result = translateMessagesToResponses(payload as never)
    return result.target
  },
  translateEvents: (events) => translateResponsesEventsToMessagesEvents(events as never),
  translateBody: (body) => translateResponsesToMessagesBody(body as never),
}

/** Pair 5: Gemini generateContent client → Anthropic Messages hub. */
const PAIR_GEMINI_TO_MESSAGES: PairTranslator = {
  translateRequest: (payload, ctx) =>
    translateGeminiToMessages(payload as never, {
      model: ctx.model ?? '',
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events, ctx) =>
    translateMessagesToGeminiEvents(events as never, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateMessagesToGeminiBody(body as never, { model: ctx.model ?? '' }),
}

/**
 * Source-to-target dispatch table. Composite key `${source}->${target}` keeps
 * the lookup O(1) and trivially testable. messages→messages is handled
 * separately in getTranslator() to keep the identity branch on its own line.
 */
const TABLE: Record<string, PairTranslator> = {
  // Pair 1
  'chat_completions->messages': PAIR_CHAT_TO_MESSAGES,
  // Pair 2
  'messages->chat_completions': PAIR_MESSAGES_TO_CHAT,
  // Pair 3
  'responses->messages': PAIR_RESPONSES_TO_MESSAGES,
  // Pair 4
  'messages->responses': PAIR_MESSAGES_TO_RESPONSES,
  // Pair 5
  'gemini->messages': PAIR_GEMINI_TO_MESSAGES,
  // Note on Pair 6 (messages→gemini): the gateway never selects this pair
  // because messages clients prefer messages → responses → chat_completions
  // (see PREFERENCE in pair-selector.ts). It exists in @vnext/translate for
  // completeness and is exercised only by translator-level unit tests.
}

void translateMessagesToGemini
void translateGeminiToMessagesEvents
void translateGeminiToMessagesBody

/**
 * Returns the PairTranslator for the given source API and target endpoint,
 * or null if no translator exists for that direction.
 *
 * Same-source identity fast paths (messages→messages, chat_completions→chat_completions,
 * responses→responses) are handled separately — they pass the payload and SSE
 * events through verbatim because the client and the hub speak the same wire
 * shape. Gemini has no identity case because the gateway never serves a hub
 * endpoint in the Gemini wire shape.
 */
export function getTranslator(source: SourceApi, target: EndpointKey): PairTranslator | null {
  if (source === 'messages' && target === 'messages') return IDENTITY_TRANSLATOR
  if (source === 'chat_completions' && target === 'chat_completions') return IDENTITY_TRANSLATOR
  if (source === 'responses' && target === 'responses') return IDENTITY_TRANSLATOR
  return TABLE[`${source}->${target}`] ?? null
}
