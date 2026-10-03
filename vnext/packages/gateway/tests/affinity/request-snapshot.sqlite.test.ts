import { afterEach, expect, test } from "bun:test"
import { setupTestPlatform } from "../_setup-platform.ts"
import { acceptAffinityExecution, createRequestAffinity, materializeAffinity, selectAffinityCandidate } from "../../src/data-plane/shared/affinity-request.ts"
import { AffinityEgress } from "../../src/shared/affinity/egress.ts"
import { AffinityCodec, InvalidAffinityStateError } from "../../src/shared/affinity/carrier.ts"
import { stampAffinityItem } from "../../src/shared/affinity/analysis.ts"
import type { AffinityExecutionTarget, LlmProviderBinding } from "@vibe-llm/provider-llm"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "model" }
function setup() {
  const { db } = setupTestPlatform()
  cleanup.push(() => db.close())
  db.run("INSERT INTO api_keys (id, name, key, owner_id, created_at) VALUES ('key', 'test', 'fixture-key', 'owner', 'now')")
  return { ownerId: "owner", apiKeyId: "key" }
}
function input(body: Record<string, unknown>): Array<{ content: Array<{ text: string }> }> {
  return body.input as Array<{ content: Array<{ text: string }> }>
}

test("ordinary affinity captures its input once and isolates nested provider mutations on every attempt", async () => {
  const auth = setup()
  let captures = 0
  const message = { role: "user", content: [{ type: "input_text", get text() { captures++; return "original" } }] }
  const source = { model: "alias", input: [message], tools: [{ name: "tool", parameters: { properties: { value: { type: "string" } } } }] }
  const state = await createRequestAffinity("responses", source, auth)
  // Each traversal of the original nested graph represents another complete
  // snapshot allocation. Large input strings make that duplication expensive.
  expect(captures).toBe(1)
  const first = materializeAffinity(state, source, "model")
  const text = input(first)[0]?.content[0]
  if (!text) throw new Error("missing input")
  text.text = "provider mutation"
  first.tools = []
  source.input.length = 0
  const retry = materializeAffinity(state, source, "model")
  expect(input(retry)[0]?.content[0]?.text).toBe("original")
  expect(retry.tools).toEqual([{ name: "tool", parameters: { properties: { value: { type: "string" } } } }])
  expect(retry.model).toBe("model")
  expect(state?.analysis.hasOwned).toBe(false)
})

test("owned candidate preparation gets independent carrier copies while inference receives decoded state", async () => {
  const auth = setup()
  const state = await createRequestAffinity("responses", {}, auth)
  const codec = await state?.execution.loadCodec?.()
  if (!codec) throw new Error("missing codec")
  const signed = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native" }, target, codec)
  const source = { input: [signed] }
  const owned = await createRequestAffinity("responses", source, auth)
  const seen: unknown[] = []
  const binding: LlmProviderBinding = { kind: "custom", upstream: "up", model: { id: "model", endpoints: { responses: {} } }, provider: {
    name: "fixture", kind: "custom", supportedEndpoints: ["responses"], getPricingForModelKey: () => null,
    getModels: async () => ({ object: "list", data: [] }), probe: async () => ({ ok: true }), fetch: async () => { throw new Error("must not infer") },
    prepareAffinityExecution: async request => {
      const payload = request.payload as Record<string, unknown>
      const items = payload.input as Array<Record<string, unknown>>
      seen.push(items[0]?.encrypted_content)
      if (items[0]) items[0].encrypted_content = "mutated"
      return target
    },
  } }
  const candidate = { binding, targetEndpoint: "responses" as const }
  await Promise.all([selectAffinityCandidate([candidate, candidate], owned, "model"), selectAffinityCandidate([candidate], owned, "model")])
  expect(seen).toEqual([signed.encrypted_content, signed.encrypted_content, signed.encrypted_content])
  expect(materializeAffinity(owned, source, "model").input).toEqual([{ type: "compaction", encrypted_content: "native" }])
  expect(source.input).toEqual([signed])
})

