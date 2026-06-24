/**
 * Stream translator: hub OpenAI Chat Completions SSE chunks → Gemini-shaped
 * generateContent stream events. Pairs with `./request.ts` and runs
 * hub → client.
 *
 * Ported from copilot-gateway's `gemini-via-chat-completions/events.ts`.
 * vNext differences:
 *  - Reference consumes `ProtocolFrame<ChatCompletionsStreamEvent>` and emits
 *    `ProtocolFrame<GeminiStreamEvent>`. vNext consumes `AsyncIterable<unknown>`
 *    and yields bare `GeminiStreamEvent` (matching messages-via-responses /
 *    gemini-via-responses convention).
 *  - Chat chunk shape inlined locally (vNext `@vnext-llm/protocols/chat` does not
 *    define a stream-event schema).
 *  - finish_reason candidates are deferred until the trailing usage chunk so
 *    the final emission carries usageMetadata together with finishReason.
 */
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiPart,
  GeminiStreamEvent,
  GeminiUsageMetadata,
} from '../shared/gemini-via/types.ts'
import {
  appendGeminiThoughtSignature,
  flushGeminiThoughtSignature,
  type GeminiThoughtSignatureState,
  parseStrictJsonObject,
  signGeminiPart,
} from '../shared/gemini-via/gemini.ts'

export interface TranslateChatToGeminiEventsOptions {
  /** Used only as a passthrough into the emitted `modelVersion` field. */
  model?: string
}

// ─── Inbound (Chat Completions) chunk shape (subset) ──────────────────

interface ChatToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface ChatStreamDelta {
  role?: 'assistant'
  content?: string | null
  tool_calls?: ChatToolCallDelta[]
  reasoning_text?: string
  reasoning_opaque?: string
}

type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null | undefined

interface ChatStreamChoice {
  index: number
  delta: ChatStreamDelta
  finish_reason?: ChatFinishReason
}

interface ChatStreamUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
}

interface ChatStreamChunk {
  id?: string
  model?: string
  choices?: ChatStreamChoice[]
  usage?: ChatStreamUsage
  error?: { message?: string }
}

// ─── State ────────────────────────────────────────────────────────────

interface ChatToolCallDraft {
  id?: string
  name?: string
  argsJson: string
}

interface ChoiceState extends GeminiThoughtSignatureState {
  toolCalls: Record<number, ChatToolCallDraft>
}

const getChoiceState = (
  states: Record<number, ChoiceState>,
  index: number,
): ChoiceState => {
  states[index] ??= { toolCalls: {} }
  return states[index]
}

const mapFinishReason = (reason: ChatFinishReason): GeminiFinishReason | undefined => {
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

// OpenAI prompt_tokens already includes prompt_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding (contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed).
const mapUsage = (usage: ChatStreamUsage | undefined): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined

  const metadata: GeminiUsageMetadata = {}
  if (usage.prompt_tokens !== undefined) metadata.promptTokenCount = usage.prompt_tokens
  if (usage.completion_tokens !== undefined) metadata.candidatesTokenCount = usage.completion_tokens
  if (usage.total_tokens !== undefined) metadata.totalTokenCount = usage.total_tokens

  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoningTokens === 'number') metadata.thoughtsTokenCount = reasoningTokens

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
  if (cachedTokens !== undefined) metadata.cachedContentTokenCount = cachedTokens

  if (
    metadata.promptTokenCount === undefined
    && metadata.candidatesTokenCount === undefined
    && metadata.totalTokenCount === undefined
    && metadata.thoughtsTokenCount === undefined
    && metadata.cachedContentTokenCount === undefined
  ) {
    return undefined
  }
  return metadata
}

const accumulateToolCalls = (
  toolCalls: ChatToolCallDelta[],
  state: ChoiceState,
): void => {
  for (const toolCall of toolCalls) {
    const current = (state.toolCalls[toolCall.index] ??= { argsJson: '' })
    if (toolCall.id !== undefined) current.id = toolCall.id
    if (toolCall.function?.name !== undefined) current.name = toolCall.function.name
    if (toolCall.function?.arguments !== undefined) current.argsJson += toolCall.function.arguments
  }
}

