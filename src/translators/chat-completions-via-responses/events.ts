/**
 * Event translator: OpenAI Responses SSE → OpenAI Chat Completions SSE.
 *
 * Pairs with `./request.ts`. Used when the client speaks
 * /v1/chat/completions but the chosen Copilot model only serves
 * /v1/responses (gpt-5.x). Mirrors the reference
 * copilot-gateway chat-completions-via-responses/events.ts, simplified to
 * the events gpt-5.x on Copilot actually emits.
 */

import { createFrameBuffer, parseDataJSON, type SSEFrame } from "~/lib/sse/parser"

// ─── Inbound (Responses) event shape ───

interface RespUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
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

type RespEvent =
  | { type: "response.created"; response: { id: string; model: string } }
  | { type: "response.in_progress" }
  | {
      type: "response.output_item.added"
      output_index: number
      item: RespOutputItem
    }
  | {
      type: "response.output_item.done"
      output_index: number
      item: RespOutputItem
    }
  | {
      type: "response.output_text.delta"
      delta: string
      output_index: number
      content_index?: number
    }
  | {
      type: "response.output_text.done"
      text: string
      output_index: number
      content_index?: number
    }
  | {
      type: "response.function_call_arguments.delta"
      delta: string
      output_index: number
    }
  | {
      type: "response.function_call_arguments.done"
      arguments: string
      output_index: number
    }
  | {
      type: "response.reasoning_summary_text.delta"
      delta: string
      output_index: number
      summary_index?: number
    }
  | {
      type: "response.reasoning_summary_text.done"
      text: string
      output_index: number
      summary_index?: number
    }
  | {
      type: "response.completed"
      response: {
        usage?: RespUsage
        output?: RespOutputItem[]
        status?: string
        incomplete_details?: { reason?: string } | null
      }
    }
  | {
      type: "response.incomplete"
      response: {
        usage?: RespUsage
        output?: RespOutputItem[]
        incomplete_details?: { reason?: string } | null
      }
    }
  | {
      type: "response.failed"
      response: { error?: { message?: string; type?: string; code?: string } }
    }
  | { type: "error"; message?: string; code?: string }
  | { type: string }

// ─── Outbound (Chat Completions chunk) shape ───

interface ChatToolCallDelta {
  index: number
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

interface ChatDelta {
  role?: "assistant"
  content?: string
  reasoning_text?: string
  tool_calls?: ChatToolCallDelta[]
}

export interface ChatCompletionsChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: 0
    delta: ChatDelta
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
  }
}

// ─── State machine ───

export interface ResponsesToChatCompletionsState {
  messageId: string
  model: string
  created: number
  /** output_index → chat tool_call index */
  functionCallIndices: Map<number, number>
  /** output_index → emitted full arguments via .done already? */
  emittedArgsDoneOutputIndexes: Set<number>
  nextToolCallIndex: number
  emittedRole: boolean
  /** output_index of the first reasoning item we project as reasoning_text (compat projection). */
  firstScalarReasoningOutputIndex?: number
  hasFunctionCalls: boolean
  terminated: boolean
}

export function createResponsesToChatCompletionsState(
  fallbackModel = "",
): ResponsesToChatCompletionsState {
  return {
    messageId: "",
    model: fallbackModel,
    created: Math.floor(Date.now() / 1000),
    functionCallIndices: new Map(),
    emittedArgsDoneOutputIndexes: new Set(),
    nextToolCallIndex: 0,
    emittedRole: false,
    hasFunctionCalls: false,
    terminated: false,
  }
}

