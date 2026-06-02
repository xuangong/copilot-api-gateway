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
  ResponseItemReference,
} from "./types"

// Billing header transform
export { stripReservedKeywords } from "./billing-header"

// Service tier strip (Copilot rejects service_tier)
export { stripServiceTier, type ServiceTierStripResult } from "./service-tier-strip"

// Tool type transforms
export { fixApplyPatchTools, stripWebSearchTools } from "./tool-type"

// Strip tools[].strict (Vertex-backed Copilot rejects structured_outputs)
export { stripToolStrict } from "./strip-tool-strict"

// x-initiator header classification (Copilot abuse controls / billing)
export {
  classifyMessagesInitiator,
  classifyChatCompletionsInitiator,
  classifyResponsesInitiator,
} from "./set-initiator-header"

// Force store:false on /responses (Copilot rejects store:true)
export { forceStoreFalse } from "./force-store-false"

// Rewrite upstream context-window errors into Anthropic-compactable shape
export {
  isContextWindowError,
  anthropicContextWindowErrorBody,
} from "./rewrite-context-window-error"

// Claude Code metadata + agent headers
export {
  parseUserIdMetadata,
  type ClaudeCodeMetadata,
} from "./detect-claude-code-metadata"
export { setClaudeAgentHeaders } from "./set-claude-agent-headers"

// Attach Copilot's private cache-control markers on Chat Completions messages
export { attachCacheControlMarkers } from "./attach-cache-control-markers"

// Responses → chat-completions payload compactor (codex 413 mitigation)
export { compactResponsesInputForChatFallback } from "./compact-responses-input"
export type { CompactStats } from "./compact-responses-input"

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

// Disable reasoning when caller forces a specific tool (opt-in workaround).
export {
  disableMessagesReasoningOnForcedToolChoice,
  disableResponsesReasoningOnForcedToolChoice,
  disableChatCompletionsReasoningOnForcedToolChoice,
} from "./disable-reasoning-on-forced-tool-choice"

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

// Composed Responses-SSE interceptor: item-id sync + whitespace abort.
export { createResponsesInterceptorStream } from "./responses-sse-interceptor"

// Chat-Completions whitespace abort for tool argument deltas.
export { createChatWhitespaceAbortStream } from "./chat-whitespace-abort"

// Request-side pipelines (composes the per-mutation helpers above in the
// canonical order each route needs).
export {
  runAnthropicMessagesPipeline,
  runAnthropicCountTokensPipeline,
  runResponsesChatFallbackPipeline,
  type AnthropicMessagesPipelineFlags,
  type ResponsesChatFallbackPipelineFlags,
} from "./pipeline"
