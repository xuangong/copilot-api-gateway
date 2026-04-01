import type { AccountType } from "~/config/constants"
import { callCopilotAPI } from "~/services/copilot"

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
  const response = await callCopilotAPI({
    endpoint: "/v1/messages",
    payload: payload as unknown as Record<string, unknown>,
    operationName: "create message",
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  })
  return response.json() as Promise<ApiResponse>
}

// Helper to call Copilot API and get stream
async function createMessagesStream(
  payload: MessagesPayload,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array>> {
  const response = await callCopilotAPI({
    endpoint: "/v1/messages",
    payload: { ...payload, stream: true } as unknown as Record<string, unknown>,
    operationName: "create message stream",
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  })
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
}> {
  const toolResults = []
  for (const toolUse of toolUses) {
    searchCount++
    const { content, isError, resultCount, engineName } =
      await handleSearchExecution(
        toolUse,
        webSearchTool,
        searchCount,
        maxUses,
        engineManager,
      )
    meta.totalResults += resultCount
    if (engineName !== "none" && !meta.enginesUsed.includes(engineName)) {
      meta.enginesUsed.push(engineName)
    }
    toolResults.push(createToolResult(toolUse.id, content, isError))

    if (isError && searchCount > maxUses) {
      break
    }
  }
  meta.searchCount = searchCount
  return { toolResults, searchCount }
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
    const { results, engineName } = await engineManager.search(
      query,
      searchOptions,
    )

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
export async function interceptWebSearch(
  payload: MessagesPayload,
  options: InterceptOptions,
): Promise<{ response: ApiResponse; meta: WebSearchMeta }> {
  const tools = payload.tools
  const webSearchTool = hasWebSearchTool(tools)

  const engineManager = new EngineManager(options.engineOptions)

  if (!webSearchTool) {
    const response = await createMessages(payload, options)
    return { response, meta: emptyMeta() }
  }

  console.log("[Web Search] Intercepting web_search tool")

  const otherTools = tools ? removeWebSearchTool(tools) : []
  const modifiedPayload: MessagesPayload = {
    ...payload,
    tools: [...otherTools, createClientWebSearchTool()],
  }

  let searchCount = 0
  const meta: WebSearchMeta = emptyMeta()
  const maxUses = Math.min(
    webSearchTool.max_uses || MAX_USES_HARD_LIMIT,
    MAX_USES_HARD_LIMIT,
  )
  const messages = [...(payload.messages || [])]

  while (true) {
    const response = await createMessages(
      { ...modifiedPayload, messages },
      options,
    )

    const { webSearchToolUses, hasOtherTools } = classifyToolUses(
      response.content || [],
    )

    if (webSearchToolUses.length === 0 || hasOtherTools) {
      if (hasOtherTools && webSearchToolUses.length > 0) {
        console.log(
          "[Web Search] Response contains other tools, returning to client",
        )
      }
      return { response, meta }
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
      const finalResponse = await createMessages(
        { ...modifiedPayload, messages },
        options,
      )
      return { response: finalResponse, meta }
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
