import { getRuntimeLocation, waitUntil } from "@vibe-core/platform"

import type { CreateProviderOptions } from "../../../../providers/registry.ts"
import { messagesAttempt } from "../../../../chat-flow/messages/attempt.ts"
import { collectMessagesProtocolEventsToResult } from "../../../../chat-flow/messages/events/reassemble.ts"
import {
  SourceStreamState,
  eventResultMetadata,
  recordPerformance,
  recordUsage,
} from "../../../../chat-flow/shared/respond-telemetry.ts"
import type { TelemetryRequestContext } from "../../../../chat-flow/shared/telemetry-ctx.ts"
import { decodeUpstreamErrorBody } from "@vibe-llm/protocols/common"
import { type ProtocolFrame } from "@vibe-core/result"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"

import { EngineManager, type EngineManagerOptions } from "./engine-manager"
import { formatSearchResults } from "./formatter"
import type {
  WebSearchTool,
  ToolUseBlock,
  Message,
  ApiResponse,
  MessageContent,
  WebSearchMeta,
  ToolInput,
} from "./types"

const MAX_USES_HARD_LIMIT = 4

const emptyMeta = (): WebSearchMeta => ({
  searchCount: 0,
  totalResults: 0,
  enginesUsed: [],
  successes: 0,
  failures: 0,
  engineAttempts: [],
})

interface SearchExecutionResult {
  content: string
  isError: boolean
  resultCount: number
  engineName: string
}

interface CallOptions {
  copilot: CreateProviderOptions
  /**
   * Optional observability context — when present, each leaf upstream call is
   * wrapped in messagesAttempt.generate so per-attempt usage/performance rows
   * fire on every intercept-loop iteration. undefined apiKeyId disables
   * observability silently (mirrors legacy dispatch behaviour).
   */
  apiKeyId?: string
  userAgent?: string
  requestId?: string
  model?: string
}

/** Tool definition sent to Copilot */
interface ClientTool {
  name: string
  type?: string
  description?: string
  input_schema?: {
    type: string
    properties?: Record<string, { type: string; description?: string }>
    required?: string[]
  }
  max_uses?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
}

/** Messages API payload structure */
interface MessagesPayload {
  model: string
  messages: Message[]
  max_tokens?: number
  tools?: ClientTool[]
  stream?: boolean
  system?: string | { type: string; text: string }[]
}

