// Ported from copilot-gateway/packages/protocols/src/responses/index.ts
// Verbatim port of the response/output/stream-event types and
// `isResponsesTerminalEvent` helper. Types only — no zod schemas.

// ── Input-side mirror types referenced from output items / stream events ──

export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage

export interface ResponsesInputText {
  type: 'input_text' | 'output_text'
  text: string
}

export interface ResponsesInputImage {
  type: 'input_image'
  image_url: string
  detail: 'auto' | 'low' | 'high'
}

export interface ResponsesInputReasoning {
  type: 'reasoning'
  id: string
  summary: { type: 'summary_text'; text: string }[]
  encrypted_content?: string
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  id?: string
  call_id: string
  output: string | ResponsesInputContent[]
  status?: 'completed' | 'incomplete'
}

export interface ResponsesCustomToolCallOutputItem {
  type: 'custom_tool_call_output'
  call_id: string
  output: string
  id?: string
  status?: string
}

export interface ResponsesPermissiveItem<TType extends string> {
  type: TType
  id?: string
  call_id?: string
  status?: string
  output?: unknown
  body?: unknown
  [key: string]: unknown
}

export interface ResponsesFileSearchCallItem extends ResponsesPermissiveItem<'file_search_call'> {
  queries?: string[]
  results?: unknown[]
}

export interface ResponsesComputerCallItem extends ResponsesPermissiveItem<'computer_call'> {
  call_id: string
  action?: unknown
  pending_safety_checks?: unknown[]
}

export interface ResponsesComputerCallOutputItem extends ResponsesPermissiveItem<'computer_call_output'> {
  call_id: string
  output?: unknown
  acknowledged_safety_checks?: unknown[]
}

export interface ResponsesToolSearchCallItem extends ResponsesPermissiveItem<'tool_search_call'> {
  call_id?: string
  query?: string
  results?: unknown[]
}

export interface ResponsesToolSearchOutputItem extends ResponsesPermissiveItem<'tool_search_output'> {
  call_id?: string
  output?: unknown
}

export type ResponsesCompactionItem = ResponsesPermissiveItem<'compaction'>

export interface ResponsesCodeInterpreterCallItem extends ResponsesPermissiveItem<'code_interpreter_call'> {
  call_id?: string
  code?: string
  results?: unknown[]
}

export interface ResponsesLocalShellCallItem extends ResponsesPermissiveItem<'local_shell_call'> {
  call_id: string
  command?: string
}

export interface ResponsesLocalShellCallOutputItem extends ResponsesPermissiveItem<'local_shell_call_output'> {
  call_id: string
  output?: unknown
}

export interface ResponsesShellCallItem extends ResponsesPermissiveItem<'shell_call'> {
  call_id: string
  command?: string
}

export interface ResponsesShellCallOutputItem extends ResponsesPermissiveItem<'shell_call_output'> {
  call_id: string
  output?: unknown
}

export interface ResponsesApplyPatchCallItem extends ResponsesPermissiveItem<'apply_patch_call'> {
  call_id: string
  patch?: string
}

export interface ResponsesApplyPatchCallOutputItem extends ResponsesPermissiveItem<'apply_patch_call_output'> {
  call_id: string
  output?: unknown
}

export interface ResponsesMcpCallItem extends ResponsesPermissiveItem<'mcp_call'> {
  call_id: string
  name?: string
  arguments?: unknown
  output?: unknown
}

export interface ResponsesMcpListToolsItem extends ResponsesPermissiveItem<'mcp_list_tools'> {
  tools?: unknown[]
}

export interface ResponsesMcpApprovalRequestItem extends ResponsesPermissiveItem<'mcp_approval_request'> {
  call_id?: string
}

export interface ResponsesMcpApprovalResponseItem extends ResponsesPermissiveItem<'mcp_approval_response'> {
  call_id?: string
  output?: unknown
}

// ── Response result + output items ──

