import { test, expect, describe } from "bun:test"
import {
  createChatCompletionsToMessagesState,
  createChatCompletionsToMessagesStream,
  translateChatCompletionsChunkToMessagesEvents,
  translateChatCompletionsToMessagesResponse,
  translateMessagesToChatCompletions,
} from "~/translators/messages-via-chat-completions"
import type { AnthropicMessagesPayload } from "~/transforms/types"

describe("translateMessagesToChatCompletions (request)", () => {
  test("system string + user text + assistant text → role-tagged messages", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-4",
      max_tokens: 100,
      system: "be brief",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "ok" },
      ],
    } as AnthropicMessagesPayload
    const out = translateMessagesToChatCompletions(payload)
    expect(out.model).toBe("gpt-4")
    expect(out.messages[0]).toEqual({ role: "system", content: "be brief" })
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" })
    expect(out.messages[2]).toEqual({ role: "assistant", content: "hello" })
    expect(out.messages[3]).toEqual({ role: "user", content: "ok" })
  })

  test("tool_result blocks become role:'tool' messages with tool_call_id", () => {
    const payload = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "found" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload
    const out = translateMessagesToChatCompletions(payload)
    expect(out.messages[0].role).toBe("assistant")
    expect(out.messages[0].tool_calls?.[0].id).toBe("tu_1")
    expect(out.messages[0].tool_calls?.[0].function.name).toBe("search")
    expect(out.messages[0].tool_calls?.[0].function.arguments).toBe('{"q":"x"}')
    expect(out.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "found",
    })
    expect(out.messages[2]).toEqual({ role: "user", content: "thanks" })
  })

  test("image blocks become ContentPart[] with data URL", () => {
    const payload = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAA" },
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload
    const out = translateMessagesToChatCompletions(payload)
    const content = out.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) throw new Error()
    expect(content[0]).toEqual({ type: "text", text: "what is this" })
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    })
  })

  test("tools and tool_choice translate", () => {
    const payload = {
      model: "gpt-4",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "search", description: "search the web", input_schema: { type: "object", properties: { q: { type: "string" } } } },
      ],
      tool_choice: { type: "tool", name: "search" },
    } as unknown as AnthropicMessagesPayload
    const out = translateMessagesToChatCompletions(payload)
    expect(out.tools?.[0].function.name).toBe("search")
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "search" } })
  })

  test("output_config.effort wins over thinking.budget_tokens", () => {
    const payload = {
      model: "gpt-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "low" },
      thinking: { type: "enabled", budget_tokens: 10000 },
    } as unknown as AnthropicMessagesPayload
    const out = translateMessagesToChatCompletions(payload)
    expect(out.reasoning_effort).toBe("low")
  })

  test("thinking.budget_tokens buckets into reasoning_effort", () => {
    const make = (budget: number) =>
      ({
        model: "gpt-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: budget },
      }) as unknown as AnthropicMessagesPayload
    expect(translateMessagesToChatCompletions(make(1024)).reasoning_effort).toBe("low")
    expect(translateMessagesToChatCompletions(make(4096)).reasoning_effort).toBe("medium")
    expect(translateMessagesToChatCompletions(make(16000)).reasoning_effort).toBe("high")
  })

  test("thinking.budget_tokens=0 → no reasoning_effort", () => {
    const payload = {
      model: "gpt-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 0 },
    } as unknown as AnthropicMessagesPayload
    const out = translateMessagesToChatCompletions(payload)
    expect(out.reasoning_effort).toBeUndefined()
  })
})

