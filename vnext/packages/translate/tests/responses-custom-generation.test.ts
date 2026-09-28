import { expect, test } from "bun:test"
import { translateResponsesToChat, translateChatToResponsesBody, translateChatToResponsesEvents } from "../src/responses-via-chat-completions/index.ts"
import { translateResponsesToMessages, translateMessagesToResponsesBody, translateMessagesToResponsesEvents } from "../src/responses-via-messages/index.ts"
import { projectResponsesTools } from "../src/shared/responses-tools.ts"
import { TranslatorValidationError } from "../src/errors.ts"

const request = {
  model: "m", input: [
    { type: "custom_tool_call", call_id: "old", name: "legacy", input: "historical" },
    { type: "custom_tool_call_output", call_id: "old", output: "ok" },
  ],
  tools: [{ type: "custom", name: "execute", description: "Run text" }, { type: "function", name: "other", parameters: { type: "object" } }],
  tool_choice: { type: "custom", name: "execute" },
} as const

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}
async function* feed(items: unknown[]) { for (const item of items) yield item }

test("custom declaration, named choice, and historical call project through both targets", () => {
  const chat = translateResponsesToChat(request as never).target as unknown as Record<string, unknown>
  const messages = translateResponsesToMessages(request as never).target as unknown as Record<string, unknown>
  expect(chat.tools).toEqual([
    { type: "function", function: { name: "execute", description: "Run text", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } } },
    { type: "function", function: { name: "other", parameters: { type: "object" } } },
  ])
  expect(chat.tool_choice).toEqual({ type: "function", function: { name: "execute" } })
  expect((chat.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "old", function: { name: "legacy", arguments: '{"input":"historical"}' } }] })
  expect(messages.tools).toMatchObject([{ name: "execute", input_schema: { type: "object", required: ["input"] } }, { name: "other" }])
  expect(messages.tool_choice).toEqual({ type: "tool", name: "execute" })
  expect((messages.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "old", input: { input: "historical" } }] })
})

test("custom schemas are independent per request", () => {
  const first = translateResponsesToChat(request as never).target as unknown as { tools: Array<{ function: { parameters: { required: string[] } } }> }
  first.tools[0]?.function.parameters.required.push("poison")
  const second = translateResponsesToChat(request as never).target as unknown as { tools: Array<{ function: { parameters: { required: string[] } } }> }
  expect(second.tools[0]?.function.parameters.required).toEqual(["input"])
})

test("selected kinds exclude disallowed declarations and reject grammar", () => {
  const selected = projectResponsesTools({ ...request, tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "custom", name: "execute" }] } } as never)
  expect(selected.tools).toHaveLength(1)
  expect(() => translateResponsesToChat({ ...request, tools: [{ type: "custom", name: "execute", format: { type: "grammar", syntax: "lark", definition: "start: /./" } }] } as never)).toThrow(TranslatorValidationError)
  expect(() => translateResponsesToMessages({ ...request, tools: [{ type: "custom", name: "execute", format: { type: "grammar" } }] } as never)).toThrow(TranslatorValidationError)
  expect(() => translateResponsesToChat({ ...request, tools: [{ type: "custom", name: "execute" }, { type: "function", name: "execute" }] } as never)).toThrow(TranslatorValidationError)
  expect(translateResponsesToChat({ model: "m", input: "q", tool_choice: null } as never).target.tool_choice).toBeUndefined()
})

test("custom history does not authorize later calls and same name has no cross-request kind leak", () => {
  const historical = translateResponsesToChat({ model: "m", input: request.input, tools: [{ type: "function", name: "execute" }] } as never)
  expect((historical.target.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ tool_calls: [{ function: { name: "legacy", arguments: '{"input":"historical"}' } }] })
  const names = projectResponsesTools({ model: "m", input: "q", tools: [{ type: "function", name: "execute" }] } as never).tools
  expect(names).toMatchObject([{ type: "function", name: "execute" }])
  const body = translateChatToResponsesBody({ id: "r", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
    { id: "a", type: "function", function: { name: "execute", arguments: "{}" } },
  ] }, finish_reason: "tool_calls" }] }, { customToolNames: [] })
  expect(body.output[0]).toMatchObject({ type: "function_call", name: "execute", arguments: "{}" })
})

test("JSON reverse classifies only selected custom names and rejects malformed wrapper", () => {
  const names = ["execute"]
  const chat = translateChatToResponsesBody({ id: "r", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
    { id: "a", type: "function", function: { name: "execute", arguments: '{"input":"你好"}' } },
    { id: "b", type: "function", function: { name: "other", arguments: "{}" } },
  ] }, finish_reason: "tool_calls" }] }, { customToolNames: names })
  expect(chat.output).toMatchObject([{ type: "custom_tool_call", call_id: "a", input: "你好" }, { type: "function_call", call_id: "b", arguments: "{}" }])
  expect(() => translateChatToResponsesBody({ id: "r", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "execute", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, { customToolNames: names })).toThrow(TranslatorValidationError)
  const msg = translateMessagesToResponsesBody({ id: "r", model: "m", content: [{ type: "tool_use", id: "a", name: "execute", input: { input: "你好" } }], stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } } as never, { customToolNames: names })
  expect(msg.output[0]).toMatchObject({ type: "custom_tool_call", call_id: "a", input: "你好" })
})

