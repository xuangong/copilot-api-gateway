/**
 * Responses web-search server-tool plugin (Spec 13-C-5a).
 *
 * Ported 1:1 from copilot-gateway
 * `packages/gateway/src/data-plane/chat/responses/interceptors/server-tools/web-search.ts`.
 *
 * Adaptations from the reference:
 *   - `@floway-dev/protocols/responses` → `@vibe-llm/protocols/responses`. vNext does
 *     NOT export narrowed `ResponsesFunctionTool` / `ResponsesHostedTool` /
 *     `ResponsesFunctionToolCallItem` / `ResponsesInputItem` / `WEB_SEARCH_HOSTED_TYPE_NAMES`,
 *     so we use loose aliases from `../../../../orchestrator/server-tools/types` and
 *     define the hosted-type name tuple locally.
 *   - `providerModelOf(invocation.candidate).enabledFlags.has(...)` →
 *     `invocation.enabledFlags.has(...)` — vNext `Invocation` exposes
 *     `enabledFlags` directly.
 *   - Registration's second argument is `ServerToolRequestCtx` (store,
 *     apiKeyId, abortSignal) rather than the reference's full `ChatGatewayCtx`.
 *   - Alpha-search passthrough branch (`state.executeAlpha`) is STRIPPED per
 *     Spec 13-C Q3(b): vNext defers alpha-search entirely; the two paths in
 *     the reference that instantiate it (`state.executeAlpha` setter, and the
 *     `planShimSlots` `executeAlpha` fast path) are removed rather than left
 *     dormant behind a flag.
 */
import { shortId } from '../../../../../data-plane/shared/short-id.ts'
import { normalizeDomainEntry } from '../../../../tools/web-search/domain-normalize.ts'
import {
  actionSearchQueries,
  CONTEXT_SIZE_TO_MAX_RESULTS,
  DEFAULT_SEARCH_CONTEXT_SIZE,
  isSearchContextSize,
  maxResultsForContextSize,
  renderWebSearchCallOutput,
  schemaErrorIr,
  type WebSearchCallIR,
  type WebSearchExecutionSession,
  type WebSearchFilters,
} from '../../../../tools/web-search/operations.ts'
import { planWebSearchCalls } from '../../../../tools/web-search/plan-operations.ts'
import { resolveConfiguredWebSearchProvider } from '../../../../tools/web-search/provider.ts'
import { loadSearchConfig } from '../../../../tools/web-search/search-config.ts'
import {
  WEB_SEARCH_SHIM_TOOL_DESCRIPTION,
  WEB_SEARCH_SHIM_TOOL_NAME,
  WEB_SEARCH_SHIM_TOOL_PARAMETERS,
} from '../../../../tools/web-search/shim-tool-schema.ts'
import type { ConfiguredWebSearchProvider } from '../../../../tools/web-search/types.ts'
import { truncatePreservingCodePoints } from '../../../shared/text.ts'
import type {
  ResponsesInputItem,
  ResponsesTool,
  ServerToolLoopState,
  ServerToolOutputItem,
  ServerToolRegistration,
  ServerToolRequestCtx,
} from '../../../../orchestrator/server-tools/types.ts'
import {
  createRandomResponsesItemId,
  type ResponsesOutputWebSearchCall,
  type ResponsesWebSearchAction,
} from '@vibe-llm/protocols/responses'
import type { Invocation } from '@vibe-llm/protocols/common'

// vNext protocols do not export narrowed types for hosted / function tools
// or function_call items — mirror the reference's public API using loose
// structural types built on the shim's loose aliases.
type ResponsesHostedTool = ResponsesTool & {
  type: string
  search_context_size?: unknown
  search_content_types?: unknown
  return_token_budget?: unknown
  filters?: { allowed_domains?: unknown; blocked_domains?: unknown }
  user_location?: NonNullable<WebSearchFilters['userLocation']>
}
type ResponsesFunctionTool = ResponsesTool & { type: 'function'; name: string }
interface ResponsesFunctionToolCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  status?: string
  [k: string]: unknown
}

