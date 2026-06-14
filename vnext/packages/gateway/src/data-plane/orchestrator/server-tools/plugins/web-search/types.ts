export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchTool {
  type: string
  name: string
  max_uses?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface ToolInput {
  query?: string
  [key: string]: string | number | boolean | null | undefined
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: ToolInput
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface MessageContent {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: ToolInput
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

export interface Message {
  role: "user" | "assistant"
  content: string | MessageContent[]
}

export interface ApiUsage {
  input_tokens: number
  output_tokens: number
}

export interface ApiResponse {
  id: string
  type: string
  role: string
  model: string
  content: MessageContent[]
  stop_reason: string
  usage?: ApiUsage
}

export interface WebSearchMeta {
  searchCount: number
  totalResults: number
  enginesUsed: string[]
  successes: number
  failures: number
  engineAttempts: Array<{
    engineId: string
    ok: boolean
    resultCount: number
    durationMs: number
  }>
}
