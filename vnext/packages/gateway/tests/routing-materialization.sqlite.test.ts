import { AffinityCodec } from "../src/shared/affinity/carrier.ts"
import { analyzeAffinityRequest, stampAffinityItem, AffinityRoutingUnavailableError } from "../src/shared/affinity/analysis.ts"
import { resolveBinding } from "../src/data-plane/routing/binding-resolver.ts"
import { selectPair } from "../src/data-plane/dispatch/pair-selector.ts"
import type { RequestAffinity } from "../src/data-plane/shared/affinity-request.ts"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from "@vibe-core/platform"
import { customProviderPlugin, CustomProvider } from "@vibe-llm/provider-custom"
import { initRepo, getDataPlaneConfiguration, withConfigurationSnapshot } from "../src/repo/index.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"
import { listUpstreamModels, listRoutingBindings, readCachedModels, _clearModelsMemoForTest } from "../src/data-plane/providers/registry.ts"
import { selectBindingForChatCompletions, selectBindingForProtocol } from "../src/data-plane/chat-flow/shared/select-binding.ts"

const databases: Database[] = []
const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  __resetPlatformForTests()
  for (const db of databases.splice(0)) db.close()
})
async function fixture() {
  initRuntimeLocation("bun")
  initBackground({ waitUntil: () => {} })
  const db = new Database(":memory:")
  databases.push(db)
  const repo = new BunSqliteRepo(db)
  initRepo(repo)
  for (const [index, id] of ["first", "second", "third"].entries()) {
    const row: UpstreamRecord = { id, provider: "custom", name: id, enabled: true, sortOrder: index,
      config: { name: id, baseUrl: `https://${id}.invalid`, authStyle: "none", endpoints: ["chat_completions", "responses"], models: ["shared"] },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
    await repo.upstreams.save(row)
  }
  await listUpstreamModels()
  return { db, repo }
}
const select = () => selectBindingForChatCompletions({ model: "shared", auth: {} })

test("warm same-model ordinary routing constructs only its winner and keeps execution request-local", async () => {
  await fixture()
  const construction = spyOn(customProviderPlugin, "createFromUpstream")
  const prepare = spyOn(CustomProvider.prototype, "prepareAffinityExecution")
  restores.push(() => construction.mockRestore(), () => prepare.mockRestore())
  const first = await select()
  expect(first.kind).toBe("ok")
  if (first.kind !== "ok") throw new Error("missing winner")
  expect(first.binding.upstream).toBe("first")
  expect(construction).toHaveBeenCalledTimes(1)
  expect(prepare).not.toHaveBeenCalled()
  const next = await select()
  if (next.kind !== "ok") throw new Error("missing next winner")
  expect(next.binding.provider).not.toBe(first.binding.provider)
  expect(construction).toHaveBeenCalledTimes(2)
  const urls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    urls.push(String(url))
    return Response.json({ id: "chatcmpl-fixture" })
  }) as typeof fetch
  restores.push(() => { globalThis.fetch = originalFetch })
  const request: ProviderRequest = { endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(), payload: { model: "shared", messages: [] } }
  expect((await first.binding.provider.fetch(request)).status).toBe(200)
  expect((await next.binding.provider.fetch(request)).status).toBe(200)
  expect(urls).toEqual(["https://first.invalid/chat/completions", "https://first.invalid/chat/completions"])
})

test("selected execution uses accepted edited proxy rows rather than the pinned preflight snapshot", async () => {
  const { repo } = await fixture()
  const first = await repo.upstreams.getById("first")
  if (!first) throw new Error("missing row")
  await repo.proxies.save({ id: "px", name: "valid", url: "http://pinned.invalid:8080", dialTimeoutSeconds: null })
  await repo.upstreams.patchMetadata(first, row => ({ ...row, proxyFallbackList: [{ id: "px" }] }))
  await listUpstreamModels()
  await withConfigurationSnapshot(async () => {
    expect((await getDataPlaneConfiguration().proxies.list())[0]?.url).toBe("http://pinned.invalid:8080")
    await repo.proxies.patch("px", { url: "trojan://fake-password@edited.invalid:99999" })
    // A retained result may intentionally serve its previous coherent epoch.
    // Force a new authoritative observation while this request stays pinned.
    _clearModelsMemoForTest()
    const selected = await select()
    if (selected.kind !== "ok") throw new Error("missing selected provider")
    expect(selected.binding.upstream).toBe("first")
    await expect(selected.binding.provider.fetch({ endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(), payload: { model: "shared", messages: [] } })).rejects.toThrow("malformed proxy px")
  })
})

