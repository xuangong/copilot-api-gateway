/**
 * Streaming translator: upstream Chat Completions SSE → Gemini SSE events.
 *
 * Replaces the per-chunk `translateChunkToGemini` in services/gemini, which
 * crashes on partial tool-call argument fragments (calls JSON.parse on every
 * delta). This state machine accumulates tool-call args by index until the
 * stream finishes, then emits a single functionCall part — matching the
 * Gemini contract that tool calls arrive as complete objects, not deltas.
 *
 * Also surfaces reasoning (delta.reasoning_text → thought:true part) and
 * the full usage triplet (promptTokens/candidatesTokens/totalTokens +
 * cachedContentTokenCount when present).
 */

import type {
  ChatCompletionChunk,
} from "~/services/gemini/format-conversion"
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiUsageMetadata,
} from "~/services/gemini/types"
import { createFrameBuffer, parseDataJSON } from "~/lib/sse/parser"

interface ToolCallDraft {
  id?: string
  name?: string
  argsJson: string
}

interface ChoiceState {
  toolCalls: Map<number, ToolCallDraft>
}

export interface ChatToGeminiState {
  choices: Map<number, ChoiceState>
  pendingUsage?: GeminiUsageMetadata
  finishedCandidates: Array<GeminiCandidate>
  terminated: boolean
}

export function createChatToGeminiState(): ChatToGeminiState {
  return {
    choices: new Map(),
    finishedCandidates: [],
    terminated: false,
  }
}

function getChoiceState(state: ChatToGeminiState, index: number): ChoiceState {
  let cs = state.choices.get(index)
  if (!cs) {
    cs = { toolCalls: new Map() }
    state.choices.set(index, cs)
  }
  return cs
}

function mapFinishReason(
  reason: ChatCompletionChunk["choices"][number]["finish_reason"],
): GeminiFinishReason | undefined {
  switch (reason) {
    case "stop":
    case "tool_calls":
      return "STOP"
    case "length":
      return "MAX_TOKENS"
    case "content_filter":
      return "SAFETY"
    default:
      return undefined
  }
}

interface ChunkUsageLike {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

function mapUsage(usage?: ChunkUsageLike): GeminiUsageMetadata | undefined {
  if (!usage) return undefined
  const meta: GeminiUsageMetadata & {
    thoughtsTokenCount?: number
  } = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  }
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === "number") {
    meta.cachedContentTokenCount = cached
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === "number") {
    meta.thoughtsTokenCount = reasoning
  }
  return meta
}

function flushToolCallParts(cs: ChoiceState): GeminiPart[] {
  const parts: GeminiPart[] = []
  const entries = Array.from(cs.toolCalls.entries()).sort(
    ([a], [b]) => a - b,
  )
  for (const [, draft] of entries) {
    if (!draft.name) continue
    let args: Record<string, unknown> = {}
    if (draft.argsJson) {
      try {
        const parsed = JSON.parse(draft.argsJson) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        // Leave args empty if upstream emitted malformed JSON.
      }
    }
    parts.push({
      functionCall: { name: draft.name, args },
    })
  }
  cs.toolCalls.clear()
  return parts
}

interface ChunkDeltaLike {
  role?: "assistant"
  content?: string
  reasoning_text?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: { name?: string; arguments?: string }
  }>
}

