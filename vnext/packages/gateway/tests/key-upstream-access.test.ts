import { afterEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { __resetPlatformForTests, initBackground, initSocketDial } from "@vibe-core/platform"
import { bunSocketDial } from "../../../apps/platform-bun/src/bun-socket-dial.ts"
import { setupTestPlatform } from "./_setup-platform.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"
import type { DataPlaneAuthCtx } from "../src/data-plane/models/routes.ts"
import { modelsRouter } from "../src/data-plane/models/routes.ts"
import { embeddingsRouter } from "../src/data-plane/embeddings/routes.ts"
import { imagesRouter } from "../src/data-plane/images/routes.ts"
import { listProviderBindings, listUpstreamModels } from "../src/data-plane/providers/registry.ts"
import { enumerateBindingCandidates } from "../src/data-plane/routing/candidates.ts"
import { resolveBinding } from "../src/data-plane/routing/binding-resolver.ts"
import { serveChatCompletions } from "../src/data-plane/chat-flow/chat-completions/serve.ts"
import { serveMessages } from "../src/data-plane/chat-flow/messages/serve.ts"
import { serveResponses } from "../src/data-plane/chat-flow/responses/serve.ts"
import { serveGemini } from "../src/data-plane/chat-flow/gemini/serve.ts"
import { serveCountTokens } from "../src/data-plane/chat-flow/count-tokens/serve.ts"
import { serveGeminiCountTokens } from "../src/data-plane/chat-flow/gemini/count-tokens.ts"
import { listTags, showModel } from "../src/data-plane/ollama/show.ts"
import { dmrRouter } from "../src/data-plane/dmr/routes.ts"
import { resolveAlphaSearchDispatcher } from "../src/data-plane/tools/web-search/alpha-search/upstream.ts"
import { resolveWebSearchForKey } from "../src/data-plane/tools/web-search/resolve-for-key.ts"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth.ts"
import { streamImageGeneration } from "../src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts"
import { AffinityCodec } from "../src/shared/affinity/carrier.ts"
import { stampAffinityOrigin } from "../src/shared/affinity/origin-anchor.ts"
import { analyzeAffinityRequest, AffinityRoutingUnavailableError, stampAffinityItem } from "../src/shared/affinity/analysis.ts"
import { selectBindingForProtocol } from "../src/data-plane/chat-flow/shared/select-binding.ts"
import type { EndpointKey } from "@vibe-llm/protocols/common"
import { resolveCredential } from "../src/shared/credential-auth.ts"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); __resetPlatformForTests() })