test("SSE custom lifecycle closes fragmented escaped input in both targets", async () => {
  const chat = await collect(translateChatToResponsesEvents(feed([
    { id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "exe", arguments: '{"input":"\\u' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "cute", arguments: '4f60"}' } }] }, finish_reason: "tool_calls" }] },
  ]), { customToolNames: ["execute"] })) as Array<Record<string, unknown>>
  expect(chat.filter(e => String(e.type).includes("custom_tool_call_input")).map(e => e.type)).toEqual(["response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"])
  expect(chat.find(e => e.type === "response.output_item.done")?.item).toMatchObject({ type: "custom_tool_call", call_id: "a", input: "你" })
  const chatAdded = chat.find(e => e.type === "response.output_item.added")
  const chatDone = chat.find(e => e.type === "response.output_item.done")
  expect(chatAdded?.output_index).toBe(chatDone?.output_index)
  expect((chatAdded?.item as Record<string, unknown>).id).toBe((chatDone?.item as Record<string, unknown>).id)
  const messages = await collect(translateMessagesToResponsesEvents(feed([
    { type: "message_start", message: { id: "r", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "execute" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"\\u' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '4f60"}' } },
    { type: "content_block_stop", index: 0 }, { type: "message_stop" },
  ] as never), { customToolNames: ["execute"] })) as Array<Record<string, unknown>>
  expect(messages.filter(e => String(e.type).includes("custom_tool_call_input")).map(e => e.type)).toEqual(["response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"])
  expect(messages.find(e => e.type === "response.output_item.done")?.item).toMatchObject({ type: "custom_tool_call", call_id: "a", input: "你" })
  const messageAdded = messages.find(e => e.type === "response.output_item.added")
  const messageDone = messages.find(e => e.type === "response.output_item.done")
  expect(messageAdded?.output_index).toBe(messageDone?.output_index)
  expect((messageAdded?.item as Record<string, unknown>).id).toBe((messageDone?.item as Record<string, unknown>).id)
})

test("malformed custom stream wrappers remain visible errors", async () => {
  await expect(collect(translateChatToResponsesEvents(feed([
    { id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "execute", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]), { customToolNames: ["execute"] }))).rejects.toThrow(TranslatorValidationError)
  await expect(collect(translateMessagesToResponsesEvents(feed([
    { type: "message_start", message: { id: "r", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "execute" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
  ] as never), { customToolNames: ["execute"] }))).rejects.toThrow(TranslatorValidationError)
})

test("Messages message_stop with an open custom block emits error without completion", async () => {
  const out = await collect(translateMessagesToResponsesEvents(feed([
    { type: "message_start", message: { id: "r", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "execute" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"unfinished' } },
    { type: "message_stop" },
  ] as never), { customToolNames: ["execute"] })) as Array<Record<string, unknown>>
  expect(out.some(event => event.type === "error")).toBe(true)
  expect(out.some(event => event.type === "response.completed")).toBe(false)
})

test("Messages custom cancellation closes upstream before a terminal response", async () => {
  let closed = false
  async function* upstream() {
    try {
      yield { type: "message_start", message: { id: "r", model: "m" } }
      yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "execute" } }
      yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"unfinished' } }
      yield { type: "message_stop" }
    } finally { closed = true }
  }
  const observed: string[] = []
  for await (const event of translateMessagesToResponsesEvents(upstream() as never, { customToolNames: ["execute"] })) {
    observed.push(event.type)
    if (event.type === "response.output_item.added") break
  }
  expect(closed).toBe(true)
  expect(observed).not.toContain("response.completed")
})

test.each(["tool_calls", "length"])("Chat terminal tool statuses follow finish_reason %s", async finish_reason => {
  const out = await collect(translateChatToResponsesEvents(feed([
    { id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "a", function: { name: "execute", arguments: '{"input":"yes"}' } },
      { index: 1, id: "b", function: { name: "ordinary", arguments: "{}" } },
    ] }, finish_reason }] },
  ]), { customToolNames: ["execute"] })) as Array<Record<string, unknown>>
  const expected = finish_reason === "length" ? "incomplete" : "completed"
  const terminal = out.find(event => event.type === `response.${expected}`)?.response as { output: Array<Record<string, unknown>> }
  expect(terminal.output).toMatchObject([
    { type: "custom_tool_call", status: expected, input: "yes" },
    { type: "function_call", status: expected, arguments: "{}" },
  ])
  expect(out.filter(event => event.type === "response.output_item.done").map(event => (event.item as Record<string, unknown>).status)).toEqual([expected, expected])
})

test("Chat ordinary function has protocol-required terminal status without custom tools", async () => {
  const out = await collect(translateChatToResponsesEvents(feed([
    { id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "a", function: { name: "ordinary", arguments: "{}" } },
    ] }, finish_reason: "tool_calls" }] },
  ]))) as Array<Record<string, unknown>>
  const terminal = out.find(event => event.type === "response.completed")?.response as { output: Array<Record<string, unknown>> }
  expect(terminal.output).toMatchObject([{ type: "function_call", status: "completed", arguments: "{}" }])
})

test("ordinary function argument deltas arrive before upstream finishes when no custom is selected", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  async function* upstream() {
    yield { id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "ordinary", arguments: '{"x":' } }] }, finish_reason: null }] }
    await gate
    yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] }
  }
  const iterator = translateChatToResponsesEvents(upstream())
  expect((await iterator.next()).value).toMatchObject({ type: "response.created" })
  expect((await iterator.next()).value).toMatchObject({ type: "response.in_progress" })
  expect((await iterator.next()).value).toMatchObject({ type: "response.output_item.added" })
  expect((await iterator.next()).value).toMatchObject({ type: "response.function_call_arguments.delta", delta: '{"x":' })
  release?.()
  await collect(iterator)
})
