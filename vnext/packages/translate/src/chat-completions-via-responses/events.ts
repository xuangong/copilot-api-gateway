/**
 * Streaming translator: Responses SSE upstream → Chat Completions SSE client.
 *
 * Direction: events = hub → client. Wraps the upstream Responses event
 * stream into Chat Completion chunks (`chat.completion.chunk`).
 *
 * Conventions:
 *  - First chunk emits `delta: { role: 'assistant' }`. If upstream skips
 *    `response.created`, a synthetic role chunk is yielded before the first
 *    real delta so the SSE stream stays well-formed.
 *  - `response.output_text.delta` → `delta: { content }`.
 *  - `response.output_item.added` (function_call) emits a tool_calls entry
 *    with `id`, `type`, and the initial `name`/`arguments`. Subsequent
 *    `response.function_call_arguments.delta` events emit only the
 *    incremental `arguments` string keyed by `index`.
 *  - On `response.completed`, finish maps from `incomplete_details.reason`
 *    (`max_output_tokens` → `length`) or, if any tool call was seen,
 *    `tool_calls`; otherwise `stop`. If the upstream stream ends without
 *    `response.completed`, finish stays `null` until the final chunk and
 *    is then defaulted to `stop` to preserve a valid Chat SSE finish.
 *  - `response.output_item.done` for a `web_search_call` carries the sources
 *    the search resolved; they become `delta.annotations` (see below).
 */
interface ChatChoiceDelta {
  role?: 'assistant'
  content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function: { name?: string; arguments?: string }
  }>
  /**
   * Web-search citations, in OpenAI's spec shape. Responses carries them on
   * the `web_search_call` output item, which has no Chat Completions
   * counterpart; without this the sources are dropped on the way out and the
   * client gets an answer it cannot attribute. Same channel and shape as the
   * Messages pair uses, so a Chat Completions client behaves identically
   * whichever endpoint actually served the model.
   */
  annotations?: ChatUrlCitationAnnotation[]
}

export interface ChatUrlCitationAnnotation {
  type: 'url_citation'
  url_citation: { url: string; title?: string }
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface ChatSSEChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{ index: 0; delta: ChatChoiceDelta; finish_reason: 'stop' | 'length' | 'tool_calls' | null }>
  usage?: ChatUsage
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface ResponsesEvent {
  type: string
  response?: {
    id?: string
    model?: string
    created_at?: number
    status?: string
    incomplete_details?: { reason?: string }
    usage?: ResponsesUsage
  }
  delta?: string
  output_index?: number
  item?: {
    type?: string
    call_id?: string
    name?: string
    arguments?: string
    results?: Array<{ url?: string; title?: string }>
  }
}

/**
 * `web_search_call.results` is only populated when the request opted in via
 * `include: ["web_search_call.results"]` — the Chat Completions request
 * translator adds that token whenever the client asks for search. URLs already
 * announced on this stream are skipped so a model that searches several times
 * does not re-cite the same page.
 */
function webSearchResultAnnotations(
  results: Array<{ url?: string; title?: string }> | undefined,
  citedUrls: Set<string>,
): ChatUrlCitationAnnotation[] {
  if (!Array.isArray(results)) return []
  const out: ChatUrlCitationAnnotation[] = []
  for (const entry of results) {
    const url = entry?.url
    if (typeof url !== 'string' || url === '') continue
    if (citedUrls.has(url)) continue
    citedUrls.add(url)
    const title = entry.title
    out.push({
      type: 'url_citation',
      url_citation: { url, ...(typeof title === 'string' && title !== '' ? { title } : {}) },
    })
  }
  return out
}

/**
 * Responses reports token counts once, on the terminal envelope; Chat
 * Completions carries them on a trailing choice-less chunk. Emitted whenever
 * upstream reports usage rather than gated on `stream_options.include_usage`
 * — this translator only sees the event stream, not the request — matching
 * what `chat-completions-via-messages` already does for the Messages pair.
 */
function makeUsageChunk(id: string, model: string, created: number, usage: ResponsesUsage): ChatSSEChunk {
  const prompt = usage.input_tokens ?? 0
  const completion = usage.output_tokens ?? 0
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  // Responses names it cache_write_tokens; Chat Completions carries the same
  // count under Anthropic's `cache_creation_input_tokens` spelling, which is
  // what the usage extractor and the Anthropic-shaped clients both read.
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: usage.total_tokens ?? prompt + completion,
      ...(cached > 0 || cacheWrite > 0
        ? {
            prompt_tokens_details: {
              ...(cached > 0 ? { cached_tokens: cached } : {}),
              ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
            },
          }
        : {}),
      ...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
    },
  }
}

function makeChunk(id: string, model: string, created: number, delta: ChatChoiceDelta, finish: ChatSSEChunk['choices'][number]['finish_reason'] = null): ChatSSEChunk {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export async function* translateResponsesToChatSSE(
  events: AsyncIterable<unknown>,
): AsyncGenerator<ChatSSEChunk, void, unknown> {
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let sawToolCall = false
  let finish: string | null = null
  let started = false
  let usage: ResponsesUsage | undefined
  /** URLs already emitted as annotations, so repeat searches do not duplicate sources. */
  const citedUrls = new Set<string>()

  for await (const ev of events as AsyncIterable<ResponsesEvent>) {
    if (ev.type === 'response.created') {
      id = ev.response?.id ?? id
      model = ev.response?.model ?? model
      if (ev.response?.created_at) created = ev.response.created_at
      yield makeChunk(id, model, created, { role: 'assistant' })
      started = true
      continue
    }
    if (!started) {
      // Some upstreams emit deltas without a preceding response.created; synthesize role chunk.
      yield makeChunk(id, model, created, { role: 'assistant' })
      started = true
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      yield makeChunk(id, model, created, { content: ev.delta })
      continue
    }
    if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
      sawToolCall = true
      yield makeChunk(id, model, created, {
        tool_calls: [{
          index: ev.output_index ?? 0,
          id: ev.item.call_id ?? '',
          type: 'function',
          function: { name: ev.item.name ?? '', arguments: ev.item.arguments ?? '' },
        }],
      })
      continue
    }
    if (ev.type === 'response.output_item.done' && ev.item?.type === 'web_search_call') {
      // Deliberately does NOT set `sawToolCall`: the search already ran
      // server-side, so surfacing it as a pending call would make the client
      // think it owes a tool result and finish the turn as `tool_calls`.
      // Only the sources travel, as annotations on an empty content delta.
      const annotations = webSearchResultAnnotations(ev.item.results, citedUrls)
      if (annotations.length > 0) yield makeChunk(id, model, created, { annotations })
      continue
    }
    if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
      yield makeChunk(id, model, created, {
        tool_calls: [{ index: ev.output_index ?? 0, function: { arguments: ev.delta } }],
      })
      continue
    }
    if (ev.type === 'response.completed') {
      const reason = ev.response?.incomplete_details?.reason
      if (reason === 'max_output_tokens') finish = 'length'
      else if (sawToolCall) finish = 'tool_calls'
      else finish = 'stop'
      usage = ev.response?.usage
      break
    }
  }

  // If the upstream stream ended without `response.completed`, fall back to
  // `stop` so the emitted Chat SSE always carries a valid finish_reason.
  const finalFinish: ChatSSEChunk['choices'][number]['finish_reason'] =
    finish === 'length' || finish === 'tool_calls' || finish === 'stop'
      ? finish
      : 'stop'
  yield makeChunk(id, model, created, {}, finalFinish)
  // Usage trails the finish chunk, per the Chat Completions streaming shape.
  if (usage) yield makeUsageChunk(id, model, created, usage)
}
