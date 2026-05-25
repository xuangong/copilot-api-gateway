/**
 * Request translator: client speaks OpenAI Chat Completions, upstream
 * serves OpenAI Responses (gpt-5.x).
 *
 * Adapted from copilot-gateway
 * chat-completions-via-responses/request.ts to this project's payload types.
 */

import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/gemini/format-conversion"
import type {
  ResponsesPayload,
  ResponseInputItem,
  ResponseTool,
} from "~/transforms/types"

function chatContentToText(content: Message["content"]): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
  }
  return ""
}

function chatContentToResponsesInputContent(
  content: Message["content"],
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  // gpt-5 Responses understands input_text + input_image. Map text → input_text
  // and image_url → input_image so multimodal Chat clients still work.
  return content.map((p) => {
    if (p.type === "text") return { type: "input_text", text: p.text ?? "" }
    if (p.type === "image_url" && p.image_url?.url) {
      return { type: "input_image", image_url: { url: p.image_url.url } }
    }
    return { type: "input_text", text: "" }
  })
}

function translateChatTools(
  tools: Tool[] | undefined,
): ResponseTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => {
    const f = t.function as { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
    return {
      type: "function" as const,
      name: f.name,
      parameters: (f.parameters ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
      strict: f.strict ?? false,
      ...(f.description ? { description: f.description } : {}),
    }
  })
}

function translateChatToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (choice == null) return "auto"
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

interface ExtendedChatPayload extends ChatCompletionsPayload {
  parallel_tool_calls?: boolean
  reasoning_effort?: "low" | "medium" | "high"
}

export function translateChatCompletionsToResponsesRequest(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const ext = payload as ExtendedChatPayload
  const instructions: string[] = []
  const input: ResponseInputItem[] = []
  let hoistSystemPrefix = true

  for (const message of payload.messages) {
    if (hoistSystemPrefix && message.role === "system") {
      const text = chatContentToText(message.content)
      if (text) instructions.push(text)
      continue
    }
    hoistSystemPrefix = false

    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: chatContentToResponsesInputContent(message.content) as
          | string
          | Array<{ type: string; text?: string }>,
      })
      continue
    }

    if (message.role === "assistant") {
      if (message.tool_calls?.length) {
        const text = chatContentToText(message.content)
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          })
        }
        for (const tc of message.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        }
        continue
      }
      const text = chatContentToText(message.content)
      input.push({
        type: "message",
        role: "assistant",
        content: text ? [{ type: "output_text", text }] : "",
      })
      continue
    }

    if (message.role === "system") {
      input.push({
        type: "message",
        role: "system",
        content: chatContentToResponsesInputContent(message.content) as
          | string
          | Array<{ type: string; text?: string }>,
      })
      continue
    }

    // tool role
    if (!message.tool_call_id) continue
    input.push({
      type: "function_call_output",
      call_id: message.tool_call_id,
      output:
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? ""),
    })
  }

  const tools = translateChatTools(payload.tools)
  const result: ResponsesPayload = {
    model: payload.model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_tokens !== undefined ? { max_output_tokens: payload.max_tokens } : {}),
    ...(tools ? { tools } : {}),
    tool_choice: translateChatToolChoice(payload.tool_choice),
    ...(ext.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: ext.parallel_tool_calls }
      : {}),
    ...(ext.reasoning_effort != null
      ? { reasoning: { effort: ext.reasoning_effort } }
      : {}),
    stream: payload.stream ?? true,
  }
  return result
}