test("warm constructor failures fall through in order and all failures remain catalog-unavailable", async () => {
  await fixture()
  const original = customProviderPlugin.createFromUpstream
  let failAll = false
  const visited: string[] = []
  const construction = spyOn(customProviderPlugin, "createFromUpstream").mockImplementation(async (row, context) => {
    visited.push(row.id)
    if (failAll || row.id === "first") throw new Error("fixture construction unavailable")
    return original(row, context)
  })
  restores.push(() => construction.mockRestore())
  const selected = await select()
  expect(selected.kind).toBe("ok")
  if (selected.kind === "ok") expect(selected.binding.upstream).toBe("second")
  expect(visited).toEqual(["first", "second"])
  failAll = true
  expect((await select()).kind).toBe("catalog-unavailable")
})


test("warm listing needs no execution provider and copies returned metadata", async () => {
  await fixture()
  const construction = spyOn(customProviderPlugin, "createFromUpstream")
  restores.push(() => construction.mockRestore())
  const first = await listUpstreamModels()
  const raw = first.data[0]
  if (!raw) throw new Error("missing model")
  raw.id = "poisoned"
  raw.capabilities.family = "poisoned"
  const second = await listUpstreamModels()
  expect(second.data[0]?.id).toBe("shared")
  expect(second.data[0]?.capabilities.family).not.toBe("poisoned")
  expect(construction).not.toHaveBeenCalled()
  const routing = await listRoutingBindings({ kind: "global" })
  const descriptor = routing.find(["shared"])[0]
  if (!descriptor) throw new Error("missing descriptor")
  expect(() => Object.assign(descriptor.model, { id: "poisoned" })).toThrow()
  const binding = await routing.materialize(descriptor)
  if (!binding) throw new Error("missing binding")
  binding.model.id = "request-only"
  expect((await listUpstreamModels()).data[0]?.id).toBe("shared")
})

test("pinned configuration flags, disabled models and order change without catalog generation changes", async () => {
  const { repo } = await fixture()
  const first = await repo.upstreams.getById("first")
  const third = await repo.upstreams.getById("third")
  if (!first || !third) throw new Error("missing rows")
  const disabled = await repo.upstreams.patchMetadata(first, row => ({ ...row, disabledPublicModelIds: ["shared"] }))
  expect(disabled.catalogGeneration).toBe(first.catalogGeneration)
  const selected = await withConfigurationSnapshot(select)
  if (selected.kind !== "ok") throw new Error("missing second")
  expect(selected.binding.upstream).toBe("second")
  const reordered = await repo.upstreams.patchMetadata(third, row => ({ ...row, sortOrder: -1, flagOverrides: { "reasoning-content-dialect": true } }))
  expect(reordered.catalogGeneration).toBe(third.catalogGeneration)
  const next = await withConfigurationSnapshot(select)
  if (next.kind !== "ok") throw new Error("missing third")
  expect(next.binding.upstream).toBe("third")
  expect(next.binding.enabledFlags?.has("reasoning-content-dialect")).toBe(true)
})

test("authoritative Repo cache survives per-request pinned views but never crosses repository reset", async () => {
  await fixture()
  const construction = spyOn(customProviderPlugin, "createFromUpstream")
  restores.push(() => construction.mockRestore())
  await withConfigurationSnapshot(select)
  await withConfigurationSnapshot(select)
  expect(construction).toHaveBeenCalledTimes(2)
  _clearModelsMemoForTest()
  construction.mockClear()
  await withConfigurationSnapshot(select)
  // A cold projection provider is reused by the selected execution.
  expect(construction).toHaveBeenCalledTimes(3)
})

test("owner and explicit pin changes cannot reuse another scope's descriptors", async () => {
  const { repo } = await fixture()
  const third = await repo.upstreams.getById("third")
  if (!third) throw new Error("missing third")
  await repo.upstreams.patchMetadata(third, row => ({ ...row, ownerId: "owner" }))
  expect((await listRoutingBindings({ kind: "global" })).all().map(row => row.upstream)).toEqual(["first", "second"])
  expect((await listRoutingBindings({ kind: "owner", ownerId: "owner" })).all().map(row => row.upstream)).toEqual(["first", "second", "third"])
  expect((await listRoutingBindings({ kind: "owner", ownerId: "other" })).all().map(row => row.upstream)).toEqual(["first", "second"])
  expect((await listRoutingBindings({ kind: "all-owners" })).all()).toHaveLength(3)
  const hidden = await selectBindingForChatCompletions({ model: "shared", auth: { pin: "third" } })
  expect(hidden.kind).toBe("model-not-found")
  const pinned = await selectBindingForChatCompletions({ model: "up_first/shared", auth: { pin: "third", ownerId: "owner" } })
  if (pinned.kind !== "ok") throw new Error("missing explicit pin")
  expect(pinned.binding.upstream).toBe("third")
})

