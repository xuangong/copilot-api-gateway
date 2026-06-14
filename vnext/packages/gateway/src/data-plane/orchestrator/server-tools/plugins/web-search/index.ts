/**
 * Web-search plugin entry — Week 4b-3 port.
 *
 * Why this looks different from the ServerToolPlugin contract:
 * Anthropic Messages web_search is a whole-request shim: the gateway runs
 * the multi-turn loop OUTSIDE the upstream stream, then replays the final
 * response. The Responses hosted-tool 4-tuple (isHostedTool / buildFunctionTool
 * / dispatcher / transformItems) is geared toward per-call dispatch on a live
 * SSE stream — it does not fit the Messages loop shape. So this plugin
 * exposes a `handleMessagesWebSearch` route helper and `hasWebSearch` guard
 * the Messages frontend adapter calls; the ServerToolPlugin registration
 * lands in Week 4b-4 alongside image-generation (which IS a real Responses
 * hosted-tool and exercises the 3-tuple end-to-end).
 */
export {
  hasWebSearch,
  interceptWebSearch,
  prepareWebSearchPayload,
  classifyToolUses,
  filterThinkingBlocks,
  createToolResult,
} from './interceptor.ts'
export type {
  InterceptOptions,
  MessagesPayload,
  ClientTool,
  MessagesInterceptedSearch,
} from './interceptor.ts'

export {
  MAX_USES_HARD_LIMIT,
  emptyMeta,
  executeWebSearch,
  loadWebSearchConfig,
  addWebSearchHeaders,
  recordWebSearchUsage,
} from './core.ts'
export type { WebSearchConfigResult, SearchExecutionResult } from './core.ts'

export { resolveWebSearchKeys, invalidateResolverCache, isKeyVisibleTo } from './resolver.ts'
export type { ResolvedWebSearchKeys } from './resolver.ts'

export { formatSearchResults } from './formatter.ts'

export { replayResponseAsSSE } from './sse-replay.ts'

export { EngineManager, ENGINE_IDS } from './engine-manager.ts'
export type { EngineManagerOptions, EngineAttempt, EngineId } from './engine-manager.ts'

export {
  BingSearchEngine,
  CopilotSearchEngine,
  LangSearchEngine,
  MicrosoftGroundingEngine,
  TavilySearchEngine,
  QuotaExceededError,
  filterByDomain,
} from './engines/index.ts'
export type { SearchEngine, SearchOptions } from './engines/index.ts'

export type {
  SearchResult,
  WebSearchTool,
  ToolUseBlock,
  ToolResultBlock,
  MessageContent,
  Message,
  ApiResponse,
  WebSearchMeta,
  ToolInput,
  ApiUsage,
} from './types.ts'

export { handleMessagesWebSearch } from './route-handler.ts'
export type { WebSearchRouteContext } from './route-handler.ts'
