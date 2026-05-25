import { test, expect, describe } from "bun:test"
import {
  createMessagesToResponsesState,
  translateMessagesEventToResponsesEvents,
  createMessagesToResponsesStream,
} from "../src/translators/responses-via-messages/events"
import { translateResponsesToMessages } from "../src/translators/responses-via-messages/request"
import { translateMessagesToResponsesResponse } from "../src/translators/responses-via-messages/response"

describe("Responses → Messages request translator", () => {
  test("string input → single user message", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-opus-4-7",
      input: "hi",
    } as any)
    expect(target.model).toBe("claude-opus-4-7")
    expect(target.messages).toEqual([{ role: "user", content: "hi" }])
    expect(target.max_tokens).toBe(8192)
    expect(target.stream).toBe(true)
  })

  test("system/developer roles aggregate into system text", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-x",
      instructions: "global instr",
      input: [
        { type: "message", role: "system", content: "be helpful" },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "dev hint" }] },
        { type: "message", role: "user", content: "hello" },
      ],
    } as any)
    expect(target.system).toBe("global instr\n\nbe helpful\n\ndev hint")
    expect(target.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ])
  })

  test("function_call + function_call_output map to tool_use + tool_result", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-x",
      input: [
        { type: "message", role: "user", content: "do it" },
        { type: "function_call", id: "fc_1", call_id: "call_42", name: "fn", arguments: '{"q":1}' },
        { type: "function_call_output", call_id: "call_42", output: "42" },
      ],
    } as any)
    expect(target.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_42", name: "fn", input: { q: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_42", content: "42" }],
      },
    ])
  })

  test("tool_choice + temperature + top_p pass through", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-x",
      input: "go",
      tool_choice: "required",
      temperature: 0.5,
      top_p: 0.9,
      tools: [{ type: "function", name: "fn", description: "d", parameters: { type: "object" } }],
    } as any)
    const extras = target as unknown as Record<string, unknown>
    expect(extras.tool_choice).toEqual({ type: "any" })
    expect(extras.temperature).toBe(0.5)
    expect(extras.top_p).toBe(0.9)
    expect(target.tools).toEqual([
      { name: "fn", description: "d", input_schema: { type: "object" } },
    ])
  })

  test("reasoning effort → output_config.effort", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-x",
      input: "go",
      reasoning: { effort: "high" },
    } as any)
    expect(target.output_config).toEqual({ effort: "high" })
  })
})

describe("Anthropic Messages → Responses event translator", () => {
  test("message_start emits response.created + response.in_progress", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    const out = translateMessagesEventToResponsesEvents(
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-x",
          usage: { input_tokens: 50, cache_read_input_tokens: 10 },
        },
      } as any,
      state,
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      type: "response.created",
      response: {
        id: "resp_1",
        model: "claude-x",
        status: "in_progress",
        usage: { input_tokens: 60, output_tokens: 0, input_tokens_details: { cached_tokens: 10 } },
      },
    })
    expect(out[1].type).toBe("response.in_progress")
  })

  test("text block emits item.added → content_part.added → delta → done", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    const start = translateMessagesEventToResponsesEvents(
      { type: "content_block_start", index: 0, content_block: { type: "text" } } as any,
      state,
    )
    expect(start).toMatchObject([
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    ])
    const delta = translateMessagesEventToResponsesEvents(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } as any,
      state,
    )
    expect(delta).toMatchObject([{ type: "response.output_text.delta", delta: "Hi" }])
    const stop = translateMessagesEventToResponsesEvents(
      { type: "content_block_stop", index: 0 } as any,
      state,
    )
    expect(stop).toMatchObject([
      { type: "response.output_text.done", text: "Hi" },
      { type: "response.content_part.done" },
      {
        type: "response.output_item.done",
        item: { type: "message", content: [{ type: "output_text", text: "Hi" }] },
      },
    ])
  })

  test("tool_use block emits function_call item + args delta + done", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    translateMessagesEventToResponsesEvents(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "fn" },
      } as any,
      state,
    )
    const delta = translateMessagesEventToResponsesEvents(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"a":' },
      } as any,
      state,
    )
    expect(delta).toMatchObject([
      { type: "response.function_call_arguments.delta", delta: '{"a":' },
    ])
    const stop = translateMessagesEventToResponsesEvents(
      { type: "content_block_stop", index: 0 } as any,
      state,
    )
    expect(stop).toMatchObject([
      { type: "response.function_call_arguments.done", arguments: '{"a":' },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "fn", arguments: '{"a":' },
      },
    ])
  })

  test("thinking block emits reasoning_summary events", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    translateMessagesEventToResponsesEvents(
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } } as any,
      state,
    )
    const delta = translateMessagesEventToResponsesEvents(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ponder" },
      } as any,
      state,
    )
    expect(delta).toMatchObject([
      { type: "response.reasoning_summary_text.delta", delta: "ponder" },
    ])
    const stop = translateMessagesEventToResponsesEvents(
      { type: "content_block_stop", index: 0 } as any,
      state,
    )
    expect(stop[0]).toMatchObject({
      type: "response.reasoning_summary_text.done",
      text: "ponder",
    })
  })

  test("message_delta sets stop_reason+output_tokens; message_stop emits response.completed", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    translateMessagesEventToResponsesEvents(
      {
        type: "message_start",
        message: { id: "msg", model: "claude-x", usage: { input_tokens: 20 } },
      } as any,
      state,
    )
    translateMessagesEventToResponsesEvents(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      } as any,
      state,
    )
    const stop = translateMessagesEventToResponsesEvents(
      { type: "message_stop" } as any,
      state,
    )
    expect(stop[0]).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      },
    })
  })

  test("max_tokens stop_reason → response.incomplete", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    translateMessagesEventToResponsesEvents(
      {
        type: "message_start",
        message: { id: "msg", model: "claude-x", usage: { input_tokens: 10 } },
      } as any,
      state,
    )
    translateMessagesEventToResponsesEvents(
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2 } } as any,
      state,
    )
    const stop = translateMessagesEventToResponsesEvents({ type: "message_stop" } as any, state)
    expect(stop[0]).toMatchObject({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    })
  })

  test("error event emits Responses error event", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    const out = translateMessagesEventToResponsesEvents(
      { type: "error", error: { type: "api_error", message: "boom" } } as any,
      state,
    )
    expect(out).toMatchObject([{ type: "error", message: "boom", code: "api_error" }])
  })

  test("events after terminated are dropped", () => {
    const state = createMessagesToResponsesState("resp_1", "claude-x")
    translateMessagesEventToResponsesEvents({ type: "message_stop" } as any, state)
    const out = translateMessagesEventToResponsesEvents(
      { type: "content_block_start", index: 0, content_block: { type: "text" } } as any,
      state,
    )
    expect(out).toEqual([])
  })
})