describe("translateChatCompletionsChunkToMessagesEvents", () => {
  test("first chunk emits message_start with id+model+input_tokens", () => {
    const state = createChatCompletionsToMessagesState("gpt-4")
    const out = translateChatCompletionsChunkToMessagesEvents(
      {
        id: "chatcmpl-1",
        model: "gpt-4",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out[0].type).toBe("message_start")
    if (out[0].type !== "message_start") throw new Error()
    expect(out[0].message.id).toBe("chatcmpl-1")
    expect(out[0].message.model).toBe("gpt-4")
  })

  test("content delta opens text block and emits text_delta", () => {
    const state = createChatCompletionsToMessagesState("gpt-4")
    translateChatCompletionsChunkToMessagesEvents(
      { id: "x", model: "gpt-4", choices: [{ delta: { role: "assistant" } }] },
      state,
    )
    const out = translateChatCompletionsChunkToMessagesEvents(
      { choices: [{ delta: { content: "hi" } }] },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out.some((e) => e.type === "content_block_start")).toBe(true)
    const delta = out.find((e) => e.type === "content_block_delta")
    if (!delta || delta.type !== "content_block_delta") throw new Error()
    expect(delta.delta).toEqual({ type: "text_delta", text: "hi" })
  })

  test("reasoning_text opens thinking block", () => {
    const state = createChatCompletionsToMessagesState("gpt-4")
    translateChatCompletionsChunkToMessagesEvents(
      { id: "x", model: "gpt-4", choices: [{ delta: { role: "assistant" } }] },
      state,
    )
    const out = translateChatCompletionsChunkToMessagesEvents(
      { choices: [{ delta: { reasoning_text: "ponder" } }] },
      state,
    )
    if (out === "DONE") throw new Error()
    const start = out.find((e) => e.type === "content_block_start")
    if (!start || start.type !== "content_block_start") throw new Error()
    expect(start.content_block.type).toBe("thinking")
    const delta = out.find((e) => e.type === "content_block_delta")
    if (!delta || delta.type !== "content_block_delta") throw new Error()
    expect(delta.delta).toEqual({ type: "thinking_delta", thinking: "ponder" })
  })

  test("tool_calls emit content_block_start + input_json_delta", () => {
    const state = createChatCompletionsToMessagesState("gpt-4")
    translateChatCompletionsChunkToMessagesEvents(
      { id: "x", model: "gpt-4", choices: [{ delta: { role: "assistant" } }] },
      state,
    )
    const start = translateChatCompletionsChunkToMessagesEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "tu_1", function: { name: "search", arguments: "" } },
              ],
            },
          },
        ],
      },
      state,
    )
    if (start === "DONE") throw new Error()
    const open = start.find((e) => e.type === "content_block_start")
    if (!open || open.type !== "content_block_start") throw new Error()
    expect(open.content_block).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "search",
      input: {},
    })

    const argDelta = translateChatCompletionsChunkToMessagesEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"q":"hi"}' } }],
            },
          },
        ],
      },
      state,
    )
    if (argDelta === "DONE") throw new Error()
    const ad = argDelta.find((e) => e.type === "content_block_delta")
    if (!ad || ad.type !== "content_block_delta") throw new Error()
    expect(ad.delta).toEqual({ type: "input_json_delta", partial_json: '{"q":"hi"}' })
  })

  test("finish_reason closes blocks + emits message_delta + message_stop", () => {
    const state = createChatCompletionsToMessagesState("gpt-4")
    translateChatCompletionsChunkToMessagesEvents(
      { id: "x", model: "gpt-4", choices: [{ delta: { content: "hi" } }] },
      state,
    )
    const out = translateChatCompletionsChunkToMessagesEvents(
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      state,
    )
    if (out === "DONE") throw new Error()
    expect(out.some((e) => e.type === "content_block_stop")).toBe(true)
    const md = out.find((e) => e.type === "message_delta")
    if (!md || md.type !== "message_delta") throw new Error()
    expect(md.delta.stop_reason).toBe("end_turn")
    expect(md.usage.output_tokens).toBe(5)
    expect(out.some((e) => e.type === "message_stop")).toBe(true)
    expect(state.terminated).toBe(true)
  })

  test("length finish maps to max_tokens, tool_calls to tool_use", () => {
    const s1 = createChatCompletionsToMessagesState("m")
    translateChatCompletionsChunkToMessagesEvents(
      { id: "x", choices: [{ delta: { content: "x" } }] },
      s1,
    )
    const o1 = translateChatCompletionsChunkToMessagesEvents(
      { choices: [{ delta: {}, finish_reason: "length" }] },
      s1,
    )
    if (o1 === "DONE") throw new Error()
    const md1 = o1.find((e) => e.type === "message_delta")
    if (!md1 || md1.type !== "message_delta") throw new Error()
    expect(md1.delta.stop_reason).toBe("max_tokens")

    const s2 = createChatCompletionsToMessagesState("m")
    translateChatCompletionsChunkToMessagesEvents(
      { id: "y", choices: [{ delta: { role: "assistant" } }] },
      s2,
    )
    const o2 = translateChatCompletionsChunkToMessagesEvents(
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      s2,
    )
    if (o2 === "DONE") throw new Error()
    const md2 = o2.find((e) => e.type === "message_delta")
    if (!md2 || md2.type !== "message_delta") throw new Error()
    expect(md2.delta.stop_reason).toBe("tool_use")
  })
})

