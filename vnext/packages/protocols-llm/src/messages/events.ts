import { z } from 'zod'

/**
 * Anthropic Messages SSE event vocabulary. Pairwise translators consume and
 * emit these as AsyncIterable<MessagesEvent>; HTTP boundary code converts
 * to/from `event: ...\ndata: ...\n\n` text frames.
 */

export const MessageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string(),
    content: z.array(z.unknown()),
    stop_reason: z.string().nullable(),
    stop_sequence: z.string().nullable(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    }).loose(),
  }).loose(),
}).loose()

export const ContentBlockStartEventSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number(),
  content_block: z.unknown(),
}).loose()

export const ContentBlockDeltaEventSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number(),
  delta: z.unknown(),
}).loose()

export const ContentBlockStopEventSchema = z.object({
  type: z.literal('content_block_stop'),
  index: z.number(),
}).loose()

export const MessageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
  }).loose(),
  usage: z.object({}).loose().optional(),
}).loose()

export const MessageStopEventSchema = z.object({ type: z.literal('message_stop') }).loose()
export const PingEventSchema = z.object({ type: z.literal('ping') }).loose()
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string(), message: z.string() }).loose(),
}).loose()

export const MessagesEventSchema = z.union([
  MessageStartEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
  PingEventSchema,
  ErrorEventSchema,
])

export type MessagesEvent = z.infer<typeof MessagesEventSchema>

// ── Verbatim port from copilot-gateway/packages/protocols/src/messages/index.ts ──

export interface MessagesSearchResultLocationCitation {
  type: 'search_result_location'
  url: string
  title: string
  search_result_index: number
  start_block_index: number
  end_block_index: number
  cited_text?: string
}

export interface MessagesWebSearchResultLocation {
  type: 'web_search_result_location'
  url: string
  title: string
  encrypted_index: string
  cited_text?: string
}

export type MessagesTextCitation = MessagesSearchResultLocationCitation | MessagesWebSearchResultLocation

export interface MessagesTextBlock {
  type: 'text'
  text: string
  citations?: MessagesTextCitation[]
  cache_control?: { type: 'ephemeral' }
}

export interface MessagesImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
  cache_control?: { type: 'ephemeral' }
}

export interface MessagesSearchResultBlock {
  type: 'search_result'
  source: string
  title: string
  content: MessagesTextBlock[]
  citations?: { enabled: boolean }
}

export interface MessagesWebSearchResultBlock {
  type: 'web_search_result'
  url: string
  title: string
  encrypted_content: string
  page_age?: string
}

export type MessagesToolResultContentBlock = MessagesTextBlock | MessagesImageBlock | MessagesSearchResultBlock

export interface MessagesToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | MessagesToolResultContentBlock[]
  is_error?: boolean
  cache_control?: { type: 'ephemeral' }
}

export interface MessagesToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  caller?: { type: 'direct' }
  cache_control?: { type: 'ephemeral' }
}

export interface MessagesServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: { query: string }
}

export const MESSAGES_WEB_SEARCH_ERROR_CODES = [
  'too_many_requests',
  'invalid_tool_input',
  'max_uses_exceeded',
  'query_too_long',
  'request_too_large',
  'unavailable',
] as const

export type MessagesWebSearchErrorCode = (typeof MESSAGES_WEB_SEARCH_ERROR_CODES)[number]

export interface MessagesWebSearchToolResultError {
  type: 'web_search_tool_result_error'
  error_code: MessagesWebSearchErrorCode
}

export interface MessagesWebSearchToolResultBlock {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: MessagesWebSearchResultBlock[] | MessagesWebSearchToolResultError
  caller?: { type: 'direct' }
}

export interface MessagesThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface MessagesRedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export type MessagesAssistantContentBlock =
  | MessagesTextBlock
  | MessagesToolUseBlock
  | MessagesServerToolUseBlock
  | MessagesWebSearchToolResultBlock
  | MessagesThinkingBlock
  | MessagesRedactedThinkingBlock

export interface MessagesUsageServerToolUse {
  web_search_requests?: number
}

export interface MessagesUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  service_tier?: 'standard' | 'priority' | 'batch'
  server_tool_use?: MessagesUsageServerToolUse
}

export interface MessagesResult {
  id: string
  type: 'message'
  role: 'assistant'
  content: MessagesAssistantContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | null
  stop_sequence: string | null
  usage: MessagesUsage
}

export type MessagesStreamEvent =
  | MessagesMessageStartEvent
  | MessagesContentBlockStartEvent
  | MessagesContentBlockDeltaEvent
  | MessagesContentBlockStopEvent
  | MessagesMessageDeltaEvent
  | MessagesMessageStopEvent
  | MessagesPingEvent
  | MessagesErrorEvent

export interface MessagesMessageStartEvent {
  type: 'message_start'
  message: Omit<MessagesResult, 'content' | 'stop_reason' | 'stop_sequence'> & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface MessagesContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block:
    | { type: 'text'; text: string; citations?: MessagesTextCitation[] }
    | (Omit<MessagesToolUseBlock, 'input'> & {
      input: Record<string, unknown>
    })
    | MessagesServerToolUseBlock
    | MessagesWebSearchToolResultBlock
    | { type: 'thinking'; thinking: string }
    | { type: 'redacted_thinking'; data: string }
}

export interface MessagesContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta'; text: string; citations?: MessagesTextCitation[] }
    | { type: 'citations_delta'; citation: MessagesTextCitation }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string }
}

export interface MessagesContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface MessagesMessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason?: MessagesResult['stop_reason']
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    server_tool_use?: MessagesUsageServerToolUse
  }
}

export interface MessagesMessageStopEvent {
  type: 'message_stop'
}

export interface MessagesPingEvent {
  type: 'ping'
}

export interface MessagesErrorEvent {
  type: 'error'
  error: {
    type: string
    message: string
    name?: string
    stack?: string
    cause?: unknown
    source_api?: string
    target_api?: string
  }
}