export interface ResponsesResult {
  id: string
  object: string
  model: string
  output: ResponsesOutputItem[]
  output_text?: string
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress'
  incomplete_details: { reason: string } | null
  error: { message: string; code: string; type?: string } | null
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens: number }
    output_tokens_details?: { reasoning_tokens: number }
  }
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesFunctionCallOutputItem
  | ResponsesOutputCustomToolCall
  | ResponsesCustomToolCallOutputItem
  | ResponsesOutputReasoning
  | ResponsesOutputWebSearchCall
  | ResponsesFileSearchCallItem
  | ResponsesComputerCallItem
  | ResponsesComputerCallOutputItem
  | ResponsesToolSearchCallItem
  | ResponsesToolSearchOutputItem
  | ResponsesCompactionItem
  | ResponsesCodeInterpreterCallItem
  | ResponsesLocalShellCallItem
  | ResponsesLocalShellCallOutputItem
  | ResponsesShellCallItem
  | ResponsesShellCallOutputItem
  | ResponsesApplyPatchCallItem
  | ResponsesApplyPatchCallOutputItem
  | ResponsesMcpCallItem
  | ResponsesMcpListToolsItem
  | ResponsesMcpApprovalRequestItem
  | ResponsesMcpApprovalResponseItem
  | ResponsesOutputImageGenerationCall

export interface ResponsesOutputMessage {
  type: 'message'
  id?: string
  status?: string
  role: 'assistant'
  content: ResponsesOutputContentBlock[]
}

export type ResponsesOutputContentBlock = ResponsesOutputText | ResponsesOutputRefusal

export interface ResponsesOutputText {
  type: 'output_text'
  text: string
}

export interface ResponsesOutputRefusal {
  type: 'refusal'
  refusal: string
}

export interface ResponsesOutputFunctionCall {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
  status: string
}

export interface ResponsesOutputCustomToolCall {
  type: 'custom_tool_call'
  call_id: string
  name: string
  input: string
  id?: string
  namespace?: string
  status?: string
}

export interface ResponsesOutputReasoning {
  type: 'reasoning'
  id: string
  summary: { type: 'summary_text'; text: string }[]
  encrypted_content?: string
}

export type ResponsesWebSearchAction =
  | { type: 'search'; query?: string; queries?: string[]; sources?: { type: 'url'; url: string }[] }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url: string; pattern: string }

export interface ResponsesWebSearchResult {
  type: 'text_result'
  url: string
  title: string
  snippet: string
}

export interface ResponsesOutputWebSearchCall {
  type: 'web_search_call'
  id: string
  status: 'in_progress' | 'searching' | 'completed' | 'failed'
  action?: ResponsesWebSearchAction
  results?: ResponsesWebSearchResult[]
}

export interface ResponsesOutputImageGenerationCall {
  type: 'image_generation_call'
  id: string
  status: 'in_progress' | 'generating' | 'completed' | 'failed'
  result?: string
  revised_prompt?: string
  action?: 'generate' | 'edit'
  background?: 'transparent' | 'opaque'
  output_format?: 'png' | 'jpeg'
  quality?: 'low' | 'medium' | 'high'
  size?: string
  error?: { message: string; code: string; type?: string }
}

// ── Stream event types ──

// Spec marks sequence_number required, but some Copilot upstreams omit it
// on the wire; the stream parser backfills a monotonic counter when missing.
export type ResponsesStreamEvent = ResponsesStreamEventVariant & { sequence_number?: number }

