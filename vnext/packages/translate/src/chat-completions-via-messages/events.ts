/**
 * Stream translator: hub Anthropic Messages SSE → OpenAI Chat Completions
 * SSE chunks. Consumes typed `MessagesEvent`s and yields `ChatSSEChunk`s.
 *
 * Cancellation: implemented as an async generator; `try/finally` releases
 * any per-stream state when the consumer breaks out of the for-await loop.
 *
 * Direction: events flow hub → client (assistant tokens, tool calls, usage).
 */
import type { MessagesEvent } from '@vnext/protocols/messages'

export interface ChatSSEChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>
      reasoning_text?: string
      reasoning_opaque?: string
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }
}

interface ToolCallSlot {
  blockIndex: number
  toolCallIndex: number
}

interface State {
  messageId: string
  model: string
  created: number
  nextToolCallIndex: number
  promptTokens: number
  cachedPromptTokens: number
  toolCalls: Map<number, ToolCallSlot>
  reasoningBlockIndex?: number
  terminated: boolean
}

function createState(): State {
  return {
    messageId: '',
    model: '',
    created: Math.floor(Date.now() / 1000),
    nextToolCallIndex: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    toolCalls: new Map(),
    terminated: false,
  }
}

function makeChunk(
  state: State,
  delta: ChatSSEChunk['choices'][0]['delta'],
  finishReason: ChatSSEChunk['choices'][0]['finish_reason'] = null,
): ChatSSEChunk {
  return {
    id: state.messageId || 'chatcmpl-pending',
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function makeUsageChunk(state: State, outputTokens: number): ChatSSEChunk {
  return {
    id: state.messageId || 'chatcmpl-pending',
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      prompt_tokens: state.promptTokens,
      completion_tokens: outputTokens,
      total_tokens: state.promptTokens + outputTokens,
      ...(state.cachedPromptTokens > 0
        ? { prompt_tokens_details: { cached_tokens: state.cachedPromptTokens } }
        : {}),
    },
  }
}

function mapStopReason(stopReason: string | null | undefined): ChatSSEChunk['choices'][0]['finish_reason'] {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
    case null:
    case undefined:
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

function translateOne(ev: MessagesEvent, state: State): ChatSSEChunk[] | 'DONE' {
  if (state.terminated) return []
  switch (ev.type) {
    case 'message_start': {
      state.messageId = ev.message.id
      if (ev.message.model) state.model = ev.message.model
      const usage = (ev.message.usage ?? {}) as {
        input_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
      const cached = usage.cache_read_input_tokens ?? 0
      state.cachedPromptTokens = cached
      state.promptTokens =
        (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0)
      return [makeChunk(state, { role: 'assistant' })]
    }
    case 'content_block_start': {
      const block = ev.content_block as {
        type: string
        id?: string
        name?: string
        data?: string
      }
      if (block.type === 'thinking') {
        state.reasoningBlockIndex = ev.index
        return []
      }
      if (block.type === 'redacted_thinking') {
        state.reasoningBlockIndex = ev.index
        return block.data ? [makeChunk(state, { reasoning_opaque: block.data })] : []
      }
      if (block.type === 'tool_use') {
        const toolCallIndex = state.nextToolCallIndex++
        state.toolCalls.set(ev.index, { blockIndex: ev.index, toolCallIndex })
        return [
          makeChunk(state, {
            tool_calls: [
              {
                index: toolCallIndex,
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: '' },
              },
            ],
          }),
        ]
      }
      return []
    }
    case 'content_block_delta': {
      const delta = ev.delta as {
        type: string
        text?: string
        thinking?: string
        signature?: string
        partial_json?: string
      }
      switch (delta.type) {
        case 'text_delta':
          return delta.text ? [makeChunk(state, { content: delta.text })] : []
        case 'thinking_delta':
          return state.reasoningBlockIndex === ev.index && delta.thinking
            ? [makeChunk(state, { reasoning_text: delta.thinking })]
            : []
        case 'signature_delta':
          return state.reasoningBlockIndex === ev.index && delta.signature
            ? [makeChunk(state, { reasoning_opaque: delta.signature })]
            : []
        case 'input_json_delta': {
          const slot = state.toolCalls.get(ev.index)
          if (!slot || !delta.partial_json) return []
          return [
            makeChunk(state, {
              tool_calls: [
                {
                  index: slot.toolCallIndex,
                  function: { arguments: delta.partial_json },
                },
              ],
            }),
          ]
        }
      }
      return []
    }
    case 'content_block_stop':
      return []
    case 'message_delta': {
      const evDelta = ev.delta as { stop_reason?: string | null }
      const evUsage = ev.usage as
        | {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        | undefined
      if (evUsage?.cache_read_input_tokens != null) {
        const newCached = evUsage.cache_read_input_tokens
        const newCreation = evUsage.cache_creation_input_tokens ?? 0
        state.promptTokens =
          (evUsage.input_tokens ?? state.promptTokens - state.cachedPromptTokens) +
          newCached +
          newCreation
        state.cachedPromptTokens = newCached
      }
      const finishReason = mapStopReason(evDelta.stop_reason ?? null)
      const finishChunk = makeChunk(state, {}, finishReason)
      return evUsage
        ? [finishChunk, makeUsageChunk(state, evUsage.output_tokens ?? 0)]
        : [finishChunk]
    }
    case 'message_stop':
      state.terminated = true
      return 'DONE'
    case 'ping':
      return []
    case 'error':
      state.terminated = true
      return [makeChunk(state, {}, 'stop')]
  }
  return []
}

export async function* translateMessagesToChatSSE(
  events: AsyncIterable<MessagesEvent>,
): AsyncGenerator<ChatSSEChunk> {
  const state = createState()
  try {
    for await (const ev of events) {
      const out = translateOne(ev, state)
      if (out === 'DONE') return
      for (const chunk of out) yield chunk
      if (state.terminated) return
    }
  } finally {
    // Release per-stream state on cancellation/early break.
    state.toolCalls.clear()
    state.terminated = true
  }
}
