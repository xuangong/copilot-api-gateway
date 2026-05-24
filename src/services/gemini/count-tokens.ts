/**
 * Gemini `:countTokens` translator + handler helpers.
 *
 * Gemini's countTokens endpoint accepts either a top-level `contents` array
 * or a nested `generateContentRequest`. We normalize both shapes, then
 * project the request onto a minimal Anthropic `/v1/messages/count_tokens`
 * payload (text-only — images/functions don't change the token count
 * shape enough to matter here, and the upstream tolerates extra fields).
 *
 * Upstream returns `{ input_tokens }` (Anthropic) or `{ total_tokens }`
 * (some forks); we coerce to Gemini's `{ totalTokens }` shape.
 */

import type {
  GeminiContent,
  GeminiGenerateContentRequest,
  GeminiPart,
} from "./types"

export interface GeminiCountTokensRequest {
  contents?: string | GeminiContent[]
  generateContentRequest?: GeminiGenerateContentRequest
}

export interface AnthropicCountTokensPayload {
  model: string
  messages: Array<{ role: "user" | "assistant"; content: string }>
  system?: string
}

export function normalizeCountTokensRequest(
  request: GeminiCountTokensRequest,
): GeminiGenerateContentRequest {
  if (request.generateContentRequest) return request.generateContentRequest
  return { contents: request.contents ?? [] }
}

function textFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((p): p is { text: string } => "text" in p)
    .map((p) => p.text)
    .join("")
}

export function translateGeminiCountTokensToAnthropic(
  request: GeminiGenerateContentRequest,
  model: string,
): AnthropicCountTokensPayload {
  const contents: GeminiContent[] = Array.isArray(request.contents)
    ? request.contents
    : [{ role: "user", parts: [{ text: request.contents as string }] }]

  const messages: AnthropicCountTokensPayload["messages"] = []
  for (const c of contents) {
    const role: "user" | "assistant" = c.role === "model" ? "assistant" : "user"
    const text = textFromParts(c.parts)
    if (text) messages.push({ role, content: text })
  }
  if (messages.length === 0) messages.push({ role: "user", content: "" })

  const payload: AnthropicCountTokensPayload = { model, messages }
  if (request.systemInstruction) {
    const sys = textFromParts(request.systemInstruction.parts)
    if (sys) payload.system = sys
  }
  return payload
}

export function totalTokensFromUpstream(value: unknown): number | null {
  if (!value || typeof value !== "object") return null
  const p = value as { input_tokens?: unknown; total_tokens?: unknown }
  if (typeof p.input_tokens === "number") return p.input_tokens
  if (typeof p.total_tokens === "number") return p.total_tokens
  return null
}
