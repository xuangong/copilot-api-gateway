/**
 * Barrel for the Copilot-specific transforms used by the package's interceptors.
 * Only the symbols actually consumed by interceptors/* are surfaced here. The
 * gateway's transforms/index.ts re-exports a much wider catalog; we stay
 * deliberately narrow.
 */

export type {
  AnthropicMessagesPayload,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicImageBlock,
  AnthropicTool,
  ResponsesPayload,
  ResponseInputItem,
  ResponseTool,
} from "./types"

export { attachCacheControlMarkers } from "./attach-cache-control-markers"
export {
  attachMessagesCacheBreakpoints,
  type CacheBreakpointInjectionResult,
} from "./attach-messages-cache-breakpoints"
export {
  compressInlineImagesMessages,
  compressInlineImagesChatCompletions,
  compressInlineImagesResponses,
} from "./compress-inline-images"
export {
  parseUserIdMetadata,
  type ClaudeCodeMetadata,
} from "./detect-claude-code-metadata"
export { forceStoreFalse } from "./force-store-false"
export { setClaudeAgentHeaders } from "./set-claude-agent-headers"
export {
  setCompactHeaders,
  classifyCompact,
  type CompactClass,
} from "./set-compact-headers"
export {
  classifyMessagesInitiator,
  classifyChatCompletionsInitiator,
  classifyResponsesInitiator,
} from "./set-initiator-header"
export { setInteractionIdHeader } from "./set-interaction-id-header"
export {
  setMessagesVisionHeader,
  setChatCompletionsVisionHeader,
  setResponsesVisionHeader,
} from "./set-vision-header"
export {
  stripImageGeneration,
  hasResponsesImageGenerationTool,
} from "./strip-image-generation"
export { stripSafetyIdentifier } from "./strip-safety-identifier"
export { stripStructuredOutputFormat } from "./strip-structured-output-format"
export { runCountTokensPrelude } from "./count-tokens-prelude"
