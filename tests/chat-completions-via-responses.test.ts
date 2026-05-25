import { describe, test, expect } from "bun:test"

import {
  createResponsesToChatCompletionsState,
  createResponsesToChatCompletionsStream,
  translateChatCompletionsToResponsesRequest,
  translateResponsesEventToChatCompletionsChunks,
  translateResponsesToChatCompletionsResponse,
} from "~/translators/chat-completions-via-responses"

describe("chat-completions-via-responses request", () => {
  test("hoists leading system message into instructions", () => {
    const out = translateChatCompletionsToResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    })
    expect(out.instructions).toBe("be brief")
    expect(out.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ])
  })

  test("maps assistant tool_calls into function_call items", () => {
    const out = translateChatCompletionsToResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    })
    expect(out.input).toEqual([
      { type: "message", role: "user", content: "search" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"x"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ])
  })

  test("maps tools, tool_choice, and reasoning_effort", () => {
    const out = translateChatCompletionsToResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          function: { name: "f", parameters: { type: "object", properties: {} } },
        },
      ],
      tool_choice: { type: "function", function: { name: "f" } },
      // @ts-expect-error - extended field validated at runtime
      reasoning_effort: "medium",
    })
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "f",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
    expect(out.tool_choice).toEqual({ type: "function", name: "f" })
    expect(out.reasoning?.effort).toBe("medium")
  })
})

describe("chat-completions-via-responses events", () => {
  test("response.created emits role:assistant chunk seeded with id/model", () => {
    const state = createResponsesToChatCompletionsState()
    const out = translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "resp_x", model: "gpt-5" } },
      state,
    )
    expect(out).not.toBe("DONE")
    const chunks = out as ReturnType<typeof translateResponsesEventToChatCompletionsChunks> extends "DONE" ? never : Array<{ id: string; model: string; choices: Array<{ delta: { role?: string } }> }>
    expect((chunks as any).length).toBe(1)
    expect((chunks as any)[0].id).toBe("resp_x")
    expect((chunks as any)[0].model).toBe("gpt-5")
    expect((chunks as any)[0].choices[0].delta.role).toBe("assistant")
    expect(state.messageId).toBe("resp_x")
  })

  test("output_item.added for function_call seeds tool_calls delta", () => {
    const state = createResponsesToChatCompletionsState("gpt-5")
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    const out = translateResponsesEventToChatCompletionsChunks(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" },
      },
      state,
    ) as any[]
    expect(out[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "" },
      },
    ])
    expect(state.functionCallIndices.get(0)).toBe(0)
    expect(state.hasFunctionCalls).toBe(true)
  })

  test("output_text.delta emits content", () => {
    const state = createResponsesToChatCompletionsState()
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    const out = translateResponsesEventToChatCompletionsChunks(
      { type: "response.output_text.delta", delta: "Hello", output_index: 0 },
      state,
    ) as any[]
    expect(out[0].choices[0].delta.content).toBe("Hello")
  })

  test("reasoning_summary_text.delta projects as reasoning_text only for first output_index", () => {
    const state = createResponsesToChatCompletionsState()
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    const first = translateResponsesEventToChatCompletionsChunks(
      { type: "response.reasoning_summary_text.delta", delta: "thinking…", output_index: 0 },
      state,
    ) as any[]
    expect(first[0].choices[0].delta.reasoning_text).toBe("thinking…")
    const second = translateResponsesEventToChatCompletionsChunks(
      { type: "response.reasoning_summary_text.delta", delta: "more", output_index: 1 },
      state,
    ) as any[]
    expect(second).toEqual([])
  })

  test("function_call_arguments.delta accumulates by output_index", () => {
    const state = createResponsesToChatCompletionsState()
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    translateResponsesEventToChatCompletionsChunks(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "c1", name: "f" },
      },
      state,
    )
    const out = translateResponsesEventToChatCompletionsChunks(
      { type: "response.function_call_arguments.delta", delta: '{"a"', output_index: 0 },
      state,
    ) as any[]
    expect(out[0].choices[0].delta.tool_calls).toEqual([
      { index: 0, function: { arguments: '{"a"' } },
    ])
  })

  test("response.completed emits finish chunk + usage chunk", () => {
    const state = createResponsesToChatCompletionsState()
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    const out = translateResponsesEventToChatCompletionsChunks(
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            input_tokens_details: { cached_tokens: 5 },
          },
          status: "completed",
          output: [],
        },
      },
      state,
    ) as any[]
    expect(out[0].choices[0].finish_reason).toBe("stop")
    expect(out[1].usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 5 },
    })
    expect(state.terminated).toBe(true)
  })

  test("response.completed with function_call → finish_reason tool_calls", () => {
    const state = createResponsesToChatCompletionsState()
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    translateResponsesEventToChatCompletionsChunks(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "c", name: "f" },
      },
      state,
    )
    const out = translateResponsesEventToChatCompletionsChunks(
      {
        type: "response.completed",
        response: { status: "completed", output: [{ type: "function_call" }] },
      },
      state,
    ) as any[]
    expect(out[0].choices[0].finish_reason).toBe("tool_calls")
  })

  test("response.incomplete + max_output_tokens → length", () => {
    const state = createResponsesToChatCompletionsState()
    translateResponsesEventToChatCompletionsChunks(
      { type: "response.created", response: { id: "r", model: "gpt-5" } },
      state,
    )
    const out = translateResponsesEventToChatCompletionsChunks(
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      },
      state,
    ) as any[]
    expect(out[0].choices[0].finish_reason).toBe("length")
  })
})

