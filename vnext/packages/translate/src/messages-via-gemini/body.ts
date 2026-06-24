/**
 * Non-streaming body translator: hub Gemini generateContent JSON → Anthropic
 * Messages JSON response.
 *
 * Composition: Gemini → Chat (locally) → Pair 2's `translateChatBodyToMessages`.
 * The Chat body normalizes finish_reason / usage / tool_calls into a single
 * shape; Pair 2 rebuilds the Messages content[] / stop_reason / usage.
 *
 * Direction: response = hub → client.
 */
import type { MessagesResponse } from '@vnext-llm/protocols/messages'
import { translateChatBodyToMessages, type ChatCompletionResultLike } from '../messages-via-chat-completions/body.ts'
import type { GeminiStreamResponse, GeminiPart } from './events.ts'

export interface TranslateGeminiToMessagesBodyOptions {
  /** Fallback model name when the Gemini body lacks `modelVersion`. */
  model: string
}

export type GeminiBodyResponse = GeminiStreamResponse

function mapFinishReason(
  reason: string | undefined,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter'
    default:
      return null
  }
}

function geminiPartsToChatMessage(
  parts: GeminiPart[] | undefined,
): { content: string; reasoning_text?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; hasToolCall: boolean } {
  const out: {
    content: string
    reasoning_text?: string
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    hasToolCall: boolean
  } = { content: '', hasToolCall: false }
  if (!parts) return out
  let toolIdx = 0
  for (const part of parts) {
    if (part.thought && typeof part.text === 'string') {
      out.reasoning_text = (out.reasoning_text ?? '') + part.text
      continue
    }
    if (typeof part.text === 'string') {
      out.content += part.text
      continue
    }
    if (part.functionCall) {
      const args = part.functionCall.args ?? {}
      let argsJson = '{}'
      try {
        argsJson = JSON.stringify(args)
      } catch {
        argsJson = '{}'
      }
      out.tool_calls ??= []
      const id = `call_${part.functionCall.name}_${toolIdx++}`
      out.tool_calls.push({
        id,
        type: 'function',
        function: { name: part.functionCall.name, arguments: argsJson },
      })
      out.hasToolCall = true
    }
  }
  return out
}

export function translateGeminiToMessagesBody(
  body: GeminiBodyResponse,
  options: TranslateGeminiToMessagesBodyOptions,
): MessagesResponse {
  const cand = body.candidates?.[0]
  const message = geminiPartsToChatMessage(cand?.content?.parts)
  const baseFinish = mapFinishReason(cand?.finishReason)
  const finishReason = message.hasToolCall && baseFinish === 'stop' ? 'tool_calls' : baseFinish

  const chatLike: ChatCompletionResultLike = {
    model: body.modelVersion ?? options.model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: message.content || null,
          ...(message.reasoning_text !== undefined ? { reasoning_text: message.reasoning_text } : {}),
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
  }

  const usage = body.usageMetadata
  if (usage) {
    chatLike.usage = {
      prompt_tokens: usage.promptTokenCount,
      completion_tokens: usage.candidatesTokenCount,
      ...(typeof usage.cachedContentTokenCount === 'number'
        ? { prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount } }
        : {}),
    }
  }

  return translateChatBodyToMessages(chatLike, options.model)
}