// The canonical hosted-tool `type` aliases OpenAI ships. vNext protocols do
// not export this tuple, so we define it locally with the same members the
// reference uses. Keep in sync with:
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_tool.py
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_preview_tool.py
export const WEB_SEARCH_HOSTED_TYPE_NAMES = [
  'web_search',
  'web_search_2025_08_26',
  'web_search_preview',
  'web_search_preview_2025_03_11',
] as const

// Runtime set derived from the canonical tuple declared next to
// `ResponsesHostedToolType` so the type union and runtime check can't drift.
export const WEB_SEARCH_HOSTED_TYPES: ReadonlySet<string> = new Set<string>(WEB_SEARCH_HOSTED_TYPE_NAMES)

// `include` opt-ins that widen the hosted `web_search_call` item. The shim
// reads them into its own state and then has them stripped from the outbound
// payload — it synthesizes the item itself, so the upstream has no use for
// them, and grok-* / mai-code-* reject the tokens instead of ignoring them.
export const WEB_SEARCH_INCLUDE_TOKENS = [
  'web_search_call.results',
  'web_search_call.action.sources',
] as const

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the shim call
// uses the underscored form of the model's training-time `web.run`.
export const SHIM_TOOL_NAME = WEB_SEARCH_SHIM_TOOL_NAME

// The hosted tool's `user_location` must surface to the model, not just
// to the backend provider — without this hint the model asks "Which
// city should I check?" even when the client supplied one.
const formatUserLocation = (loc: NonNullable<WebSearchFilters['userLocation']>): string => {
  const parts: string[] = []
  if (loc.city) parts.push(loc.city)
  if (loc.region && loc.region !== loc.city) parts.push(loc.region)
  if (loc.country) parts.push(loc.country)
  const joined = parts.join(', ')
  if (!loc.timezone) return joined
  return joined.length === 0 ? `(timezone: ${loc.timezone})` : `${joined} (timezone: ${loc.timezone})`
}

// `web.run` shim call shape — the sub-property vocabulary and its
// description live in `tools/web-search/shim-tool-schema.ts` so the Chat
// Completions shim exposes an identical tool to the model. Only the
// Responses-native envelope (top-level `name`/`parameters`, `strict`) and
// the optional user-location hint are built here.
const buildShimFunctionTool = (
  canonical: ResponsesTool,
  name: string,
): ResponsesTool => {
  const hosted = canonical as ResponsesHostedTool
  const userLocation = hosted.user_location
  const baseDescription = WEB_SEARCH_SHIM_TOOL_DESCRIPTION
  const hasUserLocation = userLocation !== undefined && (
    (userLocation.city !== undefined && userLocation.city.length > 0)
    || (userLocation.region !== undefined && userLocation.region.length > 0)
    || (userLocation.country !== undefined && userLocation.country.length > 0)
    || (userLocation.timezone !== undefined && userLocation.timezone.length > 0)
  )
  const description = hasUserLocation
    ? `${baseDescription} Default user location: ${formatUserLocation(userLocation)}. Use this as the default when the user asks about local information without specifying a location.`
    : baseDescription

  const tool: ResponsesFunctionTool = {
    type: 'function',
    name,
    description,
    parameters: WEB_SEARCH_SHIM_TOOL_PARAMETERS,
    // Strict mode requires `required` to list every property, but every
    // sub-property here is optional (one call may set only
    // `search_query`, another only `open`).
    strict: false,
  }
  return tool
}

export const isHostedWebSearchTool = (tool: ResponsesTool): boolean =>
  typeof tool.type === 'string' && WEB_SEARCH_HOSTED_TYPES.has(tool.type)

