/**
 * Non-streaming body translator: hub Anthropic Messages JSON response → Gemini
 * generateContent JSON response.
 *
 * Composition: Messages → Chat (Pair 1) → Gemini. Mirrors the streaming path
 * in `./events.ts` so finishReason and usage accounting stay consistent.
 *
 * Direction: response = hub → client.
 */
import type { MessagesResponse } from '@vnext-llm/protocols/messages'
import {
  translateMessagesToChatBody,
  type ChatCompletionResponse,
} from '../chat-completions-via-messages/index.ts'
import type {
  GeminiCandidate,
  GeminiPart,
  GeminiStreamResponse,
  GeminiUsageMetadata,
} from './events.ts'

export interface TranslateMessagesToGeminiBodyOptions {
  /** Embedded into the resulting `modelVersion` field. */
  model: string
}

export type GeminiBodyResponse = GeminiStreamResponse

function mapFinishReason(
  reason: ChatCompletionResponse['choices'][0]['finish_reason'],
): GeminiCandidate['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return 'STOP'
    case 'length':
      return 'MAX_TOKENS'
    case 'content_filter':
      return 'SAFETY'
    default:
      return 'FINISH_REASON_UNSPECIFIED'
  }
}

function mapUsage(usage: ChatCompletionResponse['usage'] | undefined): GeminiUsageMetadata | undefined {
  if (!usage) return undefined
  const meta: GeminiUsageMetadata = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  }
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number') meta.cachedContentTokenCount = cached
  return meta
}

function partsFromToolCalls(
  toolCalls: NonNullable<ChatCompletionResponse['choices'][0]['message']['tool_calls']>,
): GeminiPart[] {
  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {}
    if (tc.function.arguments) {
      try {
        const parsed = JSON.parse(tc.function.arguments) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        // Leave args empty if upstream returned malformed JSON.
      }
    }
    return { functionCall: { name: tc.function.name, args } }
  })
}

export function translateMessagesToGeminiBody(
  msg: MessagesResponse,
  options: TranslateMessagesToGeminiBodyOptions,
): GeminiBodyResponse {
  const chat = translateMessagesToChatBody(msg)
  const candidates: GeminiCandidate[] = chat.choices.map((choice, index) => {
    const parts: GeminiPart[] = []
    const reasoning = (choice.message as { reasoning_text?: string }).reasoning_text
    if (typeof reasoning === 'string' && reasoning) {
      parts.push({ text: reasoning, thought: true })
    }
    if (choice.message.content) {
      parts.push({ text: choice.message.content })
    }
    if (choice.message.tool_calls?.length) {
      parts.push(...partsFromToolCalls(choice.message.tool_calls))
    }
    return {
      index,
      content: { role: 'model', parts },
      finishReason: mapFinishReason(choice.finish_reason),
    }
  })

  const out: GeminiBodyResponse = {
    candidates,
    modelVersion: options.model,
  }
  const usage = mapUsage(chat.usage)
  if (usage) out.usageMetadata = usage
  return out
}
