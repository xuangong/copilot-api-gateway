import { expect, test } from "bun:test"
import { translateResponsesToMessagesBody } from "../src/messages-via-responses/body"
import { translateResponsesEventsToMessagesEvents } from "../src/messages-via-responses/events"

const nativeItems = [
  { type: "program_output", result: "fixture" },
  { type: "program" },
  { type: "compaction" },
  { type: "compaction_summary" },
  { type: "program", encrypted_content: "opaque" },
  { type: "program", fingerprint: "opaque" },
  { type: "compaction", encrypted_content: "opaque" },
  { type: "compaction_summary", encrypted_content: "opaque" },
  { type: "context_compaction", encrypted_content: "opaque" },
  { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "opaque" }] },
]

for (const item of nativeItems) {
  const shape = Object.keys(item).length === 1 ? "blobless" : "with payload"
  test(`Messages JSON rejects unrepresentable ${item.type} (${shape})`, () => {
    expect(() => translateResponsesToMessagesBody({ id: "resp_test", model: "fixture", status: "completed", output: [item] }))
      .toThrow("Native continuation state cannot be represented")
  })
  for (const eventType of ["response.output_item.added", "response.output_item.done", "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"]) {
    test(`Messages SSE rejects ${item.type} (${shape}) in ${eventType} and closes source`, async () => {
      let closed = false
      async function* events() {
        try {
          yield { type: "response.created", response: { id: "resp_test", model: "fixture" } }
          yield eventType.startsWith("response.output_item.")
            ? { type: eventType, output_index: 0, item }
            : { type: eventType, response: { id: "resp_test", status: "completed", output: [item] } }
        } finally { closed = true }
      }
      const received: string[] = []
      const consume = async () => {
        for await (const event of translateResponsesEventsToMessagesEvents(events())) received.push(event.type)
      }
      await expect(consume()).rejects.toThrow("Native continuation state cannot be represented")
      expect(closed).toBe(true)
      expect(received).not.toContain("message_stop")
    })
  }
}

test("Messages keeps representable text, thinking and tool blocks", () => {
  const result = translateResponsesToMessagesBody({ id: "resp_test", model: "fixture", status: "completed", output: [
    { type: "reasoning", summary: [{ text: "thought" }], encrypted_content: "native" },
    { type: "function_call", call_id: "call_fixture", name: "tool", arguments: "{}" },
    { type: "message", content: [{ type: "output_text", text: "ok" }] },
  ] })
  expect(result.content).toEqual([
    { type: "thinking", thinking: "thought", signature: "native" },
    { type: "tool_use", id: "call_fixture", name: "tool", input: {} },
    { type: "text", text: "ok" },
  ])
})
