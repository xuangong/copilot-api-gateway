import { expect, test } from "bun:test"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import { AFFINITY_MARKER, AffinityCodec, InvalidAffinityStateError } from "../../src/shared/affinity/carrier.ts"
import { AffinityRoutingUnavailableError, analyzeAffinityRequest, stampAffinityItem } from "../../src/shared/affinity/analysis.ts"
import { stampAffinityOrigin } from "../../src/shared/affinity/origin-anchor.ts"
import { appendOpaqueTrailer, splitOpaqueTrailer } from "@vibe-llm/protocols/common"

const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
const other = { ...target, model: "other" }
const secret = { version: 1 as const, keyId: "kid", secret: new Uint8Array(32).fill(3) }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", ...secret })
const field = { domain: "responses/reasoning/encrypted_content", block: '{"summary":[]}' }
async function origin(targetValue = target) {
  expect(typeof codec.encodeOrigin).toBe("function")
  return { type: "reasoning", summary: [], encrypted_content: await codec.encodeOrigin(targetValue, field, { syntheticItem: true }) }
}

test("v2 has authenticated absent native value distinct from a v1 empty native string", async () => {
  const item = await origin()
  expect(item.encrypted_content.startsWith(`${AFFINITY_MARKER}2:`)).toBe(true)
  expect(await codec.decode(item.encrypted_content, field)).toEqual({ kind: "origin", target, syntheticItem: true })
  const natural = await codec.encode("", target, field)
  expect(await codec.decode(natural, field)).toEqual({ kind: "owned", target, synthetic: false, value: "" })
  const plan = await analyzeAffinityRequest("responses", { input: [{ ...item, encrypted_content: natural }] }, codec)
  expect(plan.hasRouteConstraints).toBe(true)
  expect(plan.classify(other)).toBe("degraded")
  expect(plan.materialize(target).input).toEqual([{ ...item, encrypted_content: "" }])
})