describe("createChatCompletionsToMessagesStream", () => {
  async function pipe(input: string): Promise<string> {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(input))
        c.close()
      },
    })
    const out = stream.pipeThrough(createChatCompletionsToMessagesStream("gpt-4"))
    const chunks: Uint8Array[] = []
    const reader = out.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return chunks.map((c) => new TextDecoder().decode(c)).join("")
  }

  test("end-to-end SSE translation emits message_start through message_stop", async () => {
    const frame = (data: object) => `data: ${JSON.stringify(data)}\n\n`
    const input =
      frame({ id: "c1", model: "gpt-4", choices: [{ delta: { role: "assistant" } }] }) +
      frame({ choices: [{ delta: { content: "hi" } }] }) +
      frame({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }) +
      "data: [DONE]\n\n"

    const got = await pipe(input)
    expect(got).toContain("event: message_start")
    expect(got).toContain("event: content_block_start")
    expect(got).toContain('"text":"hi"')
    expect(got).toContain("event: message_delta")
    expect(got).toContain('"stop_reason":"end_turn"')
    expect(got).toContain("event: message_stop")
  })

  test("cache_read_input_tokens surfaces on message_delta when usage arrives in tail chunk", async () => {
    // Chat Completions surfaces usage (incl. prompt_tokens_details.cached_tokens)
    // only in the terminal chunk. Because message_start is emitted lazily on
    // the first delta — before usage is known — cache must ride on
    // message_delta, not message_start, or downstream usage tracking sees 0.
    const frame = (data: object) => `data: ${JSON.stringify(data)}\n\n`
    const input =
      frame({ id: "c-cache", model: "gpt-5.5", choices: [{ delta: { role: "assistant" } }] }) +
      frame({ choices: [{ delta: { content: "ok" } }] }) +
      frame({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 700 },
        },
      }) +
      "data: [DONE]\n\n"

    const got = await pipe(input)
    // Parse the message_delta frame and assert cache_read_input_tokens present.
    const deltaMatch = got.match(/event: message_delta\ndata: (.+)\n\n/)
    expect(deltaMatch).not.toBeNull()
    const delta = JSON.parse(deltaMatch![1])
    expect(delta.usage.cache_read_input_tokens).toBe(700)
    expect(delta.usage.output_tokens).toBe(12)
  })

  test("truncated stream synthesizes message_stop", async () => {
    const input = `data: ${JSON.stringify({ id: "x", model: "gpt-4", choices: [{ delta: { content: "hi" } }] })}\n\n`
    const got = await pipe(input)
    expect(got).toContain("event: message_delta")
    expect(got).toContain("event: message_stop")
    expect(got).toContain("Upstream Chat Completions stream ended")
  })
})

describe("translateChatCompletionsToMessagesResponse", () => {
  test("text content → text block, usage maps cached tokens", () => {
    const out = translateChatCompletionsToMessagesResponse({
      id: "c1",
      model: "gpt-4",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    })
    expect(out.content).toEqual([{ type: "text", text: "hi" }])
    expect(out.stop_reason).toBe("end_turn")
    expect(out.usage.input_tokens).toBe(6)
    expect(out.usage.cache_read_input_tokens).toBe(4)
    expect(out.usage.output_tokens).toBe(3)
  })

  test("tool_calls → tool_use blocks with parsed input", () => {
    const out = translateChatCompletionsToMessagesResponse({
      id: "c2",
      model: "gpt-4",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tu_1", type: "function", function: { name: "search", arguments: '{"q":"hi"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    expect(out.stop_reason).toBe("tool_use")
    const tool = out.content[0]
    expect(tool.type).toBe("tool_use")
    if (tool.type !== "tool_use") throw new Error()
    expect(tool.id).toBe("tu_1")
    expect(tool.name).toBe("search")
    expect(tool.input).toEqual({ q: "hi" })
  })

  test("reasoning_text → thinking block precedes text", () => {
    const out = translateChatCompletionsToMessagesResponse({
      id: "c3",
      model: "gpt-4",
      choices: [
        {
          message: { role: "assistant", content: "ok", reasoning_text: "ponder" },
          finish_reason: "stop",
        },
      ],
    })
    expect(out.content[0]).toEqual({ type: "thinking", thinking: "ponder" })
    expect(out.content[1]).toEqual({ type: "text", text: "ok" })
  })

  test("length finish maps to max_tokens", () => {
    const out = translateChatCompletionsToMessagesResponse({
      id: "c4",
      model: "gpt-4",
      choices: [{ message: { content: "..." }, finish_reason: "length" }],
    })
    expect(out.stop_reason).toBe("max_tokens")
  })
})
