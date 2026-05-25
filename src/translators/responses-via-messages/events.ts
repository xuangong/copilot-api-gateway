/**
 * Event translator: Anthropic Messages SSE → OpenAI Responses SSE.
 *
 * Used when the client speaks /v1/responses but the chosen Copilot model
 * only serves /v1/messages (claude-*). Mirrors the reference
 * (copilot-gateway responses-via-messages/events.ts).
 *
 * The Anthropic stream frames a single message via message_start/_delta/_stop
 * with content_block_start/_delta/_stop pairs in the middle. We project
 * each block into a Responses output item (reasoning / message / function_call)
 * and assemble a final response.completed (or response.incomplete on
 * stop_reason=max_tokens) at message_stop.
 */

import { createFrameBuffer, parseDataJSON, type SSEFrame } from "~/lib/sse/parser"

// ─── Inbound (Anthropic Messages SSE) shapes ───

interface AnthropicEventBase {
  type: string
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicMessageStartEvent extends AnthropicEventBase {
  type: "message_start"
  message: {
    id: string
    model: string
    usage: AnthropicUsage
  }
}

interface AnthropicContentBlockStartEvent extends AnthropicEventBase {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text?: string }
    | { type: "thinking"; thinking?: string }
    | { type: "tool_use"; id: string; name: string }
    | { type: "redacted_thinking" }
    | { type: string }
}

interface AnthropicContentBlockDeltaEvent extends AnthropicEventBase {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "input_json_delta"; partial_json: string }
}

interface AnthropicContentBlockStopEvent extends AnthropicEventBase {
  type: "content_block_stop"
  index: number
}

interface AnthropicMessageDeltaEvent extends AnthropicEventBase {
  type: "message_delta"
  delta: { stop_reason?: string | null; stop_sequence?: string | null }
  usage?: AnthropicUsage
}

interface AnthropicMessageStopEvent extends AnthropicEventBase {
  type: "message_stop"
}

interface AnthropicPingEvent extends AnthropicEventBase {
  type: "ping"
}

interface AnthropicErrorEvent extends AnthropicEventBase {
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

// ─── Outbound (Responses) shapes ───

interface ResponseOutputItem {
  type: "message" | "reasoning" | "function_call"
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  status?: "in_progress" | "completed"
  summary?: Array<{ type: "summary_text"; text: string }>
  content?: Array<{ type: "output_text"; text: string }>
  role?: "assistant"
}

interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { cached_tokens: number }
}

interface ResponsesResult {
  id: string
  object: "response"
  model: string
  status: "in_progress" | "completed" | "incomplete" | "failed"
  output: ResponseOutputItem[]
  output_text?: string
  usage?: ResponsesUsage
  incomplete_details?: { reason: string } | null
}

type ResponsesEvent =
  | { type: "response.created"; sequence_number: number; response: ResponsesResult }
  | { type: "response.in_progress"; sequence_number: number; response: ResponsesResult }
  | {
      type: "response.output_item.added"
      sequence_number: number
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.output_item.done"
      sequence_number: number
      output_index: number
      item: ResponseOutputItem
    }
  | {
      type: "response.output_text.delta"
      sequence_number: number
      output_index: number
      item_id: string
      content_index: number
      delta: string
    }
  | {
      type: "response.output_text.done"
      sequence_number: number
      output_index: number
      item_id: string
      content_index: number
      text: string
    }
  | {
      type: "response.content_part.added"
      sequence_number: number
      output_index: number
      item_id: string
      content_index: number
      part: { type: "output_text"; text: string }
    }
  | {
      type: "response.content_part.done"
      sequence_number: number
      output_index: number
      item_id: string
      content_index: number
      part: { type: "output_text"; text: string }
    }
  | {
      type: "response.function_call_arguments.delta"
      sequence_number: number
      output_index: number
      item_id: string
      delta: string
    }
  | {
      type: "response.function_call_arguments.done"
      sequence_number: number
      output_index: number
      item_id: string
      arguments: string
    }
  | {
      type: "response.reasoning_summary_part.added"
      sequence_number: number
      output_index: number
      item_id: string
      summary_index: number
      part: { type: "summary_text"; text: string }
    }
  | {
      type: "response.reasoning_summary_text.delta"
      sequence_number: number
      output_index: number
      item_id: string
      summary_index: number
      delta: string
    }
  | {
      type: "response.reasoning_summary_text.done"
      sequence_number: number
      output_index: number
      item_id: string
      summary_index: number
      text: string
    }
  | {
      type: "response.reasoning_summary_part.done"
      sequence_number: number
      output_index: number
      item_id: string
      summary_index: number
      part: { type: "summary_text"; text: string }
    }
  | { type: "response.completed"; sequence_number: number; response: ResponsesResult }
  | { type: "response.incomplete"; sequence_number: number; response: ResponsesResult }
  | { type: "response.failed"; sequence_number: number; response: ResponsesResult }
  | { type: "ping"; sequence_number: number }
  | { type: "error"; sequence_number: number; message: string; code?: string }

