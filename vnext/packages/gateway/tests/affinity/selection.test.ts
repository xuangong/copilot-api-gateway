import { expect, test } from "bun:test"
import type { AffinityExecutionTarget, LlmProviderBinding, LlmModelProvider, ProviderRequest } from "@vibe-llm/provider-llm"
import { AffinityCodec } from "../../src/shared/affinity/carrier.ts"
import { AffinityRoutingUnavailableError, analyzeAffinityRequest, stampAffinityItem } from "../../src/shared/affinity/analysis.ts"
import { selectAffinityCandidate, materializeAffinity, type RequestAffinity } from "../../src/data-plane/shared/affinity-request.ts"
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
function candidate(prepare?: LlmModelProvider["prepareAffinityExecution"], endpoint: "responses" | "messages" = "responses") {
  const provider: LlmModelProvider = { name: "fixture", kind: "claude-code", supportedEndpoints: [endpoint], inboundHeaderAllowlist: ["anthropic-beta", "x-copilot-reasoning-effort"], getPricingForModelKey: () => null,
    getModels: async () => ({ object: "list", data: [] }), probe: async () => ({ ok: true }), fetch: async () => { throw new Error("selection must not infer") }, ...(prepare ? { prepareAffinityExecution: prepare } : {}) }
  const binding: LlmProviderBinding = { kind: "claude-code", upstream: "up", enabledFlags: new Set(), model: { id: "public", endpoints: { [endpoint]: {} } }, provider }
  return { binding, targetEndpoint: endpoint }
}
async function affinity(protocol: "responses" | "messages", source: Record<string, unknown>): Promise<RequestAffinity> { return { protocol, source, codec, analysis: await analyzeAffinityRequest(protocol, source, codec) } }

test("unknown-target Claude candidate degrades optional state but rejects required native state before dispatch", async () => {
  const unknown = candidate()
  const signed = await stampAffinityItem("responses", { type: "reasoning", encrypted_content: "optional" }, target, codec)
  const foreign = { type: "reasoning", encrypted_content: "foreign" }
  const state = await affinity("responses", { model: "public", input: [signed, foreign] })
  expect(await selectAffinityCandidate([unknown], state, "public")).toBe(unknown)
  expect(materializeAffinity(state, state.source, "public").input).toEqual([foreign])
  const required = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native" }, target, codec)
  await expect(selectAffinityCandidate([unknown], await affinity("responses", { input: [required] }), "public")).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
})

test("candidate preparation retains allowed effective headers, source protocol, tier, streaming and abort identity", async () => {
  const controller = new AbortController()
  let seen: Readonly<ProviderRequest> | undefined
  const binding = candidate(async request => { seen = request; return target })
  const signed = await stampAffinityItem("messages", { type: "thinking", thinking: "thought", signature: "opaque" }, target, codec)
  const original = { model: "public", stream: false, speed: "fast", max_tokens: 128, messages: [{ role: "assistant", content: [signed] }, { role: "user", content: "question" }] }
  const state = await affinity("messages", original)
  await selectAffinityCandidate([binding], state, "public", { signal: controller.signal, inboundHeaders: new Headers({ "authorization": "private", "anthropic-beta": "context-1m-2025-08-07", "x-copilot-reasoning-effort": "low" }), inheritedHeaders: { "x-copilot-reasoning-effort": "high" } })
  expect(seen?.signal).toBe(controller.signal)
  expect(seen?.sourceProtocol).toBe("messages")
  expect(seen?.sourceApi).toBe("openai")
  expect(seen?.flags?.isStreaming).toBe(false)
  expect(seen?.headers.has("authorization")).toBe(false)
  expect(seen?.headers.get("x-copilot-reasoning-effort")).toBe("high")
  expect(seen?.headers.get("anthropic-beta")).toBe("context-1m-2025-08-07")
  expect(seen?.payload).toMatchObject({ model: "public", service_tier: "priority" })
  expect(original.speed).toBe("fast")
  controller.abort()
  await expect(selectAffinityCandidate([binding], state, "public", { signal: controller.signal })).rejects.toThrow()
})

 test("ordinary requests never prepare candidate affinity", async () => {
  const first = candidate(async () => { throw new Error("must not prepare") })
  expect(await selectAffinityCandidate([first], await affinity("responses", { input: "hello" }), "public")).toBe(first)
})
