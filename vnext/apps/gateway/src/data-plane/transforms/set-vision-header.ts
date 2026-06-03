/**
 * Set Copilot's private `copilot-vision-request: true` header when the
 * outbound payload carries any image content. Without it, Copilot silently
 * drops images or treats Anthropic `image` blocks as plain text.
 *
 * Three protocol shapes, one header — implemented as three small detectors
 * that share the header-name constant:
 *
 *   - Messages: `image` blocks at top-level message.content, plus images
 *     nested inside `tool_result.content[]` (Anthropic allows both).
 *   - Chat Completions: OpenAI-style `image_url` content parts.
 *   - Responses: `input_image` (current) or `image` (legacy) at arbitrary
 *     depth — hosted-tool output items and custom tool outputs can carry
 *     image content nested deep, so the detector recurses through `content`.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/{messages,chat-completions,responses}/set-vision-header.ts
 */

import type { AnthropicMessage, AnthropicMessagesPayload, ResponsesPayload } from "./types"

const VISION_HEADER = "copilot-vision-request"

interface ChatMessage {
  content?: unknown
}
interface ChatPayload {
  messages?: ChatMessage[]
}

function messagesContentHasImage(content: AnthropicMessage["content"]): boolean {
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (block.type === "image") return true
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return block.content.some((inner) => (inner as { type?: string }).type === "image")
    }
    return false
  })
}

export function setMessagesVisionHeader(
  payload: AnthropicMessagesPayload,
  headers: Record<string, string>,
): boolean {
  const has = payload.messages.some((m) => messagesContentHasImage(m.content))
  if (!has) return false
  headers[VISION_HEADER] = "true"
  return true
}

export function setChatCompletionsVisionHeader(
  payload: ChatPayload,
  headers: Record<string, string>,
): boolean {
  if (!Array.isArray(payload.messages)) return false
  const has = payload.messages.some((m) => {
    if (!Array.isArray(m.content)) return false
    return m.content.some((part) => (part as { type?: string }).type === "image_url")
  })
  if (!has) return false
  headers[VISION_HEADER] = "true"
  return true
}

function responsesContentHasImage(value: unknown): boolean {
  if (!value) return false
  if (Array.isArray(value)) return value.some((entry) => responsesContentHasImage(entry))
  if (typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined
  // Match legacy `image` alongside `input_image` so aged samples we may still
  // see in replay still flip the header.
  if (type === "input_image" || type === "image") return true
  if (Array.isArray(record.content)) {
    return record.content.some((entry) => responsesContentHasImage(entry))
  }
  return false
}

export function setResponsesVisionHeader(
  payload: ResponsesPayload,
  headers: Record<string, string>,
): boolean {
  const input = (payload as { input?: unknown }).input
  if (!Array.isArray(input)) return false
  if (!responsesContentHasImage(input)) return false
  headers[VISION_HEADER] = "true"
  return true
}
