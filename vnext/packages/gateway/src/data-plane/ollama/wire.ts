/**
 * Ollama ↔ OpenAI wire-format mapping.
 *
 * Pure functions only — no I/O, no context. `/api/chat` translates the inbound
 * body here, hands it to the ordinary `serveChatCompletions` pipeline, and
 * translates the outbound frames back. Keeping the mapping in one side-effect
 * free module is what makes the sharp edges testable, and there are several:
 *
 *   - Ollama streams **NDJSON** (one JSON object per `\n`), not SSE.
 *   - Ollama tool calls have **no `id`** and their `arguments` is an **object**,
 *     where OpenAI sends an id and a JSON *string* built up across deltas.
 *   - Ollama carries images in `message.images` as bare base64 (no data-URI).
 *   - Durations are **nanoseconds**. AnythingLLM divides by them
 *     (`completion_tokens / (eval_duration / 1e9)`), so zero shows as Infinity.
 *
 * Shapes taken from ollama-js `src/interfaces.ts` (`ChatRequest`, `ChatResponse`,
 * `Message`, `ToolCall`).
 */

/** Durations are nanoseconds; never emit 0 — AnythingLLM divides by them. */
export const msToNs = (ms: number): number => Math.max(1, Math.round(ms * 1e6))

export interface OllamaMessage {
  role: string
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
  tool_name?: string
}

export interface OllamaChatRequest {
  model: string
  messages?: OllamaMessage[]
  stream?: boolean
  format?: string | Record<string, unknown>
  keep_alive?: string | number
  tools?: unknown[]
  think?: boolean
  options?: Record<string, unknown>
}

export interface OllamaTimings {
  total_duration: number
  load_duration: number
  prompt_eval_count: number
  prompt_eval_duration: number
  eval_count: number
  eval_duration: number
}

/**
 * Ollama's `options` bag, mapped to the OpenAI fields that mean the same thing.
 *
 * `num_ctx` is deliberately dropped: it asks the runtime to resize a local
 * model's context window, which has no meaning against a remote upstream.
 * AnythingLLM always sends it, so silently ignoring it is the correct
 * behaviour rather than an omission.
 */
function mapOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) return {}
  const out: Record<string, unknown> = {}
  if (typeof options.temperature === 'number') out.temperature = options.temperature
  if (typeof options.top_p === 'number') out.top_p = options.top_p
  if (typeof options.seed === 'number') out.seed = options.seed
  if (typeof options.num_predict === 'number' && options.num_predict > 0) {
    out.max_tokens = options.num_predict
  }
  if (typeof options.stop === 'string') out.stop = [options.stop]
  else if (Array.isArray(options.stop) && options.stop.length > 0) out.stop = options.stop
  if (typeof options.frequency_penalty === 'number') out.frequency_penalty = options.frequency_penalty
  if (typeof options.presence_penalty === 'number') out.presence_penalty = options.presence_penalty
  return out
}

/**
 * Ollama attaches images to the message itself; OpenAI puts them inline in a
 * content-parts array. The base64 arrives bare, so we have to re-add a
 * data-URI prefix. JPEG is a guess but browsers and every upstream we speak to
 * sniff the actual bytes, so the declared subtype is not load-bearing.
 */
