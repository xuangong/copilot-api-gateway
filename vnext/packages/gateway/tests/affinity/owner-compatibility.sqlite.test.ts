import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { CustomProvider, normalizeCustomConfig } from "@vibe-llm/provider-custom"
import { AzureProvider, normalizeAzureConfig } from "@vibe-llm/provider-azure"
import type { LlmModelProvider, ProviderRequest, LlmProviderBinding, AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { Model } from "@vibe-llm/provider-copilot"
import { initRepo } from "../../src/repo/index.ts"
import { upstreamsRouter, type AuthCtx } from "../../src/control-plane/upstreams/routes.ts"
import { sessionAuthMiddleware } from "../../src/control-plane/auth/session-auth.ts"
import { dataTransferRouter } from "../../src/control-plane/data-transfer/routes.ts"
import { configurationAffinityAuthority } from "../../src/data-plane/providers/affinity-authority.ts"
import { MODEL_CATALOG_REVISION, modelToBindingModel } from "../../src/data-plane/providers/registry.ts"

import { AffinityCodec } from "../../src/shared/affinity/carrier.ts"
import { analyzeAffinityRequest, stampAffinityItem } from "../../src/shared/affinity/analysis.ts"
import { selectAffinityCandidate, materializeAffinity, affinityFence, type RequestAffinity } from "../../src/data-plane/shared/affinity-request.ts"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); __resetPlatformForTests() })
const declaration = { version: 1 as const, key: "verified-contract", scope: "owner" as const }
const configs = {
  custom: { name: "custom", baseUrl: "https://fixture.invalid", authStyle: "none", endpoints: ["responses"], models: ["raw"], opaqueCompatibility: { raw: declaration } },
  azure: { name: "azure", endpoint: "https://fixture.services.ai.azure.com", apiKey: "synthetic", deployment: "default", apiVersion: "v1", endpoints: ["responses"], deployments: [{ name: "deployed", model: "raw" }], opaqueCompatibility: { "openai:deployed": declaration } },
}
const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
function fixture() {
  __resetPlatformForTests()
  const dir = mkdtempSync(join(tmpdir(), "owner-compatibility-"))
  const path = join(dir, "test.sqlite")
  const db = new Database(path)
  const repo = new BunSqliteRepo(db)
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  initRepo(repo)
  const auth: AuthCtx = { isAdmin: true, userId: "owner" }
  const app = new Hono()
  app.use("*", (c, next) => { c.set("auth", auth); return next() })
  app.route("/api/upstreams", upstreamsRouter)
  app.route("/api", dataTransferRouter)
  return { db, path, repo, auth, app }
}
const request = (endpoint: "responses" | "messages" = "responses", model = "raw"): ProviderRequest => ({ endpoint, payload: { model }, headers: new Headers(), sourceApi: "openai" })

