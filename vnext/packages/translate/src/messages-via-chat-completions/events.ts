/**
 * Stream translator: hub OpenAI Chat Completions SSE chunks → Anthropic
 * Messages SSE events. Pairs with `./request.ts` and runs hub → client.
 *
 * State machine emits a synthetic message_start on the first chunk and
 * lazily opens content blocks per kind (thinking → text → tool_use). On
 * finish_reason it closes all open blocks, emits message_delta with usage,
 * then message_stop.
 *
 * Cancellation: implemented as an async generator with try/finally to
 * release per-stream state when the consumer breaks out of the loop.
 */
import type { MessagesEvent } from '@vibe-llm/protocols/messages'

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
      reasoning_opaque?: string
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

type OpenBlockKind = 'text' | 'thinking' | 'tool_use'

interface OpenBlock {
  index: number
  kind: OpenBlockKind
  toolCallIndex?: number
}

interface State {
  messageId: string
  model: string
  emittedMessageStart: boolean
  nextBlockIndex: number
  textBlock?: OpenBlock
  thinkingBlock?: OpenBlock
  toolBlocks: Map<number, OpenBlock>
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  terminated: boolean
}

function createState(): State {
  return {
    messageId: '',
    model: '',
    emittedMessageStart: false,
    nextBlockIndex: 0,
    toolBlocks: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    finishReason: null,
    terminated: false,
  }
}

function synthMessageId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  return `msg_${rand}`
}

function mapFinishReason(reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null | undefined): string | null {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return null
  }
}

function emitMessageStart(state: State): MessagesEvent {
  state.emittedMessageStart = true
  if (!state.messageId) state.messageId = synthMessageId()
  return {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model || 'unknown',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: 0,
        ...(state.cachedInputTokens > 0 ? { cache_read_input_tokens: state.cachedInputTokens } : {}),
      } as never,
    },
  }
}

function closeBlock(_state: State, block: OpenBlock): MessagesEvent {
  return { type: 'content_block_stop', index: block.index }
}

function closeAllOpenBlocks(state: State): MessagesEvent[] {
  const out: MessagesEvent[] = []
  if (state.textBlock) {
    out.push(closeBlock(state, state.textBlock))
    state.textBlock = undefined
  }
  if (state.thinkingBlock) {
    out.push(closeBlock(state, state.thinkingBlock))
    state.thinkingBlock = undefined
  }
  for (const block of state.toolBlocks.values()) {
    out.push(closeBlock(state, block))
  }
  state.toolBlocks.clear()
  return out
}

function openText(state: State): MessagesEvent[] {
  if (state.textBlock) return []
  const out: MessagesEvent[] = []
  if (state.thinkingBlock) {
    out.push(closeBlock(state, state.thinkingBlock))
    state.thinkingBlock = undefined
  }
  const index = state.nextBlockIndex++
  state.textBlock = { index, kind: 'text' }
  out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
  return out
}

function openThinking(state: State): MessagesEvent[] {
  if (state.thinkingBlock) return []
  if (state.textBlock) return []
  const index = state.nextBlockIndex++
  state.thinkingBlock = { index, kind: 'thinking' }
  return [{ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }]
}

function openTool(state: State, toolCallIndex: number, id: string, name: string): MessagesEvent[] {
  if (state.toolBlocks.has(toolCallIndex)) return []
  const out: MessagesEvent[] = []
  if (state.textBlock) {
    out.push(closeBlock(state, state.textBlock))
    state.textBlock = undefined
  }
  if (state.thinkingBlock) {
    out.push(closeBlock(state, state.thinkingBlock))
    state.thinkingBlock = undefined
  }
  const index = state.nextBlockIndex++
  state.toolBlocks.set(toolCallIndex, { index, kind: 'tool_use', toolCallIndex })
  out.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
  return out
}

function translateOne(chunk: ChatChunkLike, state: State): MessagesEvent[] {
  if (state.terminated) return []
  const out: MessagesEvent[] = []

  if (chunk.id && !state.messageId) state.messageId = chunk.id
  if (chunk.model && !state.model) state.model = chunk.model

  if (chunk.usage) {
    if (chunk.usage.prompt_tokens != null) state.inputTokens = chunk.usage.prompt_tokens
    if (chunk.usage.completion_tokens != null) state.outputTokens = chunk.usage.completion_tokens
    if (chunk.usage.prompt_tokens_details?.cached_tokens != null) {
      state.cachedInputTokens = chunk.usage.prompt_tokens_details.cached_tokens
    }
  }

  if (!chunk.choices || chunk.choices.length === 0) return out
  const choice = chunk.choices[0]
  if (!choice) return out
  const delta = choice.delta

  if (!state.emittedMessageStart) out.push(emitMessageStart(state))

  if (delta) {
    if (delta.reasoning_text) {
      out.push(...openThinking(state))
      if (state.thinkingBlock) {
        out.push({
          type: 'content_block_delta',
          index: state.thinkingBlock.index,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_text },
        })
      }
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      out.push(...openText(state))
      if (state.textBlock) {
        out.push({
          type: 'content_block_delta',
          index: state.textBlock.index,
          delta: { type: 'text_delta', text: delta.content },
        })
      }
    }
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        const tcIdx = tc.index ?? 0
        if (tc.id || tc.function?.name) {
          out.push(...openTool(state, tcIdx, tc.id ?? '', tc.function?.name ?? ''))
        }
        const block = state.toolBlocks.get(tcIdx)
        const args = tc.function?.arguments
        if (block && typeof args === 'string' && args.length > 0) {
          out.push({
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: args },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason
    out.push(...closeAllOpenBlocks(state))
    out.push({
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null },
      usage: {
        output_tokens: state.outputTokens,
        ...(state.cachedInputTokens > 0 ? { cache_read_input_tokens: state.cachedInputTokens } : {}),
      } as never,
    })
    out.push({ type: 'message_stop' })
    state.terminated = true
  }

  return out
}

export async function* translateChatSSEToMessagesEvents(
  chunks: AsyncIterable<unknown>,
): AsyncGenerator<MessagesEvent> {
  const state = createState()
  try {
    for await (const raw of chunks) {
      if (!raw || typeof raw !== 'object') continue
      const chunk = raw as ChatChunkLike
      const out = translateOne(chunk, state)
      for (const ev of out) yield ev
      if (state.terminated) return
    }
    // Upstream ended without finish_reason — synthesize a terminal sequence.
    if (!state.terminated) {
      if (!state.emittedMessageStart) yield emitMessageStart(state)
      for (const ev of closeAllOpenBlocks(state)) yield ev
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          output_tokens: state.outputTokens,
          ...(state.cachedInputTokens > 0 ? { cache_read_input_tokens: state.cachedInputTokens } : {}),
        } as never,
      }
      yield { type: 'message_stop' }
      state.terminated = true
    }
  } finally {
    state.toolBlocks.clear()
    state.terminated = true
  }
}
