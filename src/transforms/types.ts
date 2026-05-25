// Types for Anthropic Messages API payload
export interface AnthropicMessagesPayload {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  system?: string | AnthropicTextBlock[]
  stream?: boolean
  tools?: AnthropicTool[]
  context_management?: Record<string, unknown> | null
  thinking?: {
    type: "enabled" | "adaptive"
    budget_tokens?: number
    /**
     * Anthropic Messages thinking-display preference.
     * - "omitted"    : do not stream thinking deltas; only emit a final signature
     * - "summarized" : stream token-level thinking_delta events continuously
     * - "full"       : stream full thinking content
     *
     * Note: "omitted" causes long silent gaps which can trip the ~60s
     * client-side read-timeout window. See
     * src/transforms/promote-thinking-display.ts for the workaround.
     */
    display?: "omitted" | "summarized" | "full"
  }
  output_config?: {
    effort?: "low" | "medium" | "high"
  }
}

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicImageBlock

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface ToolInput {
  query?: string
  [key: string]: string | number | boolean | null | undefined
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: ToolInput
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content?: string | AnthropicContentBlock[]
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64" | "url"
    media_type?: string
    data?: string
    url?: string
  }
}

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  description?: string
  additionalProperties?: boolean | JsonSchema
}

export interface AnthropicTool {
  type?: string
  name: string
  description?: string
  input_schema?: JsonSchema
}

// Types for OpenAI Responses API payload
export interface ResponsesPayload {
  model: string
  input: string | ResponseInputItem[]
  instructions?: string
  tools?: ResponseTool[] | null
  stream?: boolean
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  tool_choice?: string | { type: string; name?: string }
  parallel_tool_calls?: boolean
  truncation?: string
  store?: boolean
  metadata?: Record<string, string> | null
  previous_response_id?: string | null
  reasoning?: {
    effort: "low" | "medium" | "high"
    summary?: "detailed" | "auto"
  }
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem
  | ResponseItemReference

export interface ResponseInputMessage {
  type: "message"
  role: "user" | "assistant" | "system"
  content: string | ResponseContentBlock[]
}

export interface ResponseFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export interface ResponseItemReference {
  type: "item_reference"
  id: string
}

export interface ResponseContentBlock {
  type: string
  text?: string
}

export interface ResponseTool {
  type: "function" | "custom" | "web_search"
  name?: string
  description?: string
  parameters?: JsonSchema
  strict?: boolean
}