// Canonical form of a hosted web_search tool: client's `type` alias is
// preserved (so round-trip fidelity holds), and the documented defaults
// for `search_context_size`, `search_content_types`, and
// `return_token_budget` are filled. `filters` and `user_location` pass
// through verbatim when present — never synthesized (the latter is
// IP-derived on real upstreams and we have no IP context to fake).
//
// References:
//   `search_context_size` default `'medium'` — openai-python
//   `WebSearchTool.search_context_size` docstring:
//     https://github.com/openai/openai-python/blob/main/src/openai/types/responses/web_search_tool.py
//   `return_token_budget` default `'default'` and
//   `search_content_types` default `['text']` — observed verbatim in
//   Copilot's `/responses` echo for `tools: [{type: 'web_search'}]`.
export const canonicalizeWebSearchTool = (raw: ResponsesTool): ResponsesTool | undefined => {
  if (!isHostedWebSearchTool(raw)) return undefined
  const src = raw as ResponsesHostedTool
  const canonical: ResponsesHostedTool = {
    type: src.type,
    search_context_size: src.search_context_size ?? DEFAULT_SEARCH_CONTEXT_SIZE,
    search_content_types: src.search_content_types ?? ['text'],
    return_token_budget: src.return_token_budget ?? 'default',
  }
  if (src.filters !== undefined) canonical.filters = src.filters
  if (src.user_location !== undefined) canonical.user_location = src.user_location
  return canonical
}

const extractFilters = (tool: ResponsesHostedTool): WebSearchFilters => {
  const out: WebSearchFilters = {}
  const allowed = tool.filters?.allowed_domains
  const blocked = tool.filters?.blocked_domains
  if (Array.isArray(allowed)) out.allowedDomains = allowed as string[]
  if (Array.isArray(blocked)) out.blockedDomains = blocked as string[]
  if (tool.user_location) out.userLocation = tool.user_location
  out.maxResults = maxResultsForContextSize(
    tool.search_context_size as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS | undefined,
  )
  return out
}

interface PrepareToolsError {
  /** Human-readable error message. */
  message: string
  /** JSON-Pointer-style location inside `tools[]`. */
  param: string
}

type PrepareToolsResult =
  | { ok: true; filters: WebSearchFilters }
  | { ok: false; error: PrepareToolsError }

// Per-list cap matches the OpenAI documented "up to 100 allowed_domains
// or up to 100 blocked_domains" limit.
//   https://developers.openai.com/api/docs/guides/tools-web-search.md
const MAX_DOMAIN_LIST_ENTRIES = 100

// Domain-list entry validator. First-failure-wins: returns at the
// first malformed entry so the 400 envelope names ONE offending
// value. We reject non-string entries with their type description
// (matches native's `invalid_type`-shaped rejection for non-string
// list entries); valid-string-but-bad-host entries reject with a
// simple message naming the value.
const validateDomainListEntry = (
  raw: unknown,
): { ok: true } | { ok: false; message: string } => {
  if (typeof raw !== 'string') {
    return { ok: false, message: `Expected string, got ${raw === null ? 'null' : typeof raw}.` }
  }
  if (raw.trim() === '' || /^https?:\/\//i.test(raw) || /[\s/?#@:]/.test(raw) || normalizeDomainEntry(raw) === null) {
    return { ok: false, message: `Invalid domain '${raw}'` }
  }
  return { ok: true }
}

