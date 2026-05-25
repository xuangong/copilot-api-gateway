/**
 * Response translator: full Chat Completions JSON → full Gemini
 * generateContent response.
 *
 * Companion to `events.ts`. Splits out the non-stream path so both share the
 * same usage/finish-reason mapping and tool-call extraction.
 */

import type {
  ChatCompletionResponse,
  ToolCall,
} from "~/services/gemini/format-conversion"
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiUsageMetadata,
} from "~/services/gemini/types"

function mapFinishReason(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): GeminiFinishReason {
  switch (reason) {
    case "stop":
    case "tool_calls":
      return "STOP"
    case "length":
      return "MAX_TOKENS"
    case "content_filter":
      return "SAFETY"
    default:
      return "FINISH_REASON_UNSPECIFIED"
  }
}

interface ChatUsageLike {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

function mapUsage(usage?: ChatUsageLike): GeminiUsageMetadata | undefined {
  if (!usage) return undefined
  const meta: GeminiUsageMetadata & { thoughtsTokenCount?: number } = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  }
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === "number") meta.cachedContentTokenCount = cached
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === "number") meta.thoughtsTokenCount = reasoning
  return meta
}

function partsFromToolCalls(toolCalls: ToolCall[]): GeminiPart[] {
  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {}
    if (tc.function.arguments) {
      try {
        const parsed = JSON.parse(tc.function.arguments) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        // Leave args empty when upstream returned malformed JSON.
      }
    }
    return { functionCall: { name: tc.function.name, args } }
  })
}

export function translateChatCompletionsToGeminiResponse(
  response: ChatCompletionResponse,
  modelName: string,
): GeminiGenerateContentResponse {
  const candidates: GeminiCandidate[] = response.choices.map(
    (choice, index) => {
      const parts: GeminiPart[] = []
      const reasoning = (choice.message as { reasoning_text?: string })
        .reasoning_text
      if (typeof reasoning === "string" && reasoning) {
        parts.push({ text: reasoning, thought: true } as GeminiPart)
      }
      if (choice.message.content) {
        parts.push({ text: choice.message.content })
      }
      if (choice.message.tool_calls?.length) {
        parts.push(...partsFromToolCalls(choice.message.tool_calls))
      }
      return {
        index,
        content: { role: "model", parts },
        finishReason: mapFinishReason(choice.finish_reason),
      }
    },
  )

  return {
    candidates,
    ...(response.usage
      ? { usageMetadata: mapUsage(response.usage as ChatUsageLike) }
      : {}),
    modelVersion: modelName,
  }
}
