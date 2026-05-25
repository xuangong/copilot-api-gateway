import { test, expect, describe } from "bun:test"
import {
  createMessagesToChatCompletionsState,
  createMessagesToChatCompletionsStream,
  translateMessagesEventToChatCompletionsChunks,
} from "~/translators/chat-completions-via-messages"

const MSG_START = {
  type: "message_start" as const,
  message: {
    id: "msg_abc",
    model: "claude-test",
    usage: { input_tokens: 10, cache_read_input_tokens: 2 },
  },
}

describe("translateMessagesEventToChatCompletionsChunks", () => {
  test("message_start emits role chunk and seeds prompt tokens", () => {
    const state = createMessagesToChatCompletionsState("fallback-model")
    const out = translateMessagesEventToChatCompletionsChunks(MSG_START, state)
    expect(Array.isArray(out)).toBe(true)
    if (out === "DONE") throw new Error("unexpected DONE")
    expect(out).toHaveLength(1)
    expect(out[0].choices[0].delta.role).toBe("assistant")
    expect(out[0].id).toBe("msg_abc")
    expect(out[0].model).toBe("claude-test")
    expect(state.promptTokens).toBe(12)
    expect(state.cachedPromptTokens).toBe(2)
  })

  test("text content lifecycle", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)

    const start = translateMessagesEventToChatCompletionsChunks(
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      state,
    )
    expect(start).toEqual([])

    const delta = translateMessagesEventToChatCompletionsChunks(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      state,
    )
    if (delta === "DONE") throw new Error()
    expect(delta[0].choices[0].delta.content).toBe("hi")

    const stop = translateMessagesEventToChatCompletionsChunks(
      { type: "content_block_stop", index: 0 },
      state,
    )
    expect(stop).toEqual([])
  })

  test("tool_use lifecycle emits id + name then arg deltas", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)

    const start = translateMessagesEventToChatCompletionsChunks(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "search" },
      },
      state,
    )
    if (start === "DONE") throw new Error()
    expect(start[0].choices[0].delta.tool_calls?.[0].id).toBe("tu_1")
    expect(start[0].choices[0].delta.tool_calls?.[0].function?.name).toBe("search")
    expect(start[0].choices[0].delta.tool_calls?.[0].index).toBe(0)

    const argDelta = translateMessagesEventToChatCompletionsChunks(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      },
      state,
    )
    if (argDelta === "DONE") throw new Error()
    expect(argDelta[0].choices[0].delta.tool_calls?.[0].function?.arguments).toBe('{"q":')
    expect(argDelta[0].choices[0].delta.tool_calls?.[0].index).toBe(0)
  })

  test("thinking deltas map to reasoning_text", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)
    translateMessagesEventToChatCompletionsChunks(
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      state,
    )
    const out = translateMessagesEventToChatCompletionsChunks(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "step 1" },
      },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out[0].choices[0].delta.reasoning_text).toBe("step 1")
  })

  test("message_delta emits finish chunk + usage chunk", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)
    const out = translateMessagesEventToChatCompletionsChunks(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out).toHaveLength(2)
    expect(out[0].choices[0].finish_reason).toBe("stop")
    expect(out[1].usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 2 },
    })
  })

  test("max_tokens stop_reason maps to length", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)
    const out = translateMessagesEventToChatCompletionsChunks(
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 5 },
      },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out[0].choices[0].finish_reason).toBe("length")
  })

  test("tool_use stop_reason maps to tool_calls", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)
    const out = translateMessagesEventToChatCompletionsChunks(
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out[0].choices[0].finish_reason).toBe("tool_calls")
  })

  test("message_stop returns DONE sentinel and terminates state", () => {
    const state = createMessagesToChatCompletionsState()
    translateMessagesEventToChatCompletionsChunks(MSG_START, state)
    const out = translateMessagesEventToChatCompletionsChunks(
      { type: "message_stop" },
      state,
    )
    expect(out).toBe("DONE")
    expect(state.terminated).toBe(true)
    // Subsequent events drop
    const after = translateMessagesEventToChatCompletionsChunks(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      state,
    )
    expect(after).toEqual([])
  })
})

describe("createMessagesToChatCompletionsStream", () => {
  async function pipe(input: string): Promise<string> {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(input))
        c.close()
      },
    })
    const out = stream.pipeThrough(createMessagesToChatCompletionsStream("claude-test"))
    const chunks: Uint8Array[] = []
    const reader = out.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return chunks.map((c) => new TextDecoder().decode(c)).join("")
  }

  test("end-to-end SSE translation produces [DONE]", async () => {
    const input =
      `event: message_start\ndata: ${JSON.stringify(MSG_START)}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`

    const got = await pipe(input)
    expect(got).toContain('"delta":{"role":"assistant"}')
    expect(got).toContain('"content":"hello"')
    expect(got).toContain('"finish_reason":"stop"')
    expect(got).toContain('"completion_tokens":1')
    expect(got).toContain("data: [DONE]")
  })

  test("truncated stream synthesizes finish + DONE", async () => {
    const input =
      `event: message_start\ndata: ${JSON.stringify(MSG_START)}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      })}\n\n`
    const got = await pipe(input)
    expect(got).toContain('"finish_reason":"stop"')
    expect(got).toContain("data: [DONE]")
    expect(got).toContain("Upstream Messages stream ended")
  })
})

import { translateMessagesToChatCompletionsResponse } from "~/translators/chat-completions-via-messages"

describe("translateMessagesToChatCompletionsResponse", () => {
  test("collapses text content + usage", () => {
    const out = translateMessagesToChatCompletionsResponse({
      id: "msg_1",
      model: "claude-test",
      content: [{ type: "text", text: "hi " }, { type: "text", text: "world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 1 },
    })
    expect(out.choices[0].message.content).toBe("hi world")
    expect(out.choices[0].finish_reason).toBe("stop")
    expect(out.usage.prompt_tokens).toBe(6)
    expect(out.usage.completion_tokens).toBe(3)
    expect(out.usage.total_tokens).toBe(9)
    expect(out.usage.prompt_tokens_details?.cached_tokens).toBe(1)
  })

  test("tool_use becomes tool_calls with JSON-stringified args", () => {
    const out = translateMessagesToChatCompletionsResponse({
      id: "msg_2",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "search",
          input: { q: "hi" },
        },
      ],
      stop_reason: "tool_use",
    })
    expect(out.choices[0].finish_reason).toBe("tool_calls")
    expect(out.choices[0].message.content).toBeNull()
    expect(out.choices[0].message.tool_calls?.[0].function.name).toBe("search")
    expect(out.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"q":"hi"}')
  })

  test("thinking blocks surface as reasoning_text", () => {
    const out = translateMessagesToChatCompletionsResponse({
      id: "msg_3",
      model: "claude-test",
      content: [{ type: "thinking", thinking: "ponder" }, { type: "text", text: "ok" }],
    })
    expect(out.choices[0].message.reasoning_text).toBe("ponder")
    expect(out.choices[0].message.content).toBe("ok")
  })

  test("max_tokens stop_reason maps to length", () => {
    const out = translateMessagesToChatCompletionsResponse({
      id: "msg_4",
      model: "claude-test",
      content: [{ type: "text", text: "..." }],
      stop_reason: "max_tokens",
    })
    expect(out.choices[0].finish_reason).toBe("length")
  })
})
