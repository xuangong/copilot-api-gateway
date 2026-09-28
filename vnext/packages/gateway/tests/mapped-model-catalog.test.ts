import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from "@vibe-core/platform"
import { app } from "../src/app.ts"
import { initRepo } from "../src/repo/index.ts"
import type { ApiKey, ApiKeyModelMapping, UpstreamRecord } from "../src/repo/types.ts"
import type { ApiKeyId, UserId } from "../src/repo/branded-ids.ts"

const OWNER = "catalog-owner" as UserId
const KEY_ID = "catalog-key" as ApiKeyId
const KEY = "catalog-test-key"
const TARGET = "gpt-target"
const CREATED = "2026-09-06T00:00:00Z"
const originalFetch = globalThis.fetch
let db: Database
let repo: BunSqliteRepo
let pending: Promise<unknown>[]

interface CatalogRow {
  id: string
  name?: string
  _upstream: string
  _mapped_to?: string
  capabilities?: { limits?: { max_context_window_tokens?: number } }
  chat?: { image_detail_original?: boolean }
}

function upstream(id = "up_catalog", ownerId = OWNER): UpstreamRecord {
  return {
    id, ownerId, provider: "custom", name: id, enabled: true, sortOrder: 0,
    config: { name: id, baseUrl: `https://${id}.test/v1`, apiKey: "upstream-test-key", endpoints: ["chat_completions", "responses"] },
    flagOverrides: {}, disabledPublicModelIds: [], state: null,
    proxyFallbackList: [{ id: "direct_fetch" }], createdAt: CREATED, updatedAt: CREATED,
  }
}

async function saveKey(mappings: ApiKeyModelMapping[], overrides: Partial<ApiKey> = {}) {
  await repo.apiKeys.save({
    id: KEY_ID, ownerId: OWNER, key: KEY, name: "catalog", createdAt: CREATED,
    modelMappingsEnabled: true, modelMappings: mappings, ...overrides,
  })
}

async function catalog(path = "/v1/models", key = KEY): Promise<CatalogRow[]> {
  const response = await app.request(path, { headers: { "x-api-key": key } })
  expect(response.status).toBe(200)
  return (await response.json() as { data: CatalogRow[] }).data
}

beforeEach(async () => {
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  pending = []
  initRepo(repo)
  initRuntimeLocation("bun")
  initBackground({ waitUntil: (promise) => { pending.push(promise) } })
  await repo.users.create({ id: OWNER, name: "owner", disabled: false, createdAt: CREATED, userKey: "owner-session-key" })
  await repo.upstreams.save(upstream())
  await saveKey([{ source: "client-alias", destination: TARGET }])
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{
        id: TARGET, object: "model", name: "Target display name",
        capabilities: { type: "chat", limits: { max_context_window_tokens: 128000 } },
        supported_endpoints: ["/responses"],
      }] })
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const payload = await request.json() as { model: string }
      if (payload.model !== TARGET) return Response.json({ error: "wrong model" }, { status: 400 })
      return Response.json({
        id: "completion-1", object: "chat.completion", model: TARGET,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
})

afterEach(async () => {
  await Promise.allSettled(pending)
  globalThis.fetch = originalFetch
  db.close()
  __resetPlatformForTests()
})

test.each(["/v1/models", "/models", "/api/models", `/api/models?keyId=${KEY_ID}`])(
  "%s advertises the authenticated key's callable alias with target capabilities",
  async (path) => {
    const rows = await catalog(path)
    expect(rows.map((row) => row.id)).toEqual([TARGET, "client-alias"])
    expect(rows[1]).toMatchObject({
      id: "client-alias", name: "client-alias", _mapped_to: TARGET, _upstream: "up_catalog",
      capabilities: { limits: { max_context_window_tokens: 128000 } },
    })
  },
)