// Helper to call upstream LLM via the new messagesAttempt chain and return the
// parsed JSON envelope. The web-search loop is purely server-side (we read the
// JSON to decide whether another iteration is needed), so we always run with
// `stream:false` upstream and reassemble the synthesised frame stream into a
// MessagesResult-shaped JSON via collectMessagesProtocolEventsToResult.
//
// Telemetry persistence (recordUsage + recordPerformance) is best-effort and
// fires through `waitUntil` so a slow repo write never blocks the next loop
// iteration. When `options.apiKeyId` is undefined we skip persistence entirely
// — same exit lane the legacy dispatch path uses for internal/anonymous probes.
async function createMessages(
  payload: MessagesPayload,
  options: CallOptions,
): Promise<ApiResponse> {
  // The web-search loop always asks upstream for JSON (no SSE re-emission);
  // strip any client-supplied `stream:true` so attempt.ts's `wantsUpstreamStream`
  // resolves to false and the JSON branch synthesises frames for us.
  const innerPayload = { ...payload, stream: false }
  const requestStartedAt = Date.now()
  const telemetryCtx: TelemetryRequestContext = {
    apiKeyId: options.apiKeyId ?? '<unknown>',
    userAgent: options.userAgent ?? null,
    requestId: options.requestId ?? crypto.randomUUID(),
    isStreaming: false,
    runtimeLocation: getRuntimeLocation(),
    requestStartedAt,
    sourceApi: 'messages',
  }

  const result = await messagesAttempt.generate({
    payload: innerPayload as Record<string, unknown> & { model: string; stream?: boolean },
    auth: { copilot: options.copilot },
    ctx: { requestStartedAt, downstreamAbortSignal: undefined },
    telemetryCtx,
  })

  // After Spec 3 Part 4 deleted the cross-protocol `dispatch()` bridge, the
  // messagesAttempt result is always an `LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>`
  // — bridged-response no longer exists. If binding selection picks a
  // non-messages target the attempt surfaces an `internal-error` (501) which
  // we throw below.
  if (result.type === 'upstream-error') {
    if (options.apiKeyId) {
      waitUntil(recordPerformance(telemetryCtx, result.performance, true))
    }
    const bodyText = decodeUpstreamErrorBody(result)
    const err = new Error(
      `Web search upstream returned HTTP ${result.status}: ${bodyText || '<empty>'}`,
    )
    ;(err as Error & { status?: number }).status = result.status
    throw err
  }
  if (result.type === 'internal-error') {
    if (options.apiKeyId) {
      // recordPerformance no-ops when result.performance is undefined
      // (pre-binding errors per spec §6.2 deliberately omit perf rows).
      waitUntil(recordPerformance(telemetryCtx, result.performance, true))
    }
    throw result.error
  }

  // events branch — drain through SourceStreamState (model-key correction +
  // usage capture) and reassemble into a MessagesResult JSON envelope.
  const state = new SourceStreamState(result.modelIdentity.modelKey)
  const drained = consumeFramesWithState(result.events, state)
  let reassembled: ApiResponse
  try {
    reassembled = (await collectMessagesProtocolEventsToResult(drained)) as ApiResponse
  } catch (err) {
    state.failedAfter()
    if (options.apiKeyId) {
      waitUntil(persistFromEventResult(result, state, telemetryCtx))
    }
    throw err
  }
  if (options.apiKeyId) {
    waitUntil(persistFromEventResult(result, state, telemetryCtx))
  }
  return reassembled
}

/**
 * Drain a `ProtocolFrame<MessagesStreamEvent>` stream while folding usage +
 * model identity into `state`. Mirrors `chat-flow/messages/respond.ts`'s
 * `consumeWithState` so both paths emit identical telemetry.
 */
async function* consumeFramesWithState(
  events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  state: SourceStreamState,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        state.rememberUsage(frame.event)
        const evObj = frame.event as {
          model?: unknown
          response?: { model?: unknown }
          message?: { model?: unknown }
        }
        state.rememberModelKey(evObj.model ?? evObj.response?.model ?? evObj.message?.model)
      }
      yield frame
    }
  } catch (err) {
    state.failedAfter()
    throw err
  }
}

async function persistFromEventResult(
  result: import('@vibe-llm/protocols/common').LlmEventResult<ProtocolFrame<MessagesStreamEvent>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext,
): Promise<void> {
  const md = await eventResultMetadata(result)
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : { ...md.modelIdentity, modelKey: state.modelKey }
  await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
  await recordPerformance(telemetryCtx, md.performance, state.failed)
}

function isWebSearchTool(tool: ClientTool): tool is WebSearchTool {
  return tool.name === "web_search"
}

const hasWebSearchTool = (tools?: ClientTool[]): WebSearchTool | null => {
  if (!Array.isArray(tools)) return null

  const found = tools.find(isWebSearchTool)
  return found || null
}

const removeWebSearchTool = (tools: ClientTool[]): ClientTool[] => {
  return tools.filter((tool) => !isWebSearchTool(tool))
}

interface ClassifyResult {
  webSearchToolUses: ToolUseBlock[]
  hasOtherTools: boolean
}

function classifyToolUses(content: MessageContent[]): ClassifyResult {
  const allToolUses = content.filter(
    (block) => block.type === "tool_use",
  ) as ToolUseBlock[]
  const webSearchToolUses = allToolUses.filter(
    (t) => t.name === "web_search" && t.id && t.input,
  )
  const hasOtherTools = allToolUses.length > webSearchToolUses.length

  return { webSearchToolUses, hasOtherTools }
}

