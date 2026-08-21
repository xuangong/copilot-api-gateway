/**
 * Non-streaming body translator: hub OpenAI Chat Completions JSON response →
 * Gemini generateContent JSON response.
 *
 * Strategy (per spec §6, mirrors gemini-via-responses/body.ts): synthesize the
 * equivalent stream-chunk sequence from the non-stream body, pipe it through
 * `translateChatToGeminiEvents`, then merge per-chunk candidates/usage into a
 * single body response. Keeps stream/non-stream output mapping in one place.
 */
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGroundingMetadata,
  GeminiPart,
  GeminiResult,
  GeminiUsageMetadata,
} from '../shared/gemini-via/types.ts'
import { translateChatToGeminiEvents } from './events.ts'

export interface TranslateChatToGeminiBodyOptions {
  /** Embedded into the resulting `modelVersion` field. */
  model: string
}

// ─── Inbound (Chat Completions non-stream body) shape (subset) ──────

interface ChatBodyToolCall {
  id?: string
  type?: 'function'
  function: { name: string; arguments?: string }
}

interface ChatBodyMessage {
  role?: 'assistant'
  content?: string | null
  tool_calls?: ChatBodyToolCall[]
  reasoning_text?: string
  reasoning_opaque?: string
  annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string } }> | null
}

interface ChatBodyChoice {
  index: number
  message: ChatBodyMessage
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface ChatCompletionsBodyResponse {
  id?: string
  model?: string
  choices: ChatBodyChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string }
}

// ─── Synthesizer ────────────────────────────────────────────────────

const synthesizeChunks = function* (body: ChatCompletionsBodyResponse): Generator<unknown> {
  const baseChoices = body.choices.map(choice => {
    const message = choice.message ?? {}
    const toolCalls = (message.tool_calls ?? []).map((tc, index) => ({
      index,
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments ?? '' },
    }))

    const delta: Record<string, unknown> = { role: 'assistant' }
    if (typeof message.reasoning_text === 'string' && message.reasoning_text) {
      delta.reasoning_text = message.reasoning_text
    }
    if (typeof message.reasoning_opaque === 'string' && message.reasoning_opaque) {
      delta.reasoning_opaque = message.reasoning_opaque
    }
    if (typeof message.content === 'string' && message.content) {
      delta.content = message.content
    }
    if (toolCalls.length) {
      delta.tool_calls = toolCalls
    }
    // Replayed as a delta so the stream translator's citation accumulator is
    // the single place that turns url_citations into groundingMetadata.
    if (message.annotations?.length) {
      delta.annotations = message.annotations
    }

    return { index: choice.index, delta, finish_reason: null as ChatBodyChoice['finish_reason'] }
  })

  // Single content chunk carrying all deltas (no finish_reason yet).
  if (baseChoices.length) {
    yield {
      id: body.id,
      model: body.model,
      choices: baseChoices.map(c => ({ index: c.index, delta: c.delta, finish_reason: null })),
    }
  }

  // Per-choice finish chunk.
  for (const choice of body.choices) {
    yield {
      id: body.id,
      model: body.model,
      choices: [
        { index: choice.index, delta: {}, finish_reason: choice.finish_reason ?? 'stop' },
      ],
    }
  }

  // Trailing usage chunk.
  if (body.usage) {
    yield {
      id: body.id,
      model: body.model,
      choices: [],
      usage: body.usage,
    }
  }
}

const asAsyncIterable = <T>(gen: Generator<T>): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const value of gen) yield value
  },
})

export async function translateChatToGeminiBody(
  body: ChatCompletionsBodyResponse,
  options: TranslateChatToGeminiBodyOptions,
): Promise<GeminiResult> {
  const events = asAsyncIterable(synthesizeChunks(body))

  const partsByIndex = new Map<number, GeminiPart[]>()
  const finishByIndex = new Map<number, GeminiFinishReason>()
  const groundingByIndex = new Map<number, GeminiGroundingMetadata>()
  let usageMetadata: GeminiUsageMetadata | undefined

  for await (const ge of translateChatToGeminiEvents(events, { model: options.model })) {
    if ('error' in ge) continue
    if (ge.usageMetadata !== undefined) usageMetadata = ge.usageMetadata
    for (const candidate of ge.candidates ?? []) {
      const idx = candidate.index ?? 0
      if (candidate.content?.parts?.length) {
        const existing = partsByIndex.get(idx) ?? []
        existing.push(...candidate.content.parts)
        partsByIndex.set(idx, existing)
      }
      if (candidate.finishReason !== undefined) finishByIndex.set(idx, candidate.finishReason)
      if (candidate.groundingMetadata !== undefined) groundingByIndex.set(idx, candidate.groundingMetadata)
    }
  }

  const indices = new Set<number>([
    ...partsByIndex.keys(),
    ...finishByIndex.keys(),
    ...body.choices.map(c => c.index),
  ])
  const sortedIndices = [...indices].sort((a, b) => a - b)

  const candidates: GeminiCandidate[] = sortedIndices.map(idx => {
    const parts = partsByIndex.get(idx) ?? []
    const finishReason = finishByIndex.get(idx)
    const groundingMetadata = groundingByIndex.get(idx)
    return {
      index: idx,
      content: { role: 'model', parts },
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
    }
  })

  return {
    candidates: candidates.length ? candidates : [{ index: 0, content: { role: 'model', parts: [] } }],
    ...(usageMetadata !== undefined ? { usageMetadata } : {}),
    modelVersion: options.model,
  }
}
