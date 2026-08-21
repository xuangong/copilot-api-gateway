// Ported from copilot-gateway/packages/protocols/src/chat-completions/index.ts
export interface ChatCompletionsToolCall {
  id?: string
  type?: 'function'
  index?: number
  function?: { name?: string; arguments?: string }
}

export interface ChatCompletionsReasoningItem {
  type: string
  summary?: { type: string; text: string }[]
  encrypted_content?: string | null
  id?: string
}

/**
 * URL citation emitted alongside assistant content when a web search backed
 * the answer. OpenAI spec shape (`ChatCompletionMessage.Annotation`); the only
 * discriminator defined today is `url_citation`. `start_index`/`end_index`
 * are byte offsets into the accumulated `content` and are optional here
 * because the gateway's search shim has no per-span attribution to report.
 */
export interface ChatCompletionsAnnotation {
  type: 'url_citation'
  url_citation: {
    url: string
    title?: string
    start_index?: number
    end_index?: number
  }
}

export interface ChatCompletionsDelta {
  content?: string | null
  role?: string
  tool_calls?: ChatCompletionsToolCall[] | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  reasoning_items?: ChatCompletionsReasoningItem[] | null
  annotations?: ChatCompletionsAnnotation[] | null
}

export interface ChatCompletionsChoiceStreaming {
  index: number
  delta: ChatCompletionsDelta
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface ChatCompletionsUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number }
  completion_tokens_details?: {
    accepted_prediction_tokens: number
    rejected_prediction_tokens: number
    reasoning_tokens?: number
  }
}

export interface ChatCompletionsStreamEvent {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionsChoiceStreaming[]
  usage?: ChatCompletionsUsage
}
