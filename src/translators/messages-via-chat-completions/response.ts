/**
 * Non-streaming response translator: OpenAI Chat Completions JSON →
 * Anthropic Messages JSON.
 *
 * Pairs with `./request.ts` and `./events.ts`. Used when /v1/messages is
 * routed through the Chat Completions upstream (gpt-* non-5.x) and
 * `stream: false` — expand `choices[0].message` back into Anthropic
 * `content[]` blocks plus a stop_reason.
 */

interface ChatCompletionToolCall {
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

interface ChatCompletionMessage {
  role?: string
  content?: string | null
  tool_calls?: ChatCompletionToolCall[]
  reasoning_text?: string
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null
}

export interface ChatCompletionsResultLike {
  id?: string
  model?: string
  choices?: ChatCompletionChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

type AnthropicResultBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

export interface AnthropicMessagesResultLike {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: AnthropicResultBlock[]
  stop_reason: string | null
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
}

function synthMessageId(): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  return `msg_${rand}`
}

function parseToolInput(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return {}
  }
}

function mapFinishReason(
  reason: ChatCompletionChoice["finish_reason"],
): string | null {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default:
      return null
  }
}

export function translateChatCompletionsToMessagesResponse(
  resp: ChatCompletionsResultLike,
  fallbackModel = "",
): AnthropicMessagesResultLike {
  const choice = resp.choices?.[0]
  const msg = choice?.message ?? {}
  const blocks: AnthropicResultBlock[] = []

  if (msg.reasoning_text) {
    blocks.push({ type: "thinking", thinking: msg.reasoning_text })
  }
  if (typeof msg.content === "string" && msg.content.length > 0) {
    blocks.push({ type: "text", text: msg.content })
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (!tc.id || !tc.function?.name) continue
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parseToolInput(tc.function.arguments),
      })
    }
  }

  const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const promptTokens = resp.usage?.prompt_tokens ?? 0
  const inputTokens = Math.max(0, promptTokens - cached)

  return {
    id: resp.id ?? synthMessageId(),
    type: "message",
    role: "assistant",
    model: resp.model ?? fallbackModel,
    content: blocks,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    },
  }
}
