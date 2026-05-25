/**
 * Event translator: OpenAI Chat Completions SSE → Anthropic Messages SSE.
 *
 * Pairs with `./request.ts`. Used when the client speaks /v1/messages but
 * the chosen Copilot model only serves /v1/chat/completions (gpt-* non-5.x).
 *
 * Inbound Chat Completions emits a sequence of `chat.completion.chunk`
 * frames terminated by `data: [DONE]`. We project each chunk into Anthropic
 * Messages framing: a synthetic message_start (from the first chunk),
 * content_block lifecycle pairs for each of text/tool_use/thinking, then a
 * message_delta + message_stop at finish_reason.
 */

import { createFrameBuffer, parseDataJSON, type SSEFrame } from "~/lib/sse/parser"

// ─── Inbound (Chat Completions) shapes ───

interface ChatToolCallDelta {
  index: number
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

interface ChatDelta {
  role?: "assistant"
  content?: string | null
  tool_calls?: ChatToolCallDelta[]
  reasoning_text?: string
  reasoning_opaque?: string
}

interface ChatChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: ChatDelta
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

// ─── Outbound (Anthropic Messages SSE) shapes ───

interface AnthropicUsageOut {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
}

type AnthropicContentBlockOpen =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

type AnthropicDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partial_json: string }

export type AnthropicStreamEvent =
  | {
      type: "message_start"
      message: {
        id: string
        type: "message"
        role: "assistant"
        model: string
        content: []
        stop_reason: null
        stop_sequence: null
        usage: AnthropicUsageOut
      }
    }
  | {
      type: "content_block_start"
      index: number
      content_block: AnthropicContentBlockOpen
    }
  | { type: "content_block_delta"; index: number; delta: AnthropicDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta"
      delta: { stop_reason: string | null; stop_sequence: null }
      usage: { output_tokens: number; cache_read_input_tokens?: number }
    }
  | { type: "message_stop" }
  | { type: "ping" }

// ─── State machine ───

type OpenBlockKind = "text" | "thinking" | "tool_use"

interface OpenBlock {
  index: number
  kind: OpenBlockKind
  /** For tool_use: chat-side toolCallIndex → our anthropic block index */
  toolCallIndex?: number
}

export interface ChatCompletionsToMessagesState {
  messageId: string
  model: string
  emittedMessageStart: boolean
  nextBlockIndex: number
  textBlock?: OpenBlock
  thinkingBlock?: OpenBlock
  /** toolCallIndex → OpenBlock */
  toolBlocks: Map<number, OpenBlock>
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  finishReason:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | null
  terminated: boolean
}

export function createChatCompletionsToMessagesState(
  fallbackModel = "",
): ChatCompletionsToMessagesState {
  return {
    messageId: "",
    model: fallbackModel,
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
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  return `msg_${rand}`
}

function mapFinishReason(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null | undefined,
): string | null {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default:
      return null
  }
}

function emitMessageStart(state: ChatCompletionsToMessagesState): AnthropicStreamEvent {
  state.emittedMessageStart = true
  if (!state.messageId) state.messageId = synthMessageId()
  return {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      model: state.model || "unknown",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: 0,
        ...(state.cachedInputTokens > 0
          ? { cache_read_input_tokens: state.cachedInputTokens }
          : {}),
      },
    },
  }
}

function closeBlock(
  state: ChatCompletionsToMessagesState,
  block: OpenBlock,
): AnthropicStreamEvent {
  return { type: "content_block_stop", index: block.index }
}

function closeAllOpenBlocks(
  state: ChatCompletionsToMessagesState,
): AnthropicStreamEvent[] {
  const out: AnthropicStreamEvent[] = []
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

function openText(state: ChatCompletionsToMessagesState): AnthropicStreamEvent[] {
  if (state.textBlock) return []
  // text and thinking are mutually exclusive at the same block index — close
  // thinking before opening text so blocks appear in the order they completed.
  const out: AnthropicStreamEvent[] = []
  if (state.thinkingBlock) {
    out.push(closeBlock(state, state.thinkingBlock))
    state.thinkingBlock = undefined
  }
  const index = state.nextBlockIndex++
  state.textBlock = { index, kind: "text" }
  out.push({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  })
  return out
}

function openThinking(state: ChatCompletionsToMessagesState): AnthropicStreamEvent[] {
  if (state.thinkingBlock) return []
  // thinking should precede the text block. If text is already open this is
  // an out-of-order event from upstream — skip it rather than reorder.
  if (state.textBlock) return []
  const index = state.nextBlockIndex++
  state.thinkingBlock = { index, kind: "thinking" }
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    },
  ]
}

function openTool(
  state: ChatCompletionsToMessagesState,
  toolCallIndex: number,
  id: string,
  name: string,
): AnthropicStreamEvent[] {
  if (state.toolBlocks.has(toolCallIndex)) return []
  // Close any text/thinking before tool — Anthropic emits tool_use blocks
  // strictly after assistant text in a single message.
  const out: AnthropicStreamEvent[] = []
  if (state.textBlock) {
    out.push(closeBlock(state, state.textBlock))
    state.textBlock = undefined
  }
  if (state.thinkingBlock) {
    out.push(closeBlock(state, state.thinkingBlock))
    state.thinkingBlock = undefined
  }
  const index = state.nextBlockIndex++
  state.toolBlocks.set(toolCallIndex, { index, kind: "tool_use", toolCallIndex })
  out.push({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  })
  return out
}