for (const kind of ["custom", "azure"] as const) {
  test(`${kind} owner config validates create/update/import, preserves edits and fences removal`, async () => {
    const f = fixture()
    const created = await f.app.request("/api/upstreams", json({ provider: kind, name: kind, config: configs[kind] }))
    expect(created.status).toBe(201)
    const dto = (await created.json()).upstream
    expect(dto.config.opaqueCompatibility).toEqual(configs[kind].opaqueCompatibility)
    const row = await f.repo.upstreams.getById(dto.id)
    if (!row) throw new Error("missing row")
    let calls = 0
    const transport = async () => { calls++; return Response.json({}) }
    const authority = configurationAffinityAuthority(row, f.repo.upstreams)
    const provider: LlmModelProvider = kind === "custom"
      ? new CustomProvider(normalizeCustomConfig(row.config), transport, undefined, authority)
      : new AzureProvider({ ...configs.azure, endpoints: ["responses"] }, transport, undefined, authority)
    const target = await provider.prepareAffinityExecution?.(request())
    expect(target?.compatibility).toEqual(declaration)
    const response = await provider.fetch(request())
    expect(response.affinityExecution).toEqual(target)
    await response.body?.cancel()
    expect(calls).toBe(1)
    expect((await f.app.request(`/api/upstreams/${row.id}`, json({ config: { name: "edited" } }, "PATCH"))).status).toBe(200)
    expect((await f.repo.upstreams.getById(row.id))?.config.opaqueCompatibility).toEqual(configs[kind].opaqueCompatibility)
    const exported = await (await f.app.request("/api/export?redact=1")).json()
    expect(exported.upstreams[0].config.opaqueCompatibility).toEqual(configs[kind].opaqueCompatibility)
    const invalid = [null, [], "group", "***", { raw: null }, { "": declaration }, { ["x".repeat(513)]: declaration }, { raw: { ...declaration, extra: true } }, { raw: { ...declaration, version: 2 } }, { raw: { ...declaration, scope: "global" } }, { raw: { ...declaration, key: "" } }, { raw: { ...declaration, key: "x".repeat(513) } }]
    for (const opaqueCompatibility of invalid) {
      expect((await f.app.request("/api/upstreams", json({ provider: kind, name: kind, config: { ...configs[kind], opaqueCompatibility } }))).status).toBe(400)
      expect((await f.app.request(`/api/upstreams/${row.id}`, json({ config: { opaqueCompatibility } }, "PATCH"))).status).toBe(400)
      const bundle = { ...exported, upstreams: [{ ...exported.upstreams[0], config: { ...exported.upstreams[0].config, opaqueCompatibility } }] }
      expect((await f.app.request("/api/import", json({ mode: "replace", bundle }))).status).toBe(400)
      expect(await f.repo.upstreams.getById(row.id)).not.toBeNull()
    }
    expect((await f.app.request("/api/import", json({ mode: "merge", bundle: exported }))).status).toBe(200)
    f.auth.isAdmin = false
    f.auth.userId = "other-owner"
    expect((await f.app.request(`/api/upstreams/${row.id}`, json({ config: { opaqueCompatibility: {} } }, "PATCH"))).status).toBe(404)
    expect((await f.app.request("/api/import", json({ mode: "merge", bundle: exported }))).status).toBe(403)
    f.auth.userId = "owner"
    const before = await f.repo.upstreams.getById(row.id)
    expect((await f.app.request(`/api/upstreams/${row.id}`, json({ config: { opaqueCompatibility: {} } }, "PATCH"))).status).toBe(200)
    const after = await f.repo.upstreams.getById(row.id)
    expect(after?.config.opaqueCompatibility).toEqual({})
    expect(after?.catalogGeneration).toBeGreaterThan(before?.catalogGeneration ?? -1)
    await expect(provider.fetch({ ...request(), beforeInference: async () => {} })).rejects.toThrow()
    expect(calls).toBe(1)
  })
}

test("provider construction rejects malformed stored declarations; map is immutable and prototype-safe", () => {
  const malformed = { ...configs.custom, opaqueCompatibility: { raw: { ...declaration, extra: true } } }
  expect(() => new CustomProvider({ ...malformed, endpoints: ["responses"] })).toThrow()
  expect(() => new AzureProvider({ ...configs.azure, endpoints: ["responses"], opaqueCompatibility: { raw: declaration } })).toThrow()
  const map = JSON.parse(JSON.stringify({ raw: declaration }))
  const p = new CustomProvider({ ...configs.custom, endpoints: ["responses"], opaqueCompatibility: map })
  map.raw.key = "mutated"
  const binding = { id: "raw", endpoints: { responses: {} } }
  expect(p.getOpaqueCompatibilityForModel?.(binding)).toEqual(declaration)
  expect(p.getOpaqueCompatibilityForModel?.({ ...binding, id: "toString" })).toBeUndefined()
})

test("Azure declaration lookup uses final deployment and surface, omitting ambiguous catalog declarations", async () => {
  const f = fixture()
  await f.app.request("/api/upstreams", json({ provider: "azure", name: "azure", config: configs.azure }))
  const row = (await f.repo.upstreams.list())[0]
  if (!row) throw new Error("missing row")
  const provider = new AzureProvider({ ...configs.azure, endpoints: ["responses", "messages"], opaqueCompatibility: { "openai:deployed": declaration, "anthropic:raw": { ...declaration, key: "different" } } }, async () => { throw new Error("no I/O during preparation") }, undefined, configurationAffinityAuthority(row, f.repo.upstreams))
  expect((await provider.prepareAffinityExecution(request()))?.compatibility).toEqual(declaration)
  expect((await provider.prepareAffinityExecution(request("responses", "deployed")))?.compatibility).toEqual(declaration)
  expect((await provider.prepareAffinityExecution(request("responses", "unknown")))?.compatibility).toBeUndefined()
  expect((await provider.prepareAffinityExecution(request("messages")))?.compatibility?.key).toBe("different")
  expect(provider.getOpaqueCompatibilityForModel?.({ id: "raw", endpoints: { responses: {}, messages: {} } })).toBeUndefined()
  expect(provider.getOpaqueCompatibilityForModel?.({ id: "raw", endpoints: { responses: {} } })).toEqual(declaration)
})