function makeChunk(
  state: ResponsesToChatCompletionsState,
  delta: ChatDelta,
  finishReason: ChatCompletionsChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionsChunk {
  return {
    id: state.messageId || "chatcmpl-pending",
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function makeUsageChunk(
  state: ResponsesToChatCompletionsState,
  usage: RespUsage,
): ChatCompletionsChunk {
  const promptTokens = usage.input_tokens ?? 0
  const completionTokens = usage.output_tokens ?? 0
  const cached = usage.input_tokens_details?.cached_tokens
  return {
    id: state.messageId || "chatcmpl-pending",
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
      ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  }
}

function mapFinishReason(
  resp: { status?: string; incomplete_details?: { reason?: string } | null; output?: RespOutputItem[] } | undefined,
  hasFunctionCalls: boolean,
): ChatCompletionsChunk["choices"][0]["finish_reason"] {
  if (!resp) return "stop"
  if (
    resp.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "length"
  }
  const outputHasFC =
    hasFunctionCalls ||
    (resp.output?.some((o) => o.type === "function_call") ?? false)
  if (outputHasFC) return "tool_calls"
  return "stop"
}

function shouldProjectScalarReasoning(
  outputIndex: number,
  state: ResponsesToChatCompletionsState,
): boolean {
  state.firstScalarReasoningOutputIndex ??= outputIndex
  return state.firstScalarReasoningOutputIndex === outputIndex
}

export function translateResponsesEventToChatCompletionsChunks(
  ev: RespEvent,
  state: ResponsesToChatCompletionsState,
): ChatCompletionsChunk[] | "DONE" {
  if (state.terminated) return []
  switch (ev.type) {
    case "response.created": {
      const e = ev as Extract<RespEvent, { type: "response.created" }>
      state.messageId = e.response.id
      if (e.response.model) state.model = e.response.model
      state.emittedRole = true
      return [makeChunk(state, { role: "assistant" })]
    }
    case "response.in_progress":
      return []
    case "response.output_item.added": {
      const e = ev as Extract<RespEvent, { type: "response.output_item.added" }>
      if (e.item.type !== "function_call") return []
      state.hasFunctionCalls = true
      const toolCallIndex = state.nextToolCallIndex++
      state.functionCallIndices.set(e.output_index, toolCallIndex)
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: toolCallIndex,
              id: e.item.call_id ?? e.item.id ?? `call_${toolCallIndex}`,
              type: "function",
              function: { name: e.item.name ?? "", arguments: "" },
            },
          ],
        }),
      ]
    }
    case "response.output_item.done":
      return []
    case "response.output_text.delta": {
      const e = ev as Extract<RespEvent, { type: "response.output_text.delta" }>
      return e.delta ? [makeChunk(state, { content: e.delta })] : []
    }
    case "response.output_text.done":
      // .delta carries everything; .done is just the final text we already emitted.
      return []
    case "response.reasoning_summary_text.delta": {
      const e = ev as Extract<RespEvent, { type: "response.reasoning_summary_text.delta" }>
      if (!e.delta) return []
      if (!shouldProjectScalarReasoning(e.output_index, state)) return []
      return [makeChunk(state, { reasoning_text: e.delta })]
    }
    case "response.reasoning_summary_text.done":
      return []
    case "response.function_call_arguments.delta": {
      const e = ev as Extract<RespEvent, { type: "response.function_call_arguments.delta" }>
      if (!e.delta) return []
      const idx = state.functionCallIndices.get(e.output_index)
      if (idx === undefined) return []
      return [
        makeChunk(state, {
          tool_calls: [{ index: idx, function: { arguments: e.delta } }],
        }),
      ]
    }
    case "response.function_call_arguments.done": {
      const e = ev as Extract<RespEvent, { type: "response.function_call_arguments.done" }>
      // Delta path already emitted incremental chunks; skip duplicate.
      state.emittedArgsDoneOutputIndexes.add(e.output_index)
      return []
    }
    case "response.completed":
    case "response.incomplete": {
      const e = ev as Extract<RespEvent, { type: "response.completed" | "response.incomplete" }>
      const finishReason = mapFinishReason(e.response, state.hasFunctionCalls)
      const out: ChatCompletionsChunk[] = [makeChunk(state, {}, finishReason)]
      if (e.response.usage) out.push(makeUsageChunk(state, e.response.usage))
      state.terminated = true
      return out
    }
    case "response.failed":
      state.terminated = true
      return [makeChunk(state, {}, "stop")]
    case "error":
      state.terminated = true
      return [makeChunk(state, {}, "stop")]
    default:
      return []
  }
}

// ─── TransformStream wrapper ───

function serializeChunk(chunk: ChatCompletionsChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

const DONE_FRAME = "data: [DONE]\n\n"
const UPSTREAM_MISSING_TERMINAL =
  "Upstream Responses stream ended without a terminal event."

/**
 * TransformStream: Responses SSE bytes in → Chat Completions SSE bytes out.
 * Stateful — create a new instance per request.
 */
export function createResponsesToChatCompletionsStream(
  fallbackModel = "",
): TransformStream<Uint8Array, Uint8Array> {
  const state = createResponsesToChatCompletionsState(fallbackModel)
  const buf = createFrameBuffer()
  const encoder = new TextEncoder()
  let emittedDone = false

  const flushFrames = (
    frames: SSEFrame[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const frame of frames) {
      const ev = parseDataJSON<RespEvent>(frame)
      if (!ev || typeof ev.type !== "string") continue
      const out = translateResponsesEventToChatCompletionsChunks(ev, state)
      if (out === "DONE") continue
      for (const chunk of out) {
        controller.enqueue(encoder.encode(serializeChunk(chunk)))
      }
      if (state.terminated && !emittedDone) {
        controller.enqueue(encoder.encode(DONE_FRAME))
        emittedDone = true
        return
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      const frames = buf.push(chunk)
      flushFrames(frames, controller)
    },
    flush(controller) {
      const tail = buf.flush()
      if (tail) flushFrames([tail], controller)
      if (!state.terminated) {
        const finishChunk = makeChunk(state, {}, "stop")
        controller.enqueue(encoder.encode(serializeChunk(finishChunk)))
      }
      if (!emittedDone) {
        controller.enqueue(encoder.encode(DONE_FRAME))
        emittedDone = true
      }
      if (!state.terminated) {
        state.terminated = true
        controller.enqueue(encoder.encode(`: ${UPSTREAM_MISSING_TERMINAL}\n\n`))
      }
    },
  })
}