async function fixture(endpoints: readonly EndpointKey[] = ["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings", "images_generations", "images_edits", "alpha_search"]) {
  const { db, repo } = setupTestPlatform({ envLookup: name => name === "DMR_COMPAT" ? "1" : "" })
  cleanup.push(() => db.close())
  initSocketDial(bunSocketDial)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  const sent: string[] = []
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname
    const id = path.split("/")[1] ?? ""
    sent.push(id)
    if (path.endsWith("count_tokens")) return Response.json({ input_tokens: 7 })
    if (path.endsWith("embeddings")) return Response.json({ object: "list", data: [{ object: "embedding", embedding: [1], index: 0 }], usage: { prompt_tokens: 1, total_tokens: 1 } })
    if (path.includes("/images/")) return Response.json({ created: 1, data: [{ b64_json: "aQ==" }] })
    if (path.endsWith("/messages")) return Response.json({ id: "message", type: "message", model: "duplicate", role: "assistant", content: [{ type: "text", text: id }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    if (path.endsWith("/responses")) return Response.json({ id: "response", object: "response", model: "duplicate", status: "completed", output: [{ type: "message", id: "output", role: "assistant", status: "completed", content: [{ type: "output_text", text: id, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    return Response.json({ id: "chat", object: "chat.completion", model: "duplicate", created: 1, choices: [{ index: 0, message: { role: "assistant", content: id }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  } })
  cleanup.unshift(() => upstream.stop(true))
  for (const [id, ownerId, enabled, sortOrder] of [["up_a", "owner", true, 0], ["up_b", "owner", true, 1], ["up_global", "", true, 2], ["up_foreign", "other", true, 3], ["up_disabled", "owner", false, 4]] as const) {
    await repo.upstreams.save({ id, ownerId, enabled, sortOrder, provider: "custom", name: id,
      config: { name: id, baseUrl: new URL(id + "/v1", upstream.url).toString(), authStyle: "none", endpoints, models: [{ id: "duplicate", name: id }, "text-embedding-3", "gpt-image-2", `${id}-only`] },
      flagOverrides: {}, disabledPublicModelIds: [], state: {}, proxyFallbackList: [], createdAt: "now", updatedAt: "now" } satisfies UpstreamRecord)
  }
  return { db, repo, sent, pending }
}

function auth(upstreamIds: readonly string[] | null): DataPlaneAuthCtx {
  return { userId: "owner", routingPolicy: { upstreamIds, modelMappingsEnabled: true, modelMappings: [{ source: "alias", destination: "duplicate" }] } }
}

function app(router: Hono, context: DataPlaneAuthCtx) {
  const result = new Hono()
  result.use("*", (c, next) => { c.set("auth", context); return next() })
  result.route("/", router)
  return result
}

test("ordered scope filters before catalog dedupe and leaves inherited cached ordering intact", async () => {
  await fixture()
  for (const upstreamIds of [["up_b", "up_a"], ["up_a", "up_b"], [], ["up_foreign", "up_disabled", "deleted", "up_global"]]) {
    const opts = { ownerId: "owner", upstreamIds }
    const expected = upstreamIds.filter(id => ["up_a", "up_b", "up_global"].includes(id))
    const candidates = await enumerateBindingCandidates({ model: "duplicate", pickTarget: () => "chat_completions", opts })
    expect(candidates.candidates.map(c => c.binding.upstream)).toEqual(expected)
    expect((await listProviderBindings(opts)).filter(b => b.model.id === "duplicate").map(b => b.upstream)).toEqual(expected)
    const catalog = await listUpstreamModels(opts)
    expect((catalog.data.find(m => m.id === "duplicate") as { _upstream?: string } | undefined)?._upstream).toBe(expected[0])
  }
  expect((await resolveBinding("duplicate", "chat_completions", { ownerId: "owner" }))?.upstream).toBe("up_a")
  expect((await resolveBinding("duplicate", "chat_completions", { ownerId: "owner", upstreamIds: null }))?.upstream).toBe("up_a")
  expect(await resolveBinding("up_a/duplicate", "chat_completions", { ownerId: "owner", upstreamIds: ["up_b"] })).toBeNull()
})

test("explicit scope suppresses virtual Copilot fallback even when scope resolves empty", async () => {
  await fixture()
  const before = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ data: [{ id: "virtual" }] }) }) as typeof fetch
  try {
    for (const upstreamIds of [[], ["deleted"], ["up_foreign"]]) {
      expect(await listProviderBindings({ ownerId: "owner", upstreamIds, copilot: { copilotToken: "synthetic", accountType: "individual" } })).toEqual([])
    }
    expect(calls).toBe(0)
  } finally { globalThis.fetch = before }
})

for (const source of ["chat_completions", "responses", "messages", "gemini"] as const) for (const target of [undefined, "chat_completions", "responses", "messages"] as const) test(`${source} -> ${target ?? "preferred"} maps aliases and obeys reversed ordered scopes, empty scopes and pins`, async () => {
  const f = await fixture(target ? [target] : undefined)
  const invoke = async (upstreamIds: readonly string[], model = "alias") => {
    const common = { auth: auth(upstreamIds), obsCtx: {}, signal: new AbortController().signal }
    if (source === "responses") return (await serveResponses({ ...common, raw: { model, input: "question" } })).response
    if (source === "messages") return serveMessages({ ...common, raw: { model, messages: [{ role: "user", content: "question" }], max_tokens: 20 } })
    if (source === "gemini") return serveGemini({ ...common, model, raw: { contents: [{ role: "user", parts: [{ text: "question" }] }] }, forceStream: false })
    return serveChatCompletions({ ...common, raw: { model, messages: [{ role: "user", content: "question" }] } })
  }
  for (const upstreamIds of [["up_b", "up_a"], ["up_a", "up_b"]]) {
    const response = await invoke(upstreamIds)
    expect(response.status).toBe(200)
    await response.text()
    expect(f.sent.at(-1)).toBe(upstreamIds[0])
  }
  const calls = f.sent.length
  expect((await invoke([])).status).toBe(404)
  expect((await invoke(["up_b"], "up_a/duplicate")).status).toBe(404)
  expect(f.sent).toHaveLength(calls)
  await Promise.all(f.pending)
})

test("count tokens, embeddings and image endpoints stay inside the key whitelist", async () => {
  const f = await fixture()
  for (const upstreamIds of [["up_b", "up_a"], []]) {
    const context = auth(upstreamIds)
    const expected = upstreamIds.length ? 200 : 404
    const common = { auth: context, raw: { model: "alias", messages: [{ role: "user", content: "question" }] } }
    expect((await serveCountTokens({ ...common, forwardedHeaders: {} })).status).toBe(expected)
    expect((await serveGeminiCountTokens({ auth: context, model: "alias", raw: { contents: [{ role: "user", parts: [{ text: "question" }] }] } })).status).toBe(expected)
    for (const [router, path, payload] of [[embeddingsRouter, "/v1/embeddings", { model: "text-embedding-3", input: "question" }], [imagesRouter, "/v1/images/generations", { model: "gpt-image-2", prompt: "question" }], [imagesRouter, "/v1/images/edits", { model: "gpt-image-2", prompt: "question", images: [{ image_url: "data:image/png;base64,aQ==" }] }]] as const) {
      const response = await app(router, context).request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      expect(response.status).toBe(expected)
      await response.text()
    }
  }
  expect(f.sent).toEqual(["up_b", "up_b", "up_b", "up_b", "up_b"])
  await Promise.all(f.pending)
})

test("SDK, Gemini, DMR and Ollama catalogs exclude unlisted model metadata", async () => {
  await fixture()
  const context = auth(["up_b"])
  for (const path of ["/api/models", "/v1/models", "/models", "/v1beta/models", "/v1beta/models/up_b-only"]) {
    const response = await app(modelsRouter, context).request(path)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain("up_a-only")
    expect(text).not.toContain("up_global-only")
  }
  expect((await app(modelsRouter, context).request("/v1beta/models/up_a-only")).status).toBe(404)
  expect((await listTags(context)).models.map(m => m.name)).not.toContain("up_a-only")
  expect(await showModel(context, "up_a-only")).toBeNull()
  const previous = process.env.DMR_COMPAT
  process.env.DMR_COMPAT = "1"
  try {
    const dmr = await app(dmrRouter, context).request("/models")
    expect(dmr.status).toBe(200)
    expect(await dmr.text()).not.toContain("up_a-only")
  } finally { if (previous === undefined) delete process.env.DMR_COMPAT; else process.env.DMR_COMPAT = previous }
})

test("an explicit empty or unresolved key scope publishes an empty catalog without OAuth instructions", async () => {
  await fixture()
  for (const upstreamIds of [[], ["deleted"], ["up_foreign", "up_disabled"]]) for (const copilot of [undefined, { copilotToken: "synthetic", accountType: "individual" as const }]) {
    const response = await app(modelsRouter, { ...auth(upstreamIds), copilot }).request("/v1/models")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ object: "list", data: [] })
  }
})

test("key previews use the key owner scope even for assigned viewers and invalid mappings", async () => {
  const f = await fixture()
  await f.repo.apiKeys.save({ id: "preview", name: "preview", key: "preview-credential", ownerId: "owner", createdAt: "now", upstreamIds: ["up_b"], modelMappingsEnabled: false, modelMappings: [] })
  await f.repo.keyAssignments.assign("preview", "viewer", "owner")
  for (const context of [{ userId: "owner" }, { userId: "viewer" }, { userId: "administrator", isAdmin: true }]) {
    const response = await app(modelsRouter, context).request("/api/models?keyId=preview&dedupe=0")
    expect(response.status).toBe(200)
    const json = await response.json() as { data: Array<{ _upstream: string }> }
    expect(new Set(json.data.map(model => model._upstream))).toEqual(new Set(["up_b"]))
  }
  expect((await app(modelsRouter, { userId: "stranger" }).request("/api/models?keyId=preview")).status).toBe(403)
  f.db.run("UPDATE api_keys SET model_mappings = 'malformed' WHERE id = 'preview'")
  const invalidMapping = await app(modelsRouter, { userId: "viewer" }).request("/api/models?keyId=preview")
  expect(invalidMapping.status).toBe(200)
  const invalidCatalog = await invalidMapping.json() as { data: Array<{ _upstream: string }> }
  expect(new Set(invalidCatalog.data.map(model => model._upstream))).toEqual(new Set(["up_b"]))
})

for (const owned of [true, false]) test(`${owned ? "owned" : "ownerless"} API-key auth previews only itself without a second key lookup`, async () => {
  const f = await fixture()
  await f.repo.apiKeys.save({ id: "calling-key", name: "calling", key: "calling-credential", ownerId: owned ? "owner" : undefined,
    createdAt: "now", upstreamIds: [owned ? "up_a" : "up_global"], modelMappingsEnabled: false, modelMappings: [] })
  await f.repo.apiKeys.save({ id: "other-key", name: "other", key: "other-credential", ownerId: "owner", createdAt: "now",
    upstreamIds: ["up_b"], modelMappingsEnabled: false, modelMappings: [] })
  const context = await resolveCredential("calling-credential")
  if (!context) throw new Error("real fixture credential did not resolve")
  expect(context.apiKeyId).toBe("calling-key")
  const secondKeyLookup = spyOn(f.repo.apiKeys, "getById")
  try {
    for (const suffix of ["", "&allOwners=1"]) for (const isAdmin of [undefined, true]) {
      const other = await app(modelsRouter, { ...context, isAdmin }).request(`/api/models?keyId=other-key${suffix}`)
      expect(other.status).toBe(403)
    }
    const own = await app(modelsRouter, context).request("/api/models?keyId=calling-key&dedupe=0")
    expect(own.status).toBe(200)
    const catalog = await own.json() as { data: Array<{ _upstream: string }> }
    expect(new Set(catalog.data.map(model => model._upstream))).toEqual(new Set([owned ? "up_a" : "up_global"]))
    expect(secondKeyLookup).not.toHaveBeenCalled()
    expect(f.sent).toEqual([])
  } finally { secondKeyLookup.mockRestore() }
})

test("alpha-search helper cannot use an out-of-scope configured upstream", async () => {
  const f = await fixture()
  await expect(resolveAlphaSearchDispatcher({ config: { upstreamId: "up_a", model: "duplicate" }, auth: auth(["up_b"]) })).rejects.toThrow("scope")
  await expect(resolveAlphaSearchDispatcher({ config: { upstreamId: "up_b", model: "duplicate" }, auth: auth([]) })).rejects.toThrow("scope")
  const dispatch = await resolveAlphaSearchDispatcher({ config: { upstreamId: "up_b", model: "duplicate" }, auth: auth(["up_b"]) })
  await (await dispatch({}, undefined, new Headers())).text()
  expect(f.sent).toEqual(["up_b"])
})

test("image helper filters its explicit scope before any excluded catalog preparation", async () => {
  const f = await fixture()
  const excluded = await f.repo.upstreams.getById("up_a")
  if (!excluded) throw new Error("missing fixture upstream")
  await f.repo.upstreams.save({ ...excluded, proxyFallbackList: [{ id: "direct_fetch" }], config: { name: "excluded", baseUrl: "https://excluded.invalid", authStyle: "none", endpoints: ["images_generations"] } })
  const original = globalThis.fetch
  let catalogCalls = 0
  globalThis.fetch = (async () => { catalogCalls++; return Response.json({ data: [] }) }) as typeof fetch
  try {
    const run = streamImageGeneration("question", "generate", false, [], {
      config: { model: "gpt-image-2", action: "generate" }, apiKeyId: "fixture-key", incomingModel: "image-alias",
      upstreamIds: [], bindingScope: { ownerId: "owner" }, downstreamAbortSignal: undefined, imageDispatchCount: 0,
    })()
    while (!(await run.next()).done) { /* Drain lifecycle events. */ }
    expect(catalogCalls).toBe(0)
    expect(f.sent).toEqual([])
  } finally { globalThis.fetch = original }
})

test("Copilot prewarm and web-search token choice respect key priority and visibility", async () => {
  const f = await fixture()
  await f.repo.users.create({ id: "owner", name: "fixture", disabled: false, createdAt: "now" })
  for (const [id, ownerId, sortOrder] of [["up_cp_a", "owner", 0], ["up_cp_b", "owner", 1], ["up_cp_foreign", "other", -1]] as const) {
    await f.repo.upstreams.save({ id, ownerId, sortOrder, enabled: true, provider: "copilot", name: id,
      config: { githubToken: `synthetic-${id}` }, flagOverrides: {}, disabledPublicModelIds: [], state: {}, proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "2026-01-01", updatedAt: "now" })
  }
  await f.repo.upstreams.save({ id: "up_cp_global", ownerId: "", sortOrder: 0, enabled: true, provider: "copilot", name: "global",
    config: { githubToken: "synthetic-up_cp_global" }, flagOverrides: {}, disabledPublicModelIds: [], state: {}, proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "2026-02-01", updatedAt: "now" })
  const original = globalThis.fetch
  const authorization: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorization.push(new Headers(init?.headers).get("authorization") ?? "")
    return Response.json({ token: "synthetic-session", expires_at: Date.now() / 1000 + 3600 })
  }) as typeof fetch
  try {
    for (const upstreamIds of [[], ["up_cp_b", "up_cp_a"], ["up_cp_foreign"], null]) {
      await f.repo.apiKeys.save({ id: "scope-key", key: "scope-credential", name: "scope", ownerId: "owner", createdAt: "now", modelMappingsEnabled: false, modelMappings: [], upstreamIds, webSearchEnabled: true, webSearchPriority: ["copilot"] })
      const middlewareApp = new Hono()
      middlewareApp.use("*", sessionAuthMiddleware)
      middlewareApp.get("/probe", c => c.json(c.get("auth") ?? {}))
      authorization.length = 0
      const response = await middlewareApp.request("/probe", { headers: { authorization: "Bearer scope-credential" } })
      expect(response.status).toBe(200)
      const context = await response.json() as { githubToken?: string }
      const expected = upstreamIds === null ? "synthetic-up_cp_a" : upstreamIds[0] === "up_cp_b" ? "synthetic-up_cp_b" : undefined
      expect(context.githubToken).toBe(expected)
      const search = await resolveWebSearchForKey("scope-key")
      expect(search.type).toBe(expected ? "enabled" : "none")
      if (search.type === "enabled") {
        await search.impl.search({ query: "test" })
        expect(authorization.at(-1)).toBe(`Bearer ${expected}`)
      } else expect(authorization).toEqual([])
    }
  } finally { globalThis.fetch = original }
})

test("plain provenance preserves key preference; native and inherited affinity rank only authorized upstreams", async () => {
  const f = await fixture()
  const originBinding = await resolveBinding("duplicate", "responses", { ownerId: "owner", upstreamIds: ["up_a"] })
  const target = await originBinding?.provider.prepareAffinityExecution?.({ endpoint: "responses", payload: { model: "duplicate", input: "hello" }, headers: new Headers() })
  if (!target) throw new Error("fixture did not prepare an execution identity")
  const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
  const origin = await stampAffinityOrigin("responses", { type: "reasoning", summary: [] }, target, codec)
  const native = await stampAffinityItem("responses", { type: "compaction", encrypted_content: "native" }, target, codec)
  const select = async (input: Record<string, unknown>[], upstreamIds: readonly string[]) => selectBindingForProtocol({
    model: "duplicate", protocol: "responses", pickTarget: endpoints => endpoints.responses ? "responses" : null,
    auth: { ownerId: "owner", upstreamIds }, affinity: { execution: { protocol: "responses", codec }, analysis: await analyzeAffinityRequest("responses", { model: "duplicate", input }, codec) },
  })
  expect((await select([origin], ["up_b", "up_a"]))).toMatchObject({ kind: "ok", binding: { upstream: "up_b" } })
  for (const input of [[native], [origin, { type: "program_output", result: "continue" }]]) {
    expect((await select(input, ["up_b", "up_a"]))).toMatchObject({ kind: "ok", binding: { upstream: "up_a" } })
    await expect(select(input, ["up_b"])).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
    expect((await select(input, []))).toMatchObject({ kind: "model-not-found" })
  }
  expect(f.sent).toEqual([])
})