test("an advertised alias can be used in an actual completion", async () => {
  expect((await catalog()).map((row) => row.id)).toContain("client-alias")
  const response = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: "client-alias", messages: [{ role: "user", content: "hello" }] }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ model: TARGET, choices: [{ message: { content: "ok" } }] })
})

test("mappings stay isolated between keys sharing the same upstream cache", async () => {
  await saveKey([{ source: "other-alias", destination: TARGET }], { id: "other-key" as ApiKeyId, key: "other-test-key" })
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET, "client-alias"])
  expect((await catalog("/v1/models", "other-test-key")).map((row) => row.id)).toEqual([TARGET, "other-alias"])
  expect((await catalog("/api/models", "owner-session-key")).map((row) => row.id)).toEqual([TARGET])
})

test("disabling or editing mappings changes the next catalog request", async () => {
  expect((await catalog()).map((row) => row.id)).toContain("client-alias")
  await repo.apiKeys.patchModelMappings(KEY_ID, { modelMappingsEnabled: false })
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET])
  await repo.apiKeys.patchModelMappings(KEY_ID, { modelMappingsEnabled: true, modelMappings: [{ source: "new-alias", destination: TARGET }] })
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET, "new-alias"])
  await repo.apiKeys.patchModelMappings(KEY_ID, { modelMappings: [] })
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET])
})

test("ordered chains and finite round trips advertise each source once", async () => {
  await saveKey([
    { source: "a", destination: "b" },
    { source: "b", destination: "a" },
    { source: "a", destination: TARGET },
    { source: TARGET, destination: TARGET },
  ])
  const rows = await catalog()
  expect(rows.map((row) => row.id)).toEqual([TARGET, "a", "b"])
  expect(rows.filter((row) => row._mapped_to).map((row) => row._mapped_to)).toEqual([TARGET, TARGET])
  expect(rows[0]?.name).toBe("Target display name")
})

test("a later rule with the same source cannot make an unreachable first match available", async () => {
  await saveKey([
    { source: "valid", destination: TARGET },
    { source: "unreachable", destination: "missing" },
    { source: "unreachable", destination: TARGET },
    { source: "up_absent/valid", destination: TARGET },
  ])
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET, "valid"])
})

test("an unavailable redirection omits both the raw source and its dependent alias", async () => {
  await saveKey([
    { source: "client-alias", destination: TARGET },
    { source: TARGET, destination: "missing" },
  ])
  expect(await catalog(`/api/models?keyId=${KEY_ID}`, "owner-session-key")).toEqual([])
  expect((await app.request("/v1/models", { headers: { "x-api-key": KEY } })).status).toBe(404)
})

test("disabled and foreign upstreams cannot make an alias available", async () => {
  await repo.upstreams.save({ ...upstream(), disabledPublicModelIds: [TARGET] })
  await repo.upstreams.save(upstream("up_foreign", "foreign-owner" as UserId))
  expect(await catalog(`/api/models?keyId=${KEY_ID}`)).toEqual([])
})

test("dedupe=0 preserves each target upstream for aliases without duplicating rules", async () => {
  await repo.upstreams.save(upstream("up_second"))
  await saveKey([{ source: "client-alias", destination: TARGET }, { source: "client-alias", destination: TARGET }])
  const rows = await catalog(`/api/models?keyId=${KEY_ID}&dedupe=0`)
  expect(rows.filter((row) => row.id === "client-alias").map((row) => row._upstream).sort()).toEqual(["up_catalog", "up_second"])
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET, "client-alias"])
})

test.each([false, undefined, "text-only" as const])("a key alias only advertises original image detail when every routeable upstream supports it: %s", async (second) => {
  await repo.upstreams.save(upstream("up_second"))
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    const isSecond = url.includes("up_second.test")
    return Response.json({ data: [{ id: TARGET, name: TARGET, chat: {
      modalities: { input: isSecond && second === "text-only" ? ["text"] : ["text", "image"], output: ["text"] },
      ...(isSecond && second === undefined ? {} : { image_detail_original: isSecond ? second === "text-only" : true }),
    } }] })
  }) as typeof fetch
  const rows = await catalog()
  expect(rows.find((row) => row.id === TARGET)?.chat?.image_detail_original).toBe(false)
  expect(rows.find((row) => row.id === "client-alias")?.chat?.image_detail_original).toBe(false)
})

