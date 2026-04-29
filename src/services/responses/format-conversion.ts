/**
 * Responses API ↔ Chat Completions API format conversion
 *
 * Converts OpenAI Responses API format to Chat Completions format
 * so requests can be forwarded to the Copilot backend (which only supports chat).
 */

import type {
  ResponsesPayload,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseFunctionCallItem,
  ResponseFunctionCallOutputItem,
  ResponseTool,
} from "~/transforms/types"

// ─── Chat Completions Types (local, same pattern as Gemini conversion) ───

export interface ChatCompletionsPayload {
  model: string
  messages: Message[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  temperature?: number
  top_p?: number
  tools?: Tool[]
  tool_choice?: string | { type: string; function?: { name: string } }
  parallel_tool_calls?: boolean
  reasoning_effort?: "low" | "medium" | "high"
}

interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }
}

interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

interface ChatCompletionChoice {
  index: number
  message: {
    role: "assistant"
    content: string | null
    tool_calls?: ToolCall[]
  }
  finish_reason: string | null
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: ChatCompletionChunkChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
}

interface ChatCompletionChunkChoice {
  index: number
  delta: {
    role?: string
    content?: string | null
    tool_calls?: ChunkToolCall[]
  }
  finish_reason: string | null
}

interface ChunkToolCall {
  index: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

// ─── Responses API Response Types ───

export interface ResponsesAPIResponse {
  id: string
  object: "response"
  created_at: number
  model: string
  output: ResponseOutputItem[]
  output_text: string
  status: "completed" | "failed" | "in_progress" | "incomplete"
  error: null
  incomplete_details: null
  instructions: string | null
  metadata: Record<string, string> | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: string | { type: string }
  tools: ResponseToolOutput[]
  top_p: number | null
  usage: ResponseUsage
}

interface ResponseOutputItem {
  type: "message" | "function_call"
  [key: string]: unknown
}

interface ResponseOutputMessage {
  type: "message"
  id: string
  role: "assistant"
  status: "completed"
  content: ResponseOutputContent[]
}

interface ResponseOutputContent {
  type: "output_text"
  text: string
  annotations: unknown[]
}

interface ResponseOutputFunctionCall {
  type: "function_call"
  id: string
  call_id: string
  name: string
  arguments: string
  status: "completed"
}

interface ResponseToolOutput {
  type: "function"
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

interface ResponseUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

// ─── Streaming Types ───

export interface ResponsesStreamState {
  responseId: string
  model: string
  itemIdCounter: number
  // Text message state
  messageStarted: boolean
  messageItemId: string
  accumulatedText: string
  // Function call state
  functionCalls: Map<number, {
    itemId: string
    name: string
    arguments: string
  }>
  // Output items collected for final response
  outputItems: ResponseOutputItem[]
  // Lifecycle
  createdEmitted: boolean
  finishReason: string | null
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
}

export interface ResponsesEvent {
  type: string
  data: Record<string, unknown>
}

// ─── Request Conversion: Responses → Chat Completions ───

export function translateResponsesToChatCompletions(
  payload: ResponsesPayload,
  model: string,
): ChatCompletionsPayload {
  const messages: Message[] = []

  // System instruction
  if (payload.instructions) {
    messages.push({ role: "system", content: payload.instructions })
  }

  // Convert input
  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input })
  } else if (Array.isArray(payload.input)) {
    convertInputItems(payload.input, messages)
  }

  const result: ChatCompletionsPayload = {
    model,
    messages,
    stream: payload.stream,
  }

  // Map parameters
  if (payload.max_output_tokens != null) {
    result.max_tokens = payload.max_output_tokens
  }
  if (payload.temperature != null) {
    result.temperature = payload.temperature
  }
  if (payload.top_p != null) {
    result.top_p = payload.top_p
  }
  if (payload.parallel_tool_calls != null) {
    result.parallel_tool_calls = payload.parallel_tool_calls
  }

  // Convert tools
  if (payload.tools && payload.tools.length > 0) {
    result.tools = convertTools(payload.tools)
  }

  // Convert tool_choice
  if (payload.tool_choice != null) {
    if (typeof payload.tool_choice === "string") {
      result.tool_choice = payload.tool_choice
    } else if (typeof payload.tool_choice === "object") {
      const tc = payload.tool_choice as { type: string; name?: string }
      if (tc.type === "function" && tc.name) {
        result.tool_choice = { type: "function", function: { name: tc.name } }
      } else {
        result.tool_choice = tc.type // "auto", "required", "none"
      }
    }
  }

  // Reasoning effort — only for models that support it, and not when tools are present
  // (Copilot backend rejects reasoning_effort + tools on /v1/chat/completions)
  // Also skip for models the Copilot backend rejects outright (e.g. claude-haiku-4.5).
  if (
    payload.reasoning?.effort
    && !result.tools
    && !modelRejectsReasoningEffort(result.model)
  ) {
    result.reasoning_effort = payload.reasoning.effort
  }

  return result
}

