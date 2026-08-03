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
 * Individual translator modules under `@vibe-llm/translate/<pair>` export plain
 * functions whose names vary per pair (translateChatToMessages,
 * translateMessagesToResponses, …). We wrap each set into the uniform
 * PairTranslator shape here. Two pairs (messages-via-responses and
 * responses-via-messages) wrap their `translateRequest` output in a
 * `{ target }` envelope; the registry unwraps that here so dispatch sees a
 * bare payload uniformly.
 */
import type { EndpointKey } from '@vibe-llm/protocols/common'
import type { SourceApi } from './pair-selector.ts'

// Pair 1: client = chat_completions, hub = messages
import {
  translateChatToMessages,
  translateMessagesToChatSSE,
  translateMessagesToChatBody,
} from '@vibe-llm/translate/chat-completions-via-messages'

// Pair 2: client = messages, hub = chat_completions
import {
  translateMessagesToChat,
  translateChatSSEToMessagesEvents,
  translateChatBodyToMessages,
} from '@vibe-llm/translate/messages-via-chat-completions'

// Pair 3: client = responses, hub = messages
import {
  translateResponsesToMessages,
  translateMessagesToResponsesEvents,
  translateMessagesToResponsesBody,
} from '@vibe-llm/translate/responses-via-messages'

// Pair 4: client = messages, hub = responses
import {
  translateMessagesToResponses,
  translateResponsesEventsToMessagesEvents,
  translateResponsesToMessagesBody,
} from '@vibe-llm/translate/messages-via-responses'

// Pair 5: client = gemini, hub = messages
import {
  translateGeminiToMessages,
  translateMessagesToGeminiEvents,
  translateMessagesToGeminiBody,
} from '@vibe-llm/translate/gemini-via-messages'

// Pair 6: client = messages, hub = gemini
import {
  translateMessagesToGemini,
  translateGeminiToMessagesEvents,
  translateGeminiToMessagesBody,
} from '@vibe-llm/translate/messages-via-gemini'

// Pair 7: client = chat_completions, hub = responses
import {
  translateChatToResponses,
  translateResponsesToChatSSE,
  translateResponsesToChatBody,
} from '@vibe-llm/translate/chat-completions-via-responses'

// Pair 8: client = responses, hub = chat_completions
import {
  translateResponsesToChat,
  translateChatToResponsesEvents,
  translateChatToResponsesBody,
} from '@vibe-llm/translate/responses-via-chat-completions'

// Pair 9: client = gemini, hub = responses
import {
  translateGeminiToResponses,
  translateResponsesToGeminiEvents,
  translateResponsesToGeminiBody,
} from '@vibe-llm/translate/gemini-via-responses'

// Pair 10: client = gemini, hub = chat_completions
import {
  translateGeminiToChat,
  translateChatToGeminiEvents,
  translateChatToGeminiBody,
} from '@vibe-llm/translate/gemini-via-chat-completions'

/** Translation context passed through both directions. */
export interface TranslateContext {
  signal: AbortSignal
  /** Optional fallback for translators that need a model-side default. */
  fallbackMaxOutputTokens?: number
  /** Optional model name override (only used by Gemini pairs). */
  model?: string
  /**
   * Original client-side request payload. Forwarded to `translateBody` so
   * hub→client envelope mappers can echo fields the upstream stripped (e.g.
   * responses-via-chat needs `instructions`/`tools`/etc. from the original
   * Responses payload to rebuild a full envelope).
   */
  sourcePayload?: Record<string, unknown>
}

/**
 * Uniform pair translator.
 *
 * Type parameters (all default to `unknown` so the registry can hand out a
 * shape-agnostic `PairTranslator` from `getTranslator()` — dispatch consumes
 * it uniformly). Concrete PAIR_X consts below specialize the parameters,
 * which lets each impl body see real types instead of `unknown` and drops
 * the `as never` casts that used to be scattered here.
 *
 * - TSrcReq / THubReq   : client → hub request payloads
 * - TSrcEvt / THubEvt   : client ← hub streaming event shapes
 * - TSrcBody / THubBody : client ← hub non-streaming JSON body shapes
 *
 * `translateRequest` may be async because some translators (and future
 * Gemini → Messages path) may need to pre-fetch resources; the registry
 * keeps the signature flexible.
 */
export interface PairTranslator<
  TSrcReq = unknown,
  THubReq = unknown,
  TSrcEvt = unknown,
  THubEvt = unknown,
  TSrcBody = unknown,
  THubBody = unknown,