export function translateChatCompletionsChunkToMessagesEvents(
  chunk: ChatChunk,
  state: ChatCompletionsToMessagesState,
): AnthropicStreamEvent[] | "DONE" {
  if (state.terminated) return []
  const out: AnthropicStreamEvent[] = []

  // Capture id/model from the first chunk we see.
  if (chunk.id && !state.messageId) state.messageId = chunk.id
  if (chunk.model && !state.model) state.model = chunk.model

  // Usage-only chunk (no choices): seed usage but do not emit anything yet.
  // The final message_delta will surface output_tokens.
  if (chunk.usage) {
    if (chunk.usage.prompt_tokens != null) state.inputTokens = chunk.usage.prompt_tokens
    if (chunk.usage.completion_tokens != null)
      state.outputTokens = chunk.usage.completion_tokens
    if (chunk.usage.prompt_tokens_details?.cached_tokens != null)
      state.cachedInputTokens = chunk.usage.prompt_tokens_details.cached_tokens
  }

  if (!chunk.choices || chunk.choices.length === 0) return out

  const choice = chunk.choices[0]
  if (!choice) return out
  const delta = choice.delta

  // Emit message_start lazily once we have at least an id/model + first choice.
  if (!state.emittedMessageStart) out.push(emitMessageStart(state))

  if (delta) {
    if (delta.reasoning_text) {
      out.push(...openThinking(state))
      if (state.thinkingBlock) {
        out.push({
          type: "content_block_delta",
          index: state.thinkingBlock.index,
          delta: { type: "thinking_delta", thinking: delta.reasoning_text },
        })
      }
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      out.push(...openText(state))
      if (state.textBlock) {
        out.push({
          type: "content_block_delta",
          index: state.textBlock.index,
          delta: { type: "text_delta", text: delta.content },
        })
      }
    }
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        const tcIdx = tc.index ?? 0
        if (tc.id || tc.function?.name) {
          out.push(...openTool(state, tcIdx, tc.id ?? "", tc.function?.name ?? ""))
        }
        const block = state.toolBlocks.get(tcIdx)
        const args = tc.function?.arguments
        if (block && typeof args === "string" && args.length > 0) {
          out.push({
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: args },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason
    out.push(...closeAllOpenBlocks(state))
    out.push({
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null },
      usage: {
        output_tokens: state.outputTokens,
        ...(state.cachedInputTokens > 0
          ? { cache_read_input_tokens: state.cachedInputTokens }
          : {}),
      },
    })
    out.push({ type: "message_stop" })
    state.terminated = true
  }

  return out
}

// ─── TransformStream wrapper ───

function serializeAnthropicEvent(ev: AnthropicStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

const UPSTREAM_MISSING_TERMINAL =
  "Upstream Chat Completions stream ended without [DONE] / finish_reason."

/**
 * TransformStream: Chat Completions SSE bytes in → Anthropic Messages SSE
 * bytes out. Stateful — create a new instance per request.
 */
export function createChatCompletionsToMessagesStream(
  fallbackModel = "",
): TransformStream<Uint8Array, Uint8Array> {
  const state = createChatCompletionsToMessagesState(fallbackModel)
  const buf = createFrameBuffer()
  const encoder = new TextEncoder()

  const synthesizeTerminal = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (state.terminated) return
    if (!state.emittedMessageStart) {
      controller.enqueue(encoder.encode(serializeAnthropicEvent(emitMessageStart(state))))
    }
    for (const ev of closeAllOpenBlocks(state)) {
      controller.enqueue(encoder.encode(serializeAnthropicEvent(ev)))
    }
    controller.enqueue(
      encoder.encode(
        serializeAnthropicEvent({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            output_tokens: state.outputTokens,
            ...(state.cachedInputTokens > 0
              ? { cache_read_input_tokens: state.cachedInputTokens }
              : {}),
          },
        }),
      ),
    )
    controller.enqueue(encoder.encode(serializeAnthropicEvent({ type: "message_stop" })))
    controller.enqueue(encoder.encode(`: ${UPSTREAM_MISSING_TERMINAL}\n\n`))
    state.terminated = true
  }

  const flushFrames = (
    frames: SSEFrame[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const frame of frames) {
      if (!frame.data) continue
      if (frame.data === "[DONE]") {
        if (!state.terminated) synthesizeTerminal(controller)
        return
      }
      const chunk = parseDataJSON<ChatChunk>(frame)
      if (!chunk) continue
      const out = translateChatCompletionsChunkToMessagesEvents(chunk, state)
      if (out === "DONE") return
      for (const ev of out) {
        controller.enqueue(encoder.encode(serializeAnthropicEvent(ev)))
      }
      if (state.terminated) return
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      flushFrames(buf.push(chunk), controller)
    },
    flush(controller) {
      const tail = buf.flush()
      if (tail) flushFrames([tail], controller)
      if (!state.terminated) synthesizeTerminal(controller)
    },
  })
}
