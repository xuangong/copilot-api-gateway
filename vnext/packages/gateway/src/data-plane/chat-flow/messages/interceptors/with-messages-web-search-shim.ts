// vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim.ts
//
// Port of copilot-gateway chat/messages/interceptors/web-search-shim.ts to vNext.
//
// Adaptations from reference:
//   - `Invocation.enabledFlags` (vNext exposes flags directly on Invocation)
//     replaces `providerModelOf(ctx.candidate).enabledFlags`.
//   - No `ctx.targetApi` in vNext — this interceptor is only registered in the
//     Messages chat-flow, so the flag check is unconditional (the reference
//     was defensive against non-Messages targets running the same code path).
//   - `internalErrorResult(...)` replaced by inline
//     `{ type: 'internal-error', status, error }` shape from
//     `LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>`.
//   - Local loose types for `MessagesTool`, `MessagesClientTool`,
//     `MessagesNativeWebSearchTool`, `MessagesMessage`, `MessagesUserContentBlock`
//     — vNext's protocols-llm package doesn't yet export these.
//   - `isJsonObject` inlined (vNext protocols don't export it — same pattern as
//     `web-search/providers/shared.ts`).
//   - `MessagesCountTokensInterceptor` variant (`withMessagesWebSearchRequestPrepared`)
//     is omitted — vNext chat-flow doesn't yet expose a Messages count-tokens
//     interceptor slot. Punt to a follow-up when count_tokens is wired.
//   - Invalid-request synthetic errors emit as `upstream-error` (400 JSON body)
//     matching the Responses shim's approach.

import type { MessagesInterceptor } from './types.ts'
import type { Invocation } from '@vibe-llm/protocols/common'
import type { LlmExecuteResult } from '@vibe-llm/protocols/common'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import type {
  MessagesAssistantContentBlock,
  MessagesPayload,
  MessagesSearchResultBlock,
  MessagesStreamEvent,
  MessagesTextCitation,
  MessagesToolResultBlock,
  MessagesWebSearchErrorCode,
  MessagesWebSearchResultBlock,
  MessagesWebSearchToolResultError,
} from '@vibe-llm/protocols/messages'
import { MESSAGES_WEB_SEARCH_ERROR_CODES } from '@vibe-llm/protocols/messages'
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../data-plane/shared/base64url-json.ts'
import type { ApiKeyId } from '../../../../repo/branded-ids.ts'
import { providerNameFor } from '../../../tools/web-search/key-config.ts'
import { resolveWebSearchForKey } from '../../../tools/web-search/resolve-for-key.ts'
import { searchWebAndRecordUsage } from '../../../tools/web-search/search.ts'
import type {
  WebSearchProvider,
  WebSearchProviderName,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '../../../tools/web-search/types.ts'

// ── Local loose types (vNext @vibe-llm/protocols/messages doesn't export these) ──

interface MessagesClientTool {
  type?: 'custom'
  name: string
  description?: string
  input_schema: Record<string, unknown>
  strict?: boolean
  cache_control?: unknown
}

interface MessagesNativeWebSearchTool {
  type: 'web_search_20250305' | 'web_search_20260209' | 'web_search_20260318'
  name?: string
  max_uses?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
  user_location?: {
    type?: 'approximate'
    city?: string
    region?: string
    country?: string
    timezone?: string
  }
}

type MessagesTool = MessagesClientTool | MessagesNativeWebSearchTool

type MessagesUserContentBlock = { type: string; [key: string]: unknown }

interface MessagesMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<{ type: string; [key: string]: unknown }>
}

// ── Helpers ──

type JsonObject = Record<string, unknown>
const isJsonObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const MAX_QUERY_LENGTH = 1000
const WEB_SEARCH_TOOL_NAME = 'web_search'

type SearchResultOwnership = 'owned' | 'foreign'

interface ShimWebSearchResultPayload {
  content: Array<{ type: 'text'; text: string }>
}

interface ShimWebSearchCitationPayload {
  search_result_index: number
  start_block_index: number
  end_block_index: number
}

interface OwnedReplayToolResult {
  upstreamToolResult: MessagesToolResultBlock
  searchResultOwnership: SearchResultOwnership[]
}

interface ReplayAwareMessagesWebSearchShimState {
  priorSearchUseCount: number
  requestSearchResultOwnership: SearchResultOwnership[]
}

interface ActiveMessagesWebSearchProvider {
  providerName: WebSearchProviderName
  impl: WebSearchProvider
  apiKeyId: ApiKeyId
}

export type MessagesWebSearchShimState =
  | { mode: 'inactive' }
  | ({ mode: 'replay_only' } & ReplayAwareMessagesWebSearchShimState)
  | ({
      mode: 'active'
      toolVersion: MessagesNativeWebSearchTool['type']
      maxUses?: number
      allowedDomains?: string[]
      blockedDomains?: string[]
      userLocation?: {
        city?: string
        region?: string
        country?: string
        timezone?: string
      }
    } & ReplayAwareMessagesWebSearchShimState)

export type PrepareMessagesWebSearchShimRequestResult =
  | { type: 'ok'; payload: MessagesPayload; state: MessagesWebSearchShimState }
  | { type: 'invalid-request'; message: string }

const UPSTREAM_WEB_SEARCH_TOOL_DEFINITION: MessagesClientTool = {
  name: WEB_SEARCH_TOOL_NAME,
  description: 'The web_search tool searches the internet and returns up-to-date information from web sources.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
    },
    required: ['query'],
  },
}