test("v2 authenticates provenance and its domain independently of mutable visible content", async () => {
  const item = await origin()
  for (const changed of [
    { ownerId: "other", apiKeyId: "key", ...secret },
    { ownerId: "owner", apiKeyId: "other", ...secret },
    { ownerId: "owner", apiKeyId: "key", ...secret, keyId: "other" },
    { ownerId: "owner", apiKeyId: "key", ...secret, secret: new Uint8Array(32).fill(4) },
  ]) await expect(new AffinityCodec(changed).decode(item.encrypted_content, field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  for (const changed of [
    { domain: "messages/thinking/signature", block: '{"thinking":""}' },
    { ...field, domain: "responses/program/fingerprint" },
  ]) await expect(codec.decode(item.encrypted_content, changed)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect(await codec.decode(item.encrypted_content, { ...field, block: "mutable visible content" })).toEqual({ kind: "origin", target, syntheticItem: true })
  const offset = `${AFFINITY_MARKER}2:`.length
  for (const value of [
    item.encrypted_content.replace(`${AFFINITY_MARKER}2:`, `${AFFINITY_MARKER}1:`),
    item.encrypted_content.replace(`${AFFINITY_MARKER}2:`, `${AFFINITY_MARKER}3:`),
    item.encrypted_content.slice(0, offset) + (item.encrypted_content[offset] === "A" ? "B" : "A") + item.encrypted_content.slice(offset + 1),
  ]) await expect(codec.decode(value, field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("origin codec rejects unsupported domains and synthetic identity mismatches", async () => {
  expect(typeof codec.encodeOrigin).toBe("function")
  for (const domain of ["responses/program/encrypted_content", "responses/agent_message/encrypted_content", "messages/thinking/signature", "unknown"]) {
    await expect(codec.encodeOrigin(target, { domain }, { syntheticItem: true })).rejects.toBeInstanceOf(InvalidAffinityStateError)
  }
  await expect(codec.encodeOrigin(target, field, { syntheticItem: false })).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await expect(codec.encodeOrigin(target, { domain: "chat_completions/reasoning/reasoning_opaque", block: '{"reasoning_text":""}' }, { syntheticItem: true })).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("ordinary origin authenticates history while every candidate retains first-available rank", async () => {
  const item = await origin()
  const body = { input: [item, { role: "user", content: "question" }] }
  const plan = await analyzeAffinityRequest("responses", body, codec)
  expect(plan.hasOwned).toBe(true)
  expect(plan.hasRequiredOwned).toBe(false)
  expect(plan.hasRouteConstraints).toBe(false)
  for (const candidate of [target, other, undefined]) expect(plan.classify(candidate)).toBe("exact")
  expect(plan.rankAuthorizedCandidates([other, target, undefined], value => value)).toEqual([other, target, undefined])
  expect(plan.cloneSource()).toEqual(body)
  expect(plan.prepareSource()).toEqual({ input: [body.input[1]] })
  expect(plan.materialize(undefined)).toEqual({ input: [body.input[1]] })
  expect(body.input[0]).toEqual(item)
})

test("Responses origin deletion requires authentication and exact empty shape", async () => {
  const item = await origin()
  for (const changed of [
    { ...item, type: "program_output" },
    { ...item, summary: [{ type: "summary_text", text: "real reasoning" }] },
    { ...item, content: [] }, { ...item, custom: "must not delete" },
    { ...item, id: { nested: "content" } }, { ...item, status: { nested: "content" } },
  ]) await expect(analyzeAffinityRequest("responses", { input: [changed] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect((await analyzeAffinityRequest("responses", { input: [{ ...item, id: "changed-id", status: "completed" }] }, codec)).materialize(undefined).input).toEqual([])
  const foreign = { type: "reasoning", id: "affinity_fake", summary: [], encrypted_content: "foreign" }
  expect((await analyzeAffinityRequest("responses", { input: [foreign] }, codec)).materialize(undefined).input).toEqual([foreign])
})

test("Chat removes only origin metadata and preserves meaningful tool, reasoning, refusal and audio fields", async () => {
  expect(typeof codec.encodeOrigin).toBe("function")
  const message = { role: "assistant", content: "answer", reasoning_text: "visible", reasoning_content: "visible", reasoning: "visible", reasoning_items: [{ text: "keep" }], tool_calls: [{ id: "call", type: "function", function: { name: "f", arguments: "{}" } }], refusal: "no", audio: { id: "audio" }, provider_data: { keep: true } }
  const chatField = { domain: "chat_completions/reasoning/reasoning_opaque", block: '{"reasoning_text":"visible"}' }
  const signed = { ...message, reasoning_opaque: await codec.encodeOrigin(target, chatField, { syntheticItem: false }) }
  const tool = { role: "tool", tool_call_id: "call", content: "done" }
  const plan = await analyzeAffinityRequest("chat_completions", { messages: [signed, tool] }, codec)
  expect(plan.hasRouteConstraints).toBe(false)
  expect(plan.materialize(other).messages).toEqual([message, tool])
  expect(plan.prepareSource().messages).toEqual([message, tool])
  await expect(analyzeAffinityRequest("chat_completions", { messages: [{ ...signed, role: "user" }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const merged = { ...signed, reasoning_text: "stream-merged text" }
  expect((await analyzeAffinityRequest("chat_completions", { messages: [merged] }, codec)).materialize(other).messages).toEqual([{ ...message, reasoning_text: "stream-merged text" }])
})

test("Messages synthetic origin and Gemini metadata remain removable beside real tool state", async () => {
  expect(typeof codec.encodeOrigin).toBe("function")
  const thinking = { type: "redacted_thinking", data: await codec.encodeOrigin(target, { domain: "messages/redacted_thinking/data", block: "{}" }, { syntheticItem: true }) }
  const tool = { type: "tool_use", id: "call", name: "f", input: {} }
  const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "ok" }] }
  const messages = { messages: [{ role: "assistant", content: [thinking, tool] }, result] }
  const messagePlan = await analyzeAffinityRequest("messages", messages, codec)
  expect(messagePlan.hasRouteConstraints).toBe(false)
  expect(messagePlan.materialize(other)).toEqual({ messages: [{ role: "assistant", content: [tool] }, result] })
  for (const changed of [{ ...thinking, extra: "real" }, { ...thinking, thinking: "real" }]) {
    await expect(analyzeAffinityRequest("messages", { messages: [{ role: "assistant", content: [changed] }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  }
  await expect(analyzeAffinityRequest("messages", { messages: [{ role: "user", content: [thinking] }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const part = { text: "original", thoughtSignature: await codec.encodeOrigin(target, { domain: "gemini/part/thoughtSignature", block: '{"text":"original"}' }, { syntheticItem: false }) }
  const call = { functionCall: { name: "f", args: {} } }
  const geminiPlan = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [part, call] }] }, codec)
  expect(geminiPlan.hasRouteConstraints).toBe(false)
  expect(geminiPlan.materialize(other)).toEqual({ contents: [{ role: "model", parts: [{ text: "original" }, call] }] })
  const merged = { ...part, text: "original and a later chunk", functionCall: call.functionCall, providerData: { preserve: true } }
  expect((await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [merged] }] }, codec)).materialize(other)).toEqual({ contents: [{ role: "model", parts: [{ text: "original and a later chunk", functionCall: call.functionCall, providerData: { preserve: true } }] }] })
  await expect(analyzeAffinityRequest("gemini", { contents: [{ role: "user", parts: [part] }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("blobless Responses state inherits preceding native provenance and rejects mismatches", async () => {
  const native = await stampAffinityItem("responses", { type: "reasoning", encrypted_content: "native" }, target, codec)
  for (const type of ["program", "program_output", "compaction", "compaction_summary"]) {
    const state = { type, result: "native state" }
    const plan = await analyzeAffinityRequest("responses", { input: [native, { type: "message", content: "middle" }, state] }, codec)
    expect(plan.hasRequiredOwned).toBe(true)
    expect(plan.hasRouteConstraints).toBe(true)
    expect(plan.classify(target)).toBe("exact")
    for (const candidate of [other, undefined]) {
      expect(plan.classify(candidate)).toBe("unavailable")
      expect(() => plan.materialize(candidate)).toThrow(AffinityRoutingUnavailableError)
    }
    expect(plan.materialize(target).input).toEqual([{ type: "reasoning", encrypted_content: "native" }, { type: "message", content: "middle" }, state])
  }
})

test("origin inheritance accumulates required targets rather than replacing prior requirements", async () => {
  const a = await origin(target)
  const b = await origin(other)
  const program = { type: "program_output", result: "ok" }
  const first = await analyzeAffinityRequest("responses", { input: [a, program] }, codec)
  expect(first.hasRequiredOwned).toBe(true)
  expect(first.classify(other)).toBe("unavailable")
  expect(first.materialize(target).input).toEqual([program])
  const conflicting = await analyzeAffinityRequest("responses", { input: [a, program, b, program] }, codec)
  expect(conflicting.rankAuthorizedCandidates([target, other], value => value)).toEqual([])
})

test("compatible native identities satisfy inherited state across models", async () => {
  const compatible = { ...target, compatibility: { version: 1 as const, key: "family", scope: "credential" as const } }
  const changedModel = { ...compatible, model: "compatible" }
  const a = await origin(compatible)
  const b = await origin(changedModel)
  const state = { type: "compaction", summary: "state" }
  const plan = await analyzeAffinityRequest("responses", { input: [a, state, b, state] }, codec)
  expect(plan.classify(compatible)).toBe("compatible")
  expect(plan.classify(changedModel)).toBe("compatible")
  expect(plan.materialize(changedModel).input).toEqual([state, state])
})

test("a recognized foreign blob suppresses only its own inheritance and never clears earlier provenance", async () => {
  const a = await origin()
  for (const slot of ["encrypted_content", "fingerprint"]) {
    const foreign = { type: "program_output", [slot]: "foreign", result: "state" }
    const current = await analyzeAffinityRequest("responses", { input: [a, foreign] }, codec)
    expect(current.hasRequiredOwned).toBe(false)
    expect(current.hasRouteConstraints).toBe(false)
    expect(current.materialize(other).input).toEqual([foreign])
    const later = await analyzeAffinityRequest("responses", { input: [a, foreign, { type: "program_output", result: "later" }] }, codec)
    expect(later.classify(other)).toBe("unavailable")
    expect(later.materialize(target).input).toEqual([foreign, { type: "program_output", result: "later" }])
  }
})

test("blobless context_compaction and unowned state do not acquire guessed requirements", async () => {
  const raw = [{ type: "program", code: "before any source" }, await origin(), { type: "context_compaction", summary: "optional" }]
  const plan = await analyzeAffinityRequest("responses", { input: raw }, codec)
  expect(plan.hasRequiredOwned).toBe(false)
  expect(plan.hasRouteConstraints).toBe(false)
  expect(plan.materialize(undefined).input).toEqual([raw[0], raw[2]])
})

test("preparation removes all origins in index order while canonical history and native carriers remain intact", async () => {
  const native = await stampAffinityItem("responses", { type: "reasoning", encrypted_content: "native" }, target, codec)
  const a = await origin()
  const body = { input: [a, native, a, { type: "program_output", result: "state" }, a] }
  const plan = await analyzeAffinityRequest("responses", body, codec)
  const prepared = plan.prepareSource()
  expect(prepared.input).toEqual([native, body.input[3]])
  expect(plan.cloneSource()).toEqual(body)
  expect(plan.materialize(target).input).toEqual([{ type: "reasoning", encrypted_content: "native" }, body.input[3]])
  prepared.input = []
  expect(plan.prepareSource().input).toEqual([native, body.input[3]])
})

test("origin helper stamps supported protocol slots and never overwrites a native empty value", async () => {
  const fixtures = [
    { protocol: "responses" as const, item: { type: "reasoning", id: "rs_origin", summary: [] }, key: "encrypted_content", syntheticItem: true, domain: "responses/reasoning/encrypted_content" },
    { protocol: "messages" as const, item: { type: "redacted_thinking" }, key: "data", syntheticItem: true, domain: "messages/redacted_thinking/data" },
    { protocol: "chat_completions" as const, item: { role: "assistant", content: "answer", providerData: { preserve: true } }, key: "reasoning_opaque", syntheticItem: false, domain: "chat_completions/reasoning/reasoning_opaque" },
    { protocol: "gemini" as const, item: { functionCall: { name: "f", args: { hello: true } } }, key: "thoughtSignature", syntheticItem: false, domain: "gemini/part/thoughtSignature" },
  ]
  for (const fixture of fixtures) {
    const before = structuredClone(fixture.item)
    const signed = await stampAffinityOrigin(fixture.protocol, fixture.item, target, codec)
    expect(await codec.decode(signed[fixture.key] as string, { domain: fixture.domain })).toEqual({ kind: "origin", target, syntheticItem: fixture.syntheticItem })
    expect(fixture.item).toEqual(before)
    await expect(stampAffinityOrigin(fixture.protocol, { ...fixture.item, [fixture.key]: "" }, target, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
    await expect(stampAffinityOrigin(fixture.protocol, signed, target, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  }
  await expect(stampAffinityOrigin("responses", { type: "reasoning", summary: [], content: "real" }, target, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await expect(stampAffinityOrigin("messages", { type: "redacted_thinking", text: "real" }, target, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("origin carrier rejects appended native bytes, oversized and malformed frames", async () => {
  const signed = await origin()
  const trailer = splitOpaqueTrailer(signed.encrypted_content.slice(`${AFFINITY_MARKER}2:`.length), 28)!.trailer
  const nativePayload = `${AFFINITY_MARKER}2:${appendOpaqueTrailer({ bytes: new Uint8Array([1]), origin: "base64" }, trailer)}`
  for (const wire of [nativePayload, `${AFFINITY_MARKER}2:${"A".repeat(12000)}`, `${AFFINITY_MARKER}2:invalid-base64`]) {
    await expect(codec.decode(wire, field)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  }
})

test("v2 metadata accepts client-merged text above the native companion size limit", async () => {
  const signed = await stampAffinityOrigin("gemini", { text: "first" }, target, codec)
  const part = { ...signed, text: "x".repeat(1024 * 1024 + 1) }
  const plan = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [part] }] }, codec)
  expect(plan.materialize(undefined)).toEqual({ contents: [{ role: "model", parts: [{ text: part.text }] }] })
})

test("preparation without origin changes neither empty Gemini contents nor native carriers", async () => {
  const native = await stampAffinityItem("gemini", { text: "native", thought: true, thoughtSignature: "opaque" }, target, codec)
  const body = { contents: [{ role: "model", parts: [] }, { role: "model", parts: [native] }] }
  const plan = await analyzeAffinityRequest("gemini", body, codec)
  expect(plan.prepareSource()).toEqual(body)
})

test("natural opaque bytes resembling a v2 marker still use the unchanged v1 companion binding", async () => {
  const raw = { text: "native thought", thought: true, thoughtSignature: "vnext-affinity:2:upstream-native-bytes" }
  const signed = await stampAffinityItem("gemini", raw, target, codec)
  const plan = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [signed] }] }, codec)
  expect(plan.materialize(target)).toEqual({ contents: [{ role: "model", parts: [raw] }] })
})
