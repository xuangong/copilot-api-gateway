// Types
export type {
  AnthropicMessagesPayload,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  ResponsesPayload,
  ResponseTool,
} from "./types"

// Billing header transform
export { stripReservedKeywords } from "./billing-header"

// Tool type transforms
export { fixApplyPatchTools, stripWebSearchTools } from "./tool-type"

// Thinking cleanup
export { filterThinkingBlocks, adaptThinkingForModel } from "./thinking-cleanup"

// Promote thinking.display for streaming to avoid silent gaps tripping
// ~60s client-side read timeouts. Pair with the SSE stripper below.
export {
  promoteThinkingDisplayForStreaming,
  type PromoteThinkingDisplayResult,
} from "./promote-thinking-display"

// Cache control cleanup (prompt caching not supported by Copilot)
export { stripCacheControl, type CacheControlStripResult } from "./cache-control"

// Claude Code / Anthropic beta compatibility
export {
  stripContextManagement,
  type ContextManagementStripResult,
} from "./context-management"

// Whitespace guard
export {
  checkWhitespaceOverflow,
  type WhitespaceCheckResult,
} from "./whitespace-guard"

// Streaming ID fix
export {
  createStreamIdTracker,
  fixStreamIds,
  fixChatStreamLine,
  createChatStreamFixer,
  type StreamIdTracker,
} from "./streaming-id-fix"
