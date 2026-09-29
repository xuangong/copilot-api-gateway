import { expect, spyOn, test } from "bun:test"
import { eventFrame } from "@vibe-core/result"
import { AffinityEgress, guardAffinityFrames } from "../../src/shared/affinity/egress.ts"
import { InvalidAffinityStateError, MAX_AFFINITY_PAYLOAD_BYTES } from "../../src/shared/affinity/carrier.ts"
import { JsonStringBudget } from "../../src/shared/affinity/json-string-budget.ts"
import type { RequestAffinity } from "../../src/shared/affinity/context.ts"

const affinity = {
  protocol: "responses",
  actual: { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" },
} as RequestAffinity

async function* frames(events: Record<string, unknown>[]) {
  for (const event of events) yield eventFrame(event)
}

test.each(["summary", "messages", "chat"] as const)("%s delta budgets do not reserialize accumulated reasoning", async kind => {
  const fragment = "a".repeat(32)
  const events: Record<string, unknown>[] = kind === "messages"
    ? [{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }]
    : []
  for (let i = 0; i < 128; i++) events.push(kind === "summary"
    ? { type: "response.reasoning_summary_text.delta", item_id: "r", delta: fragment }
    : kind === "messages" ? { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: fragment } }
      : { choices: [{ index: 0, delta: { reasoning_text: fragment }, finish_reason: null }] })
  if (kind === "messages") events.push({ type: "content_block_stop", index: 0 })
  if (kind === "chat") events.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  const stringify = JSON.stringify
  let serializedUnits = 0
  const observer = spyOn(JSON, "stringify").mockImplementation((...args) => {
    const value: unknown = args[0]
    if (typeof value === "string") serializedUnits += value.length
    else if (value && typeof value === "object" && "thinking" in value && typeof value.thinking === "string") serializedUnits += value.thinking.length
    return stringify(...args)
  })
  let emitted = 0
  try {
    const guarded = guardAffinityFrames(frames(events), affinity)
    const output = kind === "messages" ? new AffinityEgress(affinity).messages(guarded)
      : kind === "chat" ? new AffinityEgress(affinity).chat(guarded) : guarded
    for await (const _frame of output) emitted++
  } finally { observer.mockRestore() }
  expect(emitted).toBe(events.length)
  expect(serializedUnits).toBeLessThanOrEqual(fragment.length * 128 * 2)
})

test("signature classification scans new fragments instead of the accumulated prefix", async () => {
  const events: Record<string, unknown>[] = [{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }]
  for (let i = 0; i < 128; i++) events.push({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "A".repeat(32) } })
  events.push({ type: "content_block_stop", index: 0 })
  const pattern = /[^A-Za-z0-9+/_=\s-]/.source
  const testRegex = RegExp.prototype.test
  let scannedUnits = 0
  const observer = spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value) {
    if (this.source === pattern) scannedUnits += value.length
    return testRegex.call(this, value)
  })
  try { for await (const _frame of guardAffinityFrames(frames(events), affinity)) { /* consume */ } }
  finally { observer.mockRestore() }
  expect(scannedUnits).toBe(4096)
})

test("incremental JSON bytes match every prefix across escapes and split UTF-16 boundaries", () => {
  const units = [0, 1, 8, 9, 10, 12, 13, 31, 34, 47, 92, 127, 128, 2047, 2048, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xffff]
  const encoder = new TextEncoder()
  for (const a of units) for (const b of units) for (const c of units) {
    const value = String.fromCharCode(a, b, c)
    for (const fragments of [[value], [value.slice(0, 1), value.slice(1)], [value.slice(0, 2), value.slice(2)], [value[0]!, "", value[1]!, "", value[2]!]]) {
      const budget = new JsonStringBudget()
      let text = ""
      for (const fragment of fragments) {
        text += fragment
        budget.append(fragment)
        expect(budget.byteLength).toBe(encoder.encode(JSON.stringify(text)).length)
      }
    }
  }
})

test.each(["summary", "messages", "chat"] as const)("%s rejects an oversized lone half immediately without waiting for a later pair", async kind => {
  const overhead = kind === "summary" ? 2 : 15
  const text = "a".repeat(MAX_AFFINITY_PAYLOAD_BYTES - overhead - 5)
  let consumed = 0, closed = false
  async function* source() {
    try {
      if (kind === "messages") yield eventFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })
      for (const fragment of [text, "\ud800", "", "\udc00"]) {
        consumed++
        yield eventFrame(kind === "summary" ? { type: "response.reasoning_summary_text.delta", item_id: "r", delta: fragment }
          : kind === "messages" ? { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: fragment } }
            : { choices: [{ index: 0, delta: { reasoning_text: fragment }, finish_reason: null }] })
      }
    } finally { closed = true }
  }
  await expect(Array.fromAsync(guardAffinityFrames(source(), affinity))).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect(consumed).toBe(2)
  expect(closed).toBe(true)
})

test("interleaved Messages blocks maintain independent text budgets and signatures", async () => {
  const text = "a".repeat(MAX_AFFINITY_PAYLOAD_BYTES - 15)
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: text } },
    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: text } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "AA==" } },
    { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "raw!" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_stop", index: 0 },
  ]
  expect(await Array.fromAsync(guardAffinityFrames(frames(events), affinity))).toEqual(events.map(eventFrame))
})
