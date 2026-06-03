import { z } from 'zod'

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

const ThinkingBlock = z.object({
  type: z.union([z.literal('thinking'), z.literal('redacted_thinking')]),
}).loose()

const ContentBlock = z.union([TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock])

const Message = z.object({
  role: z.union([z.literal('user'), z.literal('assistant')]),
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
