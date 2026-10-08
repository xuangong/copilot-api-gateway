import { expect, test } from "bun:test"
import type { AffinityExecutionTarget, LlmProviderBinding, LlmModelProvider, ProviderRequest } from "@vibe-llm/provider-llm"
import type { EndpointKey } from "@vibe-llm/protocols/common"
import { AffinityCodec } from "../../src/shared/affinity/carrier.ts"
import { AffinityRoutingUnavailableError, analyzeAffinityRequest, stampAffinityItem } from "../../src/shared/affinity/analysis.ts"
import type { AffinityProtocol } from "../../src/shared/affinity/analysis.ts"
import { stampAffinityOrigin } from "../../src/shared/affinity/origin-anchor.ts"
import { getTranslator } from "../../src/data-plane/dispatch/translator-registry.ts"
import { affinityFence, materializeAffinity, selectAffinityCandidate, type RequestAffinity } from "../../src/data-plane/shared/affinity-request.ts"

const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
function candidate(prepare: LlmModelProvider["prepareAffinityExecution"], endpoint: EndpointKey = "responses") {
  const provider: LlmModelProvider = { name: "fixture", kind: "custom", supportedEndpoints: [endpoint], getPricingForModelKey: () => null, getModels: async () => ({ object: "list", data: [] }), probe: async () => ({ ok: true }), fetch: async () => { throw new Error("selection must not infer") }, prepareAffinityExecution: prepare }
  const binding: LlmProviderBinding = { kind: "custom", upstream: "up", enabledFlags: new Set(), model: { id: "public", endpoints: { [endpoint]: {} } }, provider }
  return { binding, targetEndpoint: endpoint }
}
async function affinity(inherit = false): Promise<RequestAffinity> {
  expect(typeof codec.encodeOrigin).toBe("function")
  const signed = { type: "reasoning", summary: [], encrypted_content: await codec.encodeOrigin(target, { domain: "responses/reasoning/encrypted_content", block: '{"summary":[]}' }, { syntheticItem: true }) }
  const input = [signed, ...(inherit ? [{ type: "program_output", result: "ok" }] : []), { role: "user", content: "question" }]
  return { execution: { protocol: "responses", codec }, analysis: await analyzeAffinityRequest("responses", { input }, codec) }
}

test("origin-only history never prepares candidates, sets a fence, or blocks a cross-protocol first choice", async () => {
  const first = candidate(async () => { throw new Error("must not prepare") }, "chat_completions")
  const later = candidate(async () => { throw new Error("must not materialize") })
  const state = await affinity()
  const materialized: unknown[] = []
  expect(await selectAffinityCandidate([first, later], state, "public", {}, async value => { materialized.push(value); return value })).toBe(first)
  expect(materialized).toEqual([first])
  expect(state.execution.selected).toBeUndefined()
  expect(affinityFence(state.execution)).toBeUndefined()
  expect(materializeAffinity(state, {}, "public")).toEqual({ model: "public", input: [{ role: "user", content: "question" }] })
})

test("required inherited state prepares clean source and binds selected actual execution", async () => {
  let seen: Readonly<ProviderRequest> | undefined
  const selected = candidate(async request => { seen = request; return target })
  const state = await affinity(true)
  expect(await selectAffinityCandidate([selected], state, "public")).toBe(selected)
  expect(seen?.payload).toMatchObject({ input: [{ type: "program_output", result: "ok" }, { role: "user", content: "question" }] })
  expect(JSON.stringify(seen?.payload)).not.toContain("vnext-affinity:")
  expect(JSON.stringify(state.analysis.cloneSource())).toContain("vnext-affinity:2:")
  expect(state.execution.selected).toEqual(target)
  const fence = affinityFence(state.execution)
  expect(fence).toBeDefined()
  await fence!(target)
  await expect(fence!({ ...target, credentialRevision: "changed" })).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
})