function filterThinkingBlocks(content: MessageContent[]): MessageContent[] {
  return content.filter(
    (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
  )
}

async function executeAllSearches(
  toolUses: ToolUseBlock[],
  webSearchTool: WebSearchTool,
  searchCount: number,
  maxUses: number,
  meta: WebSearchMeta,
  engineManager: EngineManager,
): Promise<{
  toolResults: ReturnType<typeof createToolResult>[]
  searchCount: number
  searches: Array<{ toolUseId: string; query: string; isError: boolean }>
}> {
  const toolResults = []
  const searches: Array<{ toolUseId: string; query: string; isError: boolean }> = []
  for (const toolUse of toolUses) {
    searchCount++
    const { content, isError, resultCount, engineName } =
      await handleSearchExecution(
        toolUse,
        webSearchTool,
        searchCount,
        maxUses,
        engineManager,
        meta,
      )
    meta.totalResults += resultCount
    if (isError) {
      meta.failures++
    } else {
      meta.successes++
    }
    if (engineName !== "none" && !meta.enginesUsed.includes(engineName)) {
      meta.enginesUsed.push(engineName)
    }
    toolResults.push(createToolResult(toolUse.id, content, isError))
    searches.push({
      toolUseId: toolUse.id,
      query: (toolUse.input as { query?: string }).query ?? "",
      isError,
    })

    if (isError && searchCount > maxUses) {
      break
    }
  }
  meta.searchCount = searchCount
  return { toolResults, searchCount, searches }
}

const createClientWebSearchTool = () => ({
  name: "web_search",
  description:
    "Search the web for current information. Use this when you need to find recent information, news, or answers to questions that require up-to-date knowledge.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to execute",
      },
    },
    required: ["query"],
  },
})

const createToolResult = (
  toolUseId: string,
  content: string,
  isError = false,
) => ({
  type: "tool_result" as const,
  tool_use_id: toolUseId,
  content,
  is_error: isError,
})

const handleSearchExecution = async (
  toolUse: ToolUseBlock,
  webSearchTool: WebSearchTool,
  searchCount: number,
  maxUses: number,
  engineManager: EngineManager,
  meta: WebSearchMeta,
): Promise<SearchExecutionResult> => {
  if (searchCount > maxUses) {
    console.warn(`[Web Search] Max uses (${maxUses}) exceeded`)
    return {
      content: `Error: Maximum web search uses (${maxUses}) exceeded`,
      isError: true,
      resultCount: 0,
      engineName: "none",
    }
  }

  const query = toolUse.input.query || ""
  console.log(`[Web Search] Executing search ${searchCount}/${maxUses}`)

  const searchOptions = {
    allowedDomains: webSearchTool.allowed_domains,
    blockedDomains: webSearchTool.blocked_domains,
  }

  try {
    const { results, engineName, attempts } = await engineManager.search(
      query,
      searchOptions,
    )
    for (const a of attempts) meta.engineAttempts.push(a)

    return {
      content: formatSearchResults(results),
      isError: false,
      resultCount: results.length,
      engineName,
    }
  } catch (error) {
    console.error("[Web Search] Search failed:", error)

    return {
      content: `Error: Search failed - ${(error as Error).message}`,
      isError: true,
      resultCount: 0,
      engineName: "none",
    }
  }
}

export interface InterceptOptions extends CallOptions {
  engineOptions: EngineManagerOptions
}

/** Tool result block for sending back search results */
interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error: boolean
}

/**
 * Intercept web_search tool calls in non-streaming Messages API
 */
export interface MessagesInterceptedSearch {
  toolUseId: string
  query: string
  isError: boolean
}

