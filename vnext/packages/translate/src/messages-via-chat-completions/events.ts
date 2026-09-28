/**
 * Stream translator: hub OpenAI Chat Completions SSE chunks → Anthropic
 * Messages SSE events. Pairs with `./request.ts` and runs hub → client.
 *
 * State machine emits a synthetic message_start on the first chunk and
 * lazily opens content blocks per kind (thinking → text → tool_use). On
 * finish_reason it closes all open blocks, then waits for trailing usage
 * before emitting message_delta and message_stop.
 *
 * Cancellation: implemented as an async generator with try/finally to
 * release per-stream state when the consumer breaks out of the loop.
 */
import { chatCompletionsErrorPayloadMessage } from "@vibe-llm/protocols/chat"
import type { MessagesEvent } from '@vibe-llm/protocols/messages'
import { chatReasoningText } from '../shared/chat-reasoning-text.ts'

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
      refusal?: string | null
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
  inputTokens: number | undefined
  outputTokens: number | undefined
  cachedInputTokens: number | undefined
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  sawRefusal: boolean
  terminated: boolean
}

function createState(): State {
  return {
    messageId: '',
    model: '',
    emittedMessageStart: false,
    nextBlockIndex: 0,
    toolBlocks: new Map(),
    inputTokens: undefined,
    outputTokens: undefined,
    cachedInputTokens: undefined,
    finishReason: null,
    sawRefusal: false,
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
        ...(state.inputTokens !== undefined ? { input_tokens: Math.max(0, state.inputTokens - (state.cachedInputTokens ?? 0)) } : {}),
        output_tokens: state.outputTokens ?? 0,
        ...(state.cachedInputTokens !== undefined ? { cache_read_input_tokens: state.cachedInputTokens } : {}),
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

  let usageChanged = false
  if (chunk.usage) {
    if (chunk.usage.prompt_tokens != null && chunk.usage.prompt_tokens !== state.inputTokens) {
      state.inputTokens = chunk.usage.prompt_tokens
      usageChanged = true
    }
    if (chunk.usage.completion_tokens != null && chunk.usage.completion_tokens !== state.outputTokens) {
      state.outputTokens = chunk.usage.completion_tokens
      usageChanged = true
    }
    if (chunk.usage.prompt_tokens_details?.cached_tokens != null) {
      const cached = chunk.usage.prompt_tokens_details.cached_tokens
      if (cached !== state.cachedInputTokens) {
        state.cachedInputTokens = cached
        usageChanged = true
      }
    }
  }

  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  const reasoning = delta ? chatReasoningText(delta) : undefined

  const opensMessage = usageChanged
    || Boolean(choice?.finish_reason)
    || (typeof delta?.content === 'string' && delta.content.length > 0)
    || Boolean(reasoning)
    || typeof delta?.refusal === 'string'
    || Boolean(delta?.tool_calls?.some(tc => tc.id || tc.function?.name || (
      state.toolBlocks.has(tc.index ?? 0) && typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0
    )))
  if (opensMessage && !state.emittedMessageStart) out.push(emitMessageStart(state))

  if (delta) {
    if (reasoning) {
      out.push(...openThinking(state))
      if (state.thinkingBlock) {
        out.push({
          type: 'content_block_delta',
          index: state.thinkingBlock.index,
          delta: { type: 'thinking_delta', thinking: reasoning },
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
    if (typeof delta.refusal === 'string') {
      state.sawRefusal = true
      out.push(...openText(state))
      if (state.textBlock && delta.refusal.length > 0) out.push({
        type: 'content_block_delta',
        index: state.textBlock.index,
        delta: { type: 'text_delta', text: delta.refusal },
      })
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

  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason
    out.push(...closeAllOpenBlocks(state))
  }

  if (usageChanged) out.push({
    type: 'message_delta',
    delta: {},
    usage: {
      ...(state.outputTokens !== undefined ? { output_tokens: state.outputTokens } : {}),
      ...(state.inputTokens !== undefined ? { input_tokens: Math.max(0, state.inputTokens - (state.cachedInputTokens ?? 0)) } : {}),
      ...(state.cachedInputTokens !== undefined ? { cache_read_input_tokens: state.cachedInputTokens } : {}),
    } as never,
  })

  return out
}

export async function* translateChatSSEToMessagesEvents(
  chunks: AsyncIterable<unknown>,
): AsyncGenerator<MessagesEvent> {
  const state = createState()
  try {
    for await (const raw of chunks) {
      if (!raw || typeof raw !== 'object') continue
      const error = chatCompletionsErrorPayloadMessage(raw)
      if (error) throw new Error(error)
      const chunk = raw as ChatChunkLike
      const out = translateOne(chunk, state)
      for (const ev of out) yield ev
      if (state.terminated) return
    }
    if (state.finishReason === null) throw new Error("Upstream Chat Completions stream ended without a finish_reason.")
    // Chat usage can arrive after finish_reason, so settle only after the tail.
    if (!state.terminated) {
      if (!state.emittedMessageStart) yield emitMessageStart(state)
      for (const ev of closeAllOpenBlocks(state)) yield ev
      yield {
        type: 'message_delta',
        delta: { stop_reason: state.finishReason === 'length' ? 'max_tokens' : state.sawRefusal ? 'refusal' : mapFinishReason(state.finishReason) ?? 'end_turn', stop_sequence: null },
        usage: {
          ...(state.outputTokens !== undefined ? { output_tokens: state.outputTokens } : {}),
          ...(state.inputTokens !== undefined ? { input_tokens: Math.max(0, state.inputTokens - (state.cachedInputTokens ?? 0)) } : {}),
          ...(state.cachedInputTokens !== undefined ? { cache_read_input_tokens: state.cachedInputTokens } : {}),
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