function mapMessage(m: OllamaMessage): Record<string, unknown> {
  const text = m.content ?? ''
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: m.tool_calls.map((tc, i) => ({
        id: `call_${i}`,
        type: 'function',
        function: {
          name: tc.function?.name ?? '',
          arguments: JSON.stringify(tc.function?.arguments ?? {}),
        },
      })),
    }
  }
  // Ollama's tool result role carries the tool name, not a call id. OpenAI
  // wants a tool_call_id; there is nothing better to put there than the name.
  if (m.role === 'tool') {
    return { role: 'tool', content: text, tool_call_id: m.tool_name ?? 'call_0' }
  }
  if (Array.isArray(m.images) && m.images.length > 0) {
    return {
      role: m.role,
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...m.images.map((b64) => ({
          type: 'image_url',
          image_url: { url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}` },
        })),
      ],
    }
  }
  return { role: m.role, content: text }
}

export function ollamaToOpenAIBody(body: OllamaChatRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    messages: (body.messages ?? []).map(mapMessage),
    stream: body.stream !== false,
    ...mapOptions(body.options),
  }
  if (out.stream) out.stream_options = { include_usage: true }
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools
  // Ollama's `format` is either the literal "json" or a JSON Schema object.
  if (body.format === 'json') out.response_format = { type: 'json_object' }
  else if (body.format && typeof body.format === 'object') {
    out.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: body.format } }
  }
  return out
}

/** OpenAI finish reasons → Ollama's much smaller vocabulary. */
export function toDoneReason(finish: string | null | undefined): string {
  if (finish === 'length') return 'length'
  return 'stop'
}

/**
 * Split a `<think>…</think>` prelude out of the content.
 *
 * Some upstreams inline reasoning in the text rather than in a dedicated
 * field. AnythingLLM re-wraps `message.thinking` in `<think>` tags itself, so
 * leaving them in the content would double them up in the transcript.
 */
export function splitThinking(content: string): { content: string; thinking?: string } {
  const m = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/)
  if (!m) return { content }
  return { content: content.slice(m[0].length), thinking: m[1]!.trim() }
}

interface OpenAIChoiceMessage {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
}

interface OpenAINonStreamBody {
  model?: string
  choices?: Array<{ message?: OpenAIChoiceMessage; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** OpenAI `arguments` is a JSON string; Ollama wants the parsed object. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function openAIJsonToOllama(
  json: OpenAINonStreamBody,
  model: string,
  createdAt: string,
  timings: OllamaTimings,
): Record<string, unknown> {
  const choice = json.choices?.[0]
  const raw = choice?.message?.content ?? ''
  const split = splitThinking(raw)
  const thinking = choice?.message?.reasoning_content || split.thinking
  const toolCalls = (choice?.message?.tool_calls ?? []).map((tc) => ({
    function: { name: tc.function?.name ?? '', arguments: parseToolArguments(tc.function?.arguments) },
  }))
  const message: OllamaMessage = { role: 'assistant', content: split.content }
  if (thinking) message.thinking = thinking
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return {
    model,
    created_at: createdAt,
    message,
    done: true,
    done_reason: toDoneReason(choice?.finish_reason),
    ...timings,
    prompt_eval_count: json.usage?.prompt_tokens ?? timings.prompt_eval_count,
    eval_count: json.usage?.completion_tokens ?? timings.eval_count,
  }
}

export interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/**
 * Streaming state machine.
 *
 * OpenAI dribbles tool-call arguments out as string fragments keyed by index;
 * Ollama has no such concept and expects each tool call to arrive whole. So we
 * accumulate fragments here and flush them as one frame when the stream
 * finishes. Token counts are also only known at the end (they ride on the
 * final usage chunk), which is why the terminal frame is built separately.
 */
export class OllamaStreamState {
  private toolNames = new Map<number, string>()
  private toolArgs = new Map<number, string>()
  finishReason: string | null = null
  promptTokens = 0
  completionTokens = 0

  /** Returns the NDJSON line for this chunk, or null when it carries nothing. */
  chunkToLine(chunk: OpenAIStreamChunk, model: string, createdAt: string): string | null {
    if (chunk.usage) {
      this.promptTokens = chunk.usage.prompt_tokens ?? this.promptTokens
      this.completionTokens = chunk.usage.completion_tokens ?? this.completionTokens
    }
    const choice = chunk.choices?.[0]
    if (!choice) return null
    if (choice.finish_reason) this.finishReason = choice.finish_reason
    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0
      if (tc.function?.name) this.toolNames.set(idx, tc.function.name)
      if (tc.function?.arguments) {
        this.toolArgs.set(idx, (this.toolArgs.get(idx) ?? '') + tc.function.arguments)
      }
    }
    const content = choice.delta?.content ?? ''
    const thinking = choice.delta?.reasoning_content ?? ''
    if (!content && !thinking) return null
    const message: OllamaMessage = { role: 'assistant', content }
    if (thinking) message.thinking = thinking
    return JSON.stringify({ model, created_at: createdAt, message, done: false })
  }

  /** The buffered tool calls, as the one frame Ollama expects. Null if none. */
  toolCallLine(model: string, createdAt: string): string | null {
    if (this.toolNames.size === 0) return null
    const tool_calls = [...this.toolNames.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, name]) => ({
        function: { name, arguments: parseToolArguments(this.toolArgs.get(idx)) },
      }))
    return JSON.stringify({
      model,
      created_at: createdAt,
      message: { role: 'assistant', content: '', tool_calls },
      done: false,
    })
  }

  doneLine(model: string, createdAt: string, timings: OllamaTimings): string {
    return JSON.stringify({
      model,
      created_at: createdAt,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: toDoneReason(this.finishReason),
      ...timings,
      prompt_eval_count: this.promptTokens || timings.prompt_eval_count,
      eval_count: this.completionTokens || timings.eval_count,
    })
  }
}

/** Builds the duration block from a wall-clock measurement, in nanoseconds. */
export function timings(
  startMs: number,
  firstTokenMs: number | null,
  endMs: number,
  promptTokens: number,
  completionTokens: number,
): OllamaTimings {
  const loadMs = firstTokenMs === null ? 0 : firstTokenMs - startMs
  const evalMs = firstTokenMs === null ? endMs - startMs : endMs - firstTokenMs
  return {
    total_duration: msToNs(endMs - startMs),
    load_duration: msToNs(loadMs),
    prompt_eval_count: promptTokens,
    prompt_eval_duration: msToNs(loadMs),
    eval_count: completionTokens,
    eval_duration: msToNs(evalMs),
  }
}