// ─── State machine ───

type BlockInfo =
  | { kind: "text"; outputIndex: number; itemId: string; text: string }
  | { kind: "thinking"; outputIndex: number; itemId: string; text: string }
  | {
      kind: "tool_use"
      outputIndex: number
      itemId: string
      toolCallId: string
      name: string
      args: string
    }

export interface MessagesToResponsesState {
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

export function createMessagesToResponsesState(
  responseId: string,
  model: string,
): MessagesToResponsesState {
  return {
    responseId,
    model,
    sequenceNumber: 0,
    outputIndex: 0,
    blockMap: new Map(),
    completedItems: [],
    accumulatedText: "",
    inputTokens: 0,
    outputTokens: 0,
    terminated: false,
  }
}

function nextSeq(state: MessagesToResponsesState): number {
  return state.sequenceNumber++
}

function buildUsage(state: MessagesToResponsesState): ResponsesUsage {
  const input =
    state.inputTokens
    + (state.cacheReadInputTokens ?? 0)
    + (state.cacheCreationInputTokens ?? 0)
  return {
    input_tokens: input,
    output_tokens: state.outputTokens,
    total_tokens: input + state.outputTokens,
    ...(state.cacheReadInputTokens !== undefined
      ? { input_tokens_details: { cached_tokens: state.cacheReadInputTokens } }
      : {}),
  }
}

function buildResult(
  state: MessagesToResponsesState,
  status: ResponsesResult["status"],
): ResponsesResult {
  return {
    id: state.responseId,
    object: "response",
    model: state.model,
    status,
    output: state.completedItems,
    output_text: state.accumulatedText,
    usage: buildUsage(state),
    ...(status === "incomplete"
      ? { incomplete_details: { reason: "max_output_tokens" } }
      : {}),
  }
}

function handleMessageStart(
  ev: AnthropicMessageStartEvent,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  state.inputTokens = ev.message.usage.input_tokens ?? 0
  state.cacheReadInputTokens = ev.message.usage.cache_read_input_tokens
  state.cacheCreationInputTokens = ev.message.usage.cache_creation_input_tokens
  const response = buildResult(state, "in_progress")
  return [
    { type: "response.created", sequence_number: nextSeq(state), response },
    { type: "response.in_progress", sequence_number: nextSeq(state), response },
  ]
}

function handleContentBlockStart(
  ev: AnthropicContentBlockStartEvent,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  const out: ResponsesEvent[] = []
  switch (ev.content_block.type) {
    case "text": {
      const outputIndex = state.outputIndex++
      const itemId = `msg_${outputIndex}`
      state.blockMap.set(ev.index, { kind: "text", outputIndex, itemId, text: "" })
      const item: ResponseOutputItem = {
        type: "message",
        id: itemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      }
      out.push({
        type: "response.output_item.added",
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item,
      })
      out.push({
        type: "response.content_part.added",
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        part: { type: "output_text", text: "" },
      })
      return out
    }
    case "thinking": {
      const outputIndex = state.outputIndex++
      const itemId = `rs_${outputIndex}`
      state.blockMap.set(ev.index, { kind: "thinking", outputIndex, itemId, text: "" })
      const item: ResponseOutputItem = {
        type: "reasoning",
        id: itemId,
        summary: [],
      }
      out.push({
        type: "response.output_item.added",
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item,
      })
      out.push({
        type: "response.reasoning_summary_part.added",
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item_id: itemId,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      })
      return out
    }
    case "tool_use": {
      const tb = ev.content_block as { type: "tool_use"; id: string; name: string }
      const outputIndex = state.outputIndex++
      const itemId = `fc_${outputIndex}`
      state.blockMap.set(ev.index, {
        kind: "tool_use",
        outputIndex,
        itemId,
        toolCallId: tb.id,
        name: tb.name,
        args: "",
      })
      const item: ResponseOutputItem = {
        type: "function_call",
        id: itemId,
        call_id: tb.id,
        name: tb.name,
        arguments: "",
        status: "in_progress",
      }
      out.push({
        type: "response.output_item.added",
        sequence_number: nextSeq(state),
        output_index: outputIndex,
        item,
      })
      return out
    }
    default:
      return []
  }
}

function handleContentBlockDelta(
  ev: AnthropicContentBlockDeltaEvent,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  const info = state.blockMap.get(ev.index)
  if (!info) return []
  switch (info.kind) {
    case "text":
      if (ev.delta.type !== "text_delta") return []
      info.text += ev.delta.text
      state.accumulatedText += ev.delta.text
      return [
        {
          type: "response.output_text.delta",
          sequence_number: nextSeq(state),
          output_index: info.outputIndex,
          item_id: info.itemId,
          content_index: 0,
          delta: ev.delta.text,
        },
      ]
    case "thinking":
      if (ev.delta.type !== "thinking_delta") return []
      info.text += ev.delta.thinking
      return [
        {
          type: "response.reasoning_summary_text.delta",
          sequence_number: nextSeq(state),
          output_index: info.outputIndex,
          item_id: info.itemId,
          summary_index: 0,
          delta: ev.delta.thinking,
        },
      ]
    case "tool_use":
      if (ev.delta.type !== "input_json_delta") return []
      info.args += ev.delta.partial_json
      return [
        {
          type: "response.function_call_arguments.delta",
          sequence_number: nextSeq(state),
          output_index: info.outputIndex,
          item_id: info.itemId,
          delta: ev.delta.partial_json,
        },
      ]
  }
}

function handleContentBlockStop(
  ev: AnthropicContentBlockStopEvent,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  const info = state.blockMap.get(ev.index)
  if (!info) return []
  state.blockMap.delete(ev.index)
  const out: ResponsesEvent[] = []
  if (info.kind === "text") {
    const item: ResponseOutputItem = {
      type: "message",
      id: info.itemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: info.text }],
    }
    state.completedItems.push(item)
    out.push({
      type: "response.output_text.done",
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      content_index: 0,
      text: info.text,
    })
    out.push({
      type: "response.content_part.done",
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      content_index: 0,
      part: { type: "output_text", text: info.text },
    })
    out.push({
      type: "response.output_item.done",
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item,
    })
    return out
  }
  if (info.kind === "thinking") {
    const item: ResponseOutputItem = {
      type: "reasoning",
      id: info.itemId,
      summary: [{ type: "summary_text", text: info.text }],
    }
    state.completedItems.push(item)
    out.push({
      type: "response.reasoning_summary_text.done",
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      summary_index: 0,
      text: info.text,
    })
    out.push({
      type: "response.reasoning_summary_part.done",
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item_id: info.itemId,
      summary_index: 0,
      part: { type: "summary_text", text: info.text },
    })
    out.push({
      type: "response.output_item.done",
      sequence_number: nextSeq(state),
      output_index: info.outputIndex,
      item,
    })
    return out
  }
  // tool_use
  const item: ResponseOutputItem = {
    type: "function_call",
    id: info.itemId,
    call_id: info.toolCallId,
    name: info.name,
    arguments: info.args,
    status: "completed",
  }
  state.completedItems.push(item)
  out.push({
    type: "response.function_call_arguments.done",
    sequence_number: nextSeq(state),
    output_index: info.outputIndex,
    item_id: info.itemId,
    arguments: info.args,
  })
  out.push({
    type: "response.output_item.done",
    sequence_number: nextSeq(state),
    output_index: info.outputIndex,
    item,
  })
  return out
}

