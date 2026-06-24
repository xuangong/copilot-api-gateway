/**
 * Stream translator: hub Anthropic Messages SSE → Gemini-shaped responses
 * (one per generateContent stream chunk; the gateway encoder wraps them as
 * `data: …` SSE or alt=json NDJSON).
 *
 * Composition: translateMessagesToChatSSE (Pair 1) → Chat-to-Gemini state
 * machine (inlined here, mirrors `gemini-via-chat/events.ts` from the
 * pre-pivot reference). This keeps tool-call accumulation/usage-mapping
 * logic in one place and avoids re-implementing block-state lifecycles.
 *
 * Cancellation: implemented as an async generator with try/finally so per-
 * stream state is released when the consumer breaks out of the loop.
 */
import type { MessagesEvent } from '@vnext-llm/protocols/messages'
import { translateMessagesToChatSSE, type ChatSSEChunk } from '../chat-completions-via-messages/index.ts'

export interface TranslateMessagesToGeminiEventsOptions {
  /** Used only as a passthrough into the emitted `modelVersion` field. */
  model?: string
}

// ─── Gemini output shape (subset) ───

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
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'FINISH_REASON_UNSPECIFIED'
}

export interface GeminiStreamResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
}

interface ToolCallDraft {
  id?: string
  name?: string
  argsJson: string
}

interface ChoiceState {
  toolCalls: Map<number, ToolCallDraft>
}

interface State {
  model?: string
  choices: Map<number, ChoiceState>
  pendingUsage?: GeminiUsageMetadata
  finishedCandidates: GeminiCandidate[]
  terminated: boolean
}

function createState(model: string | undefined): State {
  return {
    model,
    choices: new Map(),
    finishedCandidates: [],
    terminated: false,
  }
}

function getChoiceState(state: State, index: number): ChoiceState {
  let cs = state.choices.get(index)
  if (!cs) {
    cs = { toolCalls: new Map() }
    state.choices.set(index, cs)
  }
  return cs
}

function mapFinishReason(
  reason: ChatSSEChunk['choices'][0]['finish_reason'],
): GeminiCandidate['finishReason'] | undefined {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return 'STOP'
    case 'length':
      return 'MAX_TOKENS'
    case 'content_filter':
      return 'SAFETY'
    default:
      return undefined
  }
}

function mapUsage(usage: ChatSSEChunk['usage']): GeminiUsageMetadata | undefined {
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

function flushToolCallParts(cs: ChoiceState): GeminiPart[] {
  const parts: GeminiPart[] = []
  const entries = Array.from(cs.toolCalls.entries()).sort(([a], [b]) => a - b)
  for (const [, draft] of entries) {
    if (!draft.name) continue
    let args: Record<string, unknown> = {}
    if (draft.argsJson) {
      try {
        const parsed = JSON.parse(draft.argsJson) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        // Drop malformed JSON; the stream must still finalize.
      }
    }
    parts.push({ functionCall: { name: draft.name, args } })
  }
  cs.toolCalls.clear()
  return parts
}

function buildChunkResponses(state: State, chunk: ChatSSEChunk): GeminiStreamResponse[] {
  const out: GeminiStreamResponse[] = []
  const liveCandidates: GeminiCandidate[] = []

  for (const choice of chunk.choices) {
    const cs = getChoiceState(state, choice.index)
    const liveParts: GeminiPart[] = []
    const delta = choice.delta

    if (typeof delta.reasoning_text === 'string' && delta.reasoning_text) {
      liveParts.push({ text: delta.reasoning_text, thought: true })
    }
    if (typeof delta.content === 'string' && delta.content) {
      liveParts.push({ text: delta.content })
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let draft = cs.toolCalls.get(tc.index)
        if (!draft) {
          draft = { argsJson: '' }
          cs.toolCalls.set(tc.index, draft)
        }
        if (tc.id !== undefined) draft.id = tc.id
        if (tc.function?.name !== undefined) draft.name = tc.function.name
        if (tc.function?.arguments !== undefined) {
          draft.argsJson += tc.function.arguments
        }
      }
    }

    if (liveParts.length > 0) {
      liveCandidates.push({
        index: choice.index,
        content: { role: 'model', parts: liveParts },
      })
    }

    const finishReason = mapFinishReason(choice.finish_reason)
    if (finishReason !== undefined) {
      const trailingParts = flushToolCallParts(cs)
      state.finishedCandidates.push({
        index: choice.index,
        content: { role: 'model', parts: trailingParts },
        finishReason,
      })
    }
  }

  const usage = mapUsage(chunk.usage)
  if (usage) state.pendingUsage = usage

  if (liveCandidates.length > 0) {
    out.push({ candidates: liveCandidates })
  }
  return out
}

function buildFinalResponse(state: State): GeminiStreamResponse | null {
  if (state.terminated) return null
  state.terminated = true
  if (state.finishedCandidates.length === 0 && !state.pendingUsage) return null
  const out: GeminiStreamResponse = {}
  if (state.finishedCandidates.length > 0) out.candidates = state.finishedCandidates
  if (state.pendingUsage) out.usageMetadata = state.pendingUsage
  if (state.model) out.modelVersion = state.model
  return out
}

export async function* translateMessagesToGeminiEvents(
  events: AsyncIterable<MessagesEvent>,
  options: TranslateMessagesToGeminiEventsOptions = {},
): AsyncGenerator<GeminiStreamResponse> {
  const state = createState(options.model)
  const chatStream = translateMessagesToChatSSE(events)
  try {
    for await (const chunk of chatStream) {
      for (const resp of buildChunkResponses(state, chunk)) {
        yield resp
      }
    }
    const final = buildFinalResponse(state)
    if (final) yield final
  } finally {
    state.choices.clear()
    state.terminated = true
  }
}
