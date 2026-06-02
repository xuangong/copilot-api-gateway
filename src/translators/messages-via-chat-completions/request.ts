/**
 * Request translator: client speaks Anthropic Messages, upstream serves
 * OpenAI Chat Completions.
 *
 * Used when the chosen Copilot model only natively serves
 * /v1/chat/completions (gpt-* non-5.x) but the client is speaking
 * /v1/messages. Mirrors the reference (copilot-gateway
 * messages-via-chat-completions/request.ts) but adapted to the in-project
 * AnthropicMessagesPayload type (no server_tool_use/web_search/etc).
 */

import type { ChatCompletionsPayload, Message, Tool, ToolCall, ContentPart } from "~/services/gemini/format-conversion"
import { openAiJsonSchemaCoreFromMessagesFormat } from "~/translators/shared/structured-output"
import type {
  AnthropicMessagesPayload,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
} from "~/transforms/types"

function isText(b: AnthropicContentBlock): b is AnthropicTextBlock {
  return b.type === "text"
}

function isImage(b: AnthropicContentBlock): b is AnthropicImageBlock {
  return b.type === "image"
}

function toChatUserContent(
  content: string | AnthropicContentBlock[],
): string | ContentPart[] | null {
  if (typeof content === "string") return content
  const blocks = content as AnthropicContentBlock[]
  const hasImage = blocks.some(isImage)
  if (!hasImage) {
    const text = blocks
      .filter(isText)
      .map((b) => b.text)
      .join("\n\n")
    return text
  }
  const parts: ContentPart[] = []
  for (const block of blocks) {
    if (isText(block)) {
      parts.push({ type: "text", text: block.text })
      continue
    }
    if (!isImage(block)) continue
    const src = block.source
    if (src.type === "base64" && src.media_type && src.data) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      })
    } else if (src.type === "url" && src.url) {
      parts.push({ type: "image_url", image_url: { url: src.url } })
    }
  }
  return parts
}

function toChatToolResultContent(content: AnthropicToolResultBlock["content"]): string {
  if (typeof content === "string") return content
  if (!content) return ""
  const textBlocks = content.filter(isText)
  if (textBlocks.length === content.length) {
    return textBlocks.map((b) => b.text).join("\n\n")
  }
  try {
    return JSON.stringify(content)
  } catch {
    return ""
  }
}

function toChatToolCall(block: AnthropicToolUseBlock): ToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: (() => {
        try {
          return JSON.stringify(block.input ?? {})
        } catch {
          return "{}"
        }
      })(),
    },
  }
}

interface PendingAssistant {
  textParts: string[]
  toolCalls: ToolCall[]
  reasoningText: string | null
}

function flushAssistant(messages: Message[], pending: PendingAssistant): void {
  if (
    pending.textParts.length === 0 &&
    pending.toolCalls.length === 0 &&
    pending.reasoningText === null
  ) {
    return
  }
  const msg: Message = {
    role: "assistant",
    content: pending.textParts.length > 0 ? pending.textParts.join("\n\n") : null,
    ...(pending.toolCalls.length > 0 ? { tool_calls: [...pending.toolCalls] } : {}),
    ...(pending.reasoningText !== null
      ? ({ reasoning_text: pending.reasoningText } as Partial<Message>)
      : {}),
  }
  messages.push(msg)
  pending.textParts.length = 0
  pending.toolCalls.length = 0
  pending.reasoningText = null
}

function translateUser(m: AnthropicMessage): Message[] {
  if (!Array.isArray(m.content)) {
    return [{ role: "user", content: toChatUserContent(m.content) }]
  }
  const out: Message[] = []
  const pending: AnthropicContentBlock[] = []
  const flushPending = () => {
    if (pending.length === 0) return
    out.push({ role: "user", content: toChatUserContent(pending) })
    pending.length = 0
  }
  for (const block of m.content) {
    if (block.type !== "tool_result") {
      pending.push(block)
      continue
    }
    flushPending()
    out.push({
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: toChatToolResultContent(block.content),
    })
  }
  flushPending()
  return out
}

function translateAssistant(m: AnthropicMessage): Message[] {
  if (!Array.isArray(m.content)) {
    return [{ role: "assistant", content: toChatUserContent(m.content) }]
  }
  const out: Message[] = []
  const pending: PendingAssistant = { textParts: [], toolCalls: [], reasoningText: null }
  for (const block of m.content) {
    switch (block.type) {
      case "text":
        pending.textParts.push(block.text)
        break
      case "thinking":
        pending.reasoningText ??= (block as AnthropicThinkingBlock).thinking
        break
      case "tool_use":
        pending.toolCalls.push(toChatToolCall(block))
        break
    }
  }
  flushAssistant(out, pending)
  return out
}

function translateInput(
  messages: AnthropicMessage[],
  system: AnthropicMessagesPayload["system"],
): Message[] {
  const sys: Message[] = []
  if (system) {
    const text =
      typeof system === "string"
        ? system
        : system.map((b) => b.text).join("\n\n")
    if (text) sys.push({ role: "system", content: text })
  }
  return [
    ...sys,
    ...messages.flatMap((m) =>
      m.role === "user" ? translateUser(m) : translateAssistant(m),
    ),
  ]
}

function translateTools(tools: AnthropicTool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  // Filter out non-client tools (Anthropic-specific server tools that have a
  // `type` field set). Client tools have undefined or "custom" type.
  const client = tools.filter((t) => t.type === undefined || t.type === "custom")
  if (client.length === 0) return undefined
  return client.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }))
}

interface AnthropicToolChoice {
  type?: "auto" | "any" | "tool" | "none"
  name?: string
}

function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
  tools: Tool[] | undefined,
): ChatCompletionsPayload["tool_choice"] {
  if (!choice || !tools || tools.length === 0) return undefined
  switch (choice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      if (!choice.name) return undefined
      return tools.some((t) => t.function.name === choice.name)
        ? { type: "function", function: { name: choice.name } }
        : undefined
    default:
      return undefined
  }
}

interface ExtendedAnthropicPayload extends AnthropicMessagesPayload {
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  tool_choice?: AnthropicToolChoice
}

function translateEffort(
  payload: AnthropicMessagesPayload,
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (payload.output_config?.effort) return payload.output_config.effort
  const budget = payload.thinking?.budget_tokens
  if (budget != null && budget > 0) {
    if (budget <= 2048) return "low"
    if (budget <= 8192) return "medium"
    return "high"
  }
  return undefined
}

export function translateMessagesToChatCompletions(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const extended = payload as ExtendedAnthropicPayload
  const tools = translateTools(payload.tools)

  const reasoning_effort = translateEffort(payload)
  const jsonSchema = openAiJsonSchemaCoreFromMessagesFormat(payload.output_config?.format)
  const response_format = jsonSchema
    ? ({ type: "json_schema" as const, json_schema: jsonSchema })
    : undefined

  const result: ChatCompletionsPayload = {
    model: payload.model,
    messages: translateInput(payload.messages, payload.system),
    ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
    max_tokens: payload.max_tokens,
    stream: payload.stream ?? true,
    ...(extended.temperature !== undefined ? { temperature: extended.temperature } : {}),
    ...(extended.top_p !== undefined ? { top_p: extended.top_p } : {}),
    ...(extended.stop_sequences ? { stop: extended.stop_sequences } : {}),
    ...(tools ? { tools } : {}),
    ...(response_format ? { response_format } : {}),
  }
  const toolChoice = translateToolChoice(extended.tool_choice, tools)
  if (toolChoice !== undefined) {
    result.tool_choice = toolChoice
  }
  return result
}