const normalizeNonEmptyDomainList = (domains?: string[]): string[] | undefined => {
  const normalized = domains?.map(d => d.trim()).filter(d => d.length > 0)
  return normalized && normalized.length > 0 ? [...new Set(normalized)] : undefined
}

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && actualKeys.every(k => keys.includes(k))
}

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0

const isShimWebSearchResultPayload = (value: unknown): value is ShimWebSearchResultPayload => {
  if (!isJsonObject(value)) return false
  if (!hasExactKeys(value, ['content'])) return false
  const content = value.content
  return (
    Array.isArray(content)
    && content.every(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
  )
}

const isShimWebSearchCitationPayload = (value: unknown): value is ShimWebSearchCitationPayload => {
  if (!isJsonObject(value)) return false
  if (!hasExactKeys(value, ['search_result_index', 'start_block_index', 'end_block_index'])) return false
  return (
    isNonNegativeInteger(value.search_result_index)
    && isNonNegativeInteger(value.start_block_index)
    && isNonNegativeInteger(value.end_block_index)
    && (value.end_block_index as number) >= (value.start_block_index as number)
  )
}

export const encodeWebSearchResultPayload = (payload: ShimWebSearchResultPayload): string =>
  encodeBase64UrlJson(payload)

export const decodeWebSearchResultPayload = (value: string): ShimWebSearchResultPayload | null => {
  const decoded = decodeBase64UrlJson(value)
  return isShimWebSearchResultPayload(decoded) ? decoded : null
}

export const encodeWebSearchCitationPayload = (payload: ShimWebSearchCitationPayload): string =>
  encodeBase64UrlJson(payload)

export const decodeWebSearchCitationPayload = (value: string): ShimWebSearchCitationPayload | null => {
  const decoded = decodeBase64UrlJson(value)
  return isShimWebSearchCitationPayload(decoded) ? decoded : null
}

const isNativeWebSearchToolDefinition = (tool: MessagesTool): tool is MessagesNativeWebSearchTool =>
  tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209' || tool.type === 'web_search_20260318'

const messagesWebSearchErrorCodeSet = new Set<string>(MESSAGES_WEB_SEARCH_ERROR_CODES)

const isMessagesWebSearchErrorCode = (value: unknown): value is MessagesWebSearchErrorCode =>
  typeof value === 'string' && messagesWebSearchErrorCodeSet.has(value)

const isWebSearchToolResultError = (value: unknown): value is MessagesWebSearchToolResultError =>
  isJsonObject(value)
  && value.type === 'web_search_tool_result_error'
  && isMessagesWebSearchErrorCode((value as { error_code?: unknown }).error_code)

const toUpstreamToolUseId = (toolUseId: string): string =>
  toolUseId.startsWith('srvtoolu_') ? `toolu_${toolUseId.slice('srvtoolu_'.length)}` : toolUseId

const toNativeServerToolUseId = (toolUseId: string): string =>
  toolUseId.startsWith('toolu_') ? `srvtoolu_${toolUseId.slice('toolu_'.length)}` : toolUseId

const buildUpstreamSearchResultBlock = (
  result: MessagesWebSearchResultBlock,
  decoded: NonNullable<ReturnType<typeof decodeWebSearchResultPayload>>,
): MessagesSearchResultBlock => ({
  type: 'search_result',
  source: result.url,
  title: result.title,
  content: decoded.content,
  citations: { enabled: true },
})

const buildNativeWebSearchErrorResultBlock = (
  toolUseId: string,
  errorCode: MessagesWebSearchErrorCode,
): Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => ({
  type: 'web_search_tool_result',
  tool_use_id: toNativeServerToolUseId(toolUseId),
  content: { type: 'web_search_tool_result_error', error_code: errorCode },
  caller: { type: 'direct' },
})

const buildNativeWebSearchServerToolUseBlock = (
  toolUseId: string,
  query: string,
): Extract<MessagesAssistantContentBlock, { type: 'server_tool_use' }> => ({
  type: 'server_tool_use',
  id: toNativeServerToolUseId(toolUseId),
  name: WEB_SEARCH_TOOL_NAME,
  input: { query },
})

const buildNativeWebSearchResultBlock = (
  result: Extract<WebSearchProviderResult, { type: 'ok' }>['results'][number],
): MessagesWebSearchResultBlock => ({
  type: 'web_search_result',
  url: result.source,
  title: result.title,
  encrypted_content: encodeWebSearchResultPayload({ content: result.content }),
  ...(result.pageAge ? { page_age: result.pageAge } : {}),
})

const collectOwnedReplayResultsByServerToolUseId = (
  content: Array<{ type: string; [key: string]: unknown }>,
): Map<string, OwnedReplayToolResult> => {
  const pairedServerToolUseIds = new Set(
    content.flatMap(block =>
      block.type === 'server_tool_use' && (block as unknown as { name?: unknown }).name === WEB_SEARCH_TOOL_NAME
        ? [(block as unknown as { id: string }).id]
        : [],
    ),
  )
  const ownedReplayResultsByServerToolUseId = new Map<string, OwnedReplayToolResult>()

  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !pairedServerToolUseIds.has((block as unknown as { tool_use_id: string }).tool_use_id)) {
      continue
    }
    const ownedReplayResult = decodeOwnedReplayToolResult(
      block as unknown as Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }>,
    )
    if (!ownedReplayResult) continue
    ownedReplayResultsByServerToolUseId.set((block as unknown as { tool_use_id: string }).tool_use_id, ownedReplayResult)
  }

  return ownedReplayResultsByServerToolUseId
}

