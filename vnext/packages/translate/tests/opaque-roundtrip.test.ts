import { expect, test } from "bun:test"
import { translateMessagesToResponsesBody, translateMessagesToResponsesEvents, translateResponsesToMessages } from "@vibe-llm/translate/responses-via-messages"
import { translateResponsesToMessagesBody, translateMessagesToResponses, translateResponsesEventsToMessagesEvents } from "@vibe-llm/translate/messages-via-responses"
import type { MessagesResponse, MessagesPayload, MessagesEvent } from "@vibe-llm/protocols/messages"
import type { ResponsesPayload } from "@vibe-llm/protocols/responses"
async function* source<T>(values: T[]) { yield* values }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const item of source) values.push(item); return values }
const text = "  thought\n\t"
const content = [{ type: "thinking", thinking: text, signature: "signature" }, { type: "redacted_thinking", data: "redacted" }]

test("both body and request adapters preserve opaque state, redaction, and complete companion whitespace", () => {
  const response = { id: "m", model: "model", type: "message", role: "assistant", content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as unknown as MessagesResponse
  const responses = translateMessagesToResponsesBody(response)
  expect(translateResponsesToMessagesBody(responses).content).toEqual(content)
  const request = translateMessagesToResponses({ model: "model", max_tokens: 100, messages: [{ role: "assistant", content }] } as MessagesPayload)
  const inverse = translateResponsesToMessages(request.target as unknown as ResponsesPayload)
  expect(inverse.target.messages[0]?.content).toEqual(content)
})

test("Messages signature fragments become one complete Responses item and terminal output", async () => {
  const events = [
    { type: "message_start", message: { id: "m", model: "model", usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: " ", signature: "first-" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought\n" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "last" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] as unknown as MessagesEvent[]
  const out = await collect(translateMessagesToResponsesEvents(source(events)))
  const done = out.find(event => event.type === "response.output_item.done")
  expect(done).toMatchObject({ item: { type: "reasoning", summary: [{ text: " thought\n" }], encrypted_content: "first-last" } })
  expect(out.find(event => event.type === "response.completed")).toMatchObject({ response: { output: [done?.item] } })
})

test("late Responses signature reaches the original Messages thinking block before its only stop", async () => {
  const item = { type: "reasoning", id: "r", summary: [{ text }], encrypted_content: "signature" }
  const out = await collect(translateResponsesEventsToMessagesEvents(source([
    { type: "response.created", response: { id: "r", model: "model" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: text },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "answer" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
  ])))
  const starts = out.filter(event => event.type === "content_block_start" && event.content_block.type === "thinking")
  expect(starts).toHaveLength(1)
  const stops = out.filter(event => event.type === "content_block_stop" && event.index === 0)
  expect(stops).toHaveLength(1)
  const signature = out.findIndex(event => event.type === "content_block_delta" && event.delta.type === "signature_delta")
  const stop = out.findIndex(event => event.type === "content_block_stop" && event.index === 0)
  expect(signature).toBeGreaterThan(0)
  expect(stop).toBeGreaterThan(signature)
})

for (const terminalOnly of [false, true]) test(`final reasoning companion appends a missing suffix (${terminalOnly ? "terminal" : "done"})`, async () => {
  const item = { type: "reasoning", id: "r", summary: [{ text: "ab" }], encrypted_content: "signature-for-ab" }
  const out = await collect(translateResponsesEventsToMessagesEvents(source([
    { type: "response.created", response: { id: "r", model: "model" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "a" },
    ...(!terminalOnly ? [{ type: "response.output_item.done", output_index: 0, item }] : []),
    { type: "response.completed", response: { status: "completed", output: [item], usage: {} } },
  ])))
  const thinking = out.flatMap(event => event.type === "content_block_delta" && event.delta.type === "thinking_delta" ? [event.delta.thinking] : []).join("")
  expect(thinking).toBe("ab")
  expect(out.some(event => event.type === "content_block_delta" && event.delta.type === "signature_delta")).toBe(true)
})

test("conflicting finalized reasoning companion rejects before any native signature", async () => {
  const out: unknown[] = []
  await expect((async () => {
    for await (const event of translateResponsesEventsToMessagesEvents(source([
      { type: "response.created", response: { id: "r", model: "model" } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "a" },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ text: "z" }], encrypted_content: "native" } },
    ]))) out.push(event)
  })()).rejects.toThrow("Invalid opaque reasoning companion")
  expect(JSON.stringify(out)).not.toContain("native")
})
