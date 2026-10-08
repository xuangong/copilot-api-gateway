import { expect, test } from "bun:test"
import { doneFrame, eventFrame } from "@vibe-core/result"
import type { AffinityProtocol } from "../../src/shared/affinity/analysis.ts"
import type { AffinityExecutionState } from "../../src/shared/affinity/context.ts"
import { AffinityEgress } from "../../src/shared/affinity/egress.ts"

type JsonObject = Record<string, unknown>
const target = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
function withoutCodec(protocol: AffinityProtocol): AffinityExecutionState {
  return { protocol, actual: target, loadCodec: async () => { throw new Error("Output without opaque state must not load the affinity codec") } }
}
async function* values<T>(items: readonly T[]): AsyncGenerator<T> { yield* items }

const plainBodies: Readonly<Record<AffinityProtocol, JsonObject>> = {
  responses: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }, { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] }] },
  messages: { content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "thought" }] },
  chat_completions: { choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_text: "thought" }, finish_reason: "stop" }] },
  gemini: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }, { thought: true, text: "thought" }] }, finishReason: "STOP" }] },
}
const emptyBodies: Readonly<Record<AffinityProtocol, JsonObject>> = {
  responses: { output: [] },
  messages: { content: [] },
  chat_completions: { choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] },
  gemini: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] },
}

for (const protocol of ["responses", "messages", "chat_completions", "gemini"] as const) {
  test(`${protocol} JSON without opaque state neither loads a codec nor inserts a carrier`, async () => {
    const egress = new AffinityEgress(withoutCodec(protocol))
    for (const body of [plainBodies[protocol], emptyBodies[protocol]]) {
      const expected = structuredClone(body)
      expect(await egress.body(protocol, body)).toEqual(expected)
      expect(body).toEqual(expected)
    }
  })
}

test("Responses plain and empty terminal streams keep their items without loading a codec", async () => {
  for (const body of [plainBodies.responses, emptyBodies.responses]) {
    const events = [{ type: "response.created", response: { output: [] } }, { type: "response.completed", response: body }]
    const expected = structuredClone(events)
    const egress = new AffinityEgress(withoutCodec("responses"))
    const output: JsonObject[] = []
    for (const event of events) output.push(await egress.responseEvent(event))
    expect(output).toEqual(expected)
  }
})

test("Messages plain, unsigned thinking and empty streams do not add synthetic blocks or signatures", async () => {
  for (const content of [[], [{ type: "text", text: "answer" }], [{ type: "thinking", thinking: "thought" }]]) {
    const frames = [eventFrame<JsonObject>({ type: "message_start", message: { content: [] } }),
      ...content.flatMap((content_block, index) => [eventFrame<JsonObject>({ type: "content_block_start", index, content_block }), eventFrame<JsonObject>({ type: "content_block_stop", index })]),
      eventFrame<JsonObject>({ type: "message_stop" })]
    const expected = structuredClone(frames)
    expect(await Array.fromAsync(new AffinityEgress(withoutCodec("messages")).messages(values(frames)))).toEqual(expected)
  }
})

test("Chat plain and empty streams do not load a codec or add reasoning carriers", async () => {
  for (const content of ["answer", ""]) {
    const frames = [eventFrame({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] }), doneFrame()]
    const expected = structuredClone(frames)
    expect(await Array.fromAsync(new AffinityEgress(withoutCodec("chat_completions")).chat(values(frames)))).toEqual(expected)
  }
})

test("Gemini plain and empty streams do not load a codec or add signed Parts", async () => {
  const events = [plainBodies.gemini, emptyBodies.gemini]
  const expected = structuredClone(events)
  expect(await Array.fromAsync(new AffinityEgress(withoutCodec("gemini")).gemini(values(events)))).toEqual(expected)
})