const messageHasOwnedReplayMarkers = (message: MessagesMessage): boolean => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false

  return (
    collectOwnedReplayResultsByServerToolUseId(message.content).size > 0
    || message.content.some(block => {
      if (block.type !== 'text' || !(block as unknown as { citations?: unknown }).citations) return false
      const citations = (block as unknown as { citations: MessagesTextCitation[] }).citations
      return citations.some(
        c => c.type === 'web_search_result_location'
          && decodeWebSearchCitationPayload((c as { encrypted_index: string }).encrypted_index) !== null,
      )
    })
  )
}

const decodeOwnedReplayCitation = (citation: MessagesTextCitation): MessagesTextCitation => {
  if (citation.type !== 'web_search_result_location') return citation
  const decoded = decodeWebSearchCitationPayload(citation.encrypted_index)
  if (!decoded) return citation
  return {
    type: 'search_result_location',
    url: citation.url,
    title: citation.title,
    search_result_index: decoded.search_result_index,
    start_block_index: decoded.start_block_index,
    end_block_index: decoded.end_block_index,
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  }
}

const decodeOwnedReplayToolResult = (
  block: Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }>,
): OwnedReplayToolResult | null => {
  if (Array.isArray(block.content)) {
    const decodedResults = block.content.map(result => ({
      result,
      payload: decodeWebSearchResultPayload(result.encrypted_content),
    }))
    if (decodedResults.some(e => e.payload === null)) return null
    return {
      upstreamToolResult: {
        type: 'tool_result',
        tool_use_id: toUpstreamToolUseId(block.tool_use_id),
        content: decodedResults.map(({ result, payload }) => buildUpstreamSearchResultBlock(result, payload!)),
      },
      searchResultOwnership: decodedResults.map(() => 'owned'),
    }
  }

  if (isWebSearchToolResultError(block.content)) return null
  return null
}

const collectForeignSearchResultOwnership = (
  content: string | Array<{ type: string; [key: string]: unknown }>,
): SearchResultOwnership[] => {
  if (typeof content === 'string') return []
  return content.flatMap(block => {
    if (block.type !== 'tool_result' || !Array.isArray((block as unknown as { content?: unknown }).content)) return []
    const inner = (block as unknown as { content: Array<{ type: string }> }).content
    return inner.flatMap(cb => (cb.type === 'search_result' ? ['foreign' as const] : []))
  })
}

interface PreparedMessagesWebSearchReplay {
  hasOwnedReplay: boolean
  messages: MessagesMessage[]
  priorSearchUseCount: number
  requestSearchResultOwnership: SearchResultOwnership[]
}

const prepareMessagesWebSearchReplay = (messages: MessagesMessage[]): PreparedMessagesWebSearchReplay => {
  const hasOwnedReplay = messages.some(messageHasOwnedReplayMarkers)
  const rewrittenMessages: MessagesMessage[] = []
  const requestSearchResultOwnership: SearchResultOwnership[] = []
  let pendingOwnedReplayToolResults: OwnedReplayToolResult[] = []
  let priorSearchUseCount = 0

  const flushPendingOwnedReplayToolResults = () => {
    if (pendingOwnedReplayToolResults.length === 0) return
    rewrittenMessages.push({
      role: 'user',
      content: pendingOwnedReplayToolResults.map(({ upstreamToolResult }) => upstreamToolResult as unknown as MessagesUserContentBlock),
    })
    requestSearchResultOwnership.push(
      ...pendingOwnedReplayToolResults.flatMap(({ searchResultOwnership }) => searchResultOwnership),
    )
    pendingOwnedReplayToolResults = []
  }

  for (const message of messages) {
    if (pendingOwnedReplayToolResults.length > 0 && message.role !== 'user') {
      flushPendingOwnedReplayToolResults()
    }

    if (message.role === 'user') {
      const foreignSearchResultOwnership = collectForeignSearchResultOwnership(message.content)

      if (
        pendingOwnedReplayToolResults.length > 0
        && Array.isArray(message.content)
        && message.content.some(b => b.type === 'tool_result')
      ) {
        const toolResults = pendingOwnedReplayToolResults.map(({ upstreamToolResult }) => upstreamToolResult as unknown as MessagesUserContentBlock)
        rewrittenMessages.push({
          role: 'user',
          content: [
            ...toolResults,
            ...(typeof message.content === 'string'
              ? [{ type: 'text' as const, text: message.content }]
              : message.content),
          ],
        })
        requestSearchResultOwnership.push(
          ...pendingOwnedReplayToolResults.flatMap(({ searchResultOwnership }) => searchResultOwnership),
          ...foreignSearchResultOwnership,
        )
        pendingOwnedReplayToolResults = []
        continue
      }

      flushPendingOwnedReplayToolResults()
      rewrittenMessages.push(message)
      requestSearchResultOwnership.push(...foreignSearchResultOwnership)
      continue
    }

    if (!Array.isArray(message.content)) {
      rewrittenMessages.push(message)
      continue
    }

    if (message.role === 'system') {
      rewrittenMessages.push(message)
      continue
    }

    const ownedReplayResultsByServerToolUseId = collectOwnedReplayResultsByServerToolUseId(message.content)

    for (const ownedReplayResult of ownedReplayResultsByServerToolUseId.values()) {
      priorSearchUseCount += 1
      pendingOwnedReplayToolResults.push(ownedReplayResult)
    }

    const rewrittenContent = message.content.flatMap((block): Array<{ type: string; [key: string]: unknown }> => {
      if (block.type === 'server_tool_use' && ownedReplayResultsByServerToolUseId.has((block as unknown as { id: string }).id)) {
        return [
          {
            type: 'tool_use',
            id: toUpstreamToolUseId((block as unknown as { id: string }).id),
            name: (block as unknown as { name: string }).name,
            input: (block as unknown as { input: Record<string, unknown> }).input,
          },
        ]
      }
      if (block.type === 'web_search_tool_result' && ownedReplayResultsByServerToolUseId.has((block as unknown as { tool_use_id: string }).tool_use_id)) {
        return []
      }
      if (block.type !== 'text' || !(block as unknown as { citations?: unknown }).citations) return [block]
      return [
        {
          type: 'text',
          text: (block as unknown as { text: string }).text,
          citations: (block as unknown as { citations: MessagesTextCitation[] }).citations.map(decodeOwnedReplayCitation),
        },
      ]
    })

    rewrittenMessages.push({ role: 'assistant', content: rewrittenContent })
  }

  flushPendingOwnedReplayToolResults()

  return {
    hasOwnedReplay,
    messages: rewrittenMessages,
    priorSearchUseCount,
    requestSearchResultOwnership,
  }
}