test("same-id recreation and configuration changes rebuild trusted capabilities and real execution", async () => {
  const { repo } = await fixture()
  const original = await repo.upstreams.getById("first")
  if (!original) throw new Error("missing row")
  await repo.upstreams.delete(original.id)
  await repo.upstreams.save({ ...original, config: { ...original.config, models: ["recreated"], baseUrl: "https://replacement.invalid" } })
  const recreated = await repo.upstreams.getById(original.id)
  expect(recreated?.rowIncarnation).not.toBe(original.rowIncarnation)
  expect((await listRoutingBindings({ kind: "global" })).find(["shared"]).map(row => row.upstream)).toEqual(["second", "third"])
  const replacement = await resolveBinding("recreated", "responses")
  expect(replacement?.upstream).toBe("first")
  if (!recreated) throw new Error("missing recreated")
  await repo.upstreams.patchMetadata(recreated, row => ({ ...row, config: { ...row.config, models: ["changed"], endpoints: ["embeddings"] } }))
  expect(await resolveBinding("recreated", "responses")).toBeNull()
  expect((await resolveBinding("changed", "embeddings"))?.upstream).toBe("first")
})

test("no-candidate terminal reconciliation preserves absent/unsupported model versus catalog failure", async () => {
  await fixture()
  const original = customProviderPlugin.createFromUpstream
  const construction = spyOn(customProviderPlugin, "createFromUpstream").mockImplementation(async (row, context) => {
    if (row.id === "first") throw new Error("new runtime failure")
    return original(row, context)
  })
  restores.push(() => construction.mockRestore())
  expect((await selectBindingForChatCompletions({ model: "absent", auth: {} })).kind).toBe("catalog-unavailable")
  expect((await selectBindingForProtocol({ model: "shared", auth: {}, protocol: "responses", pickTarget: () => null })).kind).toBe("catalog-unavailable")
})

async function ownedThird() {
  const origin = await resolveBinding("shared", "responses", { pin: "third" })
  const target = await origin?.provider.prepareAffinityExecution?.({ endpoint: "responses", payload: { model: "shared" }, headers: new Headers(), sourceApi: "openai" })
  if (!target) throw new Error("missing origin target")
  const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
  const owned = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "opaque" }, target, codec)
  const affinity: RequestAffinity = { execution: { protocol: "responses", codec }, analysis: await analyzeAffinityRequest("responses", { input: [owned] }, codec) }
  return affinity
}
const selectOwned = (affinity: RequestAffinity) => selectBindingForProtocol({ model: "shared", auth: {}, affinity, protocol: "responses", pickTarget: endpoints => selectPair("responses", endpoints) })

test("owned routing materializes and prepares every eligible candidate before choosing later exact target", async () => {
  await fixture()
  const affinity = await ownedThird()
  const construction = spyOn(customProviderPlugin, "createFromUpstream")
  const prepare = spyOn(CustomProvider.prototype, "prepareAffinityExecution")
  restores.push(() => construction.mockRestore(), () => prepare.mockRestore())
  const selected = await selectOwned(affinity)
  if (selected.kind !== "ok") throw new Error("missing owned winner")
  expect(selected.binding.upstream).toBe("third")
  expect(construction).toHaveBeenCalledTimes(3)
  expect(prepare).toHaveBeenCalledTimes(3)
  expect(affinity.execution.selected?.upstreamId).toBe("third")
})

test("owned static protocol gates run before construction; failed preparation never grants fallback inference", async () => {
  const { repo } = await fixture()
  const first = await repo.upstreams.getById("first")
  if (!first) throw new Error("missing row")
  await repo.upstreams.patchMetadata(first, row => ({ ...row, config: { ...row.config, endpoints: ["chat_completions"] } }))
  await listUpstreamModels()
  const affinity = await ownedThird()
  const visited: string[] = []
  const original = customProviderPlugin.createFromUpstream
  const construction = spyOn(customProviderPlugin, "createFromUpstream").mockImplementation(async (row, context) => { visited.push(row.id); return original(row, context) })
  const prepare = spyOn(CustomProvider.prototype, "prepareAffinityExecution").mockImplementation(async function (this: CustomProvider, _request: Readonly<ProviderRequest>) { throw new Error(`cannot prove ${this.name}`) })
  restores.push(() => construction.mockRestore(), () => prepare.mockRestore())
  await expect(selectOwned(affinity)).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
  expect(visited).toEqual(["second", "third"])
})


