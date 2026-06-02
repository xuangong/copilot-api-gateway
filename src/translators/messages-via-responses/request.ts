/**
 * Request translator: Anthropic Messages -> OpenAI Responses.
 *
 * Used when the client speaks /v1/messages but the chosen binding only
 * serves /v1/responses. Translation is faithful and minimal: knobs absent
 * in the source are NOT synthesized (no `temperature: 1`, no `store: false`).
 *
 * Note: this project's AnthropicMessagesPayload is a subset of the upstream
 * reference (no server_tool_use, web_search_tool_result, or redacted_thinking
 * variants). Coverage for those extra block types lives in the events-side
 * translator and can be added here when those block types are admitted into
 * the protocol type.
 */

import type {
  AnthropicMessagesPayload,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicTool,
  ResponsesPayload,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseContentBlock,
  ResponseTool,
} from "~/transforms/types"
import { openAiJsonSchemaCoreFromMessagesFormat } from "~/translators/shared/structured-output"

type ToolChoice = NonNullable<ResponsesPayload["tool_choice"]>

type PendingContent = ResponseContentBlock & { type: string }

function flushPending(
  pending: PendingContent[],
  out: ResponseInputItem[],
  role: "user" | "assistant",
): void {
  if (pending.length === 0) return
  const msg: ResponseInputMessage = { type: "message", role, content: [...pending] }
  out.push(msg)
  pending.length = 0
}

function userContent(block: AnthropicContentBlock): PendingContent | null {
  if (block.type === "text") return { type: "input_text", text: block.text }
  if (block.type === "image") {
    const src = block.source
    const url =
      src.type === "base64" && src.media_type && src.data
        ? `data:${src.media_type};base64,${src.data}`
        : (src.url ?? "")
    return { type: "input_image", text: url }
  }
  return null
}

function toolResultOutput(content: AnthropicToolResultBlock["content"]): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  const allText = content.every((b): b is AnthropicTextBlock => b.type === "text")
  if (allText) return content.map((b) => b.text).join("\n\n")
  return JSON.stringify(content)
}

function functionCall(block: AnthropicToolUseBlock): ResponseInputItem {
  // Match copilot-gateway: only `call_id` is set on the request side. Upstream
  // /responses rejects ids that don't start with `fc_`, and the caller's
  // tool_use id (`call_…` / `toolu_…`) is only valid for matching `call_id`.
  return {
    type: "function_call",
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
  }
}

function translateUserMessage(message: AnthropicMessage): ResponseInputItem[] {
  if (typeof message.content === "string") {
    return [{ type: "message", role: "user", content: message.content }]
  }
  const out: ResponseInputItem[] = []
  const pending: PendingContent[] = []
  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushPending(pending, out, "user")
      out.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: toolResultOutput(block.content),
      })
      continue
    }
    const c = userContent(block)
    if (c) pending.push(c)
  }
  flushPending(pending, out, "user")
  return out
}

function translateAssistantMessage(message: AnthropicMessage): ResponseInputItem[] {
  if (typeof message.content === "string") {
    return [{ type: "message", role: "assistant", content: message.content }]
  }
  const out: ResponseInputItem[] = []
  const pending: PendingContent[] = []
  for (const block of message.content) {
    if (block.type === "tool_use") {
      flushPending(pending, out, "assistant")
      out.push(functionCall(block))
      continue
    }
    if (block.type === "text") {
      pending.push({ type: "output_text", text: block.text })
    }
    // thinking blocks are not currently round-tripped through Responses input;
    // they are surface-output only.
  }
  flushPending(pending, out, "assistant")
  return out
}

function translateInput(messages: AnthropicMessage[]): ResponseInputItem[] {
  return messages.flatMap((m) =>
    m.role === "user" ? translateUserMessage(m) : translateAssistantMessage(m),
  )
}

function translateSystem(system: AnthropicMessagesPayload["system"]): string | null {
  if (typeof system === "string") return system
  if (!system) return null
  const text = system.map((b) => b.text).join("\n\n")
  return text.length > 0 ? text : null
}

function translateTools(tools: AnthropicTool[] | undefined): ResponseTool[] | null {
  if (!tools || tools.length === 0) return null
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    parameters: t.input_schema,
    strict: false,
    ...(t.description ? { description: t.description } : {}),
  }))
}

interface MessagesToolChoice {
  type: "auto" | "any" | "tool" | "none"
  name?: string
}

function translateToolChoice(
  choice: MessagesToolChoice | undefined,
  tools: AnthropicTool[] | undefined,
): ToolChoice {
  if (!choice || !tools || tools.length === 0) return "auto"
  const names = new Set(tools.map((t) => t.name))
  switch (choice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "tool":
      return choice.name && names.has(choice.name)
        ? { type: "function", name: choice.name }
        : "auto"
    case "none":
      return "none"
    default:
      return "auto"
  }
}

function translateEffort(payload: AnthropicMessagesPayload): "low" | "medium" | "high" | "xhigh" | undefined {
  if (payload.output_config?.effort) return payload.output_config.effort
  const budget = payload.thinking?.budget_tokens
  if (budget != null && budget > 0) {
    if (budget <= 2048) return "low"
    if (budget <= 8192) return "medium"
    return "high"
  }
  return undefined
}

export function translateMessagesToResponses(payload: AnthropicMessagesPayload): ResponsesPayload {
  const instructions = translateSystem(payload.system)
  const effort = translateEffort(payload)
  const choice = (payload as unknown as { tool_choice?: MessagesToolChoice }).tool_choice
  const temperature = (payload as unknown as { temperature?: number }).temperature
  const top_p = (payload as unknown as { top_p?: number }).top_p
  const metadata = (payload as unknown as { metadata?: Record<string, string> }).metadata
  const jsonSchema = openAiJsonSchemaCoreFromMessagesFormat(payload.output_config?.format)
  const text = jsonSchema ? { format: { type: "json_schema" as const, ...jsonSchema } } : undefined
  return {
    model: payload.model,
    input: translateInput(payload.messages),
    ...(instructions !== null ? { instructions } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(top_p !== undefined ? { top_p } : {}),
    max_output_tokens: payload.max_tokens,
    ...(payload.tools !== undefined ? { tools: translateTools(payload.tools) } : {}),
    tool_choice: translateToolChoice(choice, payload.tools),
    ...(metadata ? { metadata: { ...metadata } } : {}),
    stream: payload.stream ?? true,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(text ? { text } : {}),
  }
}
