import { afterEach, expect, test } from "bun:test"
import { setupTestPlatform } from "../_setup-platform.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { CopilotProvider, type Model, type ModelsResponse } from "@vibe-llm/provider-copilot"
import { AzureProvider } from "@vibe-llm/provider-azure"
import { affinityTargetMatch, type AffinityExecutionTarget, type ProviderRequest } from "@vibe-llm/provider-llm"
import { configurationAffinityAuthority } from "../../src/data-plane/providers/affinity-authority.ts"
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); __resetPlatformForTests() })
async function fixture(kind: "copilot" | "azure") {
  const { db, repo } = setupTestPlatform()
  cleanup.push(() => db.close())
  await repo.upstreams.save({ id: "up", provider: kind, ownerId: "owner", name: "fixture", enabled: true, sortOrder: 0, config: {}, state: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
  const row = (await repo.upstreams.list())[0]
  if (!row) throw new Error("Missing fixture")
  return { db, authority: configurationAffinityAuthority(row, repo.upstreams) }
}
const request = (model: string, endpoint: "responses" | "messages" = "responses"): ProviderRequest => ({ endpoint, headers: new Headers(), payload: { model, input: [], messages: [], max_tokens: 128 }, sourceApi: endpoint === "messages" ? "anthropic" : "openai", sourceProtocol: endpoint })
function fence(target: AffinityExecutionTarget) { return async (actual: AffinityExecutionTarget) => { if (affinityTargetMatch(target, actual) !== "exact") throw new Error("Execution changed") } }
const model = (id: string): Model => ({ id, name: id, version: id, object: "model", vendor: "test", preview: false, model_picker_enabled: true, supported_endpoints: ["/responses", "/v1/messages"], capabilities: { family: id, object: "model_capabilities", type: "chat", tokenizer: "test", supports: { reasoning_effort: ["high"] }, limits: { max_context_window_tokens: 1_000_000 } } })

test("Copilot preparation uses accepted Fast/context/effort controls without session or discovery I/O", async () => {
  const { authority, db } = await fixture("copilot")
  let refreshes = 0
  let calls = 0
  const provider = new CopilotProvider({ copilotToken: "", accountType: "individual", prepareSession: async () => { refreshes++; return { token: "session" } } }, async (_url, init) => {
    calls++
    expect(JSON.parse(String(init.body)).model).toBe("claude-opus-4.8-fast")
    return Response.json({ id: "msg", content: [], usage: {} })
  }, undefined, authority)
  const models: ModelsResponse = { object: "list", data: [model("claude-opus-4.8"), model("claude-opus-4.8-fast")] }
  provider.setModelCatalog(models)
  const req = request("claude-opus-4.8", "messages")
  req.payload = { ...req.payload, speed: "fast" }
  req.headers = new Headers({ "anthropic-beta": "context-1m-2025-08-07", "x-copilot-reasoning-effort": "high" })
  const before = structuredClone(req.payload)
  const target = await provider.prepareAffinityExecution(req)
  expect(target?.model).toBe("claude-opus-4.8-fast")
  expect(req.payload).toEqual(before)
  expect(req.headers.get("x-copilot-reasoning-effort")).toBe("high")
  expect([calls, refreshes]).toEqual([0, 0])
  if (!target) throw new Error("Missing target")
  const result = await provider.fetch({ ...req, beforeInference: fence(target) })
  expect(result.affinityExecution).toEqual(target)
  await result.body?.cancel()
  expect([calls, refreshes]).toEqual([1, 1])
  db.run("UPDATE upstreams SET config_json = '{\"changed\":true}'")
  await expect(provider.fetch({ ...req, beforeInference: fence(target) })).rejects.toThrow()
  expect([calls, refreshes]).toEqual([1, 1])
})

test("Copilot replacement on 401 blocks forced refresh and retry", async () => {
  const { authority, db } = await fixture("copilot")
  let calls = 0
  let refreshes = 0
  const provider = new CopilotProvider({ copilotToken: "session", accountType: "individual", refreshSession: async () => { refreshes++; return { token: "replacement" } } }, async () => {
    calls++
    db.run("UPDATE upstreams SET config_json = '{\"changed\":true}'")
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }, undefined, authority)
  provider.setModelCatalog({ object: "list", data: [model("gpt-raw")] })
  const req = request("gpt-raw")
  const target = await provider.prepareAffinityExecution(req)
  if (!target) throw new Error("Missing target")
  await expect(provider.fetch({ ...req, beforeInference: fence(target) })).rejects.toThrow()
  expect([calls, refreshes]).toEqual([1, 0])
})

test("Azure distinguishes URL deployment from Anthropic body model and fences replaced config", async () => {
  const { authority, db } = await fixture("azure")
  const calls: string[] = []
  const provider = new AzureProvider({ name: "azure", endpoint: "https://fixture.services.ai.azure.com", apiKey: "fixture", deployment: "default-deployment", apiVersion: "v1", endpoints: ["responses", "messages"], deployments: [{ name: "deployed-model", model: "public-alias" }] }, async url => { calls.push(url); return Response.json({}) }, undefined, authority)
  const responses = request("public-alias")
  const target = await provider.prepareAffinityExecution(responses)
  expect(target?.model).toBe("deployed-model")
  expect((await provider.prepareAffinityExecution(request("claude-actual", "messages")))?.model).toBe("claude-actual")
  if (!target) throw new Error("Missing target")
  await (await provider.fetch({ ...responses, beforeInference: fence(target) })).body?.cancel()
  expect(calls[0]).toContain("/deployments/deployed-model/responses")
  db.run("UPDATE upstreams SET enabled = 0")
  await expect(provider.fetch({ ...responses, beforeInference: fence(target) })).rejects.toThrow()
  expect(calls).toHaveLength(1)
})
