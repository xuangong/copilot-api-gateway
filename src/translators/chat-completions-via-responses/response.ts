/**
 * Response translator: Responses JSON → Chat Completions JSON.
 *
 * For non-streaming Chat clients hitting a gpt-5.x model that only serves
 * /v1/responses upstream.
 */

interface RespOutputItem {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type: string; text?: string }>
  summary?: Array<{ type?: string; text?: string }>
}

export interface ResponsesResultLike {
  id?: string
  model?: string
  created_at?: number
  output?: RespOutputItem[]
  output_text?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  }
}

interface ChatToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
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
      tool_calls?: ChatToolCall[]
      reasoning_text?: string
    }
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
  }
}

export function translateResponsesToChatCompletionsResponse(
  resp: ResponsesResultLike,
  fallbackModel = "",
): ChatCompletionsResultLike {
  const toolCalls: ChatToolCall[] = []
  const textParts: string[] = []
  const reasoningParts: string[] = []
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id ?? item.id ?? "",
          type: "function",
          function: { name: item.name ?? "", arguments: item.arguments ?? "" },
        })
      } else if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) textParts.push(part.text)
        }
      } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (s.text) reasoningParts.push(s.text)
        }
      }
    }
  }
  let content: string | null = textParts.join("")
  if (!content) {
    content = resp.output_text && resp.output_text.length > 0 ? resp.output_text : null
  }

  const finishReason: ChatCompletionsResultLike["choices"][0]["finish_reason"] =
    resp.incomplete_details?.reason === "max_output_tokens"
      ? "length"
      : toolCalls.length > 0
        ? "tool_calls"
        : "stop"

  const promptTokens = resp.usage?.input_tokens ?? 0
  const completionTokens = resp.usage?.output_tokens ?? 0
  const cached = resp.usage?.input_tokens_details?.cached_tokens

  return {
    id: resp.id ?? "chatcmpl-pending",
    object: "chat.completion",
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model: resp.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoningParts.length > 0
            ? { reasoning_text: reasoningParts.join("") }
            : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(resp.usage
      ? {
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens:
              resp.usage.total_tokens ?? promptTokens + completionTokens,
            ...(cached !== undefined
              ? { prompt_tokens_details: { cached_tokens: cached } }
              : {}),
          },
        }
      : {}),
  }
}
