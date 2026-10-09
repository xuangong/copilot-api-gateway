import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { CopilotProvider, copilotProviderPlugin, type Model } from "@vibe-llm/provider-copilot"
import type { LlmProviderBinding, ProviderRequest } from "@vibe-llm/provider-llm"
import { setupTestPlatform } from "../_setup-platform"
import { initRepo } from "../../src/repo"
import { createRequestAffinity, selectAffinityCandidate, materializeAffinity, affinityFence, acceptAffinityExecution } from "../../src/data-plane/shared/affinity-request"
import { configurationAffinityAuthority } from "../../src/data-plane/providers/affinity-authority"
import { stampAffinityItem, AffinityRoutingUnavailableError } from "../../src/shared/affinity/analysis"
import { stampAffinityOrigin } from "../../src/shared/affinity/origin-anchor"
import { sharedSessionTargetDecorator } from "../../src/shared/affinity/shared-session-target"
import { InvalidAffinityStateError } from "../../src/shared/affinity/carrier"

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(close => close()); __resetPlatformForTests() })
const secret = "ab".repeat(32)
const model: Model = { id: "gpt-raw", name: "gpt-raw", version: "1", object: "model", vendor: "test", preview: false, model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { family: "gpt", object: "model_capabilities", type: "chat", tokenizer: "test" } }
const req = (): ProviderRequest => ({ endpoint: "responses", payload: { model: model.id, input: "hello" }, sourceApi: "openai", headers: new Headers() })
async function site(id: string, account = 123, host = "github.com") {
  const { db, repo } = setupTestPlatform()
  cleanup.push(() => db.close())
  db.run("INSERT INTO api_keys(id,name,key,owner_id,created_at) VALUES(?,?,?,?,?)", [id, id, `raw-${id}`, `owner-${id}`, "now"])
  const key = (await repo.apiKeys.list())[0]
  if (!key?.ownerId) throw new Error("Missing fixture key")
  await repo.apiKeys.setSharedSessionConfig(key.id, key.ownerId, { enabled: true, secret })
  await repo.upstreams.save({ id: `up-${id}`, provider: "copilot", ownerId: key.ownerId, name: "same display name", enabled: true, sortOrder: 0,
    config: { githubToken: `test-${id}`, accountType: "individual", githubHost: host, user: { id: account } }, state: {},
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
  const row = (await repo.upstreams.list())[0]
  if (!row) throw new Error("Missing fixture upstream")
  const sent: unknown[] = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    sent.push(await request.json())
    return Response.json({ id: "r", object: "response", status: "completed", model: model.id, output: [] })
  } })
  cleanup.unshift(() => { upstream.stop(true) })
  const authority = configurationAffinityAuthority(row, repo.upstreams)
  const provider = new CopilotProvider({ copilotToken: `test-session-${id}`, accountType: "individual" }, async (_url, init) => fetch(upstream.url, init), undefined, authority)
  provider.setModelCatalog({ object: "list", data: [model] })
  const binding: LlmProviderBinding = { kind: "copilot", upstream: row.id, enabledFlags: new Set(), model: { id: model.id, endpoints: { responses: {} } }, provider }
  return { db, repo, key, row, sent, provider, authority, candidate: { binding, targetEndpoint: "responses" as const },
    async affinity(input: unknown[]) {
      initRepo(repo)
      const affinity = await createRequestAffinity("responses", { input }, { ownerId: key.ownerId, apiKeyId: key.id })
      if (!affinity) throw new Error("Missing fixture affinity")
      return affinity
    },
  }
}