// Validate the parts of a hosted-web-search entry the shim acts on.
// Anything else (`external_web_access`, `return_token_budget`, etc.)
// is silently dropped along with the hosted tool itself — the shim
// replaces the hosted entry with its shim function tool, so any
// hosted-only field the shim doesn't process never reaches upstream
// regardless.
const validateHostedEntry = (tool: ResponsesTool): PrepareToolsError | null => {
  const sizeField = (tool as { search_context_size?: unknown }).search_context_size
  if (sizeField !== undefined && sizeField !== null && !isSearchContextSize(sizeField)) {
    return {
      message: `web_search tool search_context_size must be one of ${Object.keys(CONTEXT_SIZE_TO_MAX_RESULTS).map((k) => `'${k}'`).join(' | ')}; got ${JSON.stringify(sizeField)}.`,
      param: 'tools[].search_context_size',
    }
  }
  const filtersField = (tool as { filters?: unknown }).filters
  if (filtersField === undefined || filtersField === null) return null
  if (typeof filtersField !== 'object' || Array.isArray(filtersField)) {
    return {
      message: `web_search tool filters must be an object; got ${Array.isArray(filtersField) ? 'array' : typeof filtersField}.`,
      param: 'tools',
    }
  }
  for (const field of ['allowed_domains', 'blocked_domains'] as const) {
    const value = (filtersField as Record<string, unknown>)[field]
    // `undefined` and `null` both read as "omit" — same no-op
    // semantics as an empty list.
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) {
      return {
        message: `web_search tool filters.${field} must be an array of strings; got ${typeof value}.`,
        param: 'tools',
      }
    }
    if (value.length > MAX_DOMAIN_LIST_ENTRIES) {
      return {
        message: `web_search tool filters.${field} accepts at most ${MAX_DOMAIN_LIST_ENTRIES} entries; got ${value.length}.`,
        param: 'tools',
      }
    }
    for (const entry of value) {
      const verdict = validateDomainListEntry(entry)
      if (!verdict.ok) {
        return { message: verdict.message, param: 'tools' }
      }
    }
  }
  return null
}

// Validation covers every hosted declaration even though only the last one
// supplies runtime filters. Azure and Copilot both use this dedupe-to-last
// rule for repeated web-search declarations.
// https://github.com/Menci/Floway/pull/172#issuecomment-4971739422
export const prepareToolsForShim = (
  tools: ResponsesTool[],
): PrepareToolsResult => {
  let selectedFilters: WebSearchFilters = {}
  for (const tool of tools) {
    if (isHostedWebSearchTool(tool)) {
      const reject = validateHostedEntry(tool)
      if (reject !== null) return { ok: false, error: reject }
      selectedFilters = extractFilters(tool as ResponsesHostedTool)
    }
  }
  return { ok: true, filters: selectedFilters }
}

// Cap on the wire-item dump inlined into the malformed-input branch's
// `function_call_output` placeholder. A pathological prior wsc echo
// (deeply nested, multi-kilobyte) shouldn't get to blow the upstream
// context window through the diagnostic that explains it.
const MAX_MALFORMED_WIRE_DUMP_CHARS = 1024

/**
 * Persistent `payload.private` shape for one `web_search_call`. A shim call
 * carrying several operations fans out into one wsc per operation, each with
 * its own payload — so this is always one wsc and one op, never an array to
 * denormalize. The persisted-payload key IS the wsc id, so we don't repeat it
 * inside.
 *
 * - `functionCallItem` is the function_call this wsc replays as: the
 *   upstream's own item when the call produced a single wsc, otherwise a
 *   synthetic per-slot one (suffixed call_id, `arguments` naming only this
 *   slot's operation) so N replayed calls read as N honest requests rather
 *   than N copies of the same one. Either way `arguments` is the
 *   jsonrepair-canonical strict-JSON form, and type/name/status pass through
 *   untouched, so the upstream model's prior assistant turn stays well-formed.
 *
 * - `ir` stores the action, structured results, and optional upstream
 *   model-facing output straight from `planShimSlots`. Replay uses
 *   `renderWebSearchCallOutput`, which preserves that output when present
 *   and otherwise renders the action and results.
 *
 * Version-tagged: an unknown `v` falls through the no-payload branch in
 * `transformInputItemsForWebSearch` (action re-serialized into the
 * shim call shape, output replaced with the not-preserved notice). Starts
 * at 1; bump only on a wire-incompatible change after release.
 */
export interface WebSearchCallPrivatePayload {
  v: 1
  functionCallItem: ResponsesFunctionToolCallItem
  ir: WebSearchCallIR
}

const isWebSearchCallPrivatePayload = (value: unknown): value is WebSearchCallPrivatePayload => {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (obj.v !== 1) return false
  const fc = obj.functionCallItem
  if (fc === null || typeof fc !== 'object') return false
  const fcObj = fc as Record<string, unknown>
  if (fcObj.type !== 'function_call' || typeof fcObj.call_id !== 'string' || typeof fcObj.name !== 'string' || typeof fcObj.arguments !== 'string') return false
  const ir = obj.ir
  if (ir === null || typeof ir !== 'object') return false
  const irObj = ir as Record<string, unknown>
  return irObj.action !== undefined && Array.isArray(irObj.results)
}