function handleMessageDelta(
  ev: AnthropicMessageDeltaEvent,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  if (ev.delta.stop_reason !== undefined) state.stopReason = ev.delta.stop_reason
  if (ev.usage?.output_tokens != null) state.outputTokens = ev.usage.output_tokens
  // Anthropic surfaces the authoritative cache totals on message_delta in
  // newer API versions — absorb so response.completed reports them.
  if (ev.usage?.cache_read_input_tokens != null)
    state.cacheReadInputTokens = ev.usage.cache_read_input_tokens
  if (ev.usage?.cache_creation_input_tokens != null)
    state.cacheCreationInputTokens = ev.usage.cache_creation_input_tokens
  return []
}

function handleMessageStop(state: MessagesToResponsesState): ResponsesEvent[] {
  state.terminated = true
  const status: ResponsesResult["status"] =
    state.stopReason === "max_tokens" ? "incomplete" : "completed"
  const response = buildResult(state, status)
  return [
    {
      type: status === "completed" ? "response.completed" : "response.incomplete",
      sequence_number: nextSeq(state),
      response,
    },
  ]
}

function handleError(
  message: string,
  code: string | undefined,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  state.terminated = true
  return [
    {
      type: "error",
      sequence_number: nextSeq(state),
      message,
      ...(code ? { code } : {}),
    },
  ]
}

