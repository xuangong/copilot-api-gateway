/**
 * Event translator: OpenAI Responses SSE → Anthropic Messages SSE.
 *
 * Pairs with `./request.ts`. Used when the client speaks /v1/messages but
 * the chosen Copilot model only supports the Responses upstream (gpt-5.x).
 *
 * State machine mirrors the reference (copilot-gateway
 * messages-via-responses/events.ts): one Anthropic message frames the whole
 * stream; content blocks are opened/closed as Responses output items appear
 * and complete.
 *
 * Only events gpt-5.x actually emits are handled. Unrecognized events are
 * dropped (the reference defers events for cross-output ordering, but
 * gpt-5.x on Copilot emits items one at a time so deferral isn't needed
 * here yet).
 */

import { createFrameBuffer, parseDataJSON, type SSEFrame } from "~/lib/sse/parser"

// ─── Inbound (Responses) event shape ───

interface RespEventBase {
  type: string
  sequence_number?: number
}

interface RespCreatedEvent extends RespEventBase {
  type: "response.created"
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
  type: "response.output_item.added"
  output_index: number
  item: RespOutputItem
}

interface RespOutputItemDoneEvent extends RespEventBase {
  type: "response.output_item.done"
  output_index: number
  item: RespOutputItem
}

interface RespTextDeltaEvent extends RespEventBase {
  type: "response.output_text.delta"
  output_index: number
  content_index: number
  delta: string
}

interface RespFnArgsDeltaEvent extends RespEventBase {
  type: "response.function_call_arguments.delta"
  output_index: number
  delta: string
}

interface RespFnArgsDoneEvent extends RespEventBase {
  type: "response.function_call_arguments.done"
  output_index: number
  arguments: string
}

interface RespReasoningSummaryDeltaEvent extends RespEventBase {
  type: "response.reasoning_summary_text.delta"
  output_index: number
  summary_index: number
  delta: string
}

interface RespCompletedEvent extends RespEventBase {
  type: "response.completed" | "response.incomplete"
  response: {
    status: "completed" | "incomplete"
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
  type: "response.failed"
  response: { error?: { message?: string } }
}

interface RespErrorEvent extends RespEventBase {
  type: "error"
  message?: string
}

type RespEvent =
  | RespCreatedEvent
  | RespOutputItemAddedEvent
  | RespOutputItemDoneEvent
  | RespTextDeltaEvent
  | RespFnArgsDeltaEvent
  | RespFnArgsDoneEvent
  | RespReasoningSummaryDeltaEvent
  | RespCompletedEvent
  | RespFailedEvent
  | RespErrorEvent
  | (RespEventBase & { type: "ping" })

// ─── Outbound (Anthropic) event shape ───

type AnthropicEvent =
  | { type: "message_start"; message: AnthropicMessageHead }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlockInit }
  | { type: "content_block_delta"; index: number; delta: AnthropicDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null; stop_sequence: null }; usage: AnthropicUsage }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } }

interface AnthropicMessageHead {
  id: string
  type: "message"
  role: "assistant"
  content: []
  model: string
  stop_reason: null
  stop_sequence: null
  usage: AnthropicUsage
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
}

type AnthropicContentBlockInit =
  | { type: "text"; text: "" }
  | { type: "thinking"; thinking: "" }
  | { type: "tool_use"; id: string; name: string; input: Record<string, never> }

type AnthropicDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partial_json: string }

// ─── State machine ───

interface FunctionCallState {
  blockIndex: number
  toolCallId: string
  name: string
  emittedAnyArguments: boolean
}

export interface ResponsesToMessagesState {
  messageCompleted: boolean
  nextBlockIndex: number
  /** Map of "outputIndex:contentIndex" → block index, for re-opening the same text block. */
  textBlockByKey: Map<string, number>
  /** Map of outputIndex → block index, for re-opening the same thinking block. */
  thinkingBlockByOutputIndex: Map<number, number>
  openBlocks: Set<number>
  functionCallState: Map<number, FunctionCallState>
}

