/**
 * Stream translator: hub Anthropic Messages SSE events → client OpenAI Responses
 * SSE events. Pairs with `./request.ts` and runs hub → client.
 *
 * State machine projects each Anthropic content block into a Responses output
 * item (text→message, thinking→reasoning, tool_use→function_call). Sequence
 * numbers are 0-based and monotonic.
 *
 * Cancellation: implemented as an async generator with try/finally to release
 * per-stream state when the consumer breaks out of the loop.
 */
import type { MessagesEvent } from '@vibe-llm/protocols/messages'

interface ResponseOutputItem {
  type: 'message' | 'reasoning' | 'function_call'
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  status?: 'in_progress' | 'completed'
  summary?: Array<{ type: 'summary_text'; text: string }>
  content?: Array<{ type: 'output_text'; text: string }>
  role?: 'assistant'
}

interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { cached_tokens: number }
}

interface ResponsesResult {
  id: string
  object: 'response'
  model: string
  status: 'in_progress' | 'completed' | 'incomplete' | 'failed'
  output: ResponseOutputItem[]
  output_text?: string
  usage?: ResponsesUsage
  incomplete_details?: { reason: string } | null
}

export type ResponsesStreamEvent =
  | { type: 'response.created'; sequence_number: number; response: ResponsesResult }
  | { type: 'response.in_progress'; sequence_number: number; response: ResponsesResult }
  | { type: 'response.output_item.added'; sequence_number: number; output_index: number; item: ResponseOutputItem }
  | { type: 'response.output_item.done'; sequence_number: number; output_index: number; item: ResponseOutputItem }
  | { type: 'response.output_text.delta'; sequence_number: number; output_index: number; item_id: string; content_index: number; delta: string }
  | { type: 'response.output_text.done'; sequence_number: number; output_index: number; item_id: string; content_index: number; text: string }
  | { type: 'response.content_part.added'; sequence_number: number; output_index: number; item_id: string; content_index: number; part: { type: 'output_text'; text: string } }
  | { type: 'response.content_part.done'; sequence_number: number; output_index: number; item_id: string; content_index: number; part: { type: 'output_text'; text: string } }
  | { type: 'response.function_call_arguments.delta'; sequence_number: number; output_index: number; item_id: string; delta: string }
  | { type: 'response.function_call_arguments.done'; sequence_number: number; output_index: number; item_id: string; arguments: string }
  | { type: 'response.reasoning_summary_part.added'; sequence_number: number; output_index: number; item_id: string; summary_index: number; part: { type: 'summary_text'; text: string } }
  | { type: 'response.reasoning_summary_text.delta'; sequence_number: number; output_index: number; item_id: string; summary_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.done'; sequence_number: number; output_index: number; item_id: string; summary_index: number; text: string }
  | { type: 'response.reasoning_summary_part.done'; sequence_number: number; output_index: number; item_id: string; summary_index: number; part: { type: 'summary_text'; text: string } }
  | { type: 'response.completed'; sequence_number: number; response: ResponsesResult }
  | { type: 'response.incomplete'; sequence_number: number; response: ResponsesResult }
  | { type: 'response.failed'; sequence_number: number; response: ResponsesResult }
  | { type: 'ping'; sequence_number: number }
  | { type: 'error'; sequence_number: number; message: string; code?: string }

type BlockInfo =
  | { kind: 'text'; outputIndex: number; itemId: string; text: string }
  | { kind: 'thinking'; outputIndex: number; itemId: string; text: string }
  | { kind: 'tool_use'; outputIndex: number; itemId: string; toolCallId: string; name: string; args: string }

interface State {
  responseId: string
  model: string
  sequenceNumber: number
  outputIndex: number
  blockMap: Map<number, BlockInfo>
  completedItems: ResponseOutputItem[]
  accumulatedText: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  stopReason?: string | null
  terminated: boolean
}

function createState(responseId: string, model: string): State {
  return {
    responseId,
    model,
    sequenceNumber: 0,
    outputIndex: 0,
    blockMap: new Map(),
    completedItems: [],
    accumulatedText: '',
    inputTokens: 0,
    outputTokens: 0,
    terminated: false,
  }
}

function nextSeq(state: State): number {
  return state.sequenceNumber++
}

function buildUsage(state: State): ResponsesUsage {
  const input = state.inputTokens + (state.cacheReadInputTokens ?? 0) + (state.cacheCreationInputTokens ?? 0)
  return {
    input_tokens: input,
    output_tokens: state.outputTokens,
    total_tokens: input + state.outputTokens,
    ...(state.cacheReadInputTokens !== undefined
      ? { input_tokens_details: { cached_tokens: state.cacheReadInputTokens } }
      : {}),
  }
}

function buildResult(state: State, status: ResponsesResult['status']): ResponsesResult {
  return {
    id: state.responseId,
    object: 'response',
    model: state.model,
    status,
    output: state.completedItems,
    output_text: state.accumulatedText,
    usage: buildUsage(state),
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  }
}

interface MessageStartLike {
  message: {
    id: string
    model: string
    usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  }
}

function handleMessageStart(ev: MessageStartLike, state: State): ResponsesStreamEvent[] {
  state.inputTokens = ev.message.usage.input_tokens ?? 0
  state.cacheReadInputTokens = ev.message.usage.cache_read_input_tokens
  state.cacheCreationInputTokens = ev.message.usage.cache_creation_input_tokens
  // Honor the upstream message id only if caller didn't specify one.
  // Caller-provided responseId stays the source of truth (it's an
  // OpenAI-style `resp_*` id, not a Messages `msg_*` id).
  const response = buildResult(state, 'in_progress')
  return [
    { type: 'response.created', sequence_number: nextSeq(state), response },
    { type: 'response.in_progress', sequence_number: nextSeq(state), response },
  ]
}

interface ContentBlockStartLike {
  index: number
  content_block: { type: string; id?: string; name?: string }
}

function handleContentBlockStart(ev: ContentBlockStartLike, state: State): ResponsesStreamEvent[] {
  const out: ResponsesStreamEvent[] = []
  switch (ev.content_block.type) {
    case 'text': {
      const outputIndex = state.outputIndex++
      const itemId = `msg_${outputIndex}`
      state.blockMap.set(ev.index, { kind: 'text', outputIndex, itemId, text: '' })
      const item: ResponseOutputItem = {
        type: 'message',
        id: itemId,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      }
      out.push({ type: 'response.output_item.added', sequence_number: nextSeq(state), output_index: outputIndex, item })
      out.push({
        type: 'response.content_part.added',
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      })
      return out
    }
    case 'thinking': {
      const outputIndex = state.outputIndex++
      const itemId = `rs_${outputIndex}`
      state.blockMap.set(ev.index, { kind: 'thinking', outputIndex, itemId, text: '' })
      const item: ResponseOutputItem = { type: 'reasoning', id: itemId, summary: [] }
      out.push({ type: 'response.output_item.added', sequence_number: nextSeq(state), output_index: outputIndex, item })
      out.push({
        type: 'response.reasoning_summary_part.added',
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item_id: itemId,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      })
      return out
    }
    case 'tool_use': {
      const tb = ev.content_block as { type: 'tool_use'; id: string; name: string }
      const outputIndex = state.outputIndex++
      const itemId = `fc_${outputIndex}`
      state.blockMap.set(ev.index, { kind: 'tool_use', outputIndex, itemId, toolCallId: tb.id, name: tb.name, args: '' })
      const item: ResponseOutputItem = {
        type: 'function_call',
        id: itemId,
        call_id: tb.id,
        name: tb.name,
        arguments: '',
        status: 'in_progress',
      }
      out.push({ type: 'response.output_item.added', sequence_number: nextSeq(state), output_index: outputIndex, item })
      return out
    }
    default:
      return []
  }
}

interface ContentBlockDeltaLike {
  index: number
  delta: { type: string; text?: string; thinking?: string; partial_json?: string }
}

function handleContentBlockDelta(ev: ContentBlockDeltaLike, state: State): ResponsesStreamEvent[] {
  const info = state.blockMap.get(ev.index)
  if (!info) return []
  switch (info.kind) {
    case 'text': {
      if (ev.delta.type !== 'text_delta') return []
      const text = ev.delta.text ?? ''
      info.text += text
      state.accumulatedText += text
      return [
        {
          type: 'response.output_text.delta',
          sequence_number: nextSeq(state),
          output_index: info.outputIndex,
          item_id: info.itemId,
          content_index: 0,
          delta: text,
        },
      ]
    }
    case 'thinking': {
      if (ev.delta.type !== 'thinking_delta') return []
      const text = ev.delta.thinking ?? ''
      info.text += text
      return [
        {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: nextSeq(state),
          output_index: info.outputIndex,
          item_id: info.itemId,
          summary_index: 0,
          delta: text,
        },
      ]
    }
    case 'tool_use': {
      if (ev.delta.type !== 'input_json_delta') return []
      const part = ev.delta.partial_json ?? ''
      info.args += part
      return [
        {
          type: 'response.function_call_arguments.delta',
          sequence_number: nextSeq(state),
          output_index: info.outputIndex,
          item_id: info.itemId,
          delta: part,
        },
      ]
    }
  }
}

interface ContentBlockStopLike { index: number }

function handleContentBlockStop(ev: ContentBlockStopLike, state: State): ResponsesStreamEvent[] {
  const info = state.blockMap.get(ev.index)
  if (!info) return []
  state.blockMap.delete(ev.index)
  const out: ResponsesStreamEvent[] = []
  if (info.kind === 'text') {
    const item: ResponseOutputItem = {
      type: 'message',
      id: info.itemId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: info.text }],
    }
    state.completedItems.push(item)
    out.push({
      type: 'response.output_text.done',
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      content_index: 0,
      text: info.text,
    })
    out.push({
      type: 'response.content_part.done',
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      content_index: 0,
      part: { type: 'output_text', text: info.text },
    })
    out.push({ type: 'response.output_item.done', sequence_number: nextSeq(state), output_index: info.outputIndex, item })
    return out
  }
  if (info.kind === 'thinking') {
    const item: ResponseOutputItem = { type: 'reasoning', id: info.itemId, summary: [{ type: 'summary_text', text: info.text }] }
    state.completedItems.push(item)
    out.push({
      type: 'response.reasoning_summary_text.done',
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      summary_index: 0,
      text: info.text,
    })
    out.push({
      type: 'response.reasoning_summary_part.done',
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      summary_index: 0,
      part: { type: 'summary_text', text: info.text },
    })
    out.push({ type: 'response.output_item.done', sequence_number: nextSeq(state), output_index: info.outputIndex, item })
    return out
  }
  // tool_use
  const item: ResponseOutputItem = {
    type: 'function_call',
    id: info.itemId,
    call_id: info.toolCallId,
    name: info.name,
    arguments: info.args,
    status: 'completed',
  }
  state.completedItems.push(item)
  out.push({
    type: 'response.function_call_arguments.done',
    sequence_number: nextSeq(state),
    output_index: info.outputIndex,
    item_id: info.itemId,
    arguments: info.args,
  })
  out.push({ type: 'response.output_item.done', sequence_number: nextSeq(state), output_index: info.outputIndex, item })
  return out
}

