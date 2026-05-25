import { test, expect, describe } from "bun:test"
import {
  createResponsesToMessagesState,
  translateResponsesEventToMessagesEvents,
  createResponsesToMessagesStream,
} from "../src/translators/messages-via-responses/events"
import { translateResponsesToMessagesResponse } from "../src/translators/messages-via-responses/response"

describe("Responses → Messages event translator", () => {
  test("response.created emits message_start with usage", () => {
    const state = createResponsesToMessagesState()
    const out = translateResponsesEventToMessagesEvents(
      {
        type: "response.created",
        response: {
          id: "resp_1",
          model: "gpt-5.4",
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 30 } },
        },
      } as any,
      state,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: "message_start",
      message: {
        id: "resp_1",
        model: "gpt-5.4",
        usage: { input_tokens: 70, output_tokens: 0, cache_read_input_tokens: 30 },
      },
    })
  })

  test("text delta opens content_block then emits text_delta", () => {
    const state = createResponsesToMessagesState()
    const out = translateResponsesEventToMessagesEvents(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" } as any,
      state,
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: "content_block_start", index: 0, content_block: { type: "text" } })
    expect(out[1]).toMatchObject({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })

    const out2 = translateResponsesEventToMessagesEvents(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: " world" } as any,
      state,
    )
    expect(out2).toHaveLength(1)
    expect(out2[0]).toMatchObject({ type: "content_block_delta", index: 0, delta: { text: " world" } })
  })

  test("function_call.added then args delta emit tool_use + input_json_delta", () => {
    const state = createResponsesToMessagesState()
    const added = translateResponsesEventToMessagesEvents(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_42", name: "get_weather", arguments: "" },
      } as any,
      state,
    )
    expect(added).toMatchObject([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_42", name: "get_weather" } },
    ])

    const delta = translateResponsesEventToMessagesEvents(
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"city":' } as any,
      state,
    )
    expect(delta).toMatchObject([{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }])

    const done = translateResponsesEventToMessagesEvents(
      { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"city":"SF"}' } as any,
      state,
    )
    // emittedAnyArguments=true already, so done should not re-emit
    expect(done).toEqual([])
  })

  test("function_call without intermediate delta uses .done to emit args once", () => {
    const state = createResponsesToMessagesState()
    translateResponsesEventToMessagesEvents(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "c1", name: "fn", arguments: "" },
      } as any,
      state,
    )
    const done = translateResponsesEventToMessagesEvents(
      { type: "response.function_call_arguments.done", output_index: 0, arguments: "{}" } as any,
      state,
    )
    expect(done).toMatchObject([{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }])
  })

  test("response.completed closes blocks and emits message_delta + message_stop", () => {
    const state = createResponsesToMessagesState()
    translateResponsesEventToMessagesEvents(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" } as any,
      state,
    )
    const out = translateResponsesEventToMessagesEvents(
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "message" }],
          usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } },
        },
      } as any,
      state,
    )
    expect(out).toMatchObject([
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 10 } },
      { type: "message_stop" },
    ])
    expect(state.messageCompleted).toBe(true)
  })

  test("completed with function_call output → stop_reason: tool_use", () => {
    const state = createResponsesToMessagesState()
    const out = translateResponsesEventToMessagesEvents(
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "function_call", call_id: "c1", name: "fn", arguments: "{}" }],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      } as any,
      state,
    )
    expect(out.find((e: any) => e.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
    })
  })

  test("incomplete due to max_output_tokens → stop_reason: max_tokens", () => {
    const state = createResponsesToMessagesState()
    const out = translateResponsesEventToMessagesEvents(
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
      } as any,
      state,
    )
    expect(out.find((e: any) => e.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "max_tokens" },
    })
  })

  test("events after messageCompleted are dropped", () => {
    const state = createResponsesToMessagesState()
    translateResponsesEventToMessagesEvents(
      { type: "response.completed", response: { status: "completed", output: [], usage: {} } } as any,
      state,
    )
    const out = translateResponsesEventToMessagesEvents(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "extra" } as any,
      state,
    )
    expect(out).toEqual([])
  })

  test("error event closes open blocks and emits Anthropic error", () => {
    const state = createResponsesToMessagesState()
    translateResponsesEventToMessagesEvents(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "x" } as any,
      state,
    )
    const out = translateResponsesEventToMessagesEvents({ type: "error", message: "boom" } as any, state)
    expect(out).toMatchObject([
      { type: "content_block_stop" },
      { type: "error", error: { type: "api_error", message: "boom" } },
    ])
  })
})

describe("Responses → Messages non-streaming JSON translator", () => {
  test("collapses output[] into Anthropic content blocks", () => {
    const result = translateResponsesToMessagesResponse({
      id: "resp_x",
      model: "gpt-5.4",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ text: "thinking deeply" }] },
        { type: "message", content: [{ type: "output_text", text: "Hello!" }] },
        { type: "function_call", call_id: "c1", name: "fn", arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
    })
    expect(result.content).toEqual([
      { type: "thinking", thinking: "thinking deeply" },
      { type: "text", text: "Hello!" },
      { type: "tool_use", id: "c1", name: "fn", input: { a: 1 } },
    ])
    expect(result.stop_reason).toBe("tool_use")
    expect(result.usage).toEqual({ input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 })
  })

  test("falls back to output_text when output[] is empty", () => {
    const result = translateResponsesToMessagesResponse({
      id: "r1",
      model: "gpt-5.4",
      status: "completed",
      output: [],
      output_text: "plain text",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(result.content).toEqual([{ type: "text", text: "plain text" }])
    expect(result.stop_reason).toBe("end_turn")
  })

  test("malformed tool arguments are preserved under raw_arguments", () => {
    const result = translateResponsesToMessagesResponse({
      id: "r",
      model: "m",
      status: "completed",
      output: [{ type: "function_call", call_id: "c", name: "fn", arguments: "not json" }],
      usage: {},
    })
    expect(result.content[0]).toMatchObject({ type: "tool_use", input: { raw_arguments: "not json" } })
  })
})

describe("createResponsesToMessagesStream (TransformStream)", () => {
  async function pipe(events: object[]): Promise<string> {
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
    const transformed = input.pipeThrough(createResponsesToMessagesStream())
    const reader = transformed.getReader()
    let out = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
    return out
  }

  test("end-to-end pipe produces Anthropic SSE frames", async () => {
    const out = await pipe([
      {
        type: "response.created",
        response: { id: "r1", model: "gpt-5.4", usage: { input_tokens: 10 } },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ type: "message" }], usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ])
    expect(out).toContain("event: message_start")
    expect(out).toContain("event: content_block_start")
    expect(out).toContain('"text":"Hi"')
    expect(out).toContain("event: content_block_stop")
    expect(out).toContain("event: message_delta")
    expect(out).toContain("event: message_stop")
  })

  test("upstream early termination emits synthetic error event", async () => {
    const out = await pipe([
      { type: "response.created", response: { id: "r1", model: "gpt-5.4" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "abc" },
      // no completion
    ])
    expect(out).toContain("event: error")
    expect(out).toContain("Upstream stream ended without completion")
  })
})
