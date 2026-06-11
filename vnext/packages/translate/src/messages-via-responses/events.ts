/**
 * Stream translator: hub OpenAI Responses SSE events → client Anthropic
 * Messages SSE events. Pairs with `./request.ts` and runs hub → client.
 *
 * State machine: one Anthropic message frames the whole stream; content
 * blocks are opened lazily as Responses output items appear (text, thinking,
 * function_call) and closed when a new block opens or when the stream
 * completes. Mirrors the pre-pivot reference at
 * `src/translators/messages-via-responses/events.ts`.
 *
 * Cancellation: implemented as an async generator with try/finally so
 * per-stream state is cleared when the consumer breaks out of the loop.
 */
import type { MessagesEvent } from '@vnext/protocols/messages'

// ─── Inbound (Responses) event shape ───

interface RespEventBase {
  type: string
  sequence_number?: number
}

interface RespCreatedEvent extends RespEventBase {
  type: 'response.created'
  response: {
    id: string
    model: string
    usage?: {
      input_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
  }
}

interface RespOutputItem {
  type: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  summary?: Array<{ text?: string }>
  content?: Array<{ type: string; text?: string; refusal?: string }>
}

interface RespOutputItemAddedEvent extends RespEventBase {
  type: 'response.output_item.added'
  output_index: number
  item: RespOutputItem
}

interface RespTextDeltaEvent extends RespEventBase {
  type: 'response.output_text.delta'
  output_index: number
  content_index: number
  delta: string
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

interface RespReasoningSummaryDeltaEvent extends RespEventBase {
  type: 'response.reasoning_summary_text.delta'
  output_index: number
  summary_index: number
  delta: string
}

interface RespCompletedEvent extends RespEventBase {
  type: 'response.completed' | 'response.incomplete'
  response: {
    status: 'completed' | 'incomplete'
    incomplete_details?: { reason?: string } | null
    output: RespOutputItem[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
  }
}

interface RespFailedEvent extends RespEventBase {
  type: 'response.failed'
  response: { error?: { message?: string } }
}

interface RespErrorEvent extends RespEventBase {
  type: 'error'
  message?: string
}

type RespEvent =
  | RespCreatedEvent
  | RespOutputItemAddedEvent
  | RespTextDeltaEvent
  | RespFnArgsDeltaEvent
  | RespFnArgsDoneEvent
  | RespReasoningSummaryDeltaEvent
  | RespCompletedEvent
  | RespFailedEvent
  | RespErrorEvent
  | (RespEventBase & { type: 'ping' })
  | (RespEventBase & { type: 'response.output_item.done' })

// ─── State machine ───

interface FunctionCallState {
  blockIndex: number
  toolCallId: string
  name: string
  emittedAnyArguments: boolean
}

interface State {
  messageCompleted: boolean
  nextBlockIndex: number
  /** Map of "outputIndex:contentIndex" → block index (re-open same text block). */
  textBlockByKey: Map<string, number>
  /** Map of outputIndex → block index for thinking blocks. */
  thinkingBlockByOutputIndex: Map<number, number>
  openBlocks: Set<number>
  functionCallState: Map<number, FunctionCallState>
}

function createState(): State {
  return {
    messageCompleted: false,
    nextBlockIndex: 0,
    textBlockByKey: new Map(),
    thinkingBlockByOutputIndex: new Map(),
    openBlocks: new Set(),
    functionCallState: new Map(),
  }
}

function closeOpenBlocks(state: State, out: MessagesEvent[]): void {
  for (const blockIndex of state.openBlocks) {
    out.push({ type: 'content_block_stop', index: blockIndex })
  }
  state.openBlocks.clear()
}

function openTextBlock(
  state: State,
  outputIndex: number,
  contentIndex: number,
  out: MessagesEvent[],
): number {
  const key = `${outputIndex}:${contentIndex}`
  let blockIndex = state.textBlockByKey.get(key)
  if (blockIndex === undefined) {
    blockIndex = state.nextBlockIndex++
    state.textBlockByKey.set(key, blockIndex)
  }
  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, out)
    out.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' } as never,
    })
    state.openBlocks.add(blockIndex)
  }
  return blockIndex
}

function openThinkingBlock(state: State, outputIndex: number, out: MessagesEvent[]): number {
  let blockIndex = state.thinkingBlockByOutputIndex.get(outputIndex)
  if (blockIndex === undefined) {
    blockIndex = state.nextBlockIndex++
    state.thinkingBlockByOutputIndex.set(outputIndex, blockIndex)
  }
  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, out)
    out.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', thinking: '' } as never,
    })
    state.openBlocks.add(blockIndex)
  }
  return blockIndex
}

function handleCreated(ev: RespCreatedEvent): MessagesEvent[] {
  const cached = ev.response.usage?.input_tokens_details?.cached_tokens
  const input = (ev.response.usage?.input_tokens ?? 0) - (cached ?? 0)
  return [
    {
      type: 'message_start',
      message: {
        id: ev.response.id,
        type: 'message',
        role: 'assistant',
        model: ev.response.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: input,
          output_tokens: 0,
          ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
        } as never,
      },
    },
  ]
}

