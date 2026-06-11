/**
 * Stream translator: hub Gemini stream chunks → Anthropic Messages SSE.
 *
 * Composition: Gemini chunks → Chat Completions chunks → Pair 2's
 * `translateChatSSEToMessagesEvents`. The state machine that emits
 * message_start, content_block_start/delta/stop, message_delta, and
 * message_stop already lives in Pair 2; we only translate Gemini-shaped
 * deltas into Chat-shaped deltas here.
 *
 * Cancellation: implemented as an async generator with try/finally so
 * Pair 2's underlying state is released when the consumer breaks out.
 */
import type { MessagesEvent } from '@vnext/protocols/messages'
import { translateChatSSEToMessagesEvents } from '../messages-via-chat-completions/index.ts'

// ─── Gemini source-shape (subset) ───

export interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount: number
  cachedContentTokenCount?: number
}

export interface GeminiPart {
  text?: string
  thought?: boolean
  functionCall?: { name: string; args: Record<string, unknown> }
}

export interface GeminiCandidate {
  index?: number
  content?: { role: 'model'; parts: GeminiPart[] }
  finishReason?: string
}

export interface GeminiStreamResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
}

export interface TranslateGeminiToMessagesEventsOptions {
  /** Pass-through model name; surfaces in Pair 2's synthetic message_start. */
  model?: string
}

// ─── Chat-shape (intermediate, mirrors Pair 2's input) ───

interface ChatToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface ChatChunkLike {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: 'assistant'
      content?: string | null
      tool_calls?: ChatToolCallDelta[]
      reasoning_text?: string
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function mapFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'STOP':
      return hasToolCalls ? 'tool_calls' : 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter'
    case undefined:
      return null
    default:
      return null
  }
}

interface State {
  /** Number of tool_calls we've emitted; used to assign Chat tool_call.index. */
  toolCallCounter: number
  /** Was a model name pinned in the first chunk? */
  modelPinned: boolean
  modelOverride?: string
}

function createState(modelOverride: string | undefined): State {
  return {
    toolCallCounter: 0,
    modelPinned: false,
    modelOverride,
  }
}

function geminiPartsToChatDelta(
  parts: GeminiPart[] | undefined,
  state: State,
): { content: string; reasoning_text: string; tool_calls: ChatToolCallDelta[]; hasToolCall: boolean } {
  const result = { content: '', reasoning_text: '', tool_calls: [] as ChatToolCallDelta[], hasToolCall: false }
  if (!parts || parts.length === 0) return result
  for (const part of parts) {
    if (part.thought && typeof part.text === 'string') {
      result.reasoning_text += part.text
      continue
    }
    if (typeof part.text === 'string') {
      result.content += part.text
      continue
    }
    if (part.functionCall) {
      const idx = state.toolCallCounter++
      const args = part.functionCall.args ?? {}
      let argsJson = '{}'
      try {
        argsJson = JSON.stringify(args)
      } catch {
        argsJson = '{}'
      }
      result.tool_calls.push({
        index: idx,
        id: `call_${part.functionCall.name}_${idx}`,
        type: 'function',
        function: { name: part.functionCall.name, arguments: argsJson },
      })
      result.hasToolCall = true
    }
  }
  return result
}

function geminiUsageToChatUsage(usage: GeminiUsageMetadata | undefined): ChatChunkLike['usage'] | undefined {
  if (!usage) return undefined
  const out: ChatChunkLike['usage'] = {
    prompt_tokens: usage.promptTokenCount,
    completion_tokens: usage.candidatesTokenCount,
  }
  if (typeof usage.cachedContentTokenCount === 'number') {
    out.prompt_tokens_details = { cached_tokens: usage.cachedContentTokenCount }
  }
  return out
}

async function* translateGeminiToChatChunks(
  chunks: AsyncIterable<GeminiStreamResponse>,
  state: State,
): AsyncGenerator<ChatChunkLike> {
  for await (const chunk of chunks) {
    const cands = chunk.candidates ?? []
    if (cands.length === 0) {
      const usage = geminiUsageToChatUsage(chunk.usageMetadata)
      if (usage) {
        const out: ChatChunkLike = { choices: [], usage }
        if (!state.modelPinned && (chunk.modelVersion || state.modelOverride)) {
          out.model = chunk.modelVersion ?? state.modelOverride
          state.modelPinned = true
        }
        yield out
      }
      continue
    }
    const cand = cands[0]
    if (!cand) continue
    const delta = geminiPartsToChatDelta(cand.content?.parts, state)

    const out: ChatChunkLike = {}
    if (!state.modelPinned && (chunk.modelVersion || state.modelOverride)) {
      out.model = chunk.modelVersion ?? state.modelOverride
      state.modelPinned = true
    }
    const choiceIndex = cand.index ?? 0
    const finishReason = mapFinishReason(cand.finishReason, delta.hasToolCall)

    out.choices = [
      {
        index: choiceIndex,
        delta: {
          ...(delta.content ? { content: delta.content } : {}),
          ...(delta.reasoning_text ? { reasoning_text: delta.reasoning_text } : {}),
          ...(delta.tool_calls.length > 0 ? { tool_calls: delta.tool_calls } : {}),
        },
        finish_reason: finishReason,
      },
    ]
    const usage = geminiUsageToChatUsage(chunk.usageMetadata)
    if (usage) out.usage = usage

    yield out
  }
}

export async function* translateGeminiToMessagesEvents(
  chunks: AsyncIterable<GeminiStreamResponse>,
  options: TranslateGeminiToMessagesEventsOptions = {},
): AsyncGenerator<MessagesEvent> {
  const state = createState(options.model)
  const chatChunks = translateGeminiToChatChunks(chunks, state)
  try {
    for await (const ev of translateChatSSEToMessagesEvents(chatChunks)) {
      yield ev
    }
  } finally {
    // Pair 2's translator owns its own state cleanup via try/finally; the
    // chatChunks generator will run its own finally as the for-await unwinds.
  }
}