test("inherited source never grants unauthorized or incompatible candidates a route", async () => {
  const wrong = candidate(async () => ({ ...target, upstreamId: "other" }))
  await expect(selectAffinityCandidate([wrong], await affinity(true), "public")).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
  await expect(selectAffinityCandidate([], await affinity(true), "public")).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
  const incompatibleEndpoint = candidate(async () => target, "messages")
  await expect(selectAffinityCandidate([incompatibleEndpoint], await affinity(true), "public")).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
})

test("all nine registered cross-protocol pairs preserve authorized order for origin-only history", async () => {
  const source = async (protocol: AffinityProtocol): Promise<Record<string, unknown>> => {
    if (protocol === "responses") return { input: [await stampAffinityOrigin(protocol, { type: "reasoning", summary: [] }, target, codec), { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] }] }
    if (protocol === "messages") return { max_tokens: 32, messages: [{ role: "assistant", content: [await stampAffinityOrigin(protocol, { type: "redacted_thinking" }, target, codec), { type: "text", text: "answer" }] }, { role: "user", content: "question" }] }
    if (protocol === "chat_completions") return { messages: [await stampAffinityOrigin(protocol, { role: "assistant", content: "answer" }, target, codec), { role: "user", content: "question" }] }
    return { contents: [{ role: "model", parts: [await stampAffinityOrigin(protocol, { text: "answer" }, target, codec)] }, { role: "user", parts: [{ text: "question" }] }] }
  }
  const pairs = [
    ["chat_completions", "messages"], ["chat_completions", "responses"],
    ["messages", "chat_completions"], ["messages", "responses"],
    ["responses", "chat_completions"], ["responses", "messages"],
    ["gemini", "chat_completions"], ["gemini", "responses"], ["gemini", "messages"],
  ] as const
  for (const [protocol, endpoint] of pairs) {
    const body = await source(protocol)
    const state: RequestAffinity = { execution: { protocol, codec }, analysis: await analyzeAffinityRequest(protocol, body, codec) }
    const first = candidate(async () => { throw new Error("origin-only must not prepare") }, endpoint)
    const second = candidate(async () => target, endpoint)
    expect(await selectAffinityCandidate([first, second], state, "public")).toBe(first)
    expect(state.execution.selected).toBeUndefined()
    const prepared = materializeAffinity(state, {}, "public")
    const translated = await getTranslator(protocol, endpoint)!.translateRequest(prepared, { signal: new AbortController().signal, model: "public", fallbackMaxOutputTokens: 32 })
    expect(JSON.stringify(translated)).not.toContain("vnext-affinity:")
    expect(JSON.stringify(translated)).toContain("answer")
    expect(JSON.stringify(translated)).toContain("question")
  }
})

test("mixed Gemini native state and origin metadata prepare as one natural signature", async () => {
  const native = await stampAffinityItem("gemini", { thought: true, text: "native thought", thoughtSignature: "native" }, target, codec)
  const ordinary = await stampAffinityOrigin("gemini", { text: "answer" }, target, codec)
  const source = { contents: [{ role: "model", parts: [native, ordinary] }, { role: "user", parts: [{ text: "question" }] }] }
  const state: RequestAffinity = { execution: { protocol: "gemini", codec }, analysis: await analyzeAffinityRequest("gemini", source, codec) }
  let seen: Readonly<ProviderRequest> | undefined
  const selected = candidate(async request => { seen = request; return target }, "messages")
  expect(await selectAffinityCandidate([selected], state, "public")).toBe(selected)
  expect(JSON.stringify(seen?.payload)).not.toContain("vnext-affinity:2:")
  expect(JSON.stringify(seen?.payload)).toContain("vnext-affinity:1:")
  expect(JSON.stringify(seen?.payload)).toContain("answer")
  expect(state.analysis.cloneSource()).toEqual(source)
  expect(state.analysis.materialize(target)).toEqual({ contents: [{ role: "model", parts: [{ thought: true, text: "native thought", thoughtSignature: "native" }, { text: "answer" }] }, { role: "user", parts: [{ text: "question" }] }] })
})