export const synthesizeWebSearchCallId = (): string => createRandomResponsesItemId('web_search_call')

// Distinct id namespace (cc_replay_*) from web-search item ids (ws_*) so a
// replay call_id never reads as a web-search item id in logs.
const synthesizeReplayCallId = (): string => shortId('cc_replay')

// Re-serializes a wire `action` back into the shim's JSON arguments
// shape (`{search_query:[{q}]}` / `{open:[{ref_id}]}` /
// `{find:[{ref_id,pattern}]}`). Used only on the replay-fallback path to
// fill the paired function_call's `arguments` when no private payload
// exists; the happy path replays the upstream's original args verbatim.
const actionToShimCallArgsJson = (action: ResponsesWebSearchAction): string => {
  switch (action.type) {
    case 'search':
      return JSON.stringify({
        search_query: actionSearchQueries(action).map((q) => ({ q })),
      })
    case 'open_page':
      // Echoed open_page items can arrive without `url` (native drops it
      // on soft failure); fall back to an empty string in the replayed
      // args so the upstream sees a well-formed `ref_id` field rather
      // than a literal `undefined` collapse.
      return JSON.stringify({ open: [{ ref_id: action.url ?? '' }] })
    case 'find_in_page':
      return JSON.stringify({ find: [{ ref_id: action.url, pattern: action.pattern }] })
  }
}

// Replay preprocessor: turns echoed `web_search_call` items back into the
// (function_call, function_call_output) pair the upstream model originally
// saw on turn 1.
//
// Two paths:
//
// 1. Private payload hit (the request resolved the wsc id to a persisted
//    `payload.private`): emit the upstream's literal `functionCallItem`
//    (jsonrepair-canonical args, original call_id) plus a
//    `function_call_output` whose body comes from
//    `renderWebSearchCallOutput`. This is the bit-exact round-trip.
//
// 2. No payload (`store: false`, expired, foreign id, cross-account, or
//    schema-version mismatch): degrade to a synthesized pair whose
//    `function_call.arguments` is the wire action re-serialized into
//    the shim call shape (so the model still sees what it asked for) and
//    whose `function_call_output` text is the not-preserved placeholder.
//    The shim deliberately does not read `item.results` from the
//    wire — turn 1's wire results may or may not exist depending on the
//    client's `include` opt-in, and trusting them across the wire would
//    couple state correctness to client storage discipline.
//
// Echoed items with no `action` at all surface as a placeholder
// `function_call + function_call_output` pair that inlines the raw wire
// item so the model can see what the client actually sent.
export const transformInputItemsForWebSearch = (
  input: ResponsesInputItem[],
  toolName: string,
  getPrivatePayload?: (id: string) => unknown,
): ResponsesInputItem[] => {
  const out: ResponsesInputItem[] = []

  for (const item of input) {
    if (item.type !== 'web_search_call') {
      out.push(item)
      continue
    }

    const wireItem = item as ResponsesInputItem & { id?: string; action?: ResponsesWebSearchAction }
    const candidatePayload = wireItem.id !== undefined ? getPrivatePayload?.(wireItem.id) : undefined
    if (isWebSearchCallPrivatePayload(candidatePayload)) {
      out.push(
        candidatePayload.functionCallItem as unknown as ResponsesInputItem,
        {
          type: 'function_call_output',
          call_id: candidatePayload.functionCallItem.call_id,
          output: renderWebSearchCallOutput(candidatePayload.ir),
        },
      )
      continue
    }

    if (wireItem.action === undefined) {
      const callId = synthesizeReplayCallId()
      // Truncate the wire dump so a deeply-nested or large prior item
      // doesn't blow the upstream context window via a multi-kilobyte
      // function_call_output. The model still sees enough to recognize
      // the malformed shape.
      const wireDump = truncatePreservingCodePoints(JSON.stringify(item), MAX_MALFORMED_WIRE_DUMP_CHARS)
      out.push(
        {
          type: 'function_call',
          call_id: callId,
          name: toolName,
          arguments: '{}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          call_id: callId,
          output: `A prior web_search_call item in the conversation history was malformed (no \`action\` field). Original wire item: ${wireDump}`,
        },
      )
      continue
    }

    const callId = synthesizeReplayCallId()
    out.push(
      {
        type: 'function_call',
        call_id: callId,
        name: toolName,
        arguments: actionToShimCallArgsJson(wireItem.action),
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: callId,
        // See path 2 in the function docstring above for why the wire
        // `item.results` is ignored.
        output: 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.',
      },
    )
  }
  return out
}

