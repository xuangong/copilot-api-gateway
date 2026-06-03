import type { AccountType } from "~/config/constants"
import { createCopilotProvider } from "~/providers/registry"

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
  copilotToken: string
  accountType: AccountType
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

// Helper to call Copilot API and get JSON response
async function createMessages(
  payload: MessagesPayload,
  options: CallOptions,
): Promise<ApiResponse> {
  const response = await createCopilotProvider({
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  }).fetch(
    "messages",
    { method: "POST", body: JSON.stringify(payload) },
    { operationName: "create message" },
  )
  return response.json() as Promise<ApiResponse>
}

// Helper to call Copilot API and get stream
async function createMessagesStream(
  payload: MessagesPayload,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array>> {
  const response = await createCopilotProvider({
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  }).fetch(
    "messages",
    { method: "POST", body: JSON.stringify({ ...payload, stream: true }) },
    { operationName: "create message stream" },
  )
  return response.body!
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

/**
 * Run the web_search ReAct loop and stop **before** the terminal LLM call.
 * Returns the conversation state (`messages`) at the moment the loop is done
 * dispatching searches. The caller decides how to make the terminal call:
 *   - non-streaming client → `createMessages(messages)` → JSON
 *   - streaming client     → `provider.fetch(stream: true)` → pipe upstream
 *                            body directly to client (real per-token cadence,
 *                            no replay, no faked pacing)
 *
 * Returns `kind: "terminal_required"` when the loop ended naturally (model
 * stopped issuing web_search) — in that case `messages` is ready for the
 * caller's terminal call.
 *
 * Returns `kind: "complete"` when the loop ended with an early-exit response
 * that is itself the final assistant turn (e.g. the model emitted a
 * non-web_search tool alongside web_search — we surface that response as-is
 * without making a terminal call).
 */
export type LoopResult =
  | {
      kind: "terminal_required"
      messages: Message[]
      modifiedPayload: MessagesPayload
      meta: WebSearchMeta
      searches: MessagesInterceptedSearch[]
    }
  | {
      kind: "complete"
      response: ApiResponse
      meta: WebSearchMeta
      searches: MessagesInterceptedSearch[]
    }

export async function runWebSearchLoop(
  payload: MessagesPayload,
  options: InterceptOptions,
): Promise<LoopResult> {
  const tools = payload.tools
  const webSearchTool = hasWebSearchTool(tools)

  const engineManager = new EngineManager(options.engineOptions)

  if (!webSearchTool) {
    const response = await createMessages(payload, options)
    return { kind: "complete", response, meta: emptyMeta(), searches: [] }
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
    if (iter > 1 || upstreamMs > 10000) {
      console.log(JSON.stringify({
        evt: "ws_iter", iter, upstreamMs,
        stop_reason: (response as { stop_reason?: string }).stop_reason,
      }))
    }

    const { webSearchToolUses, hasOtherTools } = classifyToolUses(
      response.content || [],
    )

    // Early exit: model returned a non-web_search tool alongside (or instead
    // of) web_search. This response IS the terminal turn — surface it as-is.
    if (hasOtherTools) {
      if (webSearchToolUses.length > 0) {
        console.log("[Web Search] Response contains other tools, returning to client")
      }
      return { kind: "complete", response, meta, searches: allSearches }
    }

    // Natural terminal: model stopped issuing web_search. We DROP this
    // response's text content (caller will re-call upstream to get the
    // terminal turn — streaming if the client wants stream:true). The
    // alternative — reusing this response's text — only works for the
    // non-streaming caller, and we'd rather have one code path.
    if (webSearchToolUses.length === 0) {
      console.log(JSON.stringify({
        evt: "ws_loop_done", iter, searchCount, totalLoopMs: Date.now() - loopStart,
      }))
      return {
        kind: "terminal_required",
        messages,
        modifiedPayload,
        meta,
        searches: allSearches,
      }
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
        evt: "ws_max_uses_terminal",
        iter, searchCount, maxUses, elapsedMs: Date.now() - loopStart,
      }))
      return {
        kind: "terminal_required",
        messages,
        modifiedPayload,
        meta,
        searches: allSearches,
      }
    }
  }
}

/**
 * Legacy entry: run loop to completion and produce a full JSON ApiResponse
 * (terminal call is always non-streaming). Kept for non-streaming clients
 * and for back-compat with callers that still expect the old shape.
 */
export async function interceptWebSearch(
  payload: MessagesPayload,
  options: InterceptOptions,
): Promise<{ response: ApiResponse; meta: WebSearchMeta; searches: MessagesInterceptedSearch[] }> {
  const result = await runWebSearchLoop(payload, options)
  if (result.kind === "complete") {
    return { response: result.response, meta: result.meta, searches: result.searches }
  }
  const finalStart = Date.now()
  const finalResponse = await createMessages(
    { ...result.modifiedPayload, messages: result.messages },
    options,
  )
  console.log(JSON.stringify({
    evt: "ws_terminal_nonstream_done",
    finalUpstreamMs: Date.now() - finalStart,
  }))
  return { response: finalResponse, meta: result.meta, searches: result.searches }
}

/**
 * Streaming-terminal helper: take a loop result that needs a terminal call,
 * dispatch it upstream with `stream: true`, and return the raw upstream SSE
 * body. The caller is expected to pipe this directly to the downstream
 * response — every byte is real upstream cadence, no replay involved.
 */
export async function streamTerminalCall(
  result: Extract<LoopResult, { kind: "terminal_required" }>,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array>> {
  return createMessagesStream(
    { ...result.modifiedPayload, messages: result.messages },
    options,
  )
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
