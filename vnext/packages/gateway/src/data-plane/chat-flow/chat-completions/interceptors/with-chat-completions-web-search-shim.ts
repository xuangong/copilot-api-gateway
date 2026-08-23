/**
 * Chat Completions web-search shim.
 *
 * Trigger: the spec-conformant top-level `web_search_options` request
 * argument. Chat Completions has **no hosted tool variant** — the OpenAI SDK
 * types `ChatCompletionTool` as `ChatCompletionFunctionTool |
 * ChatCompletionCustomTool` — so `{type:'web_search'}` in `tools[]` is not
 * merely unconventional, it is invalid. `web_search_options` is the only
 * legal way for a client to ask this endpoint for a web-backed answer, and it
 * is therefore the only shape this shim accepts. We deliberately do NOT sniff
 * `function.name === 'web_search'`: a function tool belongs to the client, and
 * matching on its name would let the gateway hijack the client's namespace.
 *
 * Because chat-flow interceptors are keyed by *target* endpoint, this one
 * interceptor also serves Gemini-, Messages- and Responses-source requests
 * that route to a Chat Completions upstream — those translators map their
 * native search request onto `web_search_options`.
 *
 * Unlike Messages (which has `pause_turn` and can hand the next turn back to
 * the client) Chat Completions has no way to suspend a turn, so this shim
 * drives the ReAct loop itself: it appends the injected function tool, calls
 * `run()` per turn, executes the model's search calls server-side and feeds
 * the results back as `role:'tool'` messages until the model answers. That is
 * safe here because `runInterceptors` has no once-guard, passes the same
 * `Invocation` on every call, and `chat-completions/attempt.ts`'s terminal
 * reads `invocation.payload` at dispatch time.
 *
 * Search credentials never leave the server: the client only ever sees the
 * `search_query`/`open`/`find` vocabulary and the resulting citations.
 */
import type { ChatCompletionsInterceptor } from './types'
import type {
  ChatCompletionsAnnotation,
  ChatCompletionsChoiceStreaming,
  ChatCompletionsStreamEvent,
  ChatCompletionsUsage,
} from '@vibe-llm/protocols/chat'
import type { Invocation, LlmExecuteResult, RequestContext } from '@vibe-llm/protocols/common'
import type { ProtocolFrame } from '@vibe-core/result'
import { doneFrame, eventFrame } from '@vibe-core/result'
import { normalizeDomainList } from '../../../tools/web-search/domain-normalize.ts'
import {
  CONTEXT_SIZE_TO_MAX_RESULTS,
  isSearchContextSize,
  maxResultsForContextSize,
  renderWebSearchCallOutput,
  type WebSearchExecutionSession,
  type WebSearchFilters,
} from '../../../tools/web-search/operations.ts'
import { planWebSearchCalls } from '../../../tools/web-search/plan-operations.ts'
import { providerNameFor } from '../../../tools/web-search/key-config.ts'
import { resolveWebSearchForKey } from '../../../tools/web-search/resolve-for-key.ts'
import {
  WEB_SEARCH_SHIM_TOOL_DESCRIPTION,
  WEB_SEARCH_SHIM_TOOL_NAME,
  WEB_SEARCH_SHIM_TOOL_PARAMETERS,
} from '../../../tools/web-search/shim-tool-schema.ts'
import { parseServerToolArguments } from '../../shared/tool-arguments.ts'
import type { ApiKeyId } from '../../../../repo/branded-ids.ts'

/**
 * Search-executing turns the shim will run before it stops honoring the
 * model's calls. Matches the legacy gateway's `MAX_USES_HARD_LIMIT`. Each
 * turn is a full upstream round trip billed to the caller, so this is much
 * tighter than the Responses shim's per-response iteration cap.
 */
const MAX_SEARCH_TURNS = 4

type ChatTool = { type: string; function?: { name?: string } }

interface BufferedToolCall {
  id: string
  name: string
  arguments: string
}

type ShimResult = LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>

// Chat Completions cannot express an error in-band (the `finish_reason` enum
// has no 'error' member), so a synthesized client error has to travel as a
// non-`events` result. `attempt.ts` forwards it untouched.
const invalidRequestEnvelope = (message: string, param: string): ShimResult => ({
  type: 'upstream-error',
  status: 400,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { message, type: 'invalid_request_error', param, code: 'invalid_request_error' },
  })),
})

