import { expect, test } from "bun:test"
import { translateResponsesToChatBody } from "../src/chat-completions-via-responses/body"
import { translateResponsesToChatSSE } from "../src/chat-completions-via-responses/events"
import { translateResponsesToGeminiBody } from "../src/gemini-via-responses/body"
import { translateResponsesToGeminiEvents } from "../src/gemini-via-responses/events"
import { assertClientRepresentableResponseItem } from "../src/shared/client-opaque-state"

const clients = [
  {
    name: "Chat",
    body: translateResponsesToChatBody,
    events: translateResponsesToChatSSE,
  },
  {
    name: "Gemini",
    body: (body: Parameters<typeof translateResponsesToGeminiBody>[0]) => translateResponsesToGeminiBody(body, { model: "fixture" }),
    events: translateResponsesToGeminiEvents,
  },
]

for (const client of clients) {
  for (const type of ["program", "compaction", "compaction_summary"]) {
    const item = { type }
    test(`${client.name} JSON rejects blobless ${type}`, async () => {
      const translate = async () => client.body({ id: "resp_test", model: "fixture", status: "completed", output: [item] })
      await expect(translate()).rejects.toThrow("Native continuation state cannot be represented")
    })

    for (const eventType of ["response.output_item.added", "response.output_item.done", "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"]) {
      test(`${client.name} SSE rejects blobless ${type} in ${eventType} and closes source`, async () => {
        let closed = false
        let finished = false
        async function* events() {
          try {
            yield { type: "response.created", response: { id: "resp_test", model: "fixture" } }
            yield eventType.startsWith("response.output_item.")
              ? { type: eventType, output_index: 0, item }
              : { type: eventType, response: { id: "resp_test", status: "completed", output: [item] } }
          } finally { closed = true }
        }
        const consume = async () => {
          for await (const event of client.events(events())) {
            if ("choices" in event) finished ||= event.choices.some(choice => choice.finish_reason !== null)
            if ("candidates" in event) finished ||= event.candidates?.some(candidate => candidate.finishReason !== undefined) ?? false
          }
        }
        await expect(consume()).rejects.toThrow("Native continuation state cannot be represented")
        expect(closed).toBe(true)
        expect(finished).toBe(false)
      })
    }
  }
}

test("blobless context_compaction retains its legacy guard boundary", () => {
  // A payloadless context_compaction still has no client mapping; this task does not redefine it.
  expect(() => assertClientRepresentableResponseItem({ type: "context_compaction" })).not.toThrow()
  expect(() => assertClientRepresentableResponseItem({ type: "context_compaction", encrypted_content: "" }))
    .toThrow("Native continuation state cannot be represented")
})
