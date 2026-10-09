import { expect, test } from "bun:test"
import { AffinityCodec, InvalidAffinityStateError } from "../../src/shared/affinity/carrier"
import { analyzeAffinityRequest, stampAffinityItem } from "../../src/shared/affinity/analysis"
import { stampAffinityOrigin } from "../../src/shared/affinity/origin-anchor"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"

const sharedSecret = new Uint8Array(32).fill(9)
const target: AffinityExecutionTarget = { provider: "copilot", upstreamId: "local", upstreamIncarnation: "local-inc", credentialSubject: "account", credentialRevision: "1", model: "gpt-6-astra" }
const codec = (site: number, shared = true) => new AffinityCodec({ version: 1, keyId: `kid-${site}`, secret: new Uint8Array(32).fill(site), ownerId: `owner-${site}`, apiKeyId: `key-${site}`, ...(shared ? { sharedSecret } : {}) })

test("three independent instances authenticate shared native and origin state", async () => {
  const a = codec(1), b = codec(2), c = codec(3)
  const native = await stampAffinityItem("responses", { type: "reasoning", summary: [], content: [], encrypted_content: "opaque-native" }, target, a)
  const origin = await stampAffinityOrigin("responses", { type: "reasoning", summary: [] }, target, a)
  expect(native.encrypted_content).toStartWith("vnext-affinity:3:")
  expect(origin.encrypted_content).toStartWith("vnext-affinity:4:")
  for (const reader of [a, b, c]) {
    const plan = await analyzeAffinityRequest("responses", { input: [origin, { ...native, content: null }] }, reader)
    expect(plan.materialize(target).input).toEqual([{ ...native, content: null, encrypted_content: "opaque-native" }])
  }
  await expect(analyzeAffinityRequest("responses", { input: [native] }, codec(2, false))).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const different = new AffinityCodec({ version: 1, keyId: "x", secret: new Uint8Array(32).fill(1), ownerId: "o", apiKeyId: "k", sharedSecret: new Uint8Array(32).fill(8) })
  await expect(analyzeAffinityRequest("responses", { input: [origin] }, different)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await expect(analyzeAffinityRequest("responses", { input: [{ ...native, summary: [{ type: "summary_text", text: "changed" }] }] }, b)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("enabling shared mode retains local legacy authentication without making old history portable", async () => {
  const old = await stampAffinityItem("responses", { type: "reasoning", summary: [], encrypted_content: "old" }, target, codec(1, false))
  expect(old.encrypted_content).toStartWith("vnext-affinity:1:")
  expect((await analyzeAffinityRequest("responses", { input: [old] }, codec(1))).hasOwned).toBe(true)
  await expect(analyzeAffinityRequest("responses", { input: [old] }, codec(2))).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("shared carriers preserve agent opaque groups, reject substitution and bind protocol domains", async () => {
  const a = codec(1), b = codec(2)
  const original = { type: "agent_message", author: "a", recipient: "b", content: [
    { type: "encrypted_content", encrypted_content: "opaque-one" },
    { type: "encrypted_content", encrypted_content: "opaque-two" },
  ] }
  const signed = await stampAffinityItem("responses", original, target, a)
  expect((await analyzeAffinityRequest("responses", { input: [signed] }, b)).materialize(target).input).toEqual([original])
  const changed = structuredClone(signed)
  if (!Array.isArray(changed.content)) throw new Error("Missing fixture content")
  changed.content[1] = changed.content[0]
  await expect(analyzeAffinityRequest("responses", { input: [changed] }, b)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const field = { domain: "messages/thinking/signature", block: '{"thinking":"hello"}' }
  const carrier = await a.encode("native", target, field)
  await expect(b.decode(carrier, { ...field, domain: "responses/reasoning/encrypted_content" })).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await expect(b.decode(carrier.replace("vnext-affinity:3:", "vnext-affinity:1:"), field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await expect(b.decode(carrier.replace("vnext-affinity:3:", "vnext-affinity:9:"), field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})