for (const kind of ["custom", "azure"] as const) test(`${kind} retained SQLite catalog reconstructs declarations only from validated owner config`, async () => {
  const f = fixture()
  await f.app.request("/api/upstreams", json({ provider: kind, name: kind, config: configs[kind] }))
  const row = (await f.repo.upstreams.list())[0]
  if (!row) throw new Error("missing row")
  const construct = (config: Record<string, unknown>) => kind === "custom" ? new CustomProvider(normalizeCustomConfig(config)) : new AzureProvider(normalizeAzureConfig(config))
  const p = construct(row.config)
  const raw = (await p.getModels()).data.find(model => model.id === "raw")
  if (!raw) throw new Error("missing model")
  Object.assign(raw, { opaqueCompatibility: { ...declaration, key: "evil" }, providerData: { opaqueCompatibility: declaration } })
  const observation = await f.repo.catalogs.read(row.id, MODEL_CATALOG_REVISION)
  if (!observation) throw new Error("missing observation")
  const lease = await f.repo.catalogs.tryAcquire(observation.identity)
  if (!lease) throw new Error("missing lease")
  await f.repo.catalogs.publish(lease, { object: "list", data: [raw] })
  const db = new Database(f.path)
  try {
    const retained = new BunSqliteRepo(db)
    const saved = await retained.upstreams.getById(row.id)
    const model = (await retained.catalogs.read(row.id, MODEL_CATALOG_REVISION))?.snapshot?.models.data[0]
    if (!saved || !model) throw new Error("missing retained data")
    const provider = construct(saved.config)
    expect(modelToBindingModel(model as unknown as Model, kind, provider).opaqueCompatibility).toEqual(declaration)
    const undeclared = construct({ ...saved.config, opaqueCompatibility: undefined })
    expect(modelToBindingModel(model as unknown as Model, kind, undeclared).opaqueCompatibility).toBeUndefined()
  } finally { db.close() }
})

test("configured execution targets rank exact then stable declared groups then degradation; required state unwraps", async () => {
  const f = fixture()
  const candidates: Array<{ binding: LlmProviderBinding; targetEndpoint: "responses" }> = []
  const targets: AffinityExecutionTarget[] = []
  const sent: unknown[] = []
  for (const [name, group] of [["degraded", undefined], ["compatible-first", declaration], ["compatible-second", declaration], ["exact", declaration]] as const) {
    const created = await f.app.request("/api/upstreams", json({ provider: "custom", name, config: { ...configs.custom, opaqueCompatibility: group ? { raw: group } : {} } }))
    const id = (await created.json()).upstream.id as string
    const row = await f.repo.upstreams.getById(id)
    if (!row) throw new Error("missing row")
    const provider = new CustomProvider(normalizeCustomConfig(row.config), async (_url, init) => { sent.push(JSON.parse(String(init.body))); return Response.json({}) }, undefined, configurationAffinityAuthority(row, f.repo.upstreams))
    const target = await provider.prepareAffinityExecution(request())
    if (!target) throw new Error("missing target")
    targets.push(target)
    candidates.push({ binding: { kind: "custom", upstream: id, enabledFlags: new Set(), model: { id: "raw", endpoints: { responses: {} } }, provider }, targetEndpoint: "responses" })
  }
  const origin = targets[3]
  if (!origin) throw new Error("missing origin")
  const secret = new Uint8Array(32).fill(9)
  const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret })
  const optional = await stampAffinityItem("responses", { type: "reasoning", encrypted_content: "optional" }, origin, codec)
  const analysis = await analyzeAffinityRequest("responses", { input: [optional] }, codec)
  expect(analysis.rankAuthorizedCandidates(targets, target => target)).toEqual([targets[3], targets[1], targets[2], targets[0]])
  const required = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "required-native-state" }, origin, codec)
  const source = { model: "raw", input: [required] }
  const state: RequestAffinity = { protocol: "responses", source, codec, analysis: await analyzeAffinityRequest("responses", source, codec) }
  expect(await selectAffinityCandidate(candidates, state, "raw")).toBe(candidates[3])
  expect(await selectAffinityCandidate(candidates.slice(0, 3), state, "raw")).toBe(candidates[1])
  const chosen = candidates[1]
  if (!chosen) throw new Error("missing candidate")
  const payload = materializeAffinity(state, source, "raw")
  expect(payload.input).toEqual([{ type: "compaction", encrypted_content: "required-native-state" }])
  await (await chosen.binding.provider.fetch({ ...request(), payload, beforeInference: affinityFence(state) })).body?.cancel()
  expect(sent).toEqual([payload])
  expect(source.input).toEqual([required])
  const compatible = targets[1]
  if (!compatible) throw new Error("missing compatible")
  expect(state.analysis.classify({ ...compatible, compatibility: { ...declaration, key: "other-group" } })).toBe("unavailable")
  expect(state.analysis.classify({ ...compatible, compatibility: { ...declaration, scope: "credential" } })).toBe("unavailable")
  const credentialOrigin = { ...origin, compatibility: { ...declaration, scope: "credential" as const } }
  const credentialItem = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "private" }, credentialOrigin, codec)
  const credentialAnalysis = await analyzeAffinityRequest("responses", { input: [credentialItem] }, codec)
  expect(credentialAnalysis.classify({ ...compatible, compatibility: credentialOrigin.compatibility })).toBe("unavailable")
  for (const identity of [{ ownerId: "other-owner", apiKeyId: "key" }, { ownerId: "owner", apiKeyId: "other-key" }]) {
    const foreign = new AffinityCodec({ ...identity, version: 1, keyId: "kid", secret })
    await expect(analyzeAffinityRequest("responses", source, foreign)).rejects.toThrow()
  }
  expect(sent).toHaveLength(1)
})