export function createResponsesToMessagesState(): ResponsesToMessagesState {
  return {
    messageCompleted: false,
    nextBlockIndex: 0,
    textBlockByKey: new Map(),
    thinkingBlockByOutputIndex: new Map(),
    openBlocks: new Set(),
    functionCallState: new Map(),
  }
}

function closeOpenBlocks(state: ResponsesToMessagesState, out: AnthropicEvent[]): void {
  for (const blockIndex of state.openBlocks) {
    out.push({ type: "content_block_stop", index: blockIndex })
  }
  state.openBlocks.clear()
}

function openTextBlock(
  state: ResponsesToMessagesState,
  outputIndex: number,
  contentIndex: number,
  out: AnthropicEvent[],
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
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    })
    state.openBlocks.add(blockIndex)
  }
  return blockIndex
}

function openThinkingBlock(
  state: ResponsesToMessagesState,
  outputIndex: number,
  out: AnthropicEvent[],
): number {
  let blockIndex = state.thinkingBlockByOutputIndex.get(outputIndex)
  if (blockIndex === undefined) {
    blockIndex = state.nextBlockIndex++
    state.thinkingBlockByOutputIndex.set(outputIndex, blockIndex)
  }
  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, out)
    out.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "" },
    })
    state.openBlocks.add(blockIndex)
  }
  return blockIndex
}

function handleCreated(ev: RespCreatedEvent): AnthropicEvent[] {
  const cached = ev.response.usage?.input_tokens_details?.cached_tokens
  const input = (ev.response.usage?.input_tokens ?? 0) - (cached ?? 0)
  return [
    {
      type: "message_start",
      message: {
        id: ev.response.id,
        type: "message",
        role: "assistant",
        content: [],
        model: ev.response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: input,
          output_tokens: 0,
          ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
        },
      },
    },
  ]
}

function handleOutputItemAdded(
  ev: RespOutputItemAddedEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  if (ev.item.type !== "function_call") return []

  const blockIndex = state.nextBlockIndex++
  const toolCallId = ev.item.call_id ?? `tool_${blockIndex}`
  const name = ev.item.name ?? "function"

  const fcs: FunctionCallState = { blockIndex, toolCallId, name, emittedAnyArguments: false }
  state.functionCallState.set(ev.output_index, fcs)

  const out: AnthropicEvent[] = []
  closeOpenBlocks(state, out)
  out.push({
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "tool_use", id: toolCallId, name, input: {} },
  })
  state.openBlocks.add(blockIndex)

  // Some Responses payloads carry initial arguments on the added event.
  const initialArgs = ev.item.arguments ?? ""
  if (initialArgs.length > 0) {
    out.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: initialArgs },
    })
    fcs.emittedAnyArguments = true
  }
  return out
}

function handleTextDelta(
  ev: RespTextDeltaEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  if (!ev.delta) return []
  const out: AnthropicEvent[] = []
  const blockIndex = openTextBlock(state, ev.output_index, ev.content_index, out)
  out.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "text_delta", text: ev.delta },
  })
  return out
}

function handleFnArgsDelta(
  ev: RespFnArgsDeltaEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  if (!ev.delta) return []
  const fcs = state.functionCallState.get(ev.output_index)
  if (!fcs) return []
  fcs.emittedAnyArguments = true
  return [
    {
      type: "content_block_delta",
      index: fcs.blockIndex,
      delta: { type: "input_json_delta", partial_json: ev.delta },
    },
  ]
}

function handleFnArgsDone(
  ev: RespFnArgsDoneEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  const fcs = state.functionCallState.get(ev.output_index)
  if (!fcs) return []
  state.functionCallState.delete(ev.output_index)
  if (!ev.arguments || fcs.emittedAnyArguments) return []
  return [
    {
      type: "content_block_delta",
      index: fcs.blockIndex,
      delta: { type: "input_json_delta", partial_json: ev.arguments },
    },
  ]
}

