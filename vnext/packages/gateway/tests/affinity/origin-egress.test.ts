import { expect, test } from "bun:test"
import { doneFrame, eventFrame } from "@vibe-core/result"
import { AffinityCodec } from "../../src/shared/affinity/carrier"
import { AffinityEgress } from "../../src/shared/affinity/egress"
import type { AffinityExecutionState } from "../../src/shared/affinity/context"
import { analyzeAffinityRequest } from "../../src/shared/affinity/analysis"

type JsonObject = Record<string, unknown>
const target = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
const affinity = (protocol: AffinityExecutionState["protocol"]): AffinityExecutionState => ({ protocol, actual: target, codec })
async function* values<T>(items: readonly T[]): AsyncGenerator<T> { yield* items }

test("ordinary Chat JSON adds only an origin slot while natural opaque remains v1", async () => {
  const message = { role: "assistant", content: "answer", reasoning_text: "visible", tool_calls: [{ id: "call", type: "function", function: { name: "f", arguments: "{}" } }], refusal: null }
  const body: { choices: Array<{ index: number; message: JsonObject; finish_reason: string }> } = { choices: [{ index: 0, message, finish_reason: "tool_calls" }, { index: 1, message: { role: "assistant", content: "", reasoning_opaque: "" }, finish_reason: "stop" }] }
  const output = await new AffinityEgress(affinity("chat_completions")).body("chat_completions", body)
  const first = output.choices[0]?.message
  expect(first).toMatchObject(message)
  expect(first?.reasoning_opaque).toStartWith("vnext-affinity:2:")
  expect(output.choices[1]?.message.reasoning_opaque).toStartWith("vnext-affinity:1:")
  expect(message).not.toHaveProperty("reasoning_opaque")
})

test("Chat streaming stamps each real finished choice once and leaves usage-only output alone", async () => {
  const frames = [
    eventFrame<JsonObject>({ choices: [{ index: 0, delta: { role: "assistant", content: "early" }, finish_reason: null }] }),
    eventFrame<JsonObject>({ choices: [{ index: 1, delta: { role: "assistant", content: "" }, finish_reason: "stop" }, { index: 0, delta: {}, finish_reason: "stop" }] }),
    eventFrame<JsonObject>({ choices: [], usage: { completion_tokens: 2 } }),
    doneFrame(),
  ]
  const output = await Array.fromAsync(new AffinityEgress(affinity("chat_completions")).chat(values(frames)))
  const events = output.flatMap(frame => frame.type === "event" ? [frame.event] : [])
  expect(events[0]).toEqual({ choices: [{ index: 0, delta: { role: "assistant", content: "early" }, finish_reason: null }] })
  const finished = events[1]?.choices as Array<{ index: number; delta: JsonObject }>
  expect(finished).toHaveLength(2)
  for (const choice of finished) expect(choice.delta.reasoning_opaque).toStartWith("vnext-affinity:2:")
  expect(events[2]).toEqual({ choices: [], usage: { completion_tokens: 2 } })
  expect(output.at(-1)).toEqual(doneFrame())
})

test("origin issuance leaves unowned output and absent candidates unchanged", async () => {
  const body = { choices: [] }
  const real = { choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }] }
  for (const state of [undefined, { protocol: "chat_completions" as const, codec }, { protocol: "chat_completions" as const, actual: target }]) {
    expect(await new AffinityEgress(state).body("chat_completions", body)).toEqual(body)
    expect(await new AffinityEgress(state).body("chat_completions", real)).toEqual(real)
  }
  expect(await new AffinityEgress(affinity("chat_completions")).body("chat_completions", body)).toEqual(body)
})

test("Messages JSON adds one removable redacted prefix before unchanged visible and native blocks", async () => {
  const content: JsonObject[] = [{ type: "text", text: "answer" }, { type: "thinking", thinking: "thought", signature: "native" }, { type: "tool_use", id: "call", name: "lookup", input: { query: "q" } }]
  const body = { id: "message", type: "message", role: "assistant", content }
  const output = await new AffinityEgress(affinity("messages")).body("messages", body)
  expect(output.content).toHaveLength(4)
  expect(output.content[0]).toMatchObject({ type: "redacted_thinking" })
  expect(output.content[0]?.data).toStartWith("vnext-affinity:2:")
  expect(output.content[2]?.signature).toStartWith("vnext-affinity:1:")
  expect(content).toHaveLength(3)
  const analysis = await analyzeAffinityRequest("messages", { messages: [{ role: "assistant", content: output.content }] }, codec)
  expect(analysis.prepareSource()).toEqual({ messages: [{ role: "assistant", content: output.content.slice(1) }] })
  expect(analysis.materialize(target)).toEqual({ messages: [{ role: "assistant", content }] })
})

test("Messages streaming emits a two-event prefix and shifts every native block index", async () => {
  const input = [
    eventFrame<JsonObject>({ type: "message_start", message: { id: "message", type: "message", role: "assistant", content: [] } }),
    eventFrame<JsonObject>({ type: "content_block_start", index: 5, content_block: { type: "text", text: "" } }),
    eventFrame<JsonObject>({ type: "content_block_delta", index: 5, delta: { type: "text_delta", text: "early" } }),
    eventFrame<JsonObject>({ type: "content_block_stop", index: 5 }),
    eventFrame<JsonObject>({ type: "message_stop" }),
  ]
  const output = await Array.fromAsync(new AffinityEgress(affinity("messages")).messages(values(input)))
  const events = output.flatMap(frame => frame.type === "event" ? [frame.event] : [])
  expect(events.map(event => event.type)).toEqual(["message_start", "content_block_start", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_stop"])
  expect(events[1]).toMatchObject({ index: 0, content_block: { type: "redacted_thinking" } })
  expect((events[1]?.content_block as JsonObject).data).toStartWith("vnext-affinity:2:")
  expect(events.slice(3, 6).map(event => event.index)).toEqual([6, 6, 6])
  expect(events[4]?.delta).toEqual({ type: "text_delta", text: "early" })
  expect(input[1]).toMatchObject({ event: { index: 5 } })
})

test("Messages empty real turns get one prefix while error-only output stays unchanged", async () => {
  const empty = { id: "message", type: "message", role: "assistant", content: [] as JsonObject[] }
  expect((await new AffinityEgress(affinity("messages")).body("messages", empty)).content).toHaveLength(1)
  const frames = [eventFrame<JsonObject>({ type: "message_start", message: empty }), eventFrame<JsonObject>({ type: "message_stop" })]
  expect(await Array.fromAsync(new AffinityEgress(affinity("messages")).messages(values(frames)))).toHaveLength(4)
  const error = [eventFrame<JsonObject>({ type: "error", error: { type: "overloaded_error", message: "failed" } })]
  expect(await Array.fromAsync(new AffinityEgress(affinity("messages")).messages(values(error)))).toEqual(error)
})
