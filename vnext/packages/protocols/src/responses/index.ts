import { z } from 'zod'

const InputContent = z.union([
  z.object({ type: z.literal('input_text'), text: z.string() }).loose(),
  z.object({ type: z.literal('input_image'), image_url: z.string(), detail: z.string().optional() }).loose(),
  z.object({ type: z.literal('input_file'), file_id: z.string().optional(), filename: z.string().optional() }).loose(),
])

const InputItem = z.union([
  z.object({
    type: z.literal('message'),
    role: z.union([z.literal('user'), z.literal('assistant'), z.literal('system'), z.literal('developer')]),
    content: z.union([z.string(), z.array(InputContent)]),
  }).loose(),
  // function_call / function_call_output / reasoning / image_generation_call / web_search_call ...
  z.object({ type: z.string() }).loose(),
])

const Tool = z.union([
  z.object({
    type: z.literal('function'),
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().optional(),
  }).loose(),
  z.object({ type: z.string() }).loose(), // web_search / image_generation / code_interpreter ...
])

export const ResponsesPayloadSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(InputItem)]),
  instructions: z.string().optional(),
  previous_response_id: z.string().optional(),
  tools: z.array(Tool).optional(),
  tool_choice: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  max_output_tokens: z.number().int().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stream: z.boolean().optional(),
  store: z.boolean().optional(),
  parallel_tool_calls: z.boolean().optional(),
  metadata: z.unknown().optional(),
  text: z.unknown().optional(),
  user: z.string().optional(),
}).loose()

export type ResponsesPayload = z.infer<typeof ResponsesPayloadSchema>

export type {
  ResponsesStreamEvent,
  ResponsesStreamEventVariant,
  ResponsesResult,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesOutputContentBlock,
  ResponsesOutputText,
  ResponsesOutputRefusal,
  ResponsesOutputFunctionCall,
  ResponsesOutputCustomToolCall,
  ResponsesOutputReasoning,
  ResponsesOutputWebSearchCall,
  ResponsesOutputImageGenerationCall,
  ResponsesWebSearchAction,
  ResponsesWebSearchResult,
  ResponsesReasoningItem,
  ResponsesInputContent,
  ResponsesInputText,
  ResponsesInputImage,
  ResponsesInputReasoning,
  ResponsesFunctionCallOutputItem,
  ResponsesCustomToolCallOutputItem,
  ResponsesPermissiveItem,
  ResponsesFileSearchCallItem,
  ResponsesComputerCallItem,
  ResponsesComputerCallOutputItem,
  ResponsesToolSearchCallItem,
  ResponsesToolSearchOutputItem,
  ResponsesCompactionItem,
  ResponsesCodeInterpreterCallItem,
  ResponsesLocalShellCallItem,
  ResponsesLocalShellCallOutputItem,
  ResponsesShellCallItem,
  ResponsesShellCallOutputItem,
  ResponsesApplyPatchCallItem,
  ResponsesApplyPatchCallOutputItem,
  ResponsesMcpCallItem,
  ResponsesMcpListToolsItem,
  ResponsesMcpApprovalRequestItem,
  ResponsesMcpApprovalResponseItem,
} from './events.ts'
export { isResponsesTerminalEvent, responsesResultFromStreamEvent } from './events.ts'
