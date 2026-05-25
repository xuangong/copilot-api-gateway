/**
 * Non-streaming response translator: OpenAI Responses JSON → Anthropic Messages JSON.
 *
 * Pairs with `./request.ts` and `./events.ts`. Used when /v1/messages is
 * routed through the Responses upstream and `stream: false` — we need to
 * collapse the Responses `output[]` array back into Anthropic
 * `content[]` blocks.
 */

interface ResponsesResultLike {
  id: string
  model: string
  status?: "completed" | "incomplete" | "failed" | "in_progress"
  incomplete_details?: { reason?: string } | null
  output: Array<{
    type: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    summary?: Array<{ text?: string }>
    content?: Array<{ type: string; text?: string; refusal?: string }>
  }>
  output_text?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  }
}

interface MessagesContentBlock {
  type: string
  [key: string]: unknown
}

export interface MessagesResponseLike {
  id: string
  type: "message"
  role: "assistant"
  content: MessagesContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
}

function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const v = JSON.parse(args)
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { raw_arguments: args }
  } catch {
    return { raw_arguments: args }
  }
}

function combineMessageText(content: ResponsesResultLike["output"][number]["content"]): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => {
      if (b.type === "output_text") return b.text ?? ""
      if (b.type === "refusal") return b.refusal ?? ""
      return ""
    })
    .join("")
}

function mapOutputToContent(output: ResponsesResultLike["output"]): MessagesContentBlock[] {
  const blocks: MessagesContentBlock[] = []
  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        const thinking = (item.summary ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim()
        if (thinking) blocks.push({ type: "thinking", thinking })
        break
      }
      case "function_call":
        if (item.name && item.call_id) {
          blocks.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: parseToolArgs(item.arguments),
          })
        }
        break
      case "message": {
        const text = combineMessageText(item.content)
        if (text.length > 0) blocks.push({ type: "text", text })
        break
      }
    }
  }
  return blocks
}

function mapStopReason(resp: ResponsesResultLike): string | null {
  if (resp.status === "completed") {
    return resp.output.some((i) => i.type === "function_call") ? "tool_use" : "end_turn"
  }
  if (resp.status === "incomplete" && resp.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens"
  }
  return null
}

export function translateResponsesToMessagesResponse(resp: ResponsesResultLike): MessagesResponseLike {
  const content = mapOutputToContent(resp.output)
  const finalContent = content.length > 0
    ? content
    : resp.output_text
      ? [{ type: "text", text: resp.output_text } as MessagesContentBlock]
      : []

  const cached = resp.usage?.input_tokens_details?.cached_tokens
  const inputTokens = (resp.usage?.input_tokens ?? 0) - (cached ?? 0)

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content: finalContent,
    model: resp.model,
    stop_reason: mapStopReason(resp),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: resp.usage?.output_tokens ?? 0,
      ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    },
  }
}
