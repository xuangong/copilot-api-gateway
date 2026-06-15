/**
 * Non-streaming body translator: hub OpenAI Responses JSON response →
 * Gemini generateContent JSON response.
 *
 * Strategy (per spec §6): synthesize the equivalent SSE event sequence
 * from the non-stream body, pipe it through `translateResponsesToGeminiEvents`,
 * then merge the per-chunk candidates/usage into a single body response. This
 * keeps the stream/non-stream output mapping in one place (events.ts) rather
 * than duplicating tool_call / part / usage logic.
 */
import type { GeminiCandidate, GeminiFinishReason, GeminiPart, GeminiResult, GeminiUsageMetadata } from '../shared/gemini-via/types.ts'
import { translateResponsesToGeminiEvents } from './events.ts'

export interface TranslateResponsesToGeminiBodyOptions {
  /** Embedded into the resulting `modelVersion` field. */
  model: string
}

// ─── Inbound (Responses non-stream body) shape (subset) ──────────────

interface RespBodyOutputText { type: 'output_text'; text: string }
interface RespBodyMessageItem {
  type: 'message'
  content?: Array<RespBodyOutputText | { type: string }>
}
interface RespBodyReasoningItem {
  type: 'reasoning'
  id?: string
  summary?: Array<{ text?: string }>
}
interface RespBodyFunctionCallItem {
  type: 'function_call'
  call_id?: string
  name?: string
  arguments?: string
}
type RespBodyOutputItem = RespBodyMessageItem | RespBodyReasoningItem | RespBodyFunctionCallItem | { type: string }

interface RespBodyError {
  type?: string
  code?: string
  message?: string
}

export interface ResponsesBodyResponse {
  id?: string
  model?: string
  status?: 'completed' | 'incomplete' | 'failed' | string
  incomplete_details?: { reason?: string } | null
  output?: RespBodyOutputItem[]
  usage?: unknown
  error?: RespBodyError
}

// ─── Synthesizer ─────────────────────────────────────────────────────

const synthesizeEvents = function* (body: ResponsesBodyResponse): Generator<unknown> {
  yield {
    type: 'response.created',
    response: { id: body.id ?? '', model: body.model ?? '' },
  }

  const output = body.output ?? []
  for (const [outputIndex, item] of output.entries()) {
    yield { type: 'response.output_item.added', output_index: outputIndex, item }

    if (item.type === 'message') {
      const message = item as RespBodyMessageItem
      const content = message.content ?? []
      for (const [contentIndex, part] of content.entries()) {
        if (part.type === 'output_text') {
          yield {
            type: 'response.output_text.done',
            output_index: outputIndex,
            content_index: contentIndex,
            text: (part as RespBodyOutputText).text,
          }
        }
      }
    } else if (item.type === 'reasoning') {
      const reasoning = item as RespBodyReasoningItem
      const summary = reasoning.summary ?? []
      for (const [summaryIndex, s] of summary.entries()) {
        if (typeof s.text === 'string' && s.text) {
          yield {
            type: 'response.reasoning_summary_text.done',
            output_index: outputIndex,
            summary_index: summaryIndex,
            text: s.text,
          }
        }
      }
    } else if (item.type === 'function_call') {
      const fn = item as RespBodyFunctionCallItem
      if (fn.arguments !== undefined) {
        yield {
          type: 'response.function_call_arguments.done',
          output_index: outputIndex,
          arguments: fn.arguments,
        }
      }
    }

    yield { type: 'response.output_item.done', output_index: outputIndex, item }
  }

  const status = body.status ?? 'completed'
  const terminalType =
    status === 'failed' ? 'response.failed' : status === 'incomplete' ? 'response.incomplete' : 'response.completed'

  yield {
    type: terminalType,
    response: {
      status,
      incomplete_details: body.incomplete_details ?? null,
      output,
      usage: body.usage,
      ...(body.error ? { error: body.error } : {}),
    },
  }
}

const asAsyncIterable = <T>(gen: Generator<T>): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const value of gen) yield value
  },
})

export async function translateResponsesToGeminiBody(
  body: ResponsesBodyResponse,
  options: TranslateResponsesToGeminiBodyOptions,
): Promise<GeminiResult> {
  const events = asAsyncIterable(synthesizeEvents(body))
  const parts: GeminiPart[] = []
  let finishReason: GeminiFinishReason | undefined
  let usageMetadata: GeminiUsageMetadata | undefined

  for await (const ge of translateResponsesToGeminiEvents(events, { model: options.model })) {
    const candidate = ge.candidates?.[0]
    if (candidate?.content?.parts) parts.push(...candidate.content.parts)
    if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason
    if (ge.usageMetadata !== undefined) usageMetadata = ge.usageMetadata
  }

  const candidate: GeminiCandidate = {
    index: 0,
    content: { role: 'model', parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  }

  return {
    candidates: [candidate],
    ...(usageMetadata !== undefined ? { usageMetadata } : {}),
    modelVersion: options.model,
  }
}