> {
  translateRequest(payload: TSrcReq, ctx: TranslateContext): THubReq | Promise<THubReq>
  translateEvents(
    events: AsyncIterable<THubEvt>,
    ctx: TranslateContext,
  ): AsyncIterable<TSrcEvt>
  translateBody(body: THubBody, ctx: TranslateContext): TSrcBody | Promise<TSrcBody>
}

/** messages→messages fast path: pass everything through verbatim. */
export const IDENTITY_TRANSLATOR: PairTranslator = {
  translateRequest: (payload) => payload,
  translateEvents: (events) => events,
  translateBody: (body) => body,
}

// ─── Type helpers ─────────────────────────────────────────────────────────
// Derive concrete pair generics from the underlying translator function
// signatures. Keeps us honest — if a `@vibe-llm/translate` export changes
// shape, the PAIR_X declaration errors instead of silently drifting.
type Arg0<F> = F extends (arg: infer A, ...rest: never[]) => unknown ? A : never
type Ret<F> = F extends (...args: never[]) => infer R ? R : never
type AwaitedRet<F> = Awaited<Ret<F>>
type YieldOf<F> = F extends (...args: never[]) => AsyncIterable<infer Y> ? Y : never
type IterYield<T> = T extends AsyncIterable<infer Y> ? Y : never

// ─── Per-pair wrappers ───────────────────────────────────────────────────

/** Pair 1: OpenAI Chat Completions client → Anthropic Messages hub. */
const PAIR_CHAT_TO_MESSAGES: PairTranslator<
  Arg0<typeof translateChatToMessages>,
  Ret<typeof translateChatToMessages>,
  YieldOf<typeof translateMessagesToChatSSE>,
  IterYield<Arg0<typeof translateMessagesToChatSSE>>,
  AwaitedRet<typeof translateMessagesToChatBody>,
  Arg0<typeof translateMessagesToChatBody>
> = {
  translateRequest: (payload, ctx) =>
    translateChatToMessages(payload, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events) => translateMessagesToChatSSE(events),
  translateBody: (body) => translateMessagesToChatBody(body),
}

/** Pair 2: Anthropic Messages client → OpenAI Chat Completions hub. */
const PAIR_MESSAGES_TO_CHAT: PairTranslator<
  Arg0<typeof translateMessagesToChat>,
  Ret<typeof translateMessagesToChat>,
  YieldOf<typeof translateChatSSEToMessagesEvents>,
  IterYield<Arg0<typeof translateChatSSEToMessagesEvents>>,
  AwaitedRet<typeof translateChatBodyToMessages>,
  Arg0<typeof translateChatBodyToMessages>
> = {
  translateRequest: (payload) => translateMessagesToChat(payload),
  translateEvents: (events) => translateChatSSEToMessagesEvents(events),
  translateBody: (body) => translateChatBodyToMessages(body),
}

/** Pair 3: OpenAI Responses client → Anthropic Messages hub. */
const PAIR_RESPONSES_TO_MESSAGES: PairTranslator<
  Arg0<typeof translateResponsesToMessages>,
  Ret<typeof translateResponsesToMessages>['target'],
  YieldOf<typeof translateMessagesToResponsesEvents>,
  IterYield<Arg0<typeof translateMessagesToResponsesEvents>>,
  AwaitedRet<typeof translateMessagesToResponsesBody>,
  Arg0<typeof translateMessagesToResponsesBody>
> = {
  translateRequest: (payload) => translateResponsesToMessages(payload).target,
  translateEvents: (events) => translateMessagesToResponsesEvents(events),
  translateBody: (body) => translateMessagesToResponsesBody(body),
}

/** Pair 4: Anthropic Messages client → OpenAI Responses hub. */
const PAIR_MESSAGES_TO_RESPONSES: PairTranslator<
  Arg0<typeof translateMessagesToResponses>,
  Ret<typeof translateMessagesToResponses>['target'],
  YieldOf<typeof translateResponsesEventsToMessagesEvents>,
  IterYield<Arg0<typeof translateResponsesEventsToMessagesEvents>>,
  AwaitedRet<typeof translateResponsesToMessagesBody>,
  Arg0<typeof translateResponsesToMessagesBody>
> = {
  translateRequest: (payload) => translateMessagesToResponses(payload).target,
  translateEvents: (events) => translateResponsesEventsToMessagesEvents(events),
  translateBody: (body) => translateResponsesToMessagesBody(body),
}