test("actual session authentication permits owner/admin writes but API keys and mixed credentials cannot edit upstreams", async () => {
  const f = fixture()
  const now = new Date().toISOString()
  for (const id of ["owner", "assigned", "admin"] as const) {
    await f.repo.users.create({ id, name: id, createdAt: now, disabled: false, ...(id === "admin" ? { email: "test@local.dev" } : {}) })
    await f.repo.sessions.create({ token: `ses_${id}`, userId: id, createdAt: now, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await f.repo.apiKeys.save({ id: "owned", name: "owned", key: "synthetic-owned", ownerId: "owner", createdAt: now, modelMappingsEnabled: false, modelMappings: [] })
  await f.repo.apiKeys.save({ id: "shared", name: "shared", key: "synthetic-shared", ownerId: "owner", createdAt: now, modelMappingsEnabled: false, modelMappings: [] })
  f.db.run("INSERT INTO key_assignments (key_id, user_id, assigned_by, assigned_at) VALUES ('shared', 'assigned', 'owner', ?)", [now])
  const app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/upstreams", upstreamsRouter)
  const createBody = { provider: "custom", name: "session", config: configs.custom }
  const call = (path: string, method: string, body: unknown, headers: Record<string, string>) => app.request(path, { ...json(body, method), headers: { "content-type": "application/json", ...headers } })
  const created = await call("/api/upstreams", "POST", createBody, { cookie: "session_token=ses_owner" })
  expect(created.status).toBe(201)
  const id = (await created.json()).upstream.id as string
  for (const key of ["synthetic-owned", "synthetic-shared"]) for (const cookie of [undefined, "session_token=ses_owner", "session_token=ses_admin", "session_token=ses_assigned"]) {
    const headers = { authorization: `Bearer ${key}`, ...(cookie ? { cookie } : {}) }
    expect((await call("/api/upstreams", "POST", createBody, headers)).status).toBe(403)
    expect((await call(`/api/upstreams/${id}`, "PATCH", { config: { opaqueCompatibility: {} } }, headers)).status).toBe(403)
    expect((await call(`/api/upstreams/${id}`, "DELETE", {}, headers)).status).toBe(403)
    expect((await app.request("/api/upstreams", { headers })).status).toBe(200)
  }
  expect((await call(`/api/upstreams/${id}`, "PATCH", { config: { opaqueCompatibility: {} } }, { cookie: "session_token=ses_assigned" })).status).toBe(404)
  for (const session of ["ses_owner", "ses_admin"]) expect((await call(`/api/upstreams/${id}`, "PATCH", { name: session }, { cookie: `session_token=${session}` })).status).toBe(200)
  expect((await f.repo.upstreams.getById(id))?.config.opaqueCompatibility).toEqual(configs.custom.opaqueCompatibility)
  expect((await call(`/api/upstreams/${id}`, "DELETE", {}, { cookie: "session_token=ses_owner" })).status).toBe(200)
})

test("nonsecret declaration keys survive redacted export/import without credential sentinel substitution", async () => {
  const f = fixture()
  const opaqueCompatibility = { "model-secret-token": declaration }
  const created = await f.app.request("/api/upstreams", json({ provider: "custom", name: "export", config: { ...configs.custom, opaqueCompatibility } }))
  const id = (await created.json()).upstream.id as string
  const bundle = await (await f.app.request("/api/export?redact=1")).json()
  expect(bundle.upstreams[0].config.opaqueCompatibility).toEqual(opaqueCompatibility)
  bundle.upstreams[0].config.opaqueCompatibility["model-secret-token"].key = "__REDACTED__"
  expect((await f.app.request("/api/import", json({ mode: "merge", bundle }))).status).toBe(200)
  expect((await f.repo.upstreams.getById(id))?.config.opaqueCompatibility).toEqual({ "model-secret-token": { ...declaration, key: "__REDACTED__" } })
})
