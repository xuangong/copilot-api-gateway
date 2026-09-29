import { afterEach, expect, test } from "bun:test"
import { setupTestPlatform } from "../_setup-platform.ts"
import { createRequestAffinity, materializeAffinity, selectAffinityCandidate } from "../../src/data-plane/shared/affinity-request.ts"
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
  const codec = await state?.loadCodec?.()
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

test("owned markers authenticate before any candidate preparation", async () => {
  const auth = setup()
  const foreign = new AffinityCodec({ ownerId: "other", apiKeyId: "other", version: 1, keyId: "other", secret: new Uint8Array(32).fill(3) })
  const signed = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native" }, target, foreign)
  await expect(createRequestAffinity("responses", { input: [signed] }, auth)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})