const sumUsage = (
  a: ChatCompletionsUsage | undefined,
  b: ChatCompletionsUsage,
): ChatCompletionsUsage => {
  if (a === undefined) return b
  return {
    ...a,
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
    ...(a.prompt_tokens_details !== undefined || b.prompt_tokens_details !== undefined
      ? {
          prompt_tokens_details: {
            cached_tokens:
              (a.prompt_tokens_details?.cached_tokens ?? 0) + (b.prompt_tokens_details?.cached_tokens ?? 0),
          },
        }
      : {}),
  }
}

// Function names must be unique within `tools[]`; a client that already ships
// its own `web_search` function keeps it and the shim takes `web_search_2`.
const resolveShimToolName = (tools: readonly ChatTool[]): string => {
  const taken = new Set(
    tools.flatMap((t) => (typeof t.function?.name === 'string' ? [t.function.name] : [])),
  )
  if (!taken.has(WEB_SEARCH_SHIM_TOOL_NAME)) return WEB_SEARCH_SHIM_TOOL_NAME
  for (let i = 2; i <= 1000; i++) {
    const candidate = `${WEB_SEARCH_SHIM_TOOL_NAME}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('Unable to resolve a free web-search shim tool name')
}

const extractFilters = (options: Record<string, unknown>): WebSearchFilters => {
  const out: WebSearchFilters = {}
  const filters = options.filters
  if (filters !== null && typeof filters === 'object' && !Array.isArray(filters)) {
    const allowed = (filters as Record<string, unknown>).allowed_domains
    const blocked = (filters as Record<string, unknown>).blocked_domains
    // Entries that fail domain validation drop rather than 400, matching
    // `normalizeDomainList`'s contract everywhere else in the search stack.
    if (Array.isArray(allowed)) out.allowedDomains = normalizeDomainList(allowed as string[])
    if (Array.isArray(blocked)) out.blockedDomains = normalizeDomainList(blocked as string[])
  }
  out.maxResults = maxResultsForContextSize(
    options.search_context_size as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS | undefined,
  )
  // `web_search_options.user_location` is read and DELIBERATELY IGNORED.
  // It is accepted (no 400) so spec-conformant clients keep working, but the
  // gateway does not geo-bias the backing provider from it on this endpoint.
  // Intentional per the protocol decision for this shim — not an oversight,
  // and not a TODO. The Responses shim's differing treatment is deliberate
  // too; do not "unify" them without revisiting that decision.
  return out
}

/** Delta keys that carry model output we forward verbatim. */
const isMeaningfulChoice = (choice: Record<string, unknown>): boolean => {
  const delta = choice.delta as Record<string, unknown> | undefined
  if (delta !== undefined && Object.keys(delta).length > 0) return true
  // Preserve vendor per-choice padding (`content_filter_results` etc.) even
  // when the delta itself became empty after tool_calls were stripped.
  return Object.keys(choice).some((k) => k !== 'index' && k !== 'delta' && k !== 'finish_reason')
}

export const withChatCompletionsWebSearchShim: ChatCompletionsInterceptor = async (
  inv: Invocation,
  ctx: RequestContext,
  run,
): Promise<ShimResult> => {
  if (!inv.enabledFlags.has('chat-completions-web-search-shim')) return run()

  const rawOptions = inv.payload.web_search_options
  if (rawOptions === undefined || rawOptions === null) return run()
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return invalidRequestEnvelope(
      `web_search_options must be an object; got ${Array.isArray(rawOptions) ? 'array' : typeof rawOptions}.`,
      'web_search_options',
    )
  }
  const options = rawOptions as Record<string, unknown>

  const contextSize = options.search_context_size
  if (contextSize !== undefined && contextSize !== null && !isSearchContextSize(contextSize)) {
    return invalidRequestEnvelope(
      `web_search_options.search_context_size must be one of ${Object.keys(CONTEXT_SIZE_TO_MAX_RESULTS).map((k) => `'${k}'`).join(' | ')}; got ${JSON.stringify(contextSize)}.`,
      'web_search_options.search_context_size',
    )
  }

  // No engine for this key — switched off, or switched on with nothing
  // configured. Leave `web_search_options` in place and run the request
  // unchanged: the option is advisory, and failing here would turn a gap in
  // the dashboard into a 500 the caller can do nothing about.
  const resolved = await resolveWebSearchForKey(ctx.apiKeyId as ApiKeyId | undefined)
  if (resolved.type !== 'enabled') {
    delete inv.payload.web_search_options
    return run()
  }
  const configured = {
    type: 'enabled' as const,
    provider: providerNameFor(resolved.engines[0]!),
    impl: resolved.impl,
  }

  // Rewrite the request: the option is gateway-side only and must never
  // reach the upstream, which would either reject it or run its own search
  // with its own credentials.
  delete inv.payload.web_search_options
  const existingTools = Array.isArray(inv.payload.tools) ? (inv.payload.tools as ChatTool[]) : []
  const toolName = resolveShimToolName(existingTools)
  inv.payload.tools = [
    ...existingTools,
    {
      type: 'function',
      function: {
        name: toolName,
        description: WEB_SEARCH_SHIM_TOOL_DESCRIPTION,
        parameters: WEB_SEARCH_SHIM_TOOL_PARAMETERS,
      },
    },
  ]

  const session: WebSearchExecutionSession = {
    getProvider: () => Promise.resolve(configured),
    filters: extractFilters(options),
    apiKeyId: (ctx.apiKeyId ?? '') as ApiKeyId,
    pageCache: new Map(),
    includeSearchActionSources: false,
    ...(ctx.downstreamAbortSignal !== undefined ? { signal: ctx.downstreamAbortSignal } : {}),
  }

  const first = await run()
  if (first.type !== 'events') return first

  return {
    ...first,
    events: driveSearchLoop(first.events, inv, run, session, toolName),
  }
}

async function* driveSearchLoop(
  firstTurn: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  inv: Invocation,
  run: () => Promise<ShimResult>,
  session: WebSearchExecutionSession,
  toolName: string,
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  let current = firstTurn
  // Turn 1's identity is stamped on every forwarded chunk so a client that
  // reassembles the stream sees one coherent response rather than N.
  let streamId = ''
  let created = 0
  let model = ''
  let usage: ChatCompletionsUsage | undefined
  const annotations: ChatCompletionsAnnotation[] = []
  const citedUrls = new Set<string>()
  let searchTurns = 0
  let budgetExhausted = false

  for (;;) {
    const buffered = new Map<number, BufferedToolCall>()
    let assistantText = ''
    let finishReason: string | null = null

    for await (const frame of current) {
      // Intermediate `done` frames are swallowed; exactly one is emitted at
      // the very end so the merged stream terminates once.
      if (frame.type === 'done') continue
      const chunk = frame.event as ChatCompletionsStreamEvent & Record<string, unknown>

      if (streamId === '' && typeof chunk.id === 'string' && chunk.id !== '') {
        streamId = chunk.id
        created = chunk.created
        model = chunk.model
      }
      if (chunk.usage) usage = sumUsage(usage, chunk.usage)

      const outChoices: ChatCompletionsChoiceStreaming[] = []
      for (const rawChoice of (chunk.choices ?? []) as unknown as Array<Record<string, unknown>>) {
        const delta = { ...((rawChoice.delta as Record<string, unknown>) ?? {}) }
        if (typeof rawChoice.finish_reason === 'string') finishReason = rawChoice.finish_reason

        // Buffer tool-call deltas for the whole turn instead of forwarding
        // them. We cannot classify a call as shim-or-client until the delta
        // carrying `function.name` arrives, and forwarding early would either
        // leak the shim's call to the client or leave a hole in the client's
        // `tool_calls` array once the shim call is removed.
        const toolCalls = delta.tool_calls
        delete delta.tool_calls
        if (Array.isArray(toolCalls)) {
          for (const rawCall of toolCalls as Array<Record<string, unknown>>) {
            const idx = typeof rawCall.index === 'number' ? rawCall.index : 0
            const fn = rawCall.function as Record<string, unknown> | undefined
            const entry = buffered.get(idx) ?? { id: '', name: '', arguments: '' }
            if (typeof rawCall.id === 'string' && rawCall.id !== '') entry.id = rawCall.id
            if (typeof fn?.name === 'string' && fn.name !== '') entry.name = fn.name
            if (typeof fn?.arguments === 'string') entry.arguments += fn.arguments
            buffered.set(idx, entry)
          }
        }

        if (typeof delta.content === 'string') assistantText += delta.content

        const outChoice = { ...rawChoice, delta, finish_reason: null }
        if (isMeaningfulChoice(outChoice)) {
          outChoices.push(outChoice as unknown as ChatCompletionsChoiceStreaming)
        }
      }

      if (outChoices.length === 0) continue
      const { usage: _usage, ...rest } = chunk
      yield eventFrame({ ...rest, id: streamId, created, model, choices: outChoices } as ChatCompletionsStreamEvent)
    }

    const calls = [...buffered.keys()].sort((a, b) => a - b).map((k) => buffered.get(k)!)
    const shimCalls = calls.filter((c) => c.name === toolName)
    const clientCalls = calls.filter((c) => c.name !== toolName)

    // Hand the turn back to the client when the model produced no shim call,
    // or produced a client tool call the client must execute itself. Same
    // rule the legacy interceptor and the Responses loop use: the gateway
    // never runs a turn the client is entitled to drive.
    if (shimCalls.length === 0 || clientCalls.length > 0 || budgetExhausted) {
      yield* finalizeTurn({
        streamId, created, model, usage, annotations, clientCalls,
        // Dropping unexecuted shim calls would leave `tool_calls` as the
        // finish reason with nothing for the client to call.
        finishReason: clientCalls.length > 0
          ? 'tool_calls'
          : finishReason === 'tool_calls' ? 'stop' : finishReason,
      })
      return
    }

    budgetExhausted = searchTurns >= MAX_SEARCH_TURNS
    searchTurns++

    const toolMessages: Array<Record<string, unknown>> = []
    for (const call of shimCalls) {
      const callId = call.id !== '' ? call.id : `call_${crypto.randomUUID().replace(/-/g, '')}`
      call.id = callId
      let content: string
      if (budgetExhausted) {
        content = `Error: maximum web search uses (${MAX_SEARCH_TURNS}) exceeded. Answer using what you have already gathered.`
      } else {
        // A shim call carrying several operations fans out into several
        // searches, but Chat Completions allows exactly one `role:'tool'`
        // message per `tool_call_id` — so the results come back concatenated
        // into that one message rather than as separate replies.
        const irs = await Promise.all(
          planWebSearchCalls(parseServerToolArguments(call.arguments), session).map((plan) => plan.promise),
        )
        content = irs.map(renderWebSearchCallOutput).join('\n\n')
        for (const result of irs.flatMap((ir) => ir.results)) {
          if (citedUrls.has(result.url)) continue
          citedUrls.add(result.url)
          annotations.push({ type: 'url_citation', url_citation: { url: result.url, title: result.title } })
        }
      }
      toolMessages.push({ role: 'tool', tool_call_id: callId, content })
    }

    const messages = Array.isArray(inv.payload.messages)
      ? (inv.payload.messages as Array<Record<string, unknown>>)
      : []
    inv.payload.messages = [
      ...messages,
      {
        role: 'assistant',
        content: assistantText === '' ? null : assistantText,
        tool_calls: shimCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      },
      ...toolMessages,
    ]

    const next = await run()
    if (next.type !== 'events') {
      // Chat Completions has no in-band error frame, so a mid-loop upstream
      // failure has to throw; `attempt.ts` maps it to an internal-error
      // result the same way the whitespace-abort interceptor relies on.
      throw new Error(`Chat Completions web search shim: upstream turn failed with result type '${next.type}'`)
    }
    current = next.events
  }
}

function* finalizeTurn(args: {
  streamId: string
  created: number
  model: string
  usage: ChatCompletionsUsage | undefined
  annotations: readonly ChatCompletionsAnnotation[]
  clientCalls: readonly BufferedToolCall[]
  finishReason: string | null
}): Generator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  const base = {
    id: args.streamId,
    object: 'chat.completion.chunk' as const,
    created: args.created,
    model: args.model,
  }

  if (args.clientCalls.length > 0) {
    // Re-indexed densely from 0: the client's array must have no holes even
    // though the upstream interleaved shim calls at arbitrary indices.
    yield eventFrame({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: args.clientCalls.map((c, index) => ({
            index,
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        },
        finish_reason: null,
      }],
    } as unknown as ChatCompletionsStreamEvent)
  }

  if (args.annotations.length > 0) {
    yield eventFrame({
      ...base,
      choices: [{ index: 0, delta: { annotations: [...args.annotations] }, finish_reason: null }],
    } as unknown as ChatCompletionsStreamEvent)
  }

  yield eventFrame({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: args.finishReason }],
  } as unknown as ChatCompletionsStreamEvent)

  // One usage chunk summed across every loop turn, in OpenAI's
  // `choices: []` trailer shape. Per-turn usage chunks were swallowed above.
  if (args.usage !== undefined) {
    yield eventFrame({ ...base, choices: [], usage: args.usage } as unknown as ChatCompletionsStreamEvent)
  }

  yield doneFrame()
}