function handleOutputItemAdded(ev: RespOutputItemAddedEvent, state: State): MessagesEvent[] {
  if (ev.item.type !== 'function_call') return []
  const blockIndex = state.nextBlockIndex++
  const toolCallId = ev.item.call_id ?? `tool_${blockIndex}`
  const name = ev.item.name ?? 'function'
  const fcs: FunctionCallState = { blockIndex, toolCallId, name, emittedAnyArguments: false }
  state.functionCallState.set(ev.output_index, fcs)

  const out: MessagesEvent[] = []
  closeOpenBlocks(state, out)
  out.push({
    type: 'content_block_start',
    index: blockIndex,
    content_block: { type: 'tool_use', id: toolCallId, name, input: {} } as never,
  })
  state.openBlocks.add(blockIndex)

  // Some Responses payloads carry initial arguments on the added event.
  const initialArgs = ev.item.arguments ?? ''
  if (initialArgs.length > 0) {
    out.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: initialArgs } as never,
    })
    fcs.emittedAnyArguments = true
  }
  return out
}

function handleTextDelta(ev: RespTextDeltaEvent, state: State): MessagesEvent[] {
  if (!ev.delta) return []
  const out: MessagesEvent[] = []
  const blockIndex = openTextBlock(state, ev.output_index, ev.content_index, out)
  out.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: ev.delta } as never,
  })
  return out
}

function handleFnArgsDelta(ev: RespFnArgsDeltaEvent, state: State): MessagesEvent[] {
  if (!ev.delta) return []
  const fcs = state.functionCallState.get(ev.output_index)
  if (!fcs) return []
  fcs.emittedAnyArguments = true
  return [
    {
      type: 'content_block_delta',
      index: fcs.blockIndex,
      delta: { type: 'input_json_delta', partial_json: ev.delta } as never,
    },
  ]
}

function handleFnArgsDone(ev: RespFnArgsDoneEvent, state: State): MessagesEvent[] {
  const fcs = state.functionCallState.get(ev.output_index)
  if (!fcs) return []
  state.functionCallState.delete(ev.output_index)
  if (!ev.arguments || fcs.emittedAnyArguments) return []
  return [
    {
      type: 'content_block_delta',
      index: fcs.blockIndex,
      delta: { type: 'input_json_delta', partial_json: ev.arguments } as never,
    },
  ]
}

function handleReasoningSummaryDelta(
  ev: RespReasoningSummaryDeltaEvent,
  state: State,
): MessagesEvent[] {
  if (!ev.delta) return []
  const out: MessagesEvent[] = []
  const blockIndex = openThinkingBlock(state, ev.output_index, out)
  out.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'thinking_delta', thinking: ev.delta } as never,
  })
  return out
}

function mapStopReason(ev: RespCompletedEvent): string {
  if (ev.response.status === 'incomplete' && ev.response.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens'
  }
  if (ev.response.output.some((i) => i.type === 'function_call')) return 'tool_use'
  return 'end_turn'
}

function handleCompleted(ev: RespCompletedEvent, state: State): MessagesEvent[] {
  const out: MessagesEvent[] = []
  closeOpenBlocks(state, out)
  state.functionCallState.clear()
  const cached = ev.response.usage?.input_tokens_details?.cached_tokens
  out.push({
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(ev), stop_sequence: null },
    usage: {
      output_tokens: ev.response.usage?.output_tokens ?? 0,
      ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    } as never,
  })
  out.push({ type: 'message_stop' })
  state.messageCompleted = true
  return out
}

function handleStreamError(state: State, message: string): MessagesEvent[] {
  const out: MessagesEvent[] = []
  closeOpenBlocks(state, out)
  state.functionCallState.clear()
  state.messageCompleted = true
  out.push({ type: 'error', error: { type: 'api_error', message } })
  return out
}

function translateOne(ev: RespEvent, state: State): MessagesEvent[] {
  if (state.messageCompleted) return []
  switch (ev.type) {
    case 'response.created':
      return handleCreated(ev)
    case 'response.output_item.added':
      return handleOutputItemAdded(ev, state)
    case 'response.output_item.done':
      // Lazy-close: blocks close when a new one opens or on completion.
      return []
    case 'response.output_text.delta':
      return handleTextDelta(ev, state)
    case 'response.function_call_arguments.delta':
      return handleFnArgsDelta(ev, state)
    case 'response.function_call_arguments.done':
      return handleFnArgsDone(ev, state)
    case 'response.reasoning_summary_text.delta':
      return handleReasoningSummaryDelta(ev, state)
    case 'response.completed':
    case 'response.incomplete':
      return handleCompleted(ev, state)
    case 'response.failed':
      return handleStreamError(state, ev.response.error?.message ?? 'Response failed.')
    case 'error':
      return handleStreamError(state, ev.message ?? 'Stream error.')
    case 'ping':
      return [{ type: 'ping' }]
    default:
      return []
  }
}

export async function* translateResponsesEventsToMessagesEvents(
  events: AsyncIterable<unknown>,
): AsyncGenerator<MessagesEvent> {
  const state = createState()
  try {
    for await (const raw of events) {
      if (!raw || typeof raw !== 'object') continue
      const ev = raw as RespEvent
      if (typeof ev.type !== 'string') continue
      const out = translateOne(ev, state)
      for (const o of out) yield o
      if (state.messageCompleted) return
    }
    if (!state.messageCompleted) {
      // Upstream cut us off pre-completion. Surface an error so clients
      // don't hang waiting for a terminal frame.
      for (const o of handleStreamError(state, 'Upstream Responses stream ended without completion.')) {
        yield o
      }
    }
  } finally {
    state.openBlocks.clear()
    state.textBlockByKey.clear()
    state.thinkingBlockByOutputIndex.clear()
    state.functionCallState.clear()
    state.messageCompleted = true
  }
}
