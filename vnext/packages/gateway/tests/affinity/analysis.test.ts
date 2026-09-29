import { expect, test } from "bun:test"
import { AffinityCodec, InvalidAffinityStateError } from "../../src/shared/affinity/carrier.ts"
import { analyzeAffinityRequest, stampAffinityItem, AffinityRoutingUnavailableError } from "../../src/shared/affinity/analysis.ts"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "executed" }
const other = { ...target, model: "other" }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })

test("Responses projection removes optional whole items, retains text/order and isolates retries", async () => {
  const reasoning = await stampAffinityItem("responses", { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "opaque" }, target, codec)
  const body = { model: "alias", input: [reasoning, { type: "message", content: "keep" }] }
  const plan = await analyzeAffinityRequest("responses", body, codec)
  expect(plan.classify(target)).toBe("exact")
  expect(plan.classify(other)).toBe("degraded")
  expect(plan.materialize(other)).toEqual({ model: "alias", input: [{ type: "message", content: "keep" }] })
  const a = plan.materialize(target)
  expect(a).toEqual({ model: "alias", input: [{ ...reasoning, encrypted_content: "opaque" }, { type: "message", content: "keep" }] })
  a.input = []
  expect(plan.materialize(target).input).toHaveLength(2)
  expect(body.input[0]).toEqual(reasoning)
  expect(plan.rankAuthorizedCandidates([other, target], candidate => candidate)).toEqual([target, other])
})

test("compaction aliases and program state are required; conflicting required targets reject every candidate", async () => {
  for (const type of ["compaction", "compaction_summary", "context_compaction", "program", "program_output"]) {
    const item = await stampAffinityItem("responses", { type, encrypted_content: "opaque", fingerprint: "fp" }, target, codec)
    const plan = await analyzeAffinityRequest("responses", { input: [item] }, codec)
    expect(plan.classify(other)).toBe("unavailable")
    expect(() => plan.materialize(other)).toThrow(AffinityRoutingUnavailableError)
  }
  const a = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "a" }, target, codec)
  const b = await stampAffinityItem("responses", { type: "program", fingerprint: "b" }, other, codec)
  const plan = await analyzeAffinityRequest("responses", { input: [a, b] }, codec)
  expect(plan.rankAuthorizedCandidates([target, other], candidate => candidate)).toEqual([])
  const alias = { ...a, type: "compaction_summary" }
  expect((await analyzeAffinityRequest("responses", { input: [alias] }, codec)).classify(target)).toBe("exact")
})

test("Messages removes complete thinking/redacted blocks and emptied assistants; tool-adjacent thinking rejects unsafe removal", async () => {
  const thinking = await stampAffinityItem("messages", { type: "thinking", thinking: "thought", signature: "sig" }, target, codec)
  const redacted = await stampAffinityItem("messages", { type: "redacted_thinking", data: "redacted" }, target, codec)
  const body = { messages: [{ role: "assistant", content: [thinking] }, { role: "user", content: "hello" }, { role: "assistant", content: [redacted, { type: "text", text: "keep" }] }] }
  const plan = await analyzeAffinityRequest("messages", body, codec)
  expect(plan.materialize(other)).toEqual({ messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "keep" }] }] })
  const toolPlan = await analyzeAffinityRequest("messages", { messages: [{ role: "assistant", content: [thinking, { type: "tool_use", id: "t", name: "f", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }, codec)
  expect(toolPlan.classify(other)).toBe("unavailable")
  expect(toolPlan.classify(target)).toBe("exact")
  await expect(analyzeAffinityRequest("messages", { messages: [{ role: "assistant", content: [{ ...thinking, thinking: "swapped" }] }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("no codec leaves raw behavior; foreign and owned synthetic items are distinct", async () => {
  const body = { input: [{ type: "reasoning", encrypted_content: "foreign" }] }
  expect((await analyzeAffinityRequest("responses", body)).materialize(other)).toEqual(body)
  const synthetic = await codec.encode("", target, { domain: "responses/reasoning/encrypted_content", block: "{}" }, { synthetic: true })
  const plan = await analyzeAffinityRequest("responses", { input: [{ type: "reasoning", encrypted_content: synthetic }, ...body.input] }, codec)
  expect(plan.materialize(target)).toEqual(body)
})
