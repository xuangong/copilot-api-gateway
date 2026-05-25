/**
 * Request translator: OpenAI Responses -> Anthropic Messages.
 *
 * Used when the client speaks /v1/responses but the chosen Copilot model
 * only serves /v1/messages (claude-*). Faithful, minimal translation:
 * absent knobs are not synthesized.
 */

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicContentBlock,
  AnthropicToolResultBlock,
  AnthropicTool,
  ResponsesPayload,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseContentBlock,
  ResponseTool,
  ToolInput,
} from "~/transforms/types"

const DEFAULT_MAX_TOKENS = 8192

function extractSystemText(message: ResponseInputMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content.map((b) => b.text ?? "").join("")
}

function translateUserContent(blocks: ResponseContentBlock[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = []
  for (const block of blocks) {
    if (block.type === "input_text") {
      out.push({ type: "text", text: block.text ?? "" })
    }
    // input_image not currently supported by AnthropicImageBlock without
    // a media_type lookup; skip silently rather than synthesize wrong shape.
  }
  return out
}

function translateAssistantContent(blocks: ResponseContentBlock[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = []
  for (const block of blocks) {
    if (block.type === "output_text") {
      out.push({ type: "text", text: block.text ?? "" })
    }
  }
  return out
}

function parseToolArgs(args: string): Record<string, unknown> {
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

function appendAssistantBlock(messages: AnthropicMessage[], block: AnthropicContentBlock): void {
  const last = messages[messages.length - 1]
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  messages.push({ role: "assistant", content: [block] })
}

function appendUserBlock(messages: AnthropicMessage[], block: AnthropicToolResultBlock): void {
  const last = messages[messages.length - 1]
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  messages.push({ role: "user", content: [block] })
}

interface TranslatedInput {
  messages: AnthropicMessage[]
  systemParts: string[]
}

function translateInput(input: ResponsesPayload["input"]): TranslatedInput {
  if (typeof input === "string") {
    return { messages: [{ role: "user", content: input }], systemParts: [] }
  }
  const messages: AnthropicMessage[] = []
  const systemParts: string[] = []
  for (const item of input as ResponseInputItem[]) {
    switch (item.type) {
      case "message": {
        const msg = item as ResponseInputMessage
        if (msg.role === "system" || (msg.role as string) === "developer") {
          const text = extractSystemText(msg)
          if (text) systemParts.push(text)
          continue
        }
        const blocks = typeof msg.content === "string"
          ? [{ type: "text", text: msg.content } as AnthropicContentBlock]
          : msg.role === "user"
            ? translateUserContent(msg.content)
            : translateAssistantContent(msg.content)
        if (blocks.length > 0) {
          messages.push({ role: msg.role as "user" | "assistant", content: blocks })
        }
        break
      }
      case "function_call":
        appendAssistantBlock(messages, {
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: parseToolArgs(item.arguments) as ToolInput,
        })
        break
      case "function_call_output":
        appendUserBlock(messages, {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: item.output,
        })
        break
    }
  }
  return { messages, systemParts }
}

function translateTools(tools: ResponseTool[] | null | undefined): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: AnthropicTool[] = []
  for (const t of tools) {
    if (t.type !== "function" || !t.name) continue
    out.push({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { input_schema: t.parameters } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

interface MessagesToolChoice {
  type: "auto" | "any" | "tool" | "none"
  name?: string
}

function translateToolChoice(
  choice: ResponsesPayload["tool_choice"],
): MessagesToolChoice | undefined {
  if (!choice) return undefined
  if (typeof choice === "string") {
    switch (choice) {
      case "auto":
        return { type: "auto" }
      case "none":
        return { type: "none" }
      case "required":
        return { type: "any" }
      default:
        return undefined
    }
  }
  if ((choice.type === "function" || choice.type === "custom") && choice.name) {
    return { type: "tool", name: choice.name }
  }
  return undefined
}

export interface ResponsesToMessagesRequestResult {
  target: AnthropicMessagesPayload
}

export function translateResponsesToMessages(
  payload: ResponsesPayload,
): ResponsesToMessagesRequestResult {
  const { messages, systemParts } = translateInput(payload.input)
  const systemPieces = [payload.instructions, ...systemParts].filter(
    (p): p is string => Boolean(p),
  )
  const system = systemPieces.join("\n\n")
  const effort = payload.reasoning?.effort
  const max_tokens = payload.max_output_tokens ?? DEFAULT_MAX_TOKENS

  const tools = translateTools(payload.tools)
  const tool_choice = translateToolChoice(payload.tool_choice)

  const target: AnthropicMessagesPayload = {
    model: payload.model,
    messages,
    max_tokens,
    stream: payload.stream ?? true,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  }
  // Anthropic payload type doesn't formally declare temperature/top_p/tool_choice
  // but they're accepted by upstream — attach as additional fields.
  const extras = target as unknown as Record<string, unknown>
  if (payload.temperature != null) extras.temperature = payload.temperature
  if (payload.top_p != null) extras.top_p = payload.top_p
  if (tool_choice) extras.tool_choice = tool_choice

  return { target }
}