export type ResponsesStreamEventVariant =
  | { type: 'response.created'; response: ResponsesResult }
  | { type: 'response.in_progress'; response: ResponsesResult }
  | {
    type: 'response.output_item.added'
    output_index: number
    item: ResponsesOutputItem
  }
  | {
    type: 'response.output_item.done'
    output_index: number
    item: ResponsesOutputItem
  }
  | {
    type: 'response.content_part.added'
    item_id: string
    output_index: number
    content_index: number
    part: ResponsesOutputContentBlock
  }
  | {
    type: 'response.content_part.done'
    item_id: string
    output_index: number
    content_index: number
    part: ResponsesOutputContentBlock
  }
  | {
    type: 'response.reasoning_summary_part.added'
    item_id: string
    output_index: number
    summary_index: number
    part: { type: 'summary_text'; text: string }
  }
  | {
    type: 'response.reasoning_summary_part.done'
    item_id: string
    output_index: number
    summary_index: number
    part: { type: 'summary_text'; text: string }
  }
  | {
    type: 'response.reasoning_summary_text.delta'
    item_id: string
    output_index: number
    summary_index: number
    delta: string
  }
  | {
    type: 'response.reasoning_summary_text.done'
    item_id: string
    output_index: number
    summary_index: number
    text: string
  }
  | {
    type: 'response.output_text.delta'
    item_id: string
    output_index: number
    content_index: number
    delta: string
  }
  | {
    type: 'response.output_text.done'
    item_id: string
    output_index: number
    content_index: number
    text: string
  }
  | {
    type: 'response.output_text.annotation.added'
    output_index: number
    content_index: number
    annotation_index: number
    item_id: string
    annotation:
      | {
        type: 'url_citation'
        url: string
        title: string
        start_index: number
        end_index: number
      }
  }
  | {
    type: 'response.web_search_call.in_progress'
    output_index: number
    item_id: string
  }
  | {
    type: 'response.web_search_call.searching'
    output_index: number
    item_id: string
  }
  | {
    type: 'response.web_search_call.completed'
    output_index: number
    item_id: string
  }
  | {
    type: 'response.image_generation_call.in_progress'
    output_index: number
    item_id: string
  }
  | {
    type: 'response.image_generation_call.generating'
    output_index: number
    item_id: string
  }
  | {
    type: 'response.image_generation_call.partial_image'
    output_index: number
    item_id: string
    partial_image_index: number
    partial_image_b64: string
    background?: 'transparent' | 'opaque'
    output_format?: 'png' | 'jpeg'
    quality?: 'low' | 'medium' | 'high'
    size?: string
  }
  | {
    type: 'response.image_generation_call.completed'
    output_index: number
    item_id: string
  }
  | {
    type: 'response.function_call_arguments.delta'
    item_id: string
    output_index: number
    delta: string
  }
  | {
    type: 'response.function_call_arguments.done'
    item_id: string
    output_index: number
    arguments: string
  }
  | {
    type: 'response.custom_tool_call_input.delta'
    item_id: string
    output_index: number
    delta: string
  }
  | {
    type: 'response.custom_tool_call_input.done'
    item_id: string
    output_index: number
    input: string
  }
  | { type: 'response.completed'; response: ResponsesResult }
  | { type: 'response.incomplete'; response: ResponsesResult }
  | { type: 'response.failed'; response: ResponsesResult }
  | {
    type: 'error'
    message: string
    code?: string
    name?: string
    stack?: string
    cause?: unknown
    source_api?: string
    target_api?: string
  }
  | { type: 'ping' }

// Either side of the Responses reasoning round trip: input echoes a prior
// turn's reasoning back in, output emits the current turn's reasoning. Shape
// is identical aside from the type tag's role.
export type ResponsesReasoningItem = ResponsesInputReasoning | ResponsesOutputReasoning

export const isResponsesTerminalEvent = (event: Pick<ResponsesStreamEvent, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error'

// Typed accessor for the `response` payload carried on lifecycle envelopes
// (`response.created`, `response.in_progress`, `response.completed`,
// `response.incomplete`, `response.failed`). Returns null on every other
// event type so callers don't have to reproduce the variant check.
export const responsesResultFromStreamEvent = (event: ResponsesStreamEvent): ResponsesResult | null =>
  'response' in event ? event.response : null
