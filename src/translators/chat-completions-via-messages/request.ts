/**
 * Request translator: client speaks OpenAI Chat Completions, upstream serves
 * Anthropic Messages.
 *
 * Used when the binding only natively serves /v1/messages but the client is
 * speaking /v1/chat/completions.
 *
 * Image fetch: image_url parts referencing remote http(s) URLs are passed
 * through verbatim — this translator does NOT pre-fetch images to base64.
 * Upstreams that can't reach the URL will fail; callers needing the fetch
 * behavior can add a hook later.
 */

import type {
  ChatCompletionsPayload,
  Message,
  ContentPart,
  Tool,
} from "~/services/gemini/format-conversion"
import type {
  AnthropicMessagesPayload,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicToolResultBlock,
  AnthropicTool,
} from "~/transforms/types"

const MESSAGES_FALLBACK_MAX_TOKENS = 4096

interface TranslateChatToMessagesOptions {
  /**
   * Preferred cap when the source payload omits `max_tokens`. Callers wire
   * the binding's model maxOutputTokens through this so the translated
   * Messages request reflects the upstream-known limit.
   */
  fallbackMaxOutputTokens?: number
}

type AssistantBlock = Extract<
  AnthropicContentBlock,
  { type: "text" } | { type: "tool_use" }
>

type UserBlock = Extract<
  AnthropicContentBlock,
  { type: "text" } | { type: "image" } | { type: "tool_result" }
>

function parseToolArgs(s: string | undefined): import("~/transforms/types").ToolInput {
  if (!s) return {}
  try {
    const v = JSON.parse(s) as unknown
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as import("~/transforms/types").ToolInput)
      : {}
  } catch {
    return {}
  }
}

function userBlocksFromContent(content: Message["content"]): UserBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }]
  }
  const out: UserBlock[] = []
  for (const part of content) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text ?? "" })
      continue
    }
    if (part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url
      if (url.startsWith("data:")) {
        // data:<media>;base64,<data>
        const match = /^data:([^;]+);base64,(.+)$/.exec(url)
        if (match) {
          out.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          })
          continue
        }
      }
      out.push({ type: "image", source: { type: "url", url } })
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "" }]
}

function assistantBlocks(m: Message): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  if (typeof m.content === "string" && m.content) {
    blocks.push({ type: "text", text: m.content })
  }
  for (const call of m.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseToolArgs(call.function.arguments),
    })
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }]
}

function appendUser(out: AnthropicMessage[], blocks: UserBlock[]): void {
  const last = out[out.length - 1]
  if (last?.role === "user") {
    const existing = Array.isArray(last.content)
      ? last.content
      : ([{ type: "text" as const, text: last.content }] as UserBlock[])
    last.content = [...existing, ...blocks] as AnthropicContentBlock[]
    return
  }
  const first = blocks[0]
  const single = blocks.length === 1 && first && first.type === "text"
  out.push({
    role: "user",
    content: single ? (first as { text: string }).text : (blocks as AnthropicContentBlock[]),
  })
}

function buildMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === "user") {
      appendUser(out, userBlocksFromContent(m.content))
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: assistantBlocks(m) as AnthropicContentBlock[] })
    } else if (m.role === "tool") {
      if (!m.tool_call_id) throw new Error("tool message requires tool_call_id")
      const tr: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : "",
      }
      appendUser(out, [tr])
    }
    // system handled at caller
  }
  return out
}

function translateTools(tools: Tool[] | undefined): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema:
      (t.function.parameters as AnthropicTool["input_schema"]) ?? { type: "object", properties: {} },
  }))
}

const CHAT_TOOL_CHOICE: Record<
  Extract<NonNullable<ChatCompletionsPayload["tool_choice"]>, string>,
  { type: "auto" | "any" | "none" }
> = {
  auto: { type: "auto" },
  required: { type: "any" },
  none: { type: "none" },
}

/** Map OpenAI-style reasoning_effort to Anthropic thinking budget tokens. */
const EFFORT_TO_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
}

function translateToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): { type: "auto" | "any" | "tool" | "none"; name?: string } | undefined {
  if (choice === undefined) return undefined
  if (typeof choice === "string") return CHAT_TOOL_CHOICE[choice]
  return { type: "tool", name: choice.function.name }
}

export function translateChatCompletionsToMessages(
  payload: ChatCompletionsPayload,
  options: TranslateChatToMessagesOptions = {},
): AnthropicMessagesPayload & {
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  tool_choice?: ReturnType<typeof translateToolChoice>
} {
  const systemParts: string[] = []
  const nonSystem: Message[] = []
  for (const m of payload.messages) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p: ContentPart) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("")
            : ""
      if (text) systemParts.push(text)
      continue
    }
    nonSystem.push(m)
  }

  const messages = buildMessages(nonSystem)
  const max_tokens =
    payload.max_tokens ?? options.fallbackMaxOutputTokens ?? MESSAGES_FALLBACK_MAX_TOKENS
  const toolChoice = translateToolChoice(payload.tool_choice)
  const thinking = payload.reasoning_effort
    ? { type: "enabled" as const, budget_tokens: EFFORT_TO_BUDGET[payload.reasoning_effort] }
    : undefined

  return {
    model: payload.model,
    messages,
    max_tokens,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    ...(payload.stop != null
      ? { stop_sequences: Array.isArray(payload.stop) ? payload.stop : [payload.stop] }
      : {}),
    stream: payload.stream ?? true,
    ...(payload.tools?.length ? { tools: translateTools(payload.tools) } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(thinking ? { thinking } : {}),
  }
}