describe("Messages → Responses non-streaming JSON translator", () => {
  test("collapses content[] into output[] items", () => {
    const result = translateMessagesToResponsesResponse({
      id: "msg_x",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "thinking", thinking: "ponder" },
        { type: "text", text: "Hello!" },
        { type: "tool_use", id: "call_1", name: "fn", input: { a: 1 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 },
    })
    expect(result.output).toEqual([
      {
        type: "reasoning",
        id: "rs_0",
        summary: [{ type: "summary_text", text: "ponder" }],
      },
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello!" }],
      },
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_1",
        name: "fn",
        arguments: '{"a":1}',
        status: "completed",
      },
    ])
    expect(result.output_text).toBe("Hello!")
    expect(result.status).toBe("completed")
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 30 },
    })
  })

  test("max_tokens stop_reason → incomplete status", () => {
    const result = translateMessagesToResponsesResponse({
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 1 },
    })
    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" })
  })

  test("raw_arguments preserved when tool input was malformed", () => {
    const result = translateMessagesToResponsesResponse({
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "tool_use", id: "c1", name: "fn", input: { raw_arguments: "not json" } },
      ],
      usage: {},
    })
    expect(result.output[0]).toMatchObject({
      type: "function_call",
      call_id: "c1",
      arguments: "not json",
    })
  })
})

describe("createMessagesToResponsesStream (TransformStream)", () => {
  async function pipe(events: object[], model = "claude-x"): Promise<string> {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(encoder.encode(`event: ${(ev as any).type}\ndata: ${JSON.stringify(ev)}\n\n`))
        }
        controller.close()
      },
    })
    const out = input.pipeThrough(createMessagesToResponsesStream(model, "resp_test"))
    const reader = out.getReader()
    let s = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      s += decoder.decode(value, { stream: true })
    }
    s += decoder.decode()
    return s
  }

  test("end-to-end pipe produces Responses SSE frames", async () => {
    const out = await pipe([
      {
        type: "message_start",
        message: { id: "msg", model: "claude-x", usage: { input_tokens: 10 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ])
    expect(out).toContain("event: response.created")
    expect(out).toContain("event: response.output_item.added")
    expect(out).toContain('"delta":"Hi"')
    expect(out).toContain("event: response.output_item.done")
    expect(out).toContain("event: response.completed")
  })

  test("upstream early termination emits synthetic error event", async () => {
    const out = await pipe([
      {
        type: "message_start",
        message: { id: "msg", model: "claude-x", usage: { input_tokens: 1 } },
      },
      // no message_stop
    ])
    expect(out).toContain("event: error")
    expect(out).toContain("without a message_stop event")
  })
})