function buildCandidateForChunk(
  state: ChatToGeminiState,
  chunk: ChatCompletionChunk,
  choice: ChatCompletionChunk["choices"][number],
): { live?: GeminiCandidate; finished?: GeminiCandidate } {
  const cs = getChoiceState(state, choice.index)
  const liveParts: GeminiPart[] = []
  const delta = choice.delta as ChunkDeltaLike

  if (typeof delta.reasoning_text === "string" && delta.reasoning_text) {
    liveParts.push({ text: delta.reasoning_text, thought: true } as GeminiPart)
  }
  if (typeof delta.content === "string" && delta.content) {
    liveParts.push({ text: delta.content })
  }
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      let draft = cs.toolCalls.get(tc.index)
      if (!draft) {
        draft = { argsJson: "" }
        cs.toolCalls.set(tc.index, draft)
      }
      if (tc.id !== undefined) draft.id = tc.id
      if (tc.function?.name !== undefined) draft.name = tc.function.name
      if (tc.function?.arguments !== undefined) {
        draft.argsJson += tc.function.arguments
      }
    }
  }

  const finishReason = mapFinishReason(choice.finish_reason)
  let live: GeminiCandidate | undefined
  if (liveParts.length) {
    live = {
      index: choice.index,
      content: { role: "model", parts: liveParts },
    }
  }

  let finished: GeminiCandidate | undefined
  if (finishReason !== undefined) {
    const trailingParts = flushToolCallParts(cs)
    finished = {
      index: choice.index,
      content: { role: "model", parts: trailingParts },
      finishReason,
    }
  }

  void chunk
  return { live, finished }
}

export function translateChunkToGeminiResponses(
  state: ChatToGeminiState,
  chunk: ChatCompletionChunk,
): Array<GeminiGenerateContentResponse> {
  const out: Array<GeminiGenerateContentResponse> = []
  const liveCandidates: GeminiCandidate[] = []
  for (const choice of chunk.choices) {
    const { live, finished } = buildCandidateForChunk(state, chunk, choice)
    if (live) liveCandidates.push(live)
    if (finished) state.finishedCandidates.push(finished)
  }
  const usage = mapUsage(chunk.usage as ChunkUsageLike | undefined)
  if (usage) state.pendingUsage = usage
  if (liveCandidates.length) {
    out.push({ candidates: liveCandidates })
  }
  return out
}

export function finalizeChatToGemini(
  state: ChatToGeminiState,
): GeminiGenerateContentResponse | null {
  if (state.terminated) return null
  state.terminated = true
  if (!state.finishedCandidates.length && !state.pendingUsage) return null
  return {
    ...(state.finishedCandidates.length
      ? { candidates: state.finishedCandidates }
      : {}),
    ...(state.pendingUsage ? { usageMetadata: state.pendingUsage } : {}),
  }
}

/**
 * Build a TransformStream that consumes Chat Completions SSE bytes and emits
 * Gemini SSE (`alt=sse`) bytes. For the alt=json (NDJSON-ish) path, prefer
 * the lower-level helpers above and serialize without the `data: ` prefix.
 */
export function createChatToGeminiSSEStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  return createChatToGeminiTransform({ wrapSSE: true })
}

export function createChatToGeminiJSONStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  return createChatToGeminiTransform({ wrapSSE: false })
}

function createChatToGeminiTransform(opts: {
  wrapSSE: boolean
}): TransformStream<Uint8Array, Uint8Array> {
  const state = createChatToGeminiState()
  const buffer = createFrameBuffer()
  const encoder = new TextEncoder()

  const writeResponse = (
    resp: GeminiGenerateContentResponse,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    const body = JSON.stringify(resp)
    const bytes = opts.wrapSSE
      ? encoder.encode(`data: ${body}\n\n`)
      : encoder.encode(`${body}\n`)
    controller.enqueue(bytes)
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const frame of buffer.push(chunk)) {
        if (!frame.data || frame.data === "[DONE]") continue
        const parsed = parseDataJSON<ChatCompletionChunk>(frame)
        if (!parsed) continue
        for (const resp of translateChunkToGeminiResponses(state, parsed)) {
          writeResponse(resp, controller)
        }
      }
    },
    flush(controller) {
      const tail = buffer.flush()
      if (tail?.data && tail.data !== "[DONE]") {
        const parsed = parseDataJSON<ChatCompletionChunk>(tail)
        if (parsed) {
          for (const resp of translateChunkToGeminiResponses(state, parsed)) {
            writeResponse(resp, controller)
          }
        }
      }
      const final = finalizeChatToGemini(state)
      if (final) writeResponse(final, controller)
    },
  })
}