const validateNativeWebSearchToolDefinitions = (
  payload: MessagesPayload,
): { type: 'ok'; nativeTool?: MessagesNativeWebSearchTool } | { type: 'invalid-request'; message: string } => {
  const tools = ((payload.tools ?? []) as unknown as MessagesTool[])
  const nativeToolEntries = tools.flatMap((tool, index) =>
    isNativeWebSearchToolDefinition(tool) ? [{ tool, index }] : [],
  )

  if (nativeToolEntries.length > 1) {
    return { type: 'invalid-request', message: 'Only one native web search tool definition is supported per request.' }
  }

  const nativeTool = nativeToolEntries[0]?.tool
  if (nativeTool?.name !== undefined && nativeTool.name !== WEB_SEARCH_TOOL_NAME) {
    return {
      type: 'invalid-request',
      message: `tools.${nativeToolEntries[0]!.index}.${nativeTool.type}.name: Input should be '${WEB_SEARCH_TOOL_NAME}'`,
    }
  }

  if (nativeTool && tools.some(t => !isNativeWebSearchToolDefinition(t) && (t as MessagesClientTool).name === WEB_SEARCH_TOOL_NAME)) {
    return {
      type: 'invalid-request',
      message: `Native web search tool name collides with another client tool: ${WEB_SEARCH_TOOL_NAME}.`,
    }
  }

  return { type: 'ok', nativeTool }
}

const buildMessagesWebSearchShimState = (
  nativeTool: MessagesNativeWebSearchTool | undefined,
  replay: PreparedMessagesWebSearchReplay,
): MessagesWebSearchShimState => {
  if (!nativeTool && !replay.hasOwnedReplay) return { mode: 'inactive' }

  if (!nativeTool) {
    return {
      mode: 'replay_only',
      priorSearchUseCount: replay.priorSearchUseCount,
      requestSearchResultOwnership: replay.requestSearchResultOwnership,
    }
  }

  return {
    mode: 'active',
    toolVersion: nativeTool.type,
    maxUses: nativeTool.max_uses,
    allowedDomains: normalizeNonEmptyDomainList(nativeTool.allowed_domains),
    blockedDomains: normalizeNonEmptyDomainList(nativeTool.blocked_domains),
    ...(nativeTool.user_location && {
      userLocation: {
        city: nativeTool.user_location.city,
        region: nativeTool.user_location.region,
        country: nativeTool.user_location.country,
        timezone: nativeTool.user_location.timezone,
      },
    }),
    priorSearchUseCount: replay.priorSearchUseCount,
    requestSearchResultOwnership: replay.requestSearchResultOwnership,
  }
}

export const prepareMessagesWebSearchShimRequest = (
  payload: MessagesPayload,
): PrepareMessagesWebSearchShimRequestResult => {
  const validated = validateNativeWebSearchToolDefinitions(payload)
  if (validated.type !== 'ok') return validated

  const messages = (payload.messages as unknown as MessagesMessage[])
  const replay = prepareMessagesWebSearchReplay(messages)
  const state = buildMessagesWebSearchShimState(validated.nativeTool, replay)

  if (state.mode === 'inactive') return { type: 'ok', payload, state }

  const tools = payload.tools as unknown as MessagesTool[] | undefined
  return {
    type: 'ok',
    payload: {
      ...payload,
      ...(tools
        ? {
            tools: validated.nativeTool
              ? tools.map(t => (isNativeWebSearchToolDefinition(t) ? UPSTREAM_WEB_SEARCH_TOOL_DEFINITION : t)) as unknown as MessagesPayload['tools']
              : payload.tools,
          }
        : {}),
      messages: replay.messages as unknown as MessagesPayload['messages'],
    },
    state,
  }
}

const rewriteResponseCitationToNative = (
  citation: MessagesTextCitation,
  state: MessagesWebSearchShimState,
): MessagesTextCitation => {
  if (state.mode === 'inactive' || citation.type !== 'search_result_location') return citation
  if (state.requestSearchResultOwnership[citation.search_result_index] !== 'owned') return citation

  return {
    type: 'web_search_result_location',
    url: citation.url,
    title: citation.title,
    encrypted_index: encodeWebSearchCitationPayload({
      search_result_index: citation.search_result_index,
      start_block_index: citation.start_block_index,
      end_block_index: citation.end_block_index,
    }),
    ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
  }
}

