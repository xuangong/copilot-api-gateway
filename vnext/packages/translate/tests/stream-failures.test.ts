import { expect, test } from "bun:test"
import { translateChatToResponsesEvents } from "../src/responses-via-chat-completions/events"
import { translateChatSSEToMessagesEvents } from "../src/messages-via-chat-completions/events"
import { translateResponsesToChatSSE } from "../src/chat-completions-via-responses/events"
import { translateMessagesToChatSSE } from "../src/chat-completions-via-messages/events"
async function* events(items: unknown[]): AsyncGenerator<never> { for (const item of items) yield item as never }
async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> { const out = []; for await (const ev of stream) out.push(ev); return out }
for (const [name, translate] of [["responses", translateChatToResponsesEvents], ["messages", translateChatSSEToMessagesEvents]] as const) {
  test(`chat to ${name}: EOF without finish must not synthesize success`, async () => {
    await expect(collect(translate(events([{ choices: [{ index: 0, delta: { content: "partial" } }] }])))).rejects.toThrow("finish")
  })
  test(`chat to ${name}: explicit failure survives`, async () => {
    await expect(collect(translate(events([{ error: { message: "upstream failed" } }])))).rejects.toThrow("upstream failed")
  })
}
for (const type of ["response.failed", "error"] as const) {
  test(`responses to chat: ${type} must fail without a stop chunk`, async () => {
    await expect(collect(translateResponsesToChatSSE(events([{ type, message: "upstream failed", response: { error: { message: "upstream failed" } } }])))).rejects.toThrow("upstream failed")
  })
}
test("responses to chat: incomplete token limit stays length", async () => {
  const out = await collect(translateResponsesToChatSSE(events([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])))
  expect(out.at(-1)).toMatchObject({ choices: [{ finish_reason: "length" }] })
})
test("responses to chat: EOF must fail", async () => {
  await expect(collect(translateResponsesToChatSSE(events([])))).rejects.toThrow("completion")
})
test("messages to chat: error must fail", async () => {
  await expect(collect(translateMessagesToChatSSE(events([{ type: "error", error: { message: "upstream failed" } }])))).rejects.toThrow("upstream failed")
})
test("messages to chat: EOF must fail", async () => {
  await expect(collect(translateMessagesToChatSSE(events([])))).rejects.toThrow("message_stop")
})