export function translateMessagesEventToResponsesEvents(
  ev: AnthropicStreamEvent,
  state: MessagesToResponsesState,
): ResponsesEvent[] {
  if (state.terminated) return []
  switch (ev.type) {
    case "message_start":
      return handleMessageStart(ev, state)
    case "content_block_start":
      return handleContentBlockStart(ev, state)
    case "content_block_delta":
      return handleContentBlockDelta(ev, state)
    case "content_block_stop":
      return handleContentBlockStop(ev, state)
    case "message_delta":
      return handleMessageDelta(ev, state)
    case "message_stop":
      return handleMessageStop(state)
    case "ping":
      return [{ type: "ping", sequence_number: nextSeq(state) }]
    case "error":
      return handleError(ev.error.message ?? "Stream error.", ev.error.type, state)
    default:
      return []
  }
}

// ─── TransformStream wrapper ───

function serializeResponsesEvent(ev: ResponsesEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

function synthResponseId(): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  return `resp_${rand}`
}

/**
 * TransformStream: Anthropic Messages SSE bytes in → Responses SSE bytes out.
 * Stateful — create a new instance per request.
 */
export function createMessagesToResponsesStream(
  model: string,
  responseId: string = synthResponseId(),
): TransformStream<Uint8Array, Uint8Array> {
  const state = createMessagesToResponsesState(responseId, model)
  const buf = createFrameBuffer()
  const encoder = new TextEncoder()

  const flushFrames = (
    frames: SSEFrame[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const frame of frames) {
      const ev = parseDataJSON<AnthropicStreamEvent>(frame)
      if (!ev || typeof ev.type !== "string") continue
      for (const out of translateMessagesEventToResponsesEvents(ev, state)) {
        controller.enqueue(encoder.encode(serializeResponsesEvent(out)))
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
      if (!state.terminated) {
        for (const out of handleError(
          "Upstream Messages stream ended without a message_stop event.",
          "stream_truncated",
          state,
        )) {
          controller.enqueue(encoder.encode(serializeResponsesEvent(out)))
        }
      }
    },
  })
}
