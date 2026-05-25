/**
 * Non-streaming response translator: Anthropic Messages JSON →
 * OpenAI Chat Completions JSON.
 *
 * Pairs with `./request.ts` and `./events.ts`. Used when
 * /v1/chat/completions is routed through the Messages upstream (claude-*)
 * and `stream: false` — collapse the Anthropic `content[]` blocks into
 * a single `choices[0].message`.
 */

interface AnthropicMessagesResultBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicMessagesResult {
  id: string
  model: string
  content: AnthropicMessagesResultBlock[]
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface ChatCompletionsResultLike {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<{
    index: 0
    message: {
      role: "assistant"
      content: string | null
      tool_calls?: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
      }>
      reasoning_text?: string
    }
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
  }
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input
  if (input == null) return "{}"
  try {
    return JSON.stringify(input)
  } catch {
    return "{}"
  }
}

function mapStopReason(
  stopReason: string | null | undefined,
): ChatCompletionsResultLike["choices"][0]["finish_reason"] {
  switch (stopReason) {
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    case "refusal":
      return "content_filter"
    default:
      return "stop"
  }
}

export function translateMessagesToChatCompletionsResponse(
  resp: AnthropicMessagesResult,
): ChatCompletionsResultLike {
  const textParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls: NonNullable<
    ChatCompletionsResultLike["choices"][0]["message"]["tool_calls"]
  > = []

  for (const block of resp.content) {
    switch (block.type) {
      case "text":
        if (block.text) textParts.push(block.text)
        break
      case "thinking":
        if (block.thinking) reasoningParts.push(block.thinking)
        break
      case "tool_use":
        if (block.id && block.name) {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: stringifyToolInput(block.input),
            },
          })
        }
        break
    }
  }

  const cached = resp.usage?.cache_read_input_tokens ?? 0
  const promptTokens =
    (resp.usage?.input_tokens ?? 0) +
    cached +
    (resp.usage?.cache_creation_input_tokens ?? 0)
  const completionTokens = resp.usage?.output_tokens ?? 0

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoningParts.length > 0
            ? { reasoning_text: reasoningParts.join("") }
            : {}),
        },
        finish_reason: mapStopReason(resp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  }
}
