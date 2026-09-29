import { chatReasoningText } from "@vibe-llm/translate/shared/chat-reasoning-text"
import { chatCompletionsErrorPayloadMessage } from '@vibe-llm/protocols/chat'
import type {
  ChatCompletionsStreamEvent,
  ChatCompletionsReasoningItem,
  ChatCompletionsAnnotation,
} from '@vibe-llm/protocols/chat'
import { captureExtras } from '../../shared/reassemble-extras.ts'

export interface ChatCompletionsResult {
  id: string
  /**
   * Always `'chat.completion'` — this is the static discriminator of the
   * OpenAI Chat Completions non-streaming envelope. The OpenAI SDK relies on
   * it to type-narrow the response, so we synthesize it unconditionally even
   * when upstream (Copilot's Azure) omits it. Matches
   * `copilot-gateway/packages/protocols/src/chat-completions/reassemble.ts`.
   */
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      reasoning_text?: string
      reasoning_opaque?: string
      reasoning_items?: ChatCompletionsReasoningItem[]
      annotations?: ChatCompletionsAnnotation[]
      [k: string]: unknown
    }
    finish_reason: string
    [k: string]: unknown
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; [k: string]: unknown }
  [k: string]: unknown
}

// Known fields handled explicitly by the typed accumulators below. Anything
// outside these sets is vendor padding (Copilot `content_filter_results`,
// `prompt_filter_results`, `service_tier`, `copilot_usage`, `message.padding`,
// future OpenAI/Anthropic extensions) and flows through captureExtras so it
// reaches the client untouched. Mirrors copilot-gateway/.../reassemble.ts.
const KNOWN_CHUNK_KEYS: ReadonlySet<string> = new Set([
  'id', 'object', 'created', 'model', 'choices', 'usage', '__upstream_object',
])
const KNOWN_CHOICE_KEYS: ReadonlySet<string> = new Set(['index', 'delta', 'finish_reason'])
const KNOWN_DELTA_KEYS: ReadonlySet<string> = new Set([
  'content', 'role', 'reasoning_text', 'reasoning_opaque', 'reasoning_items', 'tool_calls',
  'annotations',
])

// SSE chunks always carry `object: 'chat.completion.chunk'`. The synthesized
// `chat.completion` envelope's `object` field is stamped unconditionally in
// the final result (see below), so we don't need to track upstream's variant
// here — the `__upstream_object` sidecar from json-to-frames is ignored.
type ChunkWithSidecar = ChatCompletionsStreamEvent & { __upstream_object?: 'chat.completion' }

export async function reassembleChatCompletions(
  chunks: AsyncIterable<ChatCompletionsStreamEvent>,
): Promise<ChatCompletionsResult> {
  let id = ''
  let model = ''
  let created = 0
  let lastUsage: ChatCompletionsResult['usage'] | undefined
  const chunkExtras: Record<string, unknown> = {}
  const states = new Map<number, ReturnType<typeof createChoice>>()
  function createChoice() {
    return {
      content: "", reasoningText: "", reasoningOpaque: "", hasReasoningText: false, hasReasoningOpaque: false,
      reasoningItems: [] as ChatCompletionsReasoningItem[], annotations: [] as ChatCompletionsAnnotation[], finishReason: "stop",
      toolCallsMap: new Map<number, { id: string; name: string; arguments: string }>(),
      choiceExtras: {} as Record<string, unknown>, messageExtras: {} as Record<string, unknown>,
    }
  }

  for await (const rawChunk of chunks) {
    const chunk = rawChunk as ChunkWithSidecar
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk)
    if (errorMessage) {
      throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`)
    }

    if (!id && chunk.id) {
      id = chunk.id
      model = chunk.model
      created = chunk.created
    }

    if (chunk.usage) {
      lastUsage = chunk.usage as ChatCompletionsResult['usage']
    }

    captureExtras(chunk as unknown as Record<string, unknown>, KNOWN_CHUNK_KEYS, chunkExtras)

    const choices = chunk.choices as unknown as Array<Record<string, unknown>> | undefined
    if (!choices) continue

    for (const choice of choices) {
      const index = typeof choice.index === "number" ? choice.index : 0
      const state = states.get(index) ?? createChoice()
      states.set(index, state)
      captureExtras(choice, KNOWN_CHOICE_KEYS, state.choiceExtras)
      const delta = choice.delta as Record<string, unknown> | undefined
      if (!delta) continue
      captureExtras(delta, KNOWN_DELTA_KEYS, state.messageExtras)

      if (typeof delta.content === 'string') {
        state.content += delta.content
      }
      const reasoning = chatReasoningText(delta)
      if (reasoning !== undefined) {
        state.hasReasoningText = true
        state.reasoningText += reasoning
      }
      if (typeof delta.reasoning_opaque === 'string') {
        state.reasoningOpaque += delta.reasoning_opaque
        state.hasReasoningOpaque = true
      }
      if (Array.isArray(delta.reasoning_items)) {
        state.reasoningItems.push(...(delta.reasoning_items as ChatCompletionsReasoningItem[]))
      }
      // Citations arrive as whole entries, never as partial deltas, so a plain
      // concat is the correct accumulation (unlike tool_calls, which are
      // index-keyed and streamed piecewise).
      if (Array.isArray(delta.annotations)) {
        state.annotations.push(...(delta.annotations as ChatCompletionsAnnotation[]))
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
          const idx = toolCall.index as number
          const existing = state.toolCallsMap.get(idx)
          if (!existing) {
            state.toolCallsMap.set(idx, {
              id: (toolCall.id as string) ?? '',
              name: ((toolCall.function as Record<string, unknown>)?.name as string) ?? '',
              arguments: ((toolCall.function as Record<string, unknown>)?.arguments as string) ?? '',
            })
          } else {
            if (toolCall.id) existing.id = toolCall.id as string
            const fn = toolCall.function as Record<string, unknown> | undefined
            if (fn?.name) existing.name = fn.name as string
            if (fn?.arguments) {
              existing.arguments += fn.arguments as string
            }
          }
        }
      }

      if (choice.finish_reason) {
        state.finishReason = choice.finish_reason as string
      }
    }
  }

  if (states.size === 0) states.set(0, createChoice())
  const resultChoices: ChatCompletionsResult["choices"] = []
  for (const [index, state] of [...states].sort(([left], [right]) => left - right)) {
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
    const sortedIndices = [...state.toolCallsMap.keys()].sort((a, b) => a - b)
    for (const idx of sortedIndices) {
      const toolCall = state.toolCallsMap.get(idx)
      if (!toolCall) continue
      toolCalls.push({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: toolCall.arguments },
      })
    }

    const message: ChatCompletionsResult['choices'][number]['message'] = {
      role: 'assistant',
      content: state.content || null,
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      ...(state.hasReasoningText ? { reasoning_text: state.reasoningText } : {}),
      ...(state.hasReasoningOpaque ? { reasoning_opaque: state.reasoningOpaque } : {}),
      ...(state.reasoningItems.length > 0 && { reasoning_items: state.reasoningItems }),
      ...(state.annotations.length > 0 && { annotations: state.annotations }),
      ...state.messageExtras,
    }
    resultChoices.push({ index, message, finish_reason: state.finishReason, ...state.choiceExtras })
  }

  const result: ChatCompletionsResult = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: resultChoices,
    ...(lastUsage && { usage: lastUsage }),
    ...chunkExtras,
  }

  return result
}