test("per-upstream alias rows retain each selected upstream's image detail fact", async () => {
  await repo.upstreams.save(upstream("up_second"))
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    return Response.json({ data: [{ id: TARGET, name: TARGET, chat: {
      modalities: { input: ["text", "image"], output: ["text"] },
      image_detail_original: url.includes("up_second.test"),
    } }] })
  }) as typeof fetch
  const rows = await catalog("/api/models?keyId=catalog-key&dedupe=0", "owner-session-key")
  expect(rows.filter((row) => row.id === "client-alias").map((row) => [row._upstream, row.chat?.image_detail_original])).toEqual([
    ["up_catalog", false], ["up_second", true],
  ])
})

test.each([
  { sourceSupportsOriginal: true, targetSupportsOriginal: false },
  { sourceSupportsOriginal: false, targetSupportsOriginal: true },
])("an existing mapped source advertises its target's image detail in public and Codex catalogs: %s", async ({ sourceSupportsOriginal, targetSupportsOriginal }) => {
  await saveKey([{ source: "gpt-source", destination: TARGET }])
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.endsWith("/models")) return new Response("not found", { status: 404 })
    return Response.json({ data: [
      { id: "gpt-source", name: "Source", chat: {
        modalities: { input: ["text", "image"], output: ["text"] }, image_detail_original: sourceSupportsOriginal,
      } },
      { id: TARGET, name: "Target", chat: {
        modalities: { input: ["text", "image"], output: ["text"] }, image_detail_original: targetSupportsOriginal,
      } },
    ] })
  }) as typeof fetch

  const publicRows = (await catalog()).filter((row) => row.id === "gpt-source")
  expect(publicRows).toHaveLength(1)
  expect(publicRows[0]).toMatchObject({
    id: "gpt-source", _mapped_to: TARGET, chat: { image_detail_original: targetSupportsOriginal },
  })

  const response = await app.request("/v1/models", { headers: { "x-api-key": KEY, "user-agent": "codex-tui/0.144.1" } })
  expect(response.status).toBe(200)
  const body = await response.json() as { models: Array<{ slug: string; supports_image_detail_original: boolean }> }
  const codexRows = body.models.filter((row) => row.slug === "gpt-source")
  expect(codexRows).toHaveLength(1)
  expect(codexRows[0]?.supports_image_detail_original).toBe(targetSupportsOriginal)
})

test("an existing mapped source excludes every raw source from multi-upstream capability aggregation", async () => {
  await repo.upstreams.save(upstream("up_second"))
  await saveKey([{ source: "gpt-source", destination: TARGET }])
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.endsWith("/models")) return new Response("not found", { status: 404 })
    const second = url.includes("up_second.test")
    return Response.json({ data: [
      { id: "gpt-source", name: "Source", chat: {
        modalities: { input: ["text", "image"], output: ["text"] }, image_detail_original: true,
      } },
      { id: TARGET, name: "Target", chat: {
        modalities: { input: ["text", "image"], output: ["text"] }, image_detail_original: second,
      } },
    ] })
  }) as typeof fetch

  const perUpstream = await catalog(`/api/models?keyId=${KEY_ID}&dedupe=0`, "owner-session-key")
  expect(perUpstream.filter((row) => row.id === "gpt-source").map((row) => [
    row._upstream, row._mapped_to, row.chat?.image_detail_original,
  ])).toEqual([
    ["up_catalog", TARGET, false], ["up_second", TARGET, true],
  ])
  const publicRows = (await catalog()).filter((row) => row.id === "gpt-source")
  expect(publicRows).toHaveLength(1)
  expect(publicRows[0]?.chat?.image_detail_original).toBe(false)

  const response = await app.request("/v1/models", { headers: { "x-api-key": KEY, "user-agent": "codex-tui/0.144.1" } })
  expect(response.status).toBe(200)
  const body = await response.json() as { models: Array<{ slug: string; supports_image_detail_original: boolean }> }
  expect(body.models.find((row) => row.slug === "gpt-source")?.supports_image_detail_original).toBe(false)
})