describe("chat-completions-via-responses stream end-to-end", () => {
  async function pipeAndCollect(events: string[]): Promise<string> {
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder()
        for (const e of events) c.enqueue(enc.encode(e))
        c.close()
      },
    })
    const out = input.pipeThrough(createResponsesToChatCompletionsStream("gpt-5"))
    const reader = out.getReader()
    const dec = new TextDecoder()
    let text = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += dec.decode(value)
    }
    return text
  }

  test("end-to-end created → text delta → completed produces Chat chunks + [DONE]", async () => {
    const text = await pipeAndCollect([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-5" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi", output_index: 0 })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      })}\n\n`,
    ])
    expect(text).toContain('"role":"assistant"')
    expect(text).toContain('"content":"Hi"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('"prompt_tokens":1')
    expect(text).toContain("data: [DONE]")
  })

  test("truncated stream synthesizes finish + [DONE] + diagnostic SSE comment", async () => {
    const text = await pipeAndCollect([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-5" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x", output_index: 0 })}\n\n`,
    ])
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
    expect(text).toContain("Upstream Responses stream ended")
  })
})

describe("chat-completions-via-responses response (non-streaming)", () => {
  test("translates text-only response", () => {
    const out = translateResponsesToChatCompletionsResponse(
      {
        id: "resp_1",
        model: "gpt-5",
        created_at: 1700,
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
          input_tokens_details: { cached_tokens: 2 },
        },
      },
      "gpt-5",
    )
    expect(out.id).toBe("resp_1")
    expect(out.choices[0].message.content).toBe("hello")
    expect(out.choices[0].finish_reason).toBe("stop")
    expect(out.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      prompt_tokens_details: { cached_tokens: 2 },
    })
  })

  test("translates function_call → tool_calls + finish_reason tool_calls", () => {
    const out = translateResponsesToChatCompletionsResponse(
      {
        id: "resp_2",
        model: "gpt-5",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"q":"x"}',
          },
        ],
      },
      "gpt-5",
    )
    expect(out.choices[0].finish_reason).toBe("tool_calls")
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"x"}' },
      },
    ])
  })

  test("max_output_tokens → finish_reason length", () => {
    const out = translateResponsesToChatCompletionsResponse(
      {
        id: "resp_3",
        model: "gpt-5",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "message", content: [{ type: "output_text", text: "trunc" }] },
        ],
      },
      "gpt-5",
    )
    expect(out.choices[0].finish_reason).toBe("length")
  })
})