function handleReasoningSummaryDelta(
  ev: RespReasoningSummaryDeltaEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  if (!ev.delta) return []
  const out: AnthropicEvent[] = []
  const blockIndex = openThinkingBlock(state, ev.output_index, out)
  out.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "thinking_delta", thinking: ev.delta },
  })
  return out
}

function mapStopReason(ev: RespCompletedEvent): string {
  if (ev.response.status === "incomplete" && ev.response.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens"
  }
  if (ev.response.output.some((i) => i.type === "function_call")) return "tool_use"
  return "end_turn"
}

function handleCompleted(
  ev: RespCompletedEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  const out: AnthropicEvent[] = []
  closeOpenBlocks(state, out)
  state.functionCallState.clear()

  const cached = ev.response.usage?.input_tokens_details?.cached_tokens
  const usage: AnthropicUsage = {
    input_tokens: (ev.response.usage?.input_tokens ?? 0) - (cached ?? 0),
    output_tokens: ev.response.usage?.output_tokens ?? 0,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
  }
  out.push({
    type: "message_delta",
    delta: { stop_reason: mapStopReason(ev), stop_sequence: null },
    usage,
  })
  out.push({ type: "message_stop" })
  state.messageCompleted = true
  return out
}

function handleStreamError(
  state: ResponsesToMessagesState,
  message: string,
): AnthropicEvent[] {
  const out: AnthropicEvent[] = []
  closeOpenBlocks(state, out)
  state.functionCallState.clear()
  state.messageCompleted = true
  out.push({ type: "error", error: { type: "api_error", message } })
  return out
}

export function translateResponsesEventToMessagesEvents(
  ev: RespEvent,
  state: ResponsesToMessagesState,
): AnthropicEvent[] {
  if (state.messageCompleted) return []
  switch (ev.type) {
    case "response.created":
      return handleCreated(ev)
    case "response.output_item.added":
      return handleOutputItemAdded(ev, state)
    case "response.output_item.done":
      // Reasoning items finalize on done; text/function deltas already emit.
      // We close blocks only when a new block opens or on completion, matching
      // the reference's lazy-close behavior.
      return []
    case "response.output_text.delta":
      return handleTextDelta(ev, state)
    case "response.function_call_arguments.delta":
      return handleFnArgsDelta(ev, state)
    case "response.function_call_arguments.done":
      return handleFnArgsDone(ev, state)
    case "response.reasoning_summary_text.delta":
      return handleReasoningSummaryDelta(ev, state)
    case "response.completed":
    case "response.incomplete":
      return handleCompleted(ev, state)
    case "response.failed":
      return handleStreamError(state, ev.response.error?.message ?? "Response failed.")
    case "error":
      return handleStreamError(state, ev.message ?? "Stream error.")
    case "ping":
      return [{ type: "ping" }]
    default:
      return []
  }
}

// ─── TransformStream wrapper ───

function serializeAnthropicEvent(ev: AnthropicEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/**
 * TransformStream: Responses SSE bytes in → Anthropic Messages SSE bytes out.
 * Stateful — create a new instance per request.
 */
export function createResponsesToMessagesStream(): TransformStream<Uint8Array, Uint8Array> {
  const state = createResponsesToMessagesState()
  const buf = createFrameBuffer()
  const encoder = new TextEncoder()

  const flushFrames = (frames: SSEFrame[], controller: TransformStreamDefaultController<Uint8Array>) => {
    for (const frame of frames) {
      const ev = parseDataJSON<RespEvent>(frame)
      if (!ev || typeof ev.type !== "string") continue
      for (const out of translateResponsesEventToMessagesEvents(ev, state)) {
        controller.enqueue(encoder.encode(serializeAnthropicEvent(out)))
      }
      if (state.messageCompleted) return
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
      if (!state.messageCompleted) {
        // Upstream cut us off pre-completion. Emit a terminal error so
        // clients don't hang.
        for (const out of handleStreamError(state, "Upstream stream ended without completion.")) {
          controller.enqueue(encoder.encode(serializeAnthropicEvent(out)))
        }
      }
    },
  })
}
