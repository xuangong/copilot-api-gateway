import { expect, test } from "bun:test"
import { eventFrame } from "@vibe-core/result"
import { AffinityCodec, InvalidAffinityStateError, MAX_AFFINITY_PAYLOAD_BYTES } from "../../src/shared/affinity/carrier.ts"
import { analyzeAffinityRequest } from "../../src/shared/affinity/analysis.ts"
import { AffinityEgress } from "../../src/shared/affinity/egress.ts"
import type { RequestAffinity } from "../../src/data-plane/shared/affinity-request.ts"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"

const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
async function state(): Promise<RequestAffinity> { return { protocol: "responses", codec, analysis: await analyzeAffinityRequest("responses", {}, codec), actual: target, plaintextCompactions: new Set() } }
async function* frames(events: Array<Record<string, unknown>>) { for (const event of events) yield eventFrame(event) }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const item of source) values.push(item); return values }

test("Responses finalized carrier is identical in done/terminal and binds the closed companion", async () => {
  const egress = new AffinityEgress(await state())
  const item = { id: "r", type: "reasoning", summary: [{ type: "summary_text", text: " thought \n" }], encrypted_content: "opaque" }
  const added = await egress.responseEvent({ type: "response.output_item.added", output_index: 0, item })
  expect(added.item).not.toHaveProperty("encrypted_content")
  const created = await egress.responseEvent({ type: "response.created", response: { output: [item] } })
  expect(created.response.output[0]).not.toHaveProperty("encrypted_content")
  const done = await egress.responseEvent({ type: "response.output_item.done", output_index: 0, item })
  const terminal = await egress.responseEvent({ type: "response.completed", response: { output: [{ ...item, encrypted_content: "conflict", summary: [] }] } })
  expect(terminal.response.output[0]).toEqual(done.item)
  expect(done.item.encrypted_content).toStartWith("vnext-affinity:1:")
  const analysis = await analyzeAffinityRequest("responses", { input: [terminal.response.output[0]] }, codec)
  expect(analysis.materialize(target).input).toEqual([item])
})

test("only a request-registered plaintext compaction avoids native signing", async () => {
  const affinity = await state()
  const own = { id: "own", type: "compaction", encrypted_content: "plaintext-summary" }
  affinity.plaintextCompactions?.add(JSON.stringify([own.id, own.encrypted_content]))
  const egress = new AffinityEgress(affinity)
  const result = await egress.body("responses", { output: [own, { ...own, id: "foreign" }] })
  expect(result.output[0]).toEqual(own)
  expect(result.output[1]?.encrypted_content).toStartWith("vnext-affinity:1:")
})

test("Messages accumulates all signature fragments and complete whitespace before stop", async () => {
  const egress = new AffinityEgress(await state())
  const out = await collect(egress.messages(frames([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: " ", signature: "raw-" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought\n" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } },
    { type: "content_block_stop", index: 0 },
  ])))
  const events = out.flatMap(frame => frame.type === "event" ? [frame.event] : [])
  expect(events).toHaveLength(4)
  expect(events[0]).toEqual({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: " " } })
  const delta = events[2]?.delta as { signature?: string }
  expect(delta.signature).toStartWith("vnext-affinity:1:")
  const analysis = await analyzeAffinityRequest("messages", { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: " thought\n", signature: delta.signature }] }] }, codec)
  expect(analysis.materialize(target).messages).toEqual([{ role: "assistant", content: [{ type: "thinking", thinking: " thought\n", signature: "raw-signature" }] }])
  expect(events[3]?.type).toBe("content_block_stop")
})

test("Messages rejects oversized accumulation and never leaks incomplete raw signature", async () => {
  const egress = new AffinityEgress(await state())
  const start = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "raw" } }
  const incomplete = await collect(egress.messages(frames([start])))
  expect(JSON.stringify(incomplete)).not.toContain("raw")
  await expect(collect(egress.messages(frames([start, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x".repeat(MAX_AFFINITY_PAYLOAD_BYTES) } }])))).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("Responses multiple and duplicate identities retain independently finalized carriers", async () => {
  const egress = new AffinityEgress(await state())
  const first = { id: "a", type: "reasoning", summary: [], encrypted_content: "a" }
  const second = { type: "reasoning", summary: [], encrypted_content: "b" }
  const a = await egress.responseEvent({ type: "response.output_item.done", output_index: 0, item: first })
  const b = await egress.responseEvent({ type: "response.output_item.done", output_index: 1, item: second })
  const duplicate = await egress.responseEvent({ type: "response.output_item.done", output_index: 2, item: { ...first, encrypted_content: "conflict" } })
  expect(duplicate.item).toEqual(a.item)
  const terminal = await egress.body("responses", { output: [first, second] })
  expect(terminal.output).toEqual([a.item, b.item])
  expect(a.item.encrypted_content).not.toBe(b.item.encrypted_content)
})

test("orphan Messages signature deltas fail closed instead of leaking raw state", async () => {
  await expect(collect(new AffinityEgress(await state()).messages(frames([
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "raw" } },
  ])))).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("sparse no-ID closed indices keep the same carrier after terminal compaction", async () => {
  const egress = new AffinityEgress(await state())
  const done = await egress.responseEvent({ type: "response.output_item.done", output_index: 5, item: { type: "reasoning", encrypted_content: "original" } })
  const terminal = await egress.responseEvent({ type: "response.completed", response: { output: [{ type: "reasoning", id: "later-id", encrypted_content: "conflict" }] } })
  expect(terminal.response.output[0]).toEqual(done.item)
})

test("hub guard rejects paced signatures before completion and closes the source with lazy codec", async () => {
  const { guardAffinityFrames } = await import("../../src/shared/affinity/egress.ts")
  const affinity = { ...await state(), codec: undefined }
  let consumed = 0
  let closed = false
  async function* source() {
    try {
      yield eventFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
      for (let i = 0; i < 40; i++) {
        consumed++
        yield eventFrame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "a".repeat(128 * 1024) } })
      }
    } finally { closed = true }
  }
  await expect(collect(guardAffinityFrames(source(), affinity))).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect(consumed).toBeLessThan(40)
  expect(closed).toBe(true)
})

test("hub guard bounds raw UTF-16 signatures and UTF-8 companions but preserves no-context streams", async () => {
  const { guardAffinityFrames } = await import("../../src/shared/affinity/egress.ts")
  const oversized = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "中".repeat(MAX_AFFINITY_PAYLOAD_BYTES / 2 + 1) } },
  ]
  await expect(collect(guardAffinityFrames(frames(oversized), await state()))).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect(await collect(guardAffinityFrames(frames(oversized), undefined))).toHaveLength(1)
  await expect(collect(guardAffinityFrames(frames([
    { type: "response.reasoning_summary_text.delta", item_id: "r", delta: "中".repeat(MAX_AFFINITY_PAYLOAD_BYTES / 3 + 1) },
  ]), await state()))).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("native guard and egress preserve opaque-looking application tool data", async () => {
  const { guardAffinityFrames } = await import("../../src/shared/affinity/egress.ts")
  const business = { type: "thinking", signature: "x".repeat(MAX_AFFINITY_PAYLOAD_BYTES + 1), encrypted_content: "business", fingerprint: "business" }
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "save", input: business } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "t", arguments: business } },
    { type: "response.completed", response: { output: [{ type: "function_call_output", output: business }] } },
  ]
  expect((await collect(guardAffinityFrames(frames(events), await state()))).map(frame => frame.type === "event" ? frame.event : null)).toEqual(events)
  const egress = new AffinityEgress(await state())
  expect(await egress.responseEvent(events[1])).toEqual(events[1])
})