test.each(["owner", "assignee", "admin"])("a %s session sees the selected key's mapping sources", async (viewer) => {
  const viewerId = viewer === "owner" ? OWNER : `${viewer}-user` as UserId
  const viewerKey = viewer === "owner" ? "owner-session-key" : `${viewer}-session-key`
  if (viewer !== "owner") {
    await repo.users.create({ id: viewerId, name: viewer, userKey: viewerKey, disabled: false, createdAt: CREATED, ...(viewer === "admin" ? { email: "test@local.dev" } : {}) })
    if (viewer === "assignee") await repo.keyAssignments.assign(KEY_ID, viewerId, OWNER)
  }
  expect((await catalog(`/api/models?keyId=${KEY_ID}`, viewerKey)).map((row) => row.id)).toEqual([TARGET, "client-alias"])
})

test("a viewer cannot enumerate another key's aliases without a grant", async () => {
  await repo.users.create({ id: "stranger" as UserId, name: "stranger", userKey: "stranger-session-key", disabled: false, createdAt: CREATED })
  for (const keyId of [KEY_ID, "unknown-key"]) {
    const response = await app.request(`/api/models?keyId=${keyId}`, { headers: { "x-api-key": "stranger-session-key" } })
    expect(response.status).toBe(403)
  }
})

test("allOwners catalog remains an upstream inventory even when an admin selects a key", async () => {
  await repo.users.create({ id: "admin" as UserId, name: "admin", userKey: "admin-session-key", email: "test@local.dev", disabled: false, createdAt: CREATED })
  expect((await catalog(`/api/models?keyId=${KEY_ID}&allOwners=1`, "admin-session-key")).map((row) => row.id)).toEqual([TARGET])
})

test("invalid persisted mapping data fails closed in both client and dashboard catalogs", async () => {
  db.query("UPDATE api_keys SET model_mappings = ? WHERE id = ?").run("invalid json", KEY_ID)
  expect((await catalog()).map((row) => row.id)).toEqual([TARGET])
  expect((await catalog(`/api/models?keyId=${KEY_ID}`, "owner-session-key")).map((row) => row.id)).toEqual([TARGET])
})

test.each(["claude-code/2.0.0", "codex-tui/0.144.1"])("%s discovers aliases through its native catalog shape", async (userAgent) => {
  const response = await app.request("/v1/models", { headers: { "x-api-key": KEY, "user-agent": userAgent } })
  expect(response.status).toBe(200)
  const body = await response.json() as { data?: Array<{ id: string }>; models?: Array<{ slug: string }> }
  const ids = body.data?.map((row) => row.id) ?? body.models?.map((row) => row.slug)
  expect(ids).toEqual([TARGET, "client-alias"])
})

test("mapping sources can target a Claude composite model resolved through its base catalog entry", async () => {
  await saveKey([{ source: "writing", destination: "claude-sonnet-4.6-high-1m" }])
  globalThis.fetch = (async () => Response.json({ object: "list", data: [{
    id: "claude-sonnet-4.6", object: "model",
    capabilities: { type: "chat", limits: { max_context_window_tokens: 1000000 } },
  }] })) as typeof fetch
  const rows = await catalog()
  expect(rows.map((row) => row.id)).toEqual(["claude-sonnet-4.6", "writing"])
  expect(rows[1]).toMatchObject({ _mapped_to: "claude-sonnet-4.6-high-1m", capabilities: { limits: { max_context_window_tokens: 1000000 } } })
})