// The shim's execution session plus the one wire-shaping flag that lives
// only on the Responses side. Alpha-search passthrough (reference
// `executeAlpha`) is intentionally omitted — Spec 13-C Q3(b) defers it.
interface ShimState extends WebSearchExecutionSession {
  // Set when the client passed `include: ["web_search_call.results"]` on
  // the request. Native Responses gates the `results` field on this
  // include token; the shim follows suit on the wire item — but the IR
  // (and therefore `payload.private`) always carries the real results
  // so a subsequent turn echoing the item id can be hydrated regardless.
  includeSearchResults: boolean
}

const ITERATION_CAP = 30

interface ShimSlot {
  id: string
  action?: ResponsesWebSearchAction
  /** The slice of the shim call's arguments this slot alone will replay. */
  arguments: Record<string, unknown>
  promise: Promise<WebSearchCallIR>
}

const planShimSlots = (
  args: Record<string, unknown> | null,
  state: ShimState,
  loopState: ServerToolLoopState,
): ShimSlot[] => {
  if (loopState.iterationCount > ITERATION_CAP) {
    // One refusal slot for the whole call, whatever it asked for: the budget
    // is exhausted, so there is nothing to fan out.
    return [{
      id: synthesizeWebSearchCallId(),
      arguments: args ?? {},
      promise: Promise.resolve(schemaErrorIr(
        'tool budget exhausted',
        'Tool call budget exhausted',
        `Web search iteration limit (${ITERATION_CAP}) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you've gathered.`,
      )),
    }]
  }

  // Everything below the iteration cap is protocol-agnostic and shared with
  // the Chat Completions shim.
  return planWebSearchCalls(args, state).map((plan) => ({
    id: synthesizeWebSearchCallId(),
    ...(plan.action !== undefined ? { action: plan.action } : {}),
    arguments: plan.arguments,
    promise: plan.promise,
  }))
}