const buildNativeWebSearchResultBlockFromProviderResult = (
  result: WebSearchProviderResult,
  toolUseId: string,
): Extract<MessagesAssistantContentBlock, { type: 'web_search_tool_result' }> => {
  if (result.type === 'error') return buildNativeWebSearchErrorResultBlock(toolUseId, result.errorCode)

  return {
    type: 'web_search_tool_result',
    tool_use_id: toNativeServerToolUseId(toolUseId),
    content: result.results.map(buildNativeWebSearchResultBlock),
    caller: { type: 'direct' },
  }
}

type ActiveBlock =
  | { kind: 'passthrough'; downstreamIndex: number }
  | { kind: 'text'; downstreamIndex: number }
  | {
      kind: 'web-search-tool-use'
      upstreamToolUseId: string
      serverToolUseIndex: number
      resultIndex: number
      inputJson: string
    }

interface ShimStreamingState {
  downstreamIndexOffset: number
  currentSearchUseCount: number
  executedSearchCount: number
  interceptedSearches: number
  hasRemainingClientToolUse: boolean
}

const rewriteContentBlockStartCitations = (
  event: Extract<MessagesStreamEvent, { type: 'content_block_start' }>,
  state: MessagesWebSearchShimState,
): Extract<MessagesStreamEvent, { type: 'content_block_start' }> => {
  if (event.content_block.type !== 'text' || !event.content_block.citations?.length) return event
  return {
    ...event,
    content_block: {
      ...event.content_block,
      citations: event.content_block.citations.map(c => rewriteResponseCitationToNative(c, state)),
    },
  }
}

const rewriteContentBlockDeltaCitations = (
  event: Extract<MessagesStreamEvent, { type: 'content_block_delta' }>,
  state: MessagesWebSearchShimState,
): Extract<MessagesStreamEvent, { type: 'content_block_delta' }> => {
  if (event.delta.type === 'text_delta' && event.delta.citations?.length) {
    return {
      ...event,
      delta: {
        ...event.delta,
        citations: event.delta.citations.map(c => rewriteResponseCitationToNative(c, state)),
      },
    }
  }
  if (event.delta.type === 'citations_delta') {
    return {
      ...event,
      delta: {
        type: 'citations_delta',
        citation: rewriteResponseCitationToNative(event.delta.citation, state),
      },
    }
  }
  return event
}

const runWebSearchStopHandler = async function* (
  block: Extract<ActiveBlock, { kind: 'web-search-tool-use' }>,
  shimState: ShimStreamingState,
  state: Extract<MessagesWebSearchShimState, { mode: 'active' }>,
  provider: ActiveMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const parsedInput = (() => {
    if (block.inputJson === '') return null
    try {
      const parsed = JSON.parse(block.inputJson)
      return isJsonObject(parsed) ? parsed : null
    } catch {
      return null
    }
  })()

  const query = parsedInput ? (typeof parsedInput.query === 'string' ? parsedInput.query.trim() : null) : null

  shimState.interceptedSearches += 1

  yield eventFrame({
    type: 'content_block_start',
    index: block.serverToolUseIndex,
    content_block: buildNativeWebSearchServerToolUseBlock(block.upstreamToolUseId, query ?? ''),
  })
  yield eventFrame({ type: 'content_block_stop', index: block.serverToolUseIndex })

  const resultBlock = await (async () => {
    if (state.maxUses !== undefined && shimState.currentSearchUseCount >= state.maxUses) {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'max_uses_exceeded')
    }
    if (!query || query.length === 0) {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'invalid_tool_input')
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'query_too_long')
    }

    shimState.executedSearchCount += 1
    shimState.currentSearchUseCount += 1

    try {
      const request: WebSearchProviderRequest = {
        query,
        allowedDomains: state.allowedDomains,
        blockedDomains: state.blockedDomains,
        userLocation: state.userLocation,
      }
      const providerResult = await searchWebAndRecordUsage({
        provider: provider.impl,
        providerName: provider.providerName,
        keyId: provider.apiKeyId,
        request,
      })
      return buildNativeWebSearchResultBlockFromProviderResult(providerResult, block.upstreamToolUseId)
    } catch {
      return buildNativeWebSearchErrorResultBlock(block.upstreamToolUseId, 'unavailable')
    }
  })()

  yield eventFrame({
    type: 'content_block_start',
    index: block.resultIndex,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: resultBlock.tool_use_id,
      content: resultBlock.content,
    },
  })
  yield eventFrame({ type: 'content_block_stop', index: block.resultIndex })

  shimState.downstreamIndexOffset += 1
}