test("candidate mutations and exact-degraded-exact attempts preserve the private carrier snapshot", async () => {
  const auth = setup()
  const initial = await createRequestAffinity("responses", {}, auth)
  const codec = await initial?.execution.loadCodec?.()
  if (!codec) throw new Error("missing codec")
  const signed = await stampAffinityItem("responses", { type: "reasoning", encrypted_content: "native", summary: [] }, target, codec)
  const source = { model: "alias", input: [signed, { type: "message", role: "user", content: "keep" }], extra: { text: "original" } }
  const state = await createRequestAffinity("responses", source, auth)
  if (!state) throw new Error("missing affinity state")
  const candidate = state.analysis.cloneSource()
  const candidateItems = candidate.input as Array<Record<string, unknown>>
  const candidateReasoning = candidateItems[0]
  if (!candidateReasoning) throw new Error("missing candidate reasoning")
  candidateReasoning.encrypted_content = "candidate mutation"
  candidateItems.splice(1, 1)
  candidate.extra = { text: "candidate mutation" }
  source.extra.text = "source mutation"
  signed.encrypted_content = "source mutation"

  state.execution.selected = target
  const first = materializeAffinity(state, source, "model")
  expect(first.input).toEqual([{ type: "reasoning", encrypted_content: "native", summary: [] }, { type: "message", role: "user", content: "keep" }])
  expect(first.extra).toEqual({ text: "original" })
  const firstItems = first.input as Array<Record<string, unknown>>
  const firstReasoning = firstItems[0]
  if (!firstReasoning) throw new Error("missing first reasoning")
  firstReasoning.encrypted_content = "attempt mutation"
  firstItems.length = 0

  state.execution.selected = { ...target, upstreamId: "other" }
  expect(state.analysis.classify(state.execution.selected)).toBe("degraded")
  const degraded = materializeAffinity(state, source, "other-model")
  expect(degraded.input).toEqual([{ type: "message", role: "user", content: "keep" }])
  expect(degraded.model).toBe("other-model")
  const degradedItems = degraded.input as unknown[]
  degradedItems.length = 0

  state.execution.selected = target
  const retry = materializeAffinity(state, source, "model")
  expect(retry.input).toEqual([{ type: "reasoning", encrypted_content: "native", summary: [] }, { type: "message", role: "user", content: "keep" }])
  expect(retry.extra).toEqual({ text: "original" })
  expect(retry.model).toBe("model")
  const carrierCopy = state.analysis.cloneSource().input as Array<Record<string, unknown>>
  expect(carrierCopy[0]?.encrypted_content).toStartWith("vnext-affinity:1:")
})

test("owned markers authenticate before any candidate preparation", async () => {
  const auth = setup()
  const foreign = new AffinityCodec({ ownerId: "other", apiKeyId: "other", version: 1, keyId: "other", secret: new Uint8Array(32).fill(3) })
  const signed = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native" }, target, foreign)
  await expect(createRequestAffinity("responses", { input: [signed] }, auth)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("execution-only egress observes later identity and plaintext compaction registration", async () => {
  const preparation = await createRequestAffinity("responses", { input: "large preparation input" }, setup())
  const execution = preparation?.execution
  expect(execution).toBeDefined()
  if (!execution) throw new Error("missing execution state")
  const egress = new AffinityEgress(execution)
  acceptAffinityExecution(execution, { status: 200, headers: new Headers(), body: null, affinityExecution: target })
  execution.plaintextCompactions?.add(JSON.stringify(["plain", "summary"]))
  const result = await egress.body("responses", { output: [
    { id: "plain", type: "compaction", encrypted_content: "summary" },
    { id: "native", type: "reasoning", encrypted_content: "opaque" },
  ] })
  expect(result.output[0]?.encrypted_content).toBe("summary")
  expect(result.output[1]?.encrypted_content).toStartWith("vnext-affinity:1:")
})