function convertInputItems(items: ResponseInputItem[], messages: Message[]) {
  // We need to group consecutive function_call items into a single assistant message
  // and consecutive function_call_output items into tool messages
  let pendingToolCalls: ToolCall[] = []

  for (const item of items) {
    switch (item.type) {
      case "message": {
        // Flush any pending tool calls first
        if (pendingToolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: pendingToolCalls,
          })
          pendingToolCalls = []
        }

        const msg = item as ResponseInputMessage
        const content = typeof msg.content === "string"
          ? msg.content
          : msg.content
            ?.filter(b => b.type === "input_text" || b.type === "text" || b.text)
            .map(b => b.text || "")
            .join("") || ""

        if (msg.role === "system") {
          messages.push({ role: "system", content })
        } else if (msg.role === "assistant") {
          messages.push({ role: "assistant", content })
        } else {
          messages.push({ role: "user", content })
        }
        break
      }

      case "function_call": {
        const fc = item as ResponseFunctionCallItem
        pendingToolCalls.push({
          id: fc.call_id,
          type: "function",
          function: {
            name: fc.name,
            arguments: fc.arguments,
          },
        })
        break
      }

      case "function_call_output": {
        // Flush pending tool calls before adding tool results
        if (pendingToolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: pendingToolCalls,
          })
          pendingToolCalls = []
        }

        const fco = item as ResponseFunctionCallOutputItem
        messages.push({
          role: "tool",
          content: fco.output,
          tool_call_id: fco.call_id,
        })
        break
      }
    }
  }

  // Flush remaining tool calls
  if (pendingToolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    })
  }
}

function convertTools(tools: ResponseTool[]): Tool[] {
  return tools
    .filter(t => t.type === "function" && t.name)
    .map(t => ({
      type: "function" as const,
      function: {
        name: t.name!,
        ...(t.description ? { description: t.description } : {}),
        ...(t.parameters ? { parameters: t.parameters as Record<string, unknown> } : {}),
        ...(t.strict != null ? { strict: t.strict } : {}),
      },
    }))
}

// ─── Response Conversion: Chat Completions → Responses (non-streaming) ───

export function translateChatCompletionsToResponses(
  response: ChatCompletionResponse,
  model: string,
  payload: ResponsesPayload,
): ResponsesAPIResponse {
  const choice = response.choices?.[0]
  const message = choice?.message
  const output: ResponseOutputItem[] = []
  let outputText = ""

  if (message) {
    // Text content
    if (message.content) {
      outputText = message.content
      const outputMessage: ResponseOutputMessage = {
        type: "message",
        id: `msg_${generateId()}`,
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: message.content,
          annotations: [],
        }],
      }
      output.push(outputMessage as unknown as ResponseOutputItem)
    }

    // Tool calls
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        const functionCall: ResponseOutputFunctionCall = {
          type: "function_call",
          id: `fc_${generateId()}`,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: "completed",
        }
        output.push(functionCall as unknown as ResponseOutputItem)
      }
    }
  }

  const usage: ResponseUsage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: response.usage?.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: response.usage?.total_tokens ?? 0,
  }

  return {
    id: `resp_${generateId()}`,
    object: "response",
    created_at: response.created || Math.floor(Date.now() / 1000),
    model: response.model || model,
    output,
    output_text: outputText,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: payload.instructions || null,
    metadata: payload.metadata || null,
    parallel_tool_calls: payload.parallel_tool_calls ?? true,
    temperature: payload.temperature ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: convertToolsForResponse(payload.tools),
    top_p: payload.top_p ?? null,
    usage,
  }
}