interface MessageDeltaLike {
  delta: { stop_reason?: string | null; stop_sequence?: string | null }
  usage?: { output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

function handleMessageDelta(ev: MessageDeltaLike, state: State): ResponsesStreamEvent[] {
  if (ev.delta.stop_reason !== undefined) state.stopReason = ev.delta.stop_reason
  if (ev.usage?.output_tokens != null) state.outputTokens = ev.usage.output_tokens
  if (ev.usage?.cache_read_input_tokens != null) state.cacheReadInputTokens = ev.usage.cache_read_input_tokens
  if (ev.usage?.cache_creation_input_tokens != null) state.cacheCreationInputTokens = ev.usage.cache_creation_input_tokens
  return []
}

function handleMessageStop(state: State): ResponsesStreamEvent[] {
  state.terminated = true
  const status: ResponsesResult['status'] = state.stopReason === 'max_tokens' ? 'incomplete' : 'completed'
  const response = buildResult(state, status)
  return [
    {
      type: status === 'completed' ? 'response.completed' : 'response.incomplete',
      sequence_number: nextSeq(state),
      response,
    },
  ]
}

function handleError(message: string, code: string | undefined, state: State): ResponsesStreamEvent[] {
  state.terminated = true
  return [
    {
      type: 'error',
      sequence_number: nextSeq(state),
      message,
      ...(code ? { code } : {}),
    },
  ]
}

function synthResponseId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  return `resp_${rand}`
}

export interface ResponsesEventsTranslateOptions {
  responseId?: string
  model?: string
}

function translateOne(ev: MessagesEvent, state: State): ResponsesStreamEvent[] {
  if (state.terminated) return []
  switch (ev.type) {
    case 'message_start':
      return handleMessageStart(ev as unknown as MessageStartLike, state)
    case 'content_block_start':
      return handleContentBlockStart(ev as unknown as ContentBlockStartLike, state)
    case 'content_block_delta':
      return handleContentBlockDelta(ev as unknown as ContentBlockDeltaLike, state)
    case 'content_block_stop':
      return handleContentBlockStop(ev as unknown as ContentBlockStopLike, state)
    case 'message_delta':
      return handleMessageDelta(ev as unknown as MessageDeltaLike, state)
    case 'message_stop':
      return handleMessageStop(state)
    case 'ping':
      return [{ type: 'ping', sequence_number: nextSeq(state) }]
    case 'error': {
      const e = ev as unknown as { error: { type?: string; message?: string } }
      return handleError(e.error?.message ?? 'Stream error.', e.error?.type, state)
    }
    default:
      return []
  }
}

export async function* translateMessagesToResponsesEvents(
  events: AsyncIterable<MessagesEvent>,
  options: ResponsesEventsTranslateOptions = {},
): AsyncGenerator<ResponsesStreamEvent> {
  const state = createState(options.responseId ?? synthResponseId(), options.model ?? '')
  try {
    for await (const ev of events) {
      const out = translateOne(ev, state)
      for (const o of out) yield o
      if (state.terminated) return
    }
    if (!state.terminated) {
      // Upstream ended without message_stop — surface as a stream error so the
      // client sees the truncation rather than hanging on a missing terminal.
      for (const o of handleError('Upstream Messages stream ended without a message_stop event.', 'stream_truncated', state)) {
        yield o
      }
    }
  } finally {
    state.blockMap.clear()
    state.terminated = true
  }
}