export const rewriteMessagesWebSearchEventsToNative = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  state: MessagesWebSearchShimState,
  provider?: ActiveMessagesWebSearchProvider,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  if (state.mode === 'inactive') {
    yield* frames
    return
  }
  if (state.mode === 'active' && !provider) {
    throw new Error('Active messages web-search rewrite requires a provider.')
  }

  const shimState: ShimStreamingState = {
    downstreamIndexOffset: 0,
    currentSearchUseCount: state.priorSearchUseCount,
    executedSearchCount: 0,
    interceptedSearches: 0,
    hasRemainingClientToolUse: false,
  }

  let activeBlock: ActiveBlock | undefined

  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame
      continue
    }

    const event = frame.event

    if (event.type === 'content_block_start') {
      if (activeBlock !== undefined) {
        throw new Error('upstream Messages SSE interleaved content blocks; web-search shim cannot renumber.')
      }
      const downstreamBase = event.index + shimState.downstreamIndexOffset

      if (
        state.mode === 'active'
        && event.content_block.type === 'tool_use'
        && (event.content_block as { name?: string }).name === WEB_SEARCH_TOOL_NAME
      ) {
        activeBlock = {
          kind: 'web-search-tool-use',
          upstreamToolUseId: (event.content_block as { id: string }).id,
          serverToolUseIndex: downstreamBase,
          resultIndex: downstreamBase + 1,
          inputJson: '',
        }
        continue
      }

      if (event.content_block.type === 'text') {
        activeBlock = { kind: 'text', downstreamIndex: downstreamBase }
        yield eventFrame({ ...rewriteContentBlockStartCitations(event, state), index: downstreamBase })
        continue
      }

      if (event.content_block.type === 'tool_use') {
        shimState.hasRemainingClientToolUse = true
      }

      activeBlock = { kind: 'passthrough', downstreamIndex: downstreamBase }
      yield eventFrame({ ...event, index: downstreamBase })
      continue
    }

    if (event.type === 'content_block_delta') {
      if (activeBlock === undefined) {
        throw new Error('upstream Messages SSE emitted content_block_delta without an open block.')
      }
      if (activeBlock.kind === 'web-search-tool-use') {
        if (event.delta.type === 'input_json_delta') {
          activeBlock = { ...activeBlock, inputJson: activeBlock.inputJson + event.delta.partial_json }
        }
        continue
      }
      if (activeBlock.kind === 'text') {
        yield eventFrame({ ...rewriteContentBlockDeltaCitations(event, state), index: activeBlock.downstreamIndex })
        continue
      }
      yield eventFrame({ ...event, index: activeBlock.downstreamIndex })
      continue
    }

    if (event.type === 'content_block_stop') {
      if (activeBlock === undefined) {
        throw new Error('upstream Messages SSE emitted content_block_stop without an open block.')
      }
      if (activeBlock.kind === 'web-search-tool-use') {
        if (state.mode !== 'active') {
          throw new Error('web-search shim entered intercept path without active state.')
        }
        yield* runWebSearchStopHandler(activeBlock, shimState, state, provider!)
        activeBlock = undefined
        continue
      }
      yield eventFrame({ type: 'content_block_stop', index: activeBlock.downstreamIndex })
      activeBlock = undefined
      continue
    }

    if (event.type === 'message_delta') {
      const interceptedAny = shimState.interceptedSearches > 0
      const baseUsage = event.usage ?? { output_tokens: 0 }
      const newUsage = shimState.executedSearchCount > 0
        ? { ...baseUsage, server_tool_use: { web_search_requests: shimState.executedSearchCount } }
        : baseUsage
      yield eventFrame({
        type: 'message_delta',
        delta: interceptedAny
          ? { ...event.delta, stop_reason: shimState.hasRemainingClientToolUse ? 'tool_use' : 'pause_turn' }
          : event.delta,
        usage: newUsage,
      })
      continue
    }

    if (event.type === 'error') {
      yield frame
      return
    }

    yield frame
  }
}

// ── Cross-protocol server-driven continuation ──

/**
 * Ceiling on continuation turns the gateway drives on the client's behalf.
 * Matches the Chat Completions shim's `MAX_SEARCH_TURNS`.
 */
const MAX_SERVER_DRIVEN_SEARCH_TURNS = 4

type LooseBlock = Record<string, unknown>

interface BlockDraft {
  block: LooseBlock
  /** `input_json_delta` fragments; only parseable once the block closes. */
  json: string
}

const accumulateBlockDelta = (draft: BlockDraft, delta: Record<string, unknown>): void => {
  switch (delta.type) {
    case 'text_delta':
      draft.block.text = String(draft.block.text ?? '') + String(delta.text ?? '')
      if (Array.isArray(delta.citations)) {
        draft.block.citations = [...((draft.block.citations as unknown[]) ?? []), ...delta.citations]
      }
      return
    case 'citations_delta':
      draft.block.citations = [...((draft.block.citations as unknown[]) ?? []), delta.citation]
      return
    case 'input_json_delta':
      draft.json += String(delta.partial_json ?? '')
      return
    case 'thinking_delta':
      draft.block.thinking = String(draft.block.thinking ?? '') + String(delta.thinking ?? '')
      return
    case 'signature_delta':
      draft.block.signature = String(draft.block.signature ?? '') + String(delta.signature ?? '')
      return
    default:
      return
  }
}

const closeBlockDraft = (draft: BlockDraft): LooseBlock => {
  if (draft.json !== '') {
    try {
      draft.block.input = JSON.parse(draft.json)
    } catch {
      /* a truncated tool call is not replayable; leave `input` as-is */
    }
  }
  return draft.block
}

/**
 * Blocks safe to send back as an assistant turn. A `thinking` block that never
 * received a delta is unsigned and an empty `text` block is malformed; both are
 * rejected by the upstream on replay.
 */
const replayableBlocks = (blocks: readonly LooseBlock[]): LooseBlock[] =>
  blocks.filter(b => {
    if (b.type === 'thinking') return Boolean(b.thinking)
    if (b.type === 'text') return Boolean(b.text)
    return true
  })

const readTokens = (usage: unknown, key: 'input_tokens' | 'output_tokens'): number => {
  if (!isJsonObject(usage)) return 0
  const value = usage[key]
  return typeof value === 'number' ? value : 0
}