function convertToolsForResponse(tools?: ResponseTool[] | null): ResponseToolOutput[] {
  if (!tools) return []
  return tools
    .filter(t => t.type === "function" && t.name)
    .map(t => ({
      type: "function" as const,
      name: t.name!,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters as Record<string, unknown> } : {}),
      ...(t.strict != null ? { strict: t.strict } : {}),
    }))
}

// ─── Streaming Conversion: Chat Completions chunks → Responses events ───

export function createStreamState(model: string): ResponsesStreamState {
  return {
    responseId: `resp_${generateId()}`,
    model,
    itemIdCounter: 0,
    messageStarted: false,
    messageItemId: `msg_${generateId()}`,
    accumulatedText: "",
    functionCalls: new Map(),
    outputItems: [],
    createdEmitted: false,
    finishReason: null,
    usage: null,
  }
}

export function translateChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  state: ResponsesStreamState,
  payload: ResponsesPayload,
): ResponsesEvent[] {
  const events: ResponsesEvent[] = []

  // Emit lifecycle events on first chunk
  if (!state.createdEmitted) {
    state.createdEmitted = true
    const baseResponse = buildBaseResponse(state, payload, "in_progress")

    events.push({
      type: "response.created",
      data: { type: "response.created", response: baseResponse, sequence_number: 0 },
    })
    events.push({
      type: "response.in_progress",
      data: { type: "response.in_progress", response: baseResponse, sequence_number: 1 },
    })
  }

  const choice = chunk.choices?.[0]
  if (!choice) {
    // Might be a usage-only chunk
    if (chunk.usage) {
      state.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      }
    }
    return events
  }

  const delta = choice.delta
  const seqBase = events.length + 2 // offset after created+in_progress

  // Handle text content
  if (delta.content != null && delta.content !== "") {
    if (!state.messageStarted) {
      state.messageStarted = true
      const outputIndex = state.outputItems.length

      // output_item.added
      events.push({
        type: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            type: "message",
            id: state.messageItemId,
            role: "assistant",
            status: "in_progress",
            content: [],
          },
          sequence_number: seqBase,
        },
      })

      // content_part.added
      events.push({
        type: "response.content_part.added",
        data: {
          type: "response.content_part.added",
          item_id: state.messageItemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
          sequence_number: seqBase + 1,
        },
      })
    }

    state.accumulatedText += delta.content

    events.push({
      type: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        item_id: state.messageItemId,
        output_index: state.outputItems.length,
        content_index: 0,
        delta: delta.content,
        sequence_number: seqBase + 2,
      },
    })
  }

  // Handle tool calls
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index
      let fcState = state.functionCalls.get(idx)

      if (!fcState) {
        // New function call
        const itemId = `fc_${generateId()}`
        fcState = {
          itemId,
          name: tc.function?.name || "",
          arguments: "",
        }
        state.functionCalls.set(idx, fcState)

        const outputIndex = state.outputItems.length + state.functionCalls.size - 1 +
          (state.messageStarted ? 1 : 0)

        events.push({
          type: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: fcState.itemId,
              call_id: tc.id || fcState.itemId,
              name: fcState.name,
              arguments: "",
              status: "in_progress",
            },
            sequence_number: seqBase + 3,
          },
        })
      }

      if (tc.function?.name) {
        fcState.name = tc.function.name
      }

      if (tc.function?.arguments) {
        fcState.arguments += tc.function.arguments
        const outputIndex = state.outputItems.length + idx +
          (state.messageStarted ? 1 : 0)

        events.push({
          type: "response.function_call_arguments.delta",
          data: {
            type: "response.function_call_arguments.delta",
            item_id: fcState.itemId,
            output_index: outputIndex,
            delta: tc.function.arguments,
            sequence_number: seqBase + 4,
          },
        })
      }
    }
  }

  // Handle finish
  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason

    if (chunk.usage) {
      state.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      }
    }

    const finishEvents = buildFinishEvents(state, payload)
    events.push(...finishEvents)
  }

  return events
}