/** Pair 5: Gemini generateContent client → Anthropic Messages hub. */
const PAIR_GEMINI_TO_MESSAGES: PairTranslator<
  Arg0<typeof translateGeminiToMessages>,
  Ret<typeof translateGeminiToMessages>,
  YieldOf<typeof translateMessagesToGeminiEvents>,
  IterYield<Arg0<typeof translateMessagesToGeminiEvents>>,
  AwaitedRet<typeof translateMessagesToGeminiBody>,
  Arg0<typeof translateMessagesToGeminiBody>
> = {
  translateRequest: (payload, ctx) =>
    translateGeminiToMessages(payload, {
      model: ctx.model ?? '',
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events, ctx) =>
    translateMessagesToGeminiEvents(events, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateMessagesToGeminiBody(body, { model: ctx.model ?? '' }),
}

/** Pair 7: Chat Completions client → Responses hub. */
const PAIR_CHAT_TO_RESPONSES: PairTranslator<
  Arg0<typeof translateChatToResponses>,
  Ret<typeof translateChatToResponses>['target'],
  YieldOf<typeof translateResponsesToChatSSE>,
  IterYield<Arg0<typeof translateResponsesToChatSSE>>,
  AwaitedRet<typeof translateResponsesToChatBody>,
  Arg0<typeof translateResponsesToChatBody>
> = {
  translateRequest: (payload, ctx) =>
    translateChatToResponses(payload, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }).target,
  translateEvents: (events) => translateResponsesToChatSSE(events),
  translateBody: (body) => translateResponsesToChatBody(body),
}

/** Pair 8: Responses client → Chat Completions hub. */
const PAIR_RESPONSES_TO_CHAT: PairTranslator<
  Arg0<typeof translateResponsesToChat>,
  Ret<typeof translateResponsesToChat>['target'],
  YieldOf<typeof translateChatToResponsesEvents>,
  IterYield<Arg0<typeof translateChatToResponsesEvents>>,
  AwaitedRet<typeof translateChatToResponsesBody>,
  Arg0<typeof translateChatToResponsesBody>
> = {
  translateRequest: (payload) => translateResponsesToChat(payload).target,
  translateEvents: (events) => translateChatToResponsesEvents(events),
  translateBody: (body, ctx) =>
    translateChatToResponsesBody(
      body,
      ctx.sourcePayload !== undefined ? { sourcePayload: ctx.sourcePayload } : {},
    ),
}

/** Pair 9: Gemini generateContent client → OpenAI Responses hub. */
const PAIR_GEMINI_TO_RESPONSES: PairTranslator<
  Arg0<typeof translateGeminiToResponses>,
  Ret<typeof translateGeminiToResponses>,
  YieldOf<typeof translateResponsesToGeminiEvents>,
  IterYield<Arg0<typeof translateResponsesToGeminiEvents>>,
  AwaitedRet<typeof translateResponsesToGeminiBody>,
  Arg0<typeof translateResponsesToGeminiBody>
> = {
  translateRequest: (payload, ctx) =>
    translateGeminiToResponses(payload, {
      model: ctx.model ?? '',
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events, ctx) =>
    translateResponsesToGeminiEvents(events, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateResponsesToGeminiBody(body, { model: ctx.model ?? '' }),
}

/** Pair 10: Gemini generateContent client → OpenAI Chat Completions hub. */
const PAIR_GEMINI_TO_CHAT: PairTranslator<
  Arg0<typeof translateGeminiToChat>,
  Ret<typeof translateGeminiToChat>,
  YieldOf<typeof translateChatToGeminiEvents>,
  IterYield<Arg0<typeof translateChatToGeminiEvents>>,
  AwaitedRet<typeof translateChatToGeminiBody>,
  Arg0<typeof translateChatToGeminiBody>
> = {
  translateRequest: (payload, ctx) =>
    translateGeminiToChat(payload, {
      model: ctx.model ?? '',
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events, ctx) =>
    translateChatToGeminiEvents(events, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateChatToGeminiBody(body, { model: ctx.model ?? '' }),
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
  // Pair 7
  'chat_completions->responses': PAIR_CHAT_TO_RESPONSES,
  // Pair 8
  'responses->chat_completions': PAIR_RESPONSES_TO_CHAT,
  // Pair 9
  'gemini->responses': PAIR_GEMINI_TO_RESPONSES,
  // Pair 10
  'gemini->chat_completions': PAIR_GEMINI_TO_CHAT,
  // Note on Pair 6 (messages→gemini): the gateway never selects this pair
  // because messages clients prefer messages → responses → chat_completions
  // (see PREFERENCE in pair-selector.ts). It exists in @vibe-llm/translate for
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