test("three independent SQLite keys replay native state through Copilot HTTP execution with destination identity", async () => {
  const sites = [await site("local"), await site("cfw"), await site("ssh")]
  let history: Record<string, unknown>[] = []
  for (const destination of [...sites, sites[0]]) {
    if (!destination) throw new Error("Missing destination")
    const affinity = await destination.affinity(history)
    const selected = await selectAffinityCandidate([destination.candidate], affinity, model.id)
    expect(selected?.binding.upstream).toBe(destination.row.id)
    const payload = materializeAffinity(affinity, { input: history }, model.id)
    const response = await destination.provider.fetch({ ...req(), payload, beforeInference: affinityFence(affinity.execution) })
    acceptAffinityExecution(affinity.execution, response)
    await response.body?.cancel()
    const codec = await affinity.execution.loadCodec?.()
    const target = affinity.execution.actual
    if (!codec || !target) throw new Error("Missing execution identity")
    expect(target.upstreamId).toBe(destination.row.id)
    const item = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native-exact-bytes" }, target, codec)
    const origin = await stampAffinityOrigin("responses", { type: "reasoning", summary: [] }, target, codec)
    history = [origin, item]
    expect(item.encrypted_content).toStartWith("vnext-affinity:3:")
    expect(origin.encrypted_content).toStartWith("vnext-affinity:4:")
    expect(JSON.stringify(destination.sent)).not.toContain("vnext-affinity:")
  }
  expect(sites[1]?.sent).toMatchObject([{ model: model.id, input: [{ type: "compaction", encrypted_content: "native-exact-bytes" }] }])
  const destination = sites[1]
  if (!destination?.key.ownerId) throw new Error("Missing destination")
  const affinity = await destination.affinity(history)
  await expect(selectAffinityCandidate([], affinity, model.id)).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
  await selectAffinityCandidate([destination.candidate], affinity, model.id)
  const before = destination.sent.length
  destination.db.run("UPDATE upstreams SET config_json = '{}' WHERE id = ?", [destination.row.id])
  await expect(destination.provider.fetch({ ...req(), beforeInference: affinityFence(affinity.execution) })).rejects.toThrow()
  expect(destination.sent).toHaveLength(before)
  await destination.repo.apiKeys.setSharedSessionConfig(destination.key.id, destination.key.ownerId, { enabled: false })
  await expect(destination.affinity(history)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  await destination.repo.apiKeys.setSharedSessionConfig(destination.key.id, destination.key.ownerId, { enabled: true, secret: "cd".repeat(32) })
  await expect(destination.affinity(history)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

test("account, host, executed model, owner and configuration changes cannot grant portable compatibility", async () => {
  const a = await site("a"), b = await site("b", 456), c = await site("c", 123, "tenant.ghe.com")
  const initial = await a.affinity([])
  const codec = await initial.execution.loadCodec?.()
  const target = await a.provider.prepareAffinityExecution(req())
  if (!codec || !target) throw new Error("Missing identity")
  const item = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native" }, target, codec)
  for (const other of [b, c]) {
    await expect(selectAffinityCandidate([other.candidate], await other.affinity([item]), model.id)).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
    expect(other.sent).toHaveLength(0)
  }
  const decorate = sharedSessionTargetDecorator(new Uint8Array(32).fill(0xab), a.key.ownerId ?? "", a.repo.upstreams)
  const shared = await decorate(target)
  expect((await decorate({ ...target, model: "different" })).compatibility).not.toEqual(shared.compatibility)
  expect((await sharedSessionTargetDecorator(new Uint8Array(32).fill(0xab), "wrong-owner", a.repo.upstreams)(target)).compatibility).toBeUndefined()
  a.db.run("UPDATE upstreams SET config_json = '{}' WHERE id = ?", [a.row.id])
  expect((await sharedSessionTargetDecorator(new Uint8Array(32).fill(0xab), a.key.ownerId ?? "", a.repo.upstreams)(target)).compatibility).toBeUndefined()
})

test("credential fallback cannot impersonate the configured Copilot affinity authority", async () => {
  const f = await site("fallback")
  let sends = 0
  const provider = await copilotProviderPlugin.createFromUpstream(f.row, {
    deferCredentials: true, affinityAuthority: f.authority,
    copilotFallback: { copilotToken: "unrelated-account", accountType: "individual" },
    getCachedCopilotToken: async () => { throw new Error("exchange failed") },
    fetcherForUpstream: () => async () => { sends++; return Response.json({}) },
  })
  await expect(provider?.fetch(req())).rejects.toThrow("exchange failed")
  expect(sends).toBe(0)
})
