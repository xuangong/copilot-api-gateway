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
} from "./types"

export { formatSearchResults } from "./formatter"

export { EngineManager } from "./engine-manager"
export type { EngineManagerOptions } from "./engine-manager"

export type { SearchEngine, SearchOptions } from "./engines"
export { BingSearchEngine, LangSearchEngine, TavilySearchEngine } from "./engines"

export {
  interceptWebSearch,
  hasWebSearch,
  prepareWebSearchPayload,
  classifyToolUses,
  filterThinkingBlocks,
  createToolResult,
} from "./interceptor"
export type { InterceptOptions, MessagesPayload, ClientTool } from "./interceptor"

export { replayResponseAsSSE } from "./sse-replay"

export {
  MAX_USES_HARD_LIMIT,
  emptyMeta,
  executeWebSearch,
  loadWebSearchConfig,
  addWebSearchHeaders,
  recordWebSearchUsage,
} from "./core"
export type { WebSearchConfigResult, SearchExecutionResult } from "./core"

export {
  hasOpenAIWebSearch,
  prepareOpenAIPayload,
  interceptOpenAIChat,
} from "./openai-interceptor"
export type {
  OpenAIChatPayload,
  OpenAIChatResponse,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolCall,
  InterceptOpenAIOptions,
} from "./openai-interceptor"

export {
  replayChatCompletionAsSSE,
  synthChatCompletionChunks,
} from "./openai-sse-replay"

export {
  hasResponsesWebSearch,
  interceptResponsesViaChat,
} from "./responses-interceptor"
export type {
  InterceptResponsesOptions,
  InterceptResponsesResult,
} from "./responses-interceptor"

export {
  hasGeminiWebSearch,
  interceptGeminiViaChat,
} from "./gemini-interceptor"
export type {
  InterceptGeminiOptions,
  InterceptGeminiResult,
} from "./gemini-interceptor"
