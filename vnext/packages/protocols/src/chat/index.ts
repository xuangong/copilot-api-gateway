import { z } from 'zod'

const ContentPart = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).loose(),
  z.object({ type: z.literal('image_url'), image_url: z.union([z.string(), z.object({ url: z.string() }).loose()]) }).loose(),
  z.object({ type: z.literal('input_audio'), input_audio: z.unknown() }).loose(),
])

const ToolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }).loose(),
}).loose()

const Message = z.object({
  role: z.union([z.literal('system'), z.literal('user'), z.literal('assistant'), z.literal('tool'), z.literal('developer')]),
  content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
}).loose()

const Tool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().optional(),
  }).loose(),
}).loose()

export const ChatPayloadSchema = z.object({
  model: z.string(),
  messages: z.array(Message),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().int().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().optional(),
  max_completion_tokens: z.number().int().optional(),
  tools: z.array(Tool).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
  reasoning_effort: z.string().optional(),
  parallel_tool_calls: z.boolean().optional(),
  user: z.string().optional(),
}).loose()

export type ChatPayload = z.infer<typeof ChatPayloadSchema>

export type {
  ChatCompletionsStreamEvent,
  ChatCompletionsDelta,
  ChatCompletionsToolCall,
  ChatCompletionsReasoningItem,
  ChatCompletionsChoiceStreaming,
  ChatCompletionsUsage,
} from './events.ts'