export async function interceptWebSearch(
  payload: MessagesPayload,
  options: InterceptOptions,
): Promise<{ response: ApiResponse; meta: WebSearchMeta; searches: MessagesInterceptedSearch[] }> {
  const tools = payload.tools
  const webSearchTool = hasWebSearchTool(tools)

  const engineManager = new EngineManager(options.engineOptions)

  if (!webSearchTool) {
    const response = await createMessages(payload, options)
    return { response, meta: emptyMeta(), searches: [] }
  }

  console.log("[Web Search] Intercepting web_search tool")

  const otherTools = tools ? removeWebSearchTool(tools) : []
  const modifiedPayload: MessagesPayload = {
    ...payload,
    tools: [...otherTools, createClientWebSearchTool()],
  }

  let searchCount = 0
  const meta: WebSearchMeta = emptyMeta()
  const allSearches: MessagesInterceptedSearch[] = []
  const maxUses = Math.min(
    webSearchTool.max_uses || MAX_USES_HARD_LIMIT,
    MAX_USES_HARD_LIMIT,
  )
  const messages = [...(payload.messages || [])]
  const loopStart = Date.now()
  let iter = 0

  while (true) {
    iter++
    const iterStart = Date.now()
    const response = await createMessages(
      { ...modifiedPayload, messages },
      options,
    )
    const upstreamMs = Date.now() - iterStart
    // Only log slow iterations or beyond the first round (interesting cases)
    if (iter > 1 || upstreamMs > 10000) {
      console.log(JSON.stringify({
        evt: "ws_iter", iter, upstreamMs,
        stop_reason: (response as { stop_reason?: string }).stop_reason,
      }))
    }

    const { webSearchToolUses, hasOtherTools } = classifyToolUses(
      response.content || [],
    )

    if (webSearchToolUses.length === 0 || hasOtherTools) {
      if (hasOtherTools && webSearchToolUses.length > 0) {
        console.log(
          "[Web Search] Response contains other tools, returning to client",
        )
      }
      return { response, meta, searches: allSearches }
    }

    console.log(`[Web Search] Found ${webSearchToolUses.length} web_search tool(s)`)

    messages.push({
      role: "assistant",
      content: filterThinkingBlocks(response.content),
    })

    const result = await executeAllSearches(
      webSearchToolUses,
      webSearchTool,
      searchCount,
      maxUses,
      meta,
      engineManager,
    )
    searchCount = result.searchCount
    for (const s of result.searches) allSearches.push(s)

    // Add tool results as user message
    const toolResultsContent: MessageContent[] = result.toolResults.map((tr) => ({
      type: tr.type,
      tool_use_id: tr.tool_use_id,
      content: tr.content,
      is_error: tr.is_error,
    }))
    messages.push({
      role: "user",
      content: toolResultsContent,
    })

    if (searchCount >= maxUses) {
      console.log(JSON.stringify({
        evt: "ws_max_uses_final_call",
        iter,
        searchCount,
        maxUses,
        elapsedMs: Date.now() - loopStart,
      }))
      const finalStart = Date.now()
      const finalResponse = await createMessages(
        { ...modifiedPayload, messages },
        options,
      )
      console.log(JSON.stringify({
        evt: "ws_final_done",
        finalUpstreamMs: Date.now() - finalStart,
        totalLoopMs: Date.now() - loopStart,
      }))
      return { response: finalResponse, meta, searches: allSearches }
    }
  }
}

/**
 * Check if payload has web_search tool
 */
export function hasWebSearch(payload: MessagesPayload): boolean {
  return hasWebSearchTool(payload.tools) !== null
}

/**
 * Prepare payload for streaming with web search
 * Returns modified payload and web search tool config
 */
export function prepareWebSearchPayload(payload: MessagesPayload): {
  modifiedPayload: MessagesPayload
  webSearchTool: WebSearchTool | null
} {
  const tools = payload.tools
  const webSearchTool = hasWebSearchTool(tools)

  if (!webSearchTool) {
    return { modifiedPayload: payload, webSearchTool: null }
  }

  const otherTools = tools ? removeWebSearchTool(tools) : []
  const modifiedPayload: MessagesPayload = {
    ...payload,
    tools: [...otherTools, createClientWebSearchTool()],
  }

  return { modifiedPayload, webSearchTool }
}

export { classifyToolUses, filterThinkingBlocks, createToolResult }
export type { MessagesPayload, ClientTool }