export const webSearchServerTool: ServerToolRegistration<Invocation, ServerToolRequestCtx> = async (
  invocation,
  requestCtx,
) => {
  // A native Responses caller reads `web_search_call` items itself, so an
  // upstream that serves the hosted tool can talk to it directly and the shim
  // is pure overhead — the flag exists to say whether this upstream can. A
  // caller on any other protocol cannot: its translator has to turn results
  // into that protocol's own citation shape, which only exists for searches the
  // gateway ran. The shim is therefore structurally required there, the mirror
  // image of `messages-web-search-shim` being structurally required when the
  // *target* cannot carry the hosted tool. `sourceApi` is the inbound protocol
  // even after a translation hop (see responses/attempt.ts).
  if ((invocation.sourceApi ?? 'responses') === 'responses') {
    return { type: 'inactive' }
  }
  if (!invocation.enabledFlags.has('responses-web-search-shim')) {
    return { type: 'inactive' }
  }

  const tools = Array.isArray(invocation.payload.tools) ? (invocation.payload.tools as ResponsesTool[]) : []
  const hasHostedWebSearch = tools.some(isHostedWebSearchTool)
  const input = Array.isArray(invocation.payload.input) ? (invocation.payload.input as ResponsesInputItem[]) : []
  const hasReplayInput = input.some((i) => i.type === 'web_search_call')
  if (!hasHostedWebSearch && !hasReplayInput) return { type: 'inactive' }

  const prepared = prepareToolsForShim(tools)
  if (!prepared.ok) {
    return {
      type: 'invalid-request',
      message: prepared.error.message,
      param: prepared.error.param,
    }
  }

  const { filters } = prepared
  const searchConfig = await loadSearchConfig()
  const includeArray = Array.isArray(invocation.payload.include) ? (invocation.payload.include as string[]) : []
  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined
  const state: ShimState = {
    filters,
    pageCache: new Map(),
    getProvider: () => {
      configuredProvider ??= Promise.resolve(resolveConfiguredWebSearchProvider(searchConfig))
      return configuredProvider
    },
    apiKeyId: requestCtx.apiKeyId,
    includeSearchResults: includeArray.includes('web_search_call.results'),
    includeSearchActionSources: includeArray.includes('web_search_call.action.sources'),
    ...(requestCtx.abortSignal !== undefined ? { signal: requestCtx.abortSignal } : {}),
  }

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    transformItems: (items, toolName) =>
      transformInputItemsForWebSearch(items, toolName, (id) => requestCtx.store.getPrivatePayload(id)),
    ...(hasHostedWebSearch
      ? {
          hosted: {
            hostedTypes: WEB_SEARCH_HOSTED_TYPE_NAMES,
            includeTokens: WEB_SEARCH_INCLUDE_TOKENS,
            canonicalize: canonicalizeWebSearchTool,
            buildFunctionTool: buildShimFunctionTool,
            dispatcher: ({ intercepted, loopState }) => {
              const slots = planShimSlots(intercepted.arguments, state, loopState)
              return slots.map((slot, index) => {
                const functionCallItem: ResponsesFunctionToolCallItem = {
                  type: 'function_call',
                  // A fanned-out call cannot reuse the upstream's single
                  // call_id: replay pairs each function_call with its own
                  // output, and duplicate call_ids would be malformed
                  // history. Upstream is stateless per request, so a
                  // synthetic suffix only has to be unique within the input
                  // list we resend.
                  call_id: slots.length === 1 ? intercepted.callId : `${intercepted.callId}_${index}`,
                  name: intercepted.name,
                  // Serialize this slot's own slice of the parsed arguments
                  // rather than the upstream's raw string (which might be
                  // malformed, and which names every operation rather than
                  // just this one).
                  arguments: JSON.stringify(slot.arguments),
                  status: 'completed',
                }
                return {
                  id: slot.id,
                  // Native Responses can't name the query until the search
                  // resolves, so its `added` item carries only an id. The shim
                  // runs the search itself and already knows — announcing it
                  // here is an additive deviation that lets clients show what
                  // is being searched while it is still in flight.
                  startItem: slot.action !== undefined
                    ? { type: 'web_search_call', status: 'in_progress', action: slot.action }
                    : { type: 'web_search_call', status: 'in_progress' },
                  startEvents: [
                    { type: 'response.web_search_call.in_progress' },
                    { type: 'response.web_search_call.searching' },
                  ],
                  run: async function* run() {
                    const ir = await slot.promise
                    // `results` is gated on the client's `include`
                    // opt-in to match native Responses' default wire
                    // shape; the IR keeps them either way for the
                    // private-payload round-trip.
                    const item: ServerToolOutputItem & Omit<ResponsesOutputWebSearchCall, 'id'> = state.includeSearchResults
                      ? { type: 'web_search_call', status: 'completed', action: ir.action, results: ir.results }
                      : { type: 'web_search_call', status: 'completed', action: ir.action }
                    const privatePayload: WebSearchCallPrivatePayload = {
                      v: 1,
                      functionCallItem,
                      ir,
                    }
                    return {
                      item,
                      endEvents: [{ type: 'response.web_search_call.completed' }],
                      privatePayload,
                    }
                  },
                }
              })
            },
          },
        }
      : {}),
  }
}