function buildFinishEvents(
  state: ResponsesStreamState,
  payload: ResponsesPayload,
): ResponsesEvent[] {
  const events: ResponsesEvent[] = []
  let seq = 100

  // Close text message if started
  if (state.messageStarted) {
    const outputIndex = 0

    events.push({
      type: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        item_id: state.messageItemId,
        output_index: outputIndex,
        content_index: 0,
        text: state.accumulatedText,
        sequence_number: seq++,
      },
    })

    events.push({
      type: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        item_id: state.messageItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: state.accumulatedText, annotations: [] },
        sequence_number: seq++,
      },
    })

    events.push({
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          type: "message",
          id: state.messageItemId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: state.accumulatedText, annotations: [] }],
        },
        sequence_number: seq++,
      },
    })
  }

  // Close function calls
  for (const [idx, fc] of state.functionCalls) {
    const outputIndex = idx + (state.messageStarted ? 1 : 0)

    events.push({
      type: "response.function_call_arguments.done",
      data: {
        type: "response.function_call_arguments.done",
        item_id: fc.itemId,
        output_index: outputIndex,
        arguments: fc.arguments,
        name: fc.name,
        sequence_number: seq++,
      },
    })

    events.push({
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: {
          type: "function_call",
          id: fc.itemId,
          call_id: fc.itemId,
          name: fc.name,
          arguments: fc.arguments,
          status: "completed",
        },
        sequence_number: seq++,
      },
    })
  }

  // response.completed
  const usage: ResponseUsage = {
    input_tokens: state.usage?.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: state.usage?.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: state.usage?.total_tokens ?? 0,
  }

  const finalResponse = buildBaseResponse(state, payload, "completed")
  finalResponse.usage = usage
  finalResponse.output_text = state.accumulatedText

  // Build output array for final response
  const output: unknown[] = []
  if (state.messageStarted) {
    output.push({
      type: "message",
      id: state.messageItemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: state.accumulatedText, annotations: [] }],
    })
  }
  for (const [, fc] of state.functionCalls) {
    output.push({
      type: "function_call",
      id: fc.itemId,
      call_id: fc.itemId,
      name: fc.name,
      arguments: fc.arguments,
      status: "completed",
    })
  }
  finalResponse.output = output as ResponseOutputItem[]

  events.push({
    type: "response.completed",
    data: { type: "response.completed", response: finalResponse, sequence_number: seq },
  })

  return events
}

function buildBaseResponse(
  state: ResponsesStreamState,
  payload: ResponsesPayload,
  status: "in_progress" | "completed",
): ResponsesAPIResponse {
  return {
    id: state.responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: state.model,
    output: [],
    output_text: "",
    status,
    error: null,
    incomplete_details: null,
    instructions: payload.instructions || null,
    metadata: payload.metadata || null,
    parallel_tool_calls: payload.parallel_tool_calls ?? true,
    temperature: payload.temperature ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: convertToolsForResponse(payload.tools),
    top_p: payload.top_p ?? null,
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  }
}

// ─── Helpers ───

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24)
}

// Models the upstream Copilot backend rejects when reasoning_effort is set.
function modelRejectsReasoningEffort(model: string): boolean {
  // Claude Haiku 4.5 (and dated variants like claude-haiku-4-5-20251001)
  return /claude-haiku-4[-.]5/i.test(model)
}
