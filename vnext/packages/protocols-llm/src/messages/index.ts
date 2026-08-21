import { z } from 'zod'
import type { MessagesThinkingBlock, MessagesRedactedThinkingBlock } from './events.ts'

const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: z.unknown().optional(),
}).loose()

const ImageBlock = z.object({
  type: z.literal('image'),
  source: z.unknown(),
}).loose()

const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
}).loose()

const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
}).loose()

export const MessagesThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
  id: z.string().optional(),
  encryptedContent: z.string().optional(),
}).loose()

export const MessagesRedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
}).loose()

// `MessagesThinkingBlock` / `MessagesRedactedThinkingBlock` interface types
// are exported from `./events.ts` (verbatim port of the upstream protocols
// package). The schema-derived alias previously declared here was removed
// to avoid duplicate exports of the same name.

/** Backwards-compatible alias for the previous loose ThinkingBlock union. */
export type ThinkingBlock = MessagesThinkingBlock | MessagesRedactedThinkingBlock

/**
 * Server-side tool blocks — what the gateway's hosted web-search shim emits.
 *
 * A paused turn (`stop_reason: 'pause_turn'`) hands the conversation back to
 * the client, which must replay the assistant turn verbatim to get the answer.
 * That replay carries these two blocks, so rejecting them here would 400 the
 * gateway's own output and make hosted search unusable past the first turn.
 */
const ServerToolUseBlock = z.object({
  type: z.literal('server_tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
}).loose()

const WebSearchToolResultBlock = z.object({
  type: z.literal('web_search_tool_result'),
  tool_use_id: z.string(),
  // Either the result array or a `web_search_tool_result_error` object.
  content: z.union([z.array(z.unknown()), z.unknown()]).optional(),
}).loose()

const ContentBlock = z.union([
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  MessagesThinkingBlockSchema,
  MessagesRedactedThinkingBlockSchema,
])

const Message = z.object({
  // The Anthropic Messages role enum is user | assistant | system. The docs
  // prose still claims there is no system role for input messages, but the
  // schema and live backend accept it, and Claude Code 2.1.154+ emits
  // interleaved system messages.
  role: z.union([z.literal('user'), z.literal('assistant'), z.literal('system')]),
  content: z.union([z.string(), z.array(ContentBlock)]),
}).loose()

const Tool = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
}).loose()

export const MessagesPayloadSchema = z.object({
  model: z.string(),
  messages: z.array(Message),
  system: z.union([z.string(), z.array(z.unknown())]).optional(),
  max_tokens: z.number().int().positive(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stream: z.boolean().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(Tool).optional(),
  tool_choice: z.unknown().optional(),
  metadata: z.unknown().optional(),
  thinking: z.unknown().optional(),
}).loose()

export type MessagesPayload = z.infer<typeof MessagesPayloadSchema>

// /v1/messages/count_tokens accepts the same shape but does not require
// `max_tokens` (the call doesn't generate). Reuse the messages schema
// loosened only on that field.
export const MessagesCountTokensPayloadSchema = MessagesPayloadSchema.extend({
  max_tokens: z.number().int().positive().optional(),
})

export type MessagesCountTokensPayload = z.infer<typeof MessagesCountTokensPayloadSchema>

export const MessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(ContentBlock),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }).loose(),
}).loose()

export type MessagesResponse = z.infer<typeof MessagesResponseSchema>

export { HUB_VERSION } from './version.ts'
export * from './events.ts'
export { parseMessagesStream, type ParseMessagesStreamOptions } from './stream.ts'

// Fallback `max_tokens` value when the caller omits it and the model catalog
// doesn't advertise `limits.max_output_tokens`. 8192 matches the sub2api
// hard-cap for Claude Code CLI and the Anthropic Messages default cap for
// mid-tier models. Reference:
// copilot-gateway/packages/protocols/src/messages/index.ts.
export const MESSAGES_FALLBACK_MAX_TOKENS = 8192