const readWebSearchRequests = (usage: unknown): number => {
  if (!isJsonObject(usage)) return 0
  const serverToolUse = usage.server_tool_use
  if (!isJsonObject(serverToolUse)) return 0
  const value = serverToolUse.web_search_requests
  return typeof value === 'number' ? value : 0
}

/**
 * Splices N upstream turns into ONE downstream Messages turn.
 *
 * The native shim ends an intercepted turn with `stop_reason: 'pause_turn'`,
 * which is Anthropic's handback: the *client* is expected to replay the
 * assistant blocks and ask again for the answer. That contract only works when
 * the client speaks Messages. When the inbound protocol is gemini / responses /
 * chat-completions, the translator on the way out has no `pause_turn` to map —
 * Pair 1 folds it into a plain stop — so the client sees an empty, finished
 * turn and cannot recover. Here the gateway plays the client itself: it
 * withholds the paused turn's terminator, appends the assistant blocks to the
 * conversation, re-runs the chain, and renumbers the follow-up turn's content
 * blocks so downstream sees one continuous message.
 */
const driveMessagesWebSearchTurns = async function* (
  firstTurn: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  args: {
    invocation: Invocation
    /** Native (pre-shim-rewrite) payload — the re-prepare has to start here. */
    basePayload: MessagesPayload
    run: () => Promise<LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>>
    provider: ActiveMessagesWebSearchProvider | undefined
  },
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  let current = firstTurn
  let turn = 0
  // Content-block indices are per-turn; downstream needs one ascending run.
  let indexBase = 0
  const messages = [...((args.basePayload.messages ?? []) as unknown as MessagesMessage[])]
  let inputTokens = 0
  let outputTokens = 0
  let webSearchRequests = 0

  for (;;) {
    const blocks: LooseBlock[] = []
    let draft: BlockDraft | undefined
    let highestIndex = -1
    let stopReason: string | null = null
    let finalDelta: Extract<MessagesStreamEvent, { type: 'message_delta' }> | undefined
    // `message_stop` and the `done` frame terminate the *merged* turn, so they
    // are held back until the loop actually finishes.
    const tail: Array<ProtocolFrame<MessagesStreamEvent>> = []
    let errored = false

    for await (const frame of current) {
      if (frame.type === 'done') {
        tail.push(frame)
        continue
      }
      const event = frame.event

      if (event.type === 'message_start') {
        inputTokens += readTokens((event as { message?: { usage?: unknown } }).message?.usage, 'input_tokens')
        outputTokens += readTokens((event as { message?: { usage?: unknown } }).message?.usage, 'output_tokens')
        // Only the first turn's opener is real; later ones would restart the
        // message downstream.
        if (turn === 0) yield frame
        continue
      }

      if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
        highestIndex = Math.max(highestIndex, event.index)
        if (event.type === 'content_block_start') {
          draft = { block: { ...(event.content_block as unknown as LooseBlock) }, json: '' }
        } else if (event.type === 'content_block_delta') {
          if (draft) accumulateBlockDelta(draft, event.delta as unknown as Record<string, unknown>)
        } else if (draft) {
          blocks.push(closeBlockDraft(draft))
          draft = undefined
        }
        yield eventFrame({ ...event, index: event.index + indexBase })
        continue
      }

      if (event.type === 'message_delta') {
        finalDelta = event
        stopReason = (event.delta as { stop_reason?: string | null }).stop_reason ?? null
        inputTokens += readTokens(event.usage, 'input_tokens')
        outputTokens += readTokens(event.usage, 'output_tokens')
        webSearchRequests += readWebSearchRequests(event.usage)
        continue
      }

      if (event.type === 'message_stop') {
        tail.push(frame)
        continue
      }

      if (event.type === 'error') {
        errored = true
        yield frame
        break
      }

      yield frame
    }

    const finishMergedTurn = function* (): Generator<ProtocolFrame<MessagesStreamEvent>> {
      if (finalDelta) {
        yield eventFrame({
          type: 'message_delta',
          delta: {
            ...finalDelta.delta,
            // A `pause_turn` surviving to here means the budget ran out. The
            // caller cannot continue, so end the turn rather than hand back a
            // handback it has no way to honour.
            ...(stopReason === 'pause_turn' ? { stop_reason: 'end_turn' as const } : {}),
          },
          usage: {
            ...(inputTokens > 0 ? { input_tokens: inputTokens } : {}),
            output_tokens: outputTokens,
            ...(webSearchRequests > 0 ? { server_tool_use: { web_search_requests: webSearchRequests } } : {}),
          },
        } as MessagesStreamEvent)
      }
      yield* tail
    }

    if (errored) {
      yield* tail
      return
    }

    if (stopReason !== 'pause_turn' || turn >= MAX_SERVER_DRIVEN_SEARCH_TURNS) {
      yield* finishMergedTurn()
      return
    }

    messages.push({ role: 'assistant', content: replayableBlocks(blocks) as MessagesMessage['content'] })
    // Re-preparing from the native shape (rather than patching the already
    // rewritten upstream payload) means the replay decoder does the
    // native → upstream translation for us, exactly as it would for a client
    // that continued the turn itself. Scalar fields other interceptors set on
    // `invocation.payload` are preserved; only tools + messages are restored.
    const nextSource = {
      ...(args.invocation.payload as unknown as MessagesPayload),
      ...(args.basePayload.tools !== undefined ? { tools: args.basePayload.tools } : {}),
      messages: messages as unknown as MessagesPayload['messages'],
    } as MessagesPayload
    const nextPrepared = prepareMessagesWebSearchShimRequest(nextSource)
    if (nextPrepared.type !== 'ok' || nextPrepared.state.mode === 'inactive') {
      yield* finishMergedTurn()
      return
    }
    if (turn + 1 >= MAX_SERVER_DRIVEN_SEARCH_TURNS && nextPrepared.state.mode === 'active') {
      // Last turn we are willing to drive: clamp the search budget so further
      // searches come back as `max_uses_exceeded` and the model answers with
      // what it has instead of paging for more.
      nextPrepared.state.maxUses = nextPrepared.state.priorSearchUseCount
    }

    args.invocation.payload = nextPrepared.payload as unknown as Record<string, unknown>
    const next = await args.run()
    if (next.type !== 'events') {
      // Messages has an in-band `error` event, but synthesizing one here would
      // lose the upstream status; throwing lets `attempt.ts` map it to a
      // fully-accounted internal-error result.
      throw new Error(`Messages web search shim: upstream continuation turn failed with result type '${next.type}'`)
    }

    indexBase += highestIndex + 1
    turn += 1
    current = rewriteMessagesWebSearchEventsToNative(next.events, nextPrepared.state, args.provider)
  }
}