const flushToolCallParts = (state: ChoiceState): GeminiPart[] => {
  const parts: GeminiPart[] = []
  const entries = Object.entries(state.toolCalls).sort(
    ([left], [right]) => Number(left) - Number(right),
  )
  for (const [, toolCall] of entries) {
    if (!toolCall.name) continue
    parts.push(
      signGeminiPart(state, {
        functionCall: {
          ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
          name: toolCall.name,
          args: toolCall.argsJson
            ? parseStrictJsonObject(toolCall.argsJson, 'Chat Completions tool call arguments')
            : {},
        },
      }),
    )
  }
  state.toolCalls = {}
  return parts
}

const buildCandidate = (
  choice: ChatStreamChoice,
  state: ChoiceState,
): GeminiCandidate | null => {
  const parts: GeminiPart[] = []
  const delta = choice.delta ?? {}

  if (typeof delta.reasoning_text === 'string' && delta.reasoning_text) {
    parts.push({ text: delta.reasoning_text, thought: true })
  }

  if (typeof delta.reasoning_opaque === 'string' && delta.reasoning_opaque) {
    appendGeminiThoughtSignature(state, delta.reasoning_opaque)
  }

  if (typeof delta.content === 'string' && delta.content) {
    parts.push(signGeminiPart(state, { text: delta.content }))
  }

  if (delta.tool_calls) accumulateToolCalls(delta.tool_calls, state)

  const finishReason = mapFinishReason(choice.finish_reason)
  if (finishReason) {
    parts.push(...flushToolCallParts(state))
    parts.push(...flushGeminiThoughtSignature(state))
  }

  if (!parts.length && !finishReason) return null

  return {
    index: choice.index,
    content: { role: 'model', parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  }
}

const throwOnErrorPayload = (chunk: ChatStreamChunk): void => {
  const message = chunk.error?.message
  if (!message) return
  throw new Error(`Upstream Chat Completions stream error: ${message}`, { cause: chunk })
}

export async function* translateChatToGeminiEvents(
  events: AsyncIterable<unknown>,
  options: TranslateChatToGeminiEventsOptions = {},
): AsyncGenerator<GeminiStreamEvent> {
  const states: Record<number, ChoiceState> = {}
  let pendingUsageMetadata: GeminiUsageMetadata | undefined
  const deferredFinalCandidates: GeminiCandidate[] = []

  try {
    for await (const raw of events) {
      if (!raw || typeof raw !== 'object') continue
      const chunk = raw as ChatStreamChunk
      throwOnErrorPayload(chunk)

      const usageMetadata = mapUsage(chunk.usage)
      if (usageMetadata) pendingUsageMetadata = usageMetadata

      const choices = chunk.choices ?? []
      const nonFinal: GeminiCandidate[] = []
      for (const choice of choices) {
        const state = getChoiceState(states, choice.index)
        const candidate = buildCandidate(choice, state)
        if (!candidate) continue
        if (candidate.finishReason !== undefined) {
          deferredFinalCandidates.push(candidate)
        } else {
          nonFinal.push(candidate)
        }
      }

      if (nonFinal.length) {
        yield { candidates: nonFinal }
      }
    }

    if (deferredFinalCandidates.length) {
      yield {
        candidates: deferredFinalCandidates,
        ...(pendingUsageMetadata ? { usageMetadata: pendingUsageMetadata } : {}),
        ...(options.model ? { modelVersion: options.model } : {}),
      }
    } else if (pendingUsageMetadata) {
      yield {
        usageMetadata: pendingUsageMetadata,
        ...(options.model ? { modelVersion: options.model } : {}),
      }
    }
  } finally {
    for (const k of Object.keys(states)) delete states[Number(k)]
  }
}
