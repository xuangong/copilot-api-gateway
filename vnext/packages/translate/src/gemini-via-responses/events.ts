/**
 * Stream translator: hub OpenAI Responses SSE events → Gemini-shaped
 * generateContent stream chunks. Pairs with `./request.ts` and runs
 * hub → client.
 *
 * Ported from copilot-gateway's `gemini-via-responses/events.ts`. vNext
 * differences from the reference:
 *  - Reference uses `ProtocolFrame<T>` framing (`event` / `done` types) and
 *    `eventFrame()` helper. vNext consumes a plain `AsyncIterable<unknown>`
 *    (matching `messages-via-responses/events.ts`) and yields bare
 *    `GeminiResult` objects; the gateway encoder wraps them as SSE.
 *  - Responses event shapes are inlined locally (vNext protocols package
 *    leaves nested Responses shapes loose).
 */
import type { GeminiFinishReason, GeminiPart, GeminiResult, GeminiUsageMetadata } from '../shared/gemini-via/types.ts'
import { geminiCandidateEvent, parseStrictJsonObject } from '../shared/gemini-via/gemini.ts'

export interface TranslateResponsesToGeminiEventsOptions {
  /** Reserved for future passthrough into emitted modelVersion. */
  model?: string
}

// ─── Inbound (Responses) event shape (subset) ──────────────────────────

interface RespUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  input_tokens_details?: { cached_tokens?: number }
}

interface RespError {
  type?: string
  code?: string
  message?: string
}

interface RespResult {
  status?: string
  incomplete_details?: { reason?: string } | null
  output?: Array<{ type?: string }>
  usage?: RespUsage
  error?: RespError
}

interface RespOutputFunctionCall {
  type: 'function_call'
  call_id?: string
  name?: string
  arguments?: string
}

interface RespOutputReasoning {
  type: 'reasoning'
  summary: Array<{ text?: string }>
}

interface RespEventBase {
  type: string
  output_index?: number
  content_index?: number
  summary_index?: number
}

interface RespTextDeltaEvent extends RespEventBase {
  type: 'response.output_text.delta'
  output_index: number
  content_index: number
  delta: string
}

interface RespTextDoneEvent extends RespEventBase {
  type: 'response.output_text.done'
  output_index: number
  content_index: number
  text: string
}

interface RespReasoningDeltaEvent extends RespEventBase {
  type: 'response.reasoning_summary_text.delta'
  output_index: number
  summary_index: number
  delta: string
}

interface RespReasoningDoneEvent extends RespEventBase {
  type: 'response.reasoning_summary_text.done'
  output_index: number
  summary_index: number
  text: string
}

interface RespOutputItemAddedEvent extends RespEventBase {
  type: 'response.output_item.added'
  output_index: number
  item: { type: string; call_id?: string; name?: string; arguments?: string }
}

interface RespOutputItemDoneEvent extends RespEventBase {
  type: 'response.output_item.done'
  output_index: number
  item: RespOutputFunctionCall | RespOutputReasoning | { type: string }
}

interface RespFnArgsDeltaEvent extends RespEventBase {
  type: 'response.function_call_arguments.delta'
  output_index: number
  delta: string
}

interface RespFnArgsDoneEvent extends RespEventBase {
  type: 'response.function_call_arguments.done'
  output_index: number
  arguments: string
}

interface RespTerminalEvent extends RespEventBase {
  type: 'response.completed' | 'response.incomplete' | 'response.failed'
  response: RespResult
}

interface RespErrorEvent extends RespEventBase {
  type: 'error'
  message?: string
}

type RespEvent =
  | RespTextDeltaEvent
  | RespTextDoneEvent
  | RespReasoningDeltaEvent
  | RespReasoningDoneEvent
  | RespOutputItemAddedEvent
  | RespOutputItemDoneEvent
  | RespFnArgsDeltaEvent
  | RespFnArgsDoneEvent
  | RespTerminalEvent
  | RespErrorEvent
  | RespEventBase

// ─── State ─────────────────────────────────────────────────────────────

interface ResponsesFunctionCallDraft {
  id?: string
  name?: string
  argsJson: string
}

interface State {
  functionCalls: Map<number, ResponsesFunctionCallDraft>
  emittedReasoningKeys: Set<string>
  emittedTextKeys: Set<string>
}

const partKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`

// Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding (contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed).
const mapUsage = (usage: RespUsage | undefined): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined
  return {
    ...(usage.input_tokens !== undefined ? { promptTokenCount: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { candidatesTokenCount: usage.output_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokenCount: usage.total_tokens } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { thoughtsTokenCount: usage.output_tokens_details.reasoning_tokens }
      : {}),
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? { cachedContentTokenCount: usage.input_tokens_details.cached_tokens }
      : {}),
  }
}

const isSafetyFailure = (response: RespResult): boolean => {
  const error = response.error
  if (!error) return false
  const text = `${error.type ?? ''} ${error.code ?? ''} ${error.message ?? ''}`.toLowerCase()
  return text.includes('safety') || text.includes('content_filter') || text.includes('policy')
}

const mapTerminalFinishReason = (event: RespTerminalEvent): GeminiFinishReason => {
  if (event.type === 'response.completed') return 'STOP'
  if (event.type === 'response.failed') {
    return isSafetyFailure(event.response) ? 'SAFETY' : 'OTHER'
  }
  return event.response.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : 'OTHER'
}

const emitTextPart = (part: GeminiPart): GeminiResult => geminiCandidateEvent([part])

function* reasoningItemDoneEvents(
  item: RespOutputReasoning,
  outputIndex: number,
  state: State,
): Generator<GeminiResult> {
  for (const [summaryIndex, summary] of item.summary.entries()) {
    const key = partKey(outputIndex, summaryIndex)
    if (!summary.text || state.emittedReasoningKeys.has(key)) continue
    state.emittedReasoningKeys.add(key)
    yield geminiCandidateEvent([{ text: summary.text, thought: true }])
  }
}

function functionCallDoneEvent(
  item: RespOutputFunctionCall,
  outputIndex: number,
  state: State,
): GeminiResult {
  const current = state.functionCalls.get(outputIndex)
  state.functionCalls.delete(outputIndex)

  const draft = current ?? {
    id: item.call_id,
    name: item.name,
    argsJson: item.arguments ?? '',
  }
  const argsJson = current?.argsJson || item.arguments || ''

  if (!draft.name) {
    throw new Error('Responses function call ended without a name.')
  }

  return emitTextPart({
    functionCall: {
      ...(draft.id !== undefined ? { id: draft.id } : {}),
      name: draft.name,
      args: argsJson ? parseStrictJsonObject(argsJson, 'Responses function call arguments') : {},
    },
  })
}

const handleTerminal = (event: RespTerminalEvent): GeminiResult =>
  geminiCandidateEvent([], mapTerminalFinishReason(event), mapUsage(event.response.usage))

export async function* translateResponsesToGeminiEvents(
  events: AsyncIterable<unknown>,
  _options: TranslateResponsesToGeminiEventsOptions = {},
): AsyncGenerator<GeminiResult> {
  const state: State = {
    functionCalls: new Map(),
    emittedReasoningKeys: new Set(),
    emittedTextKeys: new Set(),
  }

  try {
    for await (const raw of events) {
      if (!raw || typeof raw !== 'object') continue
      const event = raw as RespEvent
      if (typeof event.type !== 'string') continue

      switch (event.type) {
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_summary_text.done': {
          const ev = event as RespReasoningDeltaEvent | RespReasoningDoneEvent
          const text = ev.type === 'response.reasoning_summary_text.delta' ? ev.delta : ev.text
          if (!text) break
          const key = partKey(ev.output_index, ev.summary_index)
          if (ev.type === 'response.reasoning_summary_text.done' && state.emittedReasoningKeys.has(key)) break
          state.emittedReasoningKeys.add(key)
          yield geminiCandidateEvent([{ text, thought: true }])
          break
        }

        case 'response.output_text.delta':
        case 'response.output_text.done': {
          const ev = event as RespTextDeltaEvent | RespTextDoneEvent
          const text = ev.type === 'response.output_text.delta' ? ev.delta : ev.text
          if (!text) break
          const key = partKey(ev.output_index, ev.content_index)
          if (ev.type === 'response.output_text.done' && state.emittedTextKeys.has(key)) break
          state.emittedTextKeys.add(key)
          yield emitTextPart({ text })
          break
        }

        case 'response.output_item.added': {
          const ev = event as RespOutputItemAddedEvent
          if (ev.item.type === 'function_call') {
            state.functionCalls.set(ev.output_index, {
              id: ev.item.call_id,
              name: ev.item.name,
              argsJson: ev.item.arguments ?? '',
            })
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          const ev = event as RespFnArgsDeltaEvent
          const current = state.functionCalls.get(ev.output_index)
          if (current) current.argsJson += ev.delta
          break
        }

        case 'response.function_call_arguments.done': {
          const ev = event as RespFnArgsDoneEvent
          const current = state.functionCalls.get(ev.output_index)
          if (current) current.argsJson = ev.arguments
          break
        }

        case 'response.output_item.done': {
          const ev = event as RespOutputItemDoneEvent
          if (ev.item.type === 'reasoning') {
            yield* reasoningItemDoneEvents(ev.item as RespOutputReasoning, ev.output_index, state)
          } else if (ev.item.type === 'function_call') {
            yield functionCallDoneEvent(ev.item as RespOutputFunctionCall, ev.output_index, state)
          }
          break
        }

        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed':
          yield handleTerminal(event as RespTerminalEvent)
          return

        case 'error': {
          const ev = event as RespErrorEvent
          throw new Error(`Upstream Responses stream error: ${ev.message ?? 'unknown'}`, { cause: ev })
        }

        default:
          break
      }
    }
  } finally {
    state.functionCalls.clear()
    state.emittedReasoningKeys.clear()
    state.emittedTextKeys.clear()
  }
}