const invalidRequestUpstreamError = (
  message: string,
): LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>> => ({
  type: 'upstream-error',
  status: 400,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
  ),
})

/**
 * `null` means the key can't search — switched off, or switched on with no
 * engine whose credential resolved. That is a configuration state, not a
 * failure: the caller drops the hosted tool and lets the model answer without
 * search, rather than turning a gap in the dashboard into a 500 mid-request.
 */
const resolveActiveMessagesWebSearchProvider = async (
  apiKeyId: ApiKeyId,
): Promise<ActiveMessagesWebSearchProvider | null> => {
  const resolved = await resolveWebSearchForKey(apiKeyId)
  if (resolved.type !== 'enabled') return null
  return { providerName: providerNameFor(resolved.engines[0]!), impl: resolved.impl, apiKeyId }
}

type PreparedMessagesWebSearchShimState = Exclude<MessagesWebSearchShimState, { mode: 'inactive' }>

type PrepareMessagesWebSearchInvocationResult =
  | { type: 'inactive' }
  | { type: 'invalid-request'; message: string }
  | { type: 'prepared'; state: PreparedMessagesWebSearchShimState }

/** The request as it would have looked had the caller never asked for search. */
const withoutNativeWebSearchTool = (payload: MessagesPayload): MessagesPayload => {
  const tools = payload.tools as unknown as MessagesTool[] | undefined
  if (!Array.isArray(tools)) return payload
  const kept = tools.filter(t => !isNativeWebSearchToolDefinition(t))
  const next = { ...payload, tools: kept as unknown as MessagesPayload['tools'] }
  // An empty `tools` array is not the same as no tools to every upstream.
  if (kept.length === 0) delete next.tools
  return next
}

const prepareMessagesWebSearchInvocation = (
  invocation: Invocation,
): PrepareMessagesWebSearchInvocationResult => {
  if (!invocation.enabledFlags.has('messages-web-search-shim')) return { type: 'inactive' }

  const prepared = prepareMessagesWebSearchShimRequest(invocation.payload as MessagesPayload)
  if (prepared.type === 'invalid-request') return prepared
  if (prepared.state.mode === 'inactive') return { type: 'inactive' }

  invocation.payload = prepared.payload as unknown as Record<string, unknown>
  return { type: 'prepared', state: prepared.state }
}

/**
 * Anthropic exposes native `web_search_*` server tools. This shim rewrites the
 * native tool definition into an ordinary client `web_search` tool, executes
 * each search the model issues using the gateway's configured provider, and
 * rewrites the response back to the Anthropic native `server_tool_use` /
 * `web_search_tool_result` / `web_search_result_location` shape.
 *
 * Gated by the `messages-web-search-shim` flag on `Invocation.enabledFlags`.
 */
export const withMessagesWebSearchShim: MessagesInterceptor = async (invocation, ctx, run) => {
  // Captured before `prepare` swaps in the upstream-shaped payload: the
  // cross-protocol continuation loop has to re-prepare from the native shape.
  const basePayload = invocation.payload as unknown as MessagesPayload
  const prepared = prepareMessagesWebSearchInvocation(invocation)
  if (prepared.type === 'inactive') return await run()
  if (prepared.type === 'invalid-request') return invalidRequestUpstreamError(prepared.message)

  let provider: ActiveMessagesWebSearchProvider | undefined
  if (prepared.state.mode === 'active') {
    const resolved = await resolveActiveMessagesWebSearchProvider((ctx.apiKeyId ?? '') as ApiKeyId)
    if (!resolved) {
      // No engine for this key. `prepare` has already rewritten the native
      // tool into a client `web_search` function tool for the shim to execute;
      // leaving that in place would hand the caller a tool it never declared
      // and nobody runs. Put the original payload back, minus the hosted tool,
      // and let the model answer without search.
      invocation.payload = withoutNativeWebSearchTool(basePayload) as unknown as Record<string, unknown>
      return await run()
    }
    provider = resolved
  }

  const result = await run()
  if (result.type !== 'events') return result

  const events = rewriteMessagesWebSearchEventsToNative(result.events, prepared.state, provider)

  // A Messages client can honour `pause_turn` itself; anything else cannot.
  if ((invocation.sourceApi ?? 'messages') === 'messages') return { ...result, events }

  return {
    ...result,
    events: driveMessagesWebSearchTurns(events, {
      invocation,
      basePayload,
      run,
      provider,
    }),
  }
}
