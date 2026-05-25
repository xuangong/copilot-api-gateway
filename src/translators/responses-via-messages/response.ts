/**
 * Non-streaming JSON translator: Anthropic Messages response → Responses result.
 *
 * Pairs with `./request.ts` / `./events.ts`. Used when /v1/responses is
 * routed through the Messages upstream and `stream: false`.
 */

interface AnthropicContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicMessagesResult {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: AnthropicContentBlock[]
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

interface ResponseOutputItem {
  type: "message" | "reasoning" | "function_call"
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  status?: "completed"
  role?: "assistant"
  content?: Array<{ type: "output_text"; text: string }>
  summary?: Array<{ type: "summary_text"; text: string }>
}

export interface ResponsesResultLike {
  id: string
  object: "response"
  model: string
  status: "completed" | "incomplete" | "failed"
  output: ResponseOutputItem[]
  output_text: string
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens: number }
  }
  incomplete_details?: { reason: string } | null
}

function stringifyToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  if ("raw_arguments" in input && typeof input.raw_arguments === "string") {
    return input.raw_arguments
  }
  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function mapContentToOutput(
  content: AnthropicContentBlock[],
): { items: ResponseOutputItem[]; outputText: string } {
  const items: ResponseOutputItem[] = []
  let outputText = ""
  let nextIndex = 0
  for (const block of content) {
    switch (block.type) {
      case "text": {
        const text = block.text ?? ""
        outputText += text
        items.push({
          type: "message",
          id: `msg_${nextIndex++}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text }],
        })
        break
      }
      case "thinking": {
        const text = (block.thinking ?? "").trim()
        if (!text) break
        items.push({
          type: "reasoning",
          id: `rs_${nextIndex++}`,
          summary: [{ type: "summary_text", text }],
        })
        break
      }
      case "tool_use": {
        if (!block.id || !block.name) break
        items.push({
          type: "function_call",
          id: `fc_${nextIndex++}`,
          call_id: block.id,
          name: block.name,
          arguments: stringifyToolInput(block.input),
          status: "completed",
        })
        break
      }
    }
  }
  return { items, outputText }
}

function mapStatus(stopReason: string | null | undefined): ResponsesResultLike["status"] {
  if (stopReason === "max_tokens") return "incomplete"
  return "completed"
}

export function translateMessagesToResponsesResponse(
  resp: AnthropicMessagesResult,
): ResponsesResultLike {
  const { items, outputText } = mapContentToOutput(resp.content)
  const cached = resp.usage?.cache_read_input_tokens
  const cacheCreated = resp.usage?.cache_creation_input_tokens
  const inputBase = resp.usage?.input_tokens ?? 0
  const inputTokens = inputBase + (cached ?? 0) + (cacheCreated ?? 0)
  const outputTokens = resp.usage?.output_tokens ?? 0
  const status = mapStatus(resp.stop_reason)

  return {
    id: resp.id,
    object: "response",
    model: resp.model,
    status,
    output: items,
    output_text: outputText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached } } : {}),
    },
    ...(status === "incomplete"
      ? { incomplete_details: { reason: "max_output_tokens" } }
      : {}),
  }
}