test("warm empty catalogs still reconcile newly failing constructors before terminal classification", async () => {
  const { repo } = await fixture()
  for (const row of await repo.upstreams.list()) await repo.upstreams.patchMetadata(row, metadata => ({ ...metadata, config: { ...metadata.config, models: [] } }))
  // Publish accepted empty remote catalogs, without touching the SQL adapter.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ object: "list", data: [] })) as typeof fetch
  restores.push(() => { globalThis.fetch = originalFetch })
  await listUpstreamModels()
  const construction = spyOn(customProviderPlugin, "createFromUpstream").mockImplementation(async () => { throw new Error("runtime unavailable") })
  restores.push(() => construction.mockRestore())
  expect((await select()).kind).toBe("catalog-unavailable")
})


test("chat keeps upstream order for composite matches while direct resolver prioritizes direct IDs", async () => {
  const { repo } = await fixture()
  const first = await repo.upstreams.getById("first")
  const second = await repo.upstreams.getById("second")
  if (!first || !second) throw new Error("missing rows")
  await repo.upstreams.patchMetadata(first, row => ({ ...row, config: { ...row.config, models: ["claude-sonnet-4.5"] } }))
  await repo.upstreams.patchMetadata(second, row => ({ ...row, config: { ...row.config, models: ["claude-sonnet-4.5-high"] } }))
  await listUpstreamModels()
  const chat = await selectBindingForChatCompletions({ model: "claude-sonnet-4.5-high", auth: {} })
  if (chat.kind !== "ok") throw new Error("missing chat winner")
  expect(chat.binding.upstream).toBe("first")
  expect((await resolveBinding("claude-sonnet-4.5-high", "responses"))?.upstream).toBe("second")
  const original = customProviderPlugin.createFromUpstream
  const construction = spyOn(customProviderPlugin, "createFromUpstream").mockImplementation(async (row, context) => {
    if (row.id === "second") throw new Error("direct unavailable")
    return original(row, context)
  })
  restores.push(() => construction.mockRestore())
  expect((await resolveBinding("claude-sonnet-4.5-high", "responses"))?.upstream).toBe("first")
})

for (const stored of [false, true]) test(`request-token Copilot ${stored ? "stored row" : "synthetic fallback"} catalogs never cross token boundaries`, async () => {
  const { repo } = await fixture()
  if (stored) {
    const row = await repo.upstreams.getById("first")
    if (!row) throw new Error("missing row")
    await repo.upstreams.save({ ...row, id: "token-row", provider: "copilot", config: {} })
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    return Response.json({ object: "list", data: [{ id: auth.includes("token-a") ? "only-token-a" : "only-token-b" }] })
  }) as typeof fetch
  restores.push(() => { globalThis.fetch = originalFetch })
  const first = await listUpstreamModels({ copilot: { copilotToken: "token-a", accountType: "individual" } })
  const second = await listUpstreamModels({ copilot: { copilotToken: "token-b", accountType: "individual" } })
  expect(first.data.map(model => model.id)).toContain("only-token-a")
  expect(second.data.map(model => model.id)).toContain("only-token-b")
  expect(second.data.map(model => model.id)).not.toContain("only-token-a")
})

test("trusted compatibility is reprojected on owner configuration edits", async () => {
  const { repo } = await fixture()
  const first = await repo.upstreams.getById("first")
  if (!first) throw new Error("missing row")
  const configured = await repo.upstreams.patchMetadata(first, row => ({ ...row, config: { ...row.config,
    opaqueCompatibility: { shared: { version: 1, key: "declared-a", scope: "owner" } } } }))
  const declared = (await listRoutingBindings({ kind: "global" })).find(["shared"])[0]
  expect(declared?.model.opaqueCompatibility?.key).toBe("declared-a")
  await repo.upstreams.patchMetadata(configured, row => ({ ...row, config: { ...row.config,
    opaqueCompatibility: { shared: { version: 1, key: "declared-b", scope: "owner" } } } }))
  const changed = (await listRoutingBindings({ kind: "global" })).find(["shared"])[0]
  expect(changed?.model.opaqueCompatibility?.key).toBe("declared-b")
})


test("accepted catalog arrays cannot be mutated through catalog/provider read APIs", async () => {
  const { repo } = await fixture()
  const row = await repo.upstreams.getById("first")
  if (!row) throw new Error("missing row")
  const accepted = await readCachedModels(row)
  if (!accepted) throw new Error("missing catalog")
  expect(() => accepted.snapshot.models.data.push({ id: "injected" })).toThrow()
  expect((await listUpstreamModels()).data.map(model => model.id)).toEqual(["shared"])
})
