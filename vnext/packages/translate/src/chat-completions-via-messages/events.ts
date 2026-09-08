/**
 * Stream translator: hub Anthropic Messages SSE → OpenAI Chat Completions
 * SSE chunks. Consumes typed `MessagesEvent`s and yields `ChatSSEChunk`s.
 *
 * Cancellation: implemented as an async generator; `try/finally` releases
 * any per-stream state when the consumer breaks out of the for-await loop.
 *
 * Direction: events flow hub → client (assistant tokens, tool calls, usage).
 */
import type { MessagesEvent } from '@vibe-llm/protocols/messages'

export interface ChatUrlCitationAnnotation {
  type: 'url_citation'
  url_citation: { url: string; title?: string }
}

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
      /**
       * Web-search citations, in OpenAI's spec shape. Anthropic carries them as
       * a `web_search_tool_result` content block, which has no Chat Completions
       * counterpart; without this the whole search round trip is dropped on the
       * way out and cross-protocol clients get an answer with no sources.
       */
      annotations?: ChatUrlCitationAnnotation[]
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

interface InputUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
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
  inputUsage: InputUsage
  outputTokens?: number
  toolCalls: Map<number, ToolCallSlot>
  /** URLs already emitted as annotations, to keep repeat searches from duplicating sources. */
  citedUrls: Set<string>
  reasoningBlockIndex?: number
  terminated: boolean
}

function createState(): State {
  return {
    messageId: '',
    model: '',
    created: Math.floor(Date.now() / 1000),
    nextToolCallIndex: 0,
    inputUsage: {},
    toolCalls: new Map(),
    citedUrls: new Set(),
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

function updateInputUsage(state: State, usage: InputUsage): void {
  // Messages deltas contain partial cumulative updates, not replacement snapshots.
  for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const value = usage[key]
    if (value !== undefined && Number.isFinite(value) && value >= 0) state.inputUsage[key] = Math.max(state.inputUsage[key] ?? 0, value)
  }
}

function makeUsageChunk(state: State): ChatSSEChunk {
  const input = state.inputUsage
  const promptTokens = input.input_tokens === undefined ? undefined : input.input_tokens + (input.cache_read_input_tokens ?? 0) + (input.cache_creation_input_tokens ?? 0)
  const outputTokens = state.outputTokens
  return {
    id: state.messageId || 'chatcmpl-pending',
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
      ...(outputTokens !== undefined ? { completion_tokens: outputTokens } : {}),
      ...(promptTokens !== undefined && outputTokens !== undefined ? { total_tokens: promptTokens + outputTokens } : {}),
      ...(input.cache_read_input_tokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: input.cache_read_input_tokens } }
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

/**
 * `web_search_tool_result.content` is either the result array or a single
 * error object (`web_search_tool_result_error`); only the former has sources.
 * URLs already announced on this stream are skipped so a model that searches
 * several times does not re-cite the same page.
 */
function webSearchResultAnnotations(content: unknown, state: State): ChatUrlCitationAnnotation[] {
  if (!Array.isArray(content)) return []
  const out: ChatUrlCitationAnnotation[] = []
  for (const entry of content as Array<{ url?: unknown; title?: unknown }>) {
    const url = entry?.url
    if (typeof url !== 'string' || url === '') continue
    if (state.citedUrls.has(url)) continue
    state.citedUrls.add(url)
    const title = entry.title
    out.push({
      type: 'url_citation',
      url_citation: { url, ...(typeof title === 'string' && title !== '' ? { title } : {}) },
    })
  }
  return out
}

function translateOne(ev: MessagesEvent, state: State): ChatSSEChunk[] | 'DONE' {
  if (state.terminated) return []
  switch (ev.type) {
    case 'message_start': {
      state.messageId = ev.message.id
      if (ev.message.model) state.model = ev.message.model
      updateInputUsage(state, ev.message.usage ?? {})
      return [makeChunk(state, { role: 'assistant' })]
    }
    case 'content_block_start': {
      const block = ev.content_block as {
        type: string
        id?: string
        name?: string
        data?: string
        content?: unknown
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
      if (block.type === 'web_search_tool_result') {
        // `server_tool_use` is deliberately *not* mapped to a `tool_calls`
        // delta: the search already ran server-side, so surfacing it as a
        // pending call would make the client think it owes a tool result.
        // Only the sources travel, as annotations on an empty content delta.
        const annotations = webSearchResultAnnotations(block.content, state)
        return annotations.length > 0 ? [makeChunk(state, { annotations })] : []
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
      updateInputUsage(state, evUsage ?? {})
      if (evUsage?.output_tokens !== undefined) state.outputTokens = Math.max(state.outputTokens ?? 0, evUsage.output_tokens)
      const finishReason = mapStopReason(evDelta.stop_reason ?? null)
      const finishChunk = makeChunk(state, {}, finishReason)
      return state.outputTokens !== undefined || Object.keys(state.inputUsage).length > 0
        ? [finishChunk, makeUsageChunk(state)]
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
    state.citedUrls.clear()
    state.terminated = true
  }
}
