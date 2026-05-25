/**
 * Event translator: Anthropic Messages SSE → OpenAI Chat Completions SSE.
 *
 * Pairs with `./request.ts`. Used when the client speaks
 * /v1/chat/completions but the chosen Copilot model only serves
 * /v1/messages (claude-*). Mirrors the reference
 * copilot-gateway chat-completions-via-messages/events.ts but inlined to
 * this project's protocol shapes.
 *
 * Output is a sequence of chat.completion.chunk frames terminated by
 * `data: [DONE]\n\n`. Usage chunk is emitted only when message_delta carries
 * usage (i.e. include_usage equivalent — Anthropic always sends it, so
 * downstream consumers can rely on receiving a final usage chunk).
 */

import { createFrameBuffer, parseDataJSON, type SSEFrame } from "~/lib/sse/parser"

// ─── Inbound (Anthropic Messages SSE) shapes ───

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicMessageStartEvent {
  type: "message_start"
  message: { id: string; model: string; usage: AnthropicUsage }
}

interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text?: string }
    | { type: "thinking"; thinking?: string }
    | { type: "tool_use"; id: string; name: string }
    | { type: "redacted_thinking"; data?: string }
}

interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
    | { type: "input_json_delta"; partial_json: string }
}

interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: { stop_reason?: string | null; stop_sequence?: string | null }
  usage?: AnthropicUsage
}

interface AnthropicMessageStopEvent {
  type: "message_stop"
}

interface AnthropicPingEvent {
  type: "ping"
}

interface AnthropicErrorEvent {
  type: "error"
  error: { type?: string; message?: string }
}

type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// ─── Outbound (Chat Completions chunk) shapes ───

interface ChatToolCallDelta {
  index: number
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

interface ChatDelta {
  role?: "assistant"
  content?: string
  tool_calls?: ChatToolCallDelta[]
  reasoning_text?: string
  reasoning_opaque?: string
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

interface ToolCallSlot {
  blockIndex: number
  toolCallIndex: number
}

export interface MessagesToChatCompletionsState {
  messageId: string
  model: string
  created: number
  nextToolCallIndex: number
  promptTokens: number
  cachedPromptTokens: number
  /** blockIndex → tool call slot */
  toolCalls: Map<number, ToolCallSlot>
  /** Anthropic blockIndex of an active reasoning ("thinking") block, if any */
  reasoningBlockIndex?: number
  terminated: boolean
}

export function createMessagesToChatCompletionsState(
  fallbackModel = "",
): MessagesToChatCompletionsState {
  return {
    messageId: "",
    model: fallbackModel,
    created: Math.floor(Date.now() / 1000),
    nextToolCallIndex: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    toolCalls: new Map(),
    terminated: false,
  }
}

function makeChunk(
  state: MessagesToChatCompletionsState,
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
  state: MessagesToChatCompletionsState,
  outputTokens: number,
): ChatCompletionsChunk {
  return {
    id: state.messageId || "chatcmpl-pending",
    object: "chat.completion.chunk",
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

function mapStopReason(
  stopReason: string | null | undefined,
): ChatCompletionsChunk["choices"][0]["finish_reason"] {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
    case null:
    case undefined:
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    default:
      return "stop"
  }
}

export function translateMessagesEventToChatCompletionsChunks(
  ev: AnthropicStreamEvent,
  state: MessagesToChatCompletionsState,
): ChatCompletionsChunk[] | "DONE" {
  if (state.terminated) return []
  switch (ev.type) {
    case "message_start": {
      state.messageId = ev.message.id
      if (ev.message.model) state.model = ev.message.model
      const cached = ev.message.usage.cache_read_input_tokens ?? 0
      state.cachedPromptTokens = cached
      state.promptTokens =
        (ev.message.usage.input_tokens ?? 0) +
        cached +
        (ev.message.usage.cache_creation_input_tokens ?? 0)
      return [makeChunk(state, { role: "assistant" })]
    }
    case "content_block_start": {
      const block = ev.content_block
      if (block.type === "thinking") {
        state.reasoningBlockIndex = ev.index
        return []
      }
      if (block.type === "redacted_thinking") {
        state.reasoningBlockIndex = ev.index
        return block.data
          ? [makeChunk(state, { reasoning_opaque: block.data })]
          : []
      }
      if (block.type === "tool_use") {
        const toolCallIndex = state.nextToolCallIndex++
        state.toolCalls.set(ev.index, { blockIndex: ev.index, toolCallIndex })
        return [
          makeChunk(state, {
            tool_calls: [
              {
                index: toolCallIndex,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: "" },
              },
            ],
          }),
        ]
      }
      // text or unknown
      return []
    }
    case "content_block_delta": {
      const delta = ev.delta
      switch (delta.type) {
        case "text_delta":
          return delta.text ? [makeChunk(state, { content: delta.text })] : []
        case "thinking_delta":
          return state.reasoningBlockIndex === ev.index && delta.thinking
            ? [makeChunk(state, { reasoning_text: delta.thinking })]
            : []
        case "signature_delta":
          return state.reasoningBlockIndex === ev.index && delta.signature
            ? [makeChunk(state, { reasoning_opaque: delta.signature })]
            : []
        case "input_json_delta": {
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
    case "content_block_stop":
      return []
    case "message_delta": {
      const finishReason = mapStopReason(ev.delta.stop_reason ?? null)
      const finishChunk = makeChunk(state, {}, finishReason)
      return ev.usage
        ? [finishChunk, makeUsageChunk(state, ev.usage.output_tokens ?? 0)]
        : [finishChunk]
    }
    case "message_stop":
      state.terminated = true
      return "DONE"
    case "ping":
      return []
    case "error":
      state.terminated = true
      // Emit a finish chunk with stop so downstream consumers see closure,
      // then DONE. The error itself is logged but not propagated as an OpenAI
      // error frame (Chat Completions SSE has no standard error event).
      return [makeChunk(state, {}, "stop")]
  }
}

// ─── TransformStream wrapper ───

function serializeChunk(chunk: ChatCompletionsChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

const DONE_FRAME = "data: [DONE]\n\n"
const UPSTREAM_MISSING_TERMINAL =
  "Upstream Messages stream ended without a message_stop event."

/**
 * TransformStream: Anthropic Messages SSE bytes in → Chat Completions SSE
 * bytes out. Stateful — create a new instance per request.
 */
export function createMessagesToChatCompletionsStream(
  fallbackModel = "",
): TransformStream<Uint8Array, Uint8Array> {
  const state = createMessagesToChatCompletionsState(fallbackModel)
  const buf = createFrameBuffer()
  const encoder = new TextEncoder()

  const flushFrames = (
    frames: SSEFrame[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const frame of frames) {
      const ev = parseDataJSON<AnthropicStreamEvent>(frame)
      if (!ev || typeof ev.type !== "string") continue
      const out = translateMessagesEventToChatCompletionsChunks(ev, state)
      if (out === "DONE") {
        controller.enqueue(encoder.encode(DONE_FRAME))
        return
      }
      for (const chunk of out) {
        controller.enqueue(encoder.encode(serializeChunk(chunk)))
      }
      if (state.terminated) return
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
        // Synthesize a finish + DONE so downstream consumers don't hang.
        const finishChunk = makeChunk(state, {}, "stop")
        controller.enqueue(encoder.encode(serializeChunk(finishChunk)))
        controller.enqueue(encoder.encode(DONE_FRAME))
        state.terminated = true
        // Surface the truncation as an SSE comment so logs can pick it up.
        controller.enqueue(encoder.encode(`: ${UPSTREAM_MISSING_TERMINAL}\n\n`))
      }
    },
  })
}
