import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { Hono } from "hono"
import { __resetPlatformForTests, initBackground, initRuntimeLocation, initSocketDial } from "@vibe-core/platform"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { InMemoryResponsesSnapshotStore } from "@vibe-llm/responses-store"
import { app } from "../src/app.ts"
import { initRepo } from "../src/repo/index.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { initResponsesStore } from "../src/data-plane/runtime/responses-store.ts"
import { initDumpBroker, initDumpStore, resetDumpRegistryForTests } from "../src/shared/dump/registry.ts"
import { DumpAccumulator, openDumpAccumulator } from "../src/shared/dump/accumulator.ts"
import { listProviderBindings } from "../src/data-plane/providers/registry.ts"
import type { ApiKey, UpstreamRecord } from "../src/repo/types.ts"
import type { ApiKeyId, DumpRecordId, UserId } from "../src/repo/branded-ids.ts"
import type { EndpointKey } from "@vibe-llm/protocols/common"

const originalFetch = globalThis.fetch
const now = "2026-09-29T00:00:00.000Z"
const keyId = "capture_key" as ApiKeyId
const ownerId = "capture_owner" as UserId
let root: string
let db: Database
let repo: BunSqliteRepo
let store: FileDumpStore
let pending: Promise<unknown>[]
let calls: string[]
let replies: (url: string, init?: RequestInit) => Response | Promise<Response>
const json = (body: unknown) => Response.json(body)
const chatBody = { id: "chat_capture", object: "chat.completion", model: "model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
const responsesBody = { id: "resp_capture", object: "response", model: "model", status: "completed", output: [{ id: "msg_capture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
const messagesBody = { id: "msg_capture", type: "message", role: "assistant", model: "model", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }

beforeEach(async () => {
  __resetPlatformForTests()
  resetDumpRegistryForTests()
  root = await mkdtemp(join(tmpdir(), "dump-route-activation-"))
  db = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  store = new FileDumpStore(new BunSqliteDatabase(db), new FsFileProvider(join(root, "files")))
  initDumpStore(store)
  initDumpBroker({ publish: async () => {}, closeChannel: async () => {}, subscribe: async function* () {} })
  pending = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  await saveKey(keyId, ownerId)
  calls = []
  replies = (url) => {
    if (url.endsWith("/models")) return json({ object: "list", data: [{ id: "model" }, { id: "gpt-image-1" }] })
    if (url.endsWith("/chat/completions")) return json(chatBody)
    if (url.endsWith("/messages/count_tokens")) return json({ input_tokens: 7 })
    if (url.endsWith("/messages")) return json(messagesBody)
    if (url.endsWith("/responses")) return json(responsesBody)
    if (url.endsWith("/embeddings")) return json({ object: "list", model: "model", data: [{ object: "embedding", index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 1, total_tokens: 1 } })
    if (url.includes("/images/")) return json({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] })
    if (url.endsWith("/alpha/search")) return json({ encrypted_output: "opaque", output: "ok" })
    throw new Error(`unexpected test endpoint ${url}`)
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    return replies(url, init)
  }) as typeof fetch
})
afterEach(async () => {
  await drain()
  globalThis.fetch = originalFetch
  resetDumpRegistryForTests()
  __resetPlatformForTests()
  db.close()
  await rm(root, { recursive: true, force: true })
})
async function drain() {
  let observed = -1
  while (observed !== pending.length) { observed = pending.length; await Promise.all(pending) }
}
async function saveKey(id: ApiKeyId, owner: UserId, retention: number | null = 3600, search = false) {
  const key: ApiKey = { id, name: id, key: `raw_${id}`, ownerId: owner, createdAt: now, modelMappingsEnabled: false, modelMappings: [], dumpRetentionSeconds: retention,
    ...(search ? { webSearchPassthroughUpstream: "up_capture", webSearchPassthroughModel: "model" } : {}) }
  await repo.apiKeys.save(key)
  return key
}
async function saveUpstream(endpoints: EndpointKey[], id = "up_capture", owner: UserId = ownerId, config: Record<string, unknown> = {}) {
  const upstream: UpstreamRecord = { id, ownerId: owner, name: id, provider: "custom", enabled: true, sortOrder: 0, createdAt: now, updatedAt: now, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [{ id: "direct_fetch" }],
    config: { baseUrl: `https://${id}.test/v1`, apiKey: "upstream-secret-credential", endpoints, ...config } }
  await repo.upstreams.save(upstream)
  return upstream
}
function request(path: string, body: unknown, id = keyId) {
  return app.fetch(new Request(`http://local.test${path}`, { method: "POST", headers: { authorization: `Bearer raw_${id}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
}
async function recordFor(response: Response, id = keyId) {
  const recordId = response.headers.get("x-dump-record-id")
  const body = await response.text()
  expect(response.status, body).toBe(200)
  expect(recordId).not.toBeNull()
  await drain()
  const record = await store.get(id, recordId as DumpRecordId)
  if (!record) throw new Error("missing persisted dump")
  return record
}
const chatInput = { model: "model", messages: [{ role: "user", content: "hello" }] }
const messageInput = { ...chatInput, max_tokens: 32 }
const responseInput = { model: "model", input: "hello" }
const geminiInput = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }

const routes: Array<[string, unknown, EndpointKey, string]> = [
  ["/v1/chat/completions", chatInput, "chat_completions", "chat.completions"],
  ["/v1/messages", messageInput, "messages", "messages.create"],
  ["/v1/responses", responseInput, "responses", "responses.create"],
  ["/v1/responses/compact", responseInput, "responses", "responses.compact"],
  ["/v1beta/models/model:generateContent", geminiInput, "chat_completions", "chat.completions"],
  ["/v1beta/models/model:streamGenerateContent", geminiInput, "chat_completions", "chat.completions"],
  ["/v1/messages/count_tokens", messageInput, "messages_count_tokens", "count_tokens"],
  ["/v1beta/models/model:countTokens", geminiInput, "messages_count_tokens", "count_tokens"],
  ["/v1/embeddings", { model: "model", input: "hello" }, "embeddings", "embeddings.create"],
  ["/v1/images/generations", { model: "gpt-image-1", prompt: "cat" }, "images_generations", "images.generate"],
  ["/v1/alpha/search", { commands: {} }, "alpha_search", "search"],
  ["/alpha/search", { commands: {} }, "alpha_search", "search"],
]
test.each(routes)("retained route %s captures only terminal execution", async (path, input, endpoint, operation) => {
  await saveUpstream([endpoint])
  if (endpoint === "alpha_search") await saveKey(keyId, ownerId, 3600, true)
  const record = await recordFor(await request(path, input))
  expect(calls.filter(url => url.endsWith("/models"))).toHaveLength(1)
  const attempts = record.upstreamExchanges?.attempts
  expect(attempts).toHaveLength(1)
  expect(attempts?.[0]?.operation).toBe(operation)
  expect(attempts?.[0]?.upstreamId).toBe("up_capture")
  expect(attempts?.[0]?.response.terminal).toBe("eof")
  expect(attempts?.[0]?.response.totalBytes).toBe(attempts?.[0]?.response.capturedBytes)
  expect(attempts?.[0]?.request.source).toBe("prepared")
})
test.each([
  ["/v1/chat/completions", chatInput, "responses", "responses.create"],
  ["/v1/messages", messageInput, "chat_completions", "chat.completions"],
  ["/v1/responses", responseInput, "messages", "messages.create"],
  ["/v1beta/models/model:generateContent", geminiInput, "responses", "responses.create"],
] as Array<[string, unknown, EndpointKey, string]>)("translated %s shares request capture", async (path, input, endpoint, operation) => {
  await saveUpstream([endpoint])
  const record = await recordFor(await request(path, input))
  expect(record.upstreamExchanges?.attempts.map(attempt => attempt.operation)).toEqual([operation])
})
test("multipart images retain unobserved request bytes and observed response without reading FormData twice", async () => {
  await saveUpstream(["images_edits"])
  const form = new FormData()
  form.set("model", "gpt-image-1")
  form.set("prompt", "edit")
  form.set("image", new Blob(["image"]), "image.png")
  const response = await app.fetch(new Request("http://local.test/v1/images/edits", { method: "POST", headers: { authorization: `Bearer raw_${keyId}` }, body: form }))
  const record = await recordFor(response)
  expect(record.upstreamExchanges?.attempts[0]?.operation).toBe("images.edit")
  expect(record.upstreamExchanges?.attempts[0]?.request.source).toBe("unobserved")
  expect(record.upstreamExchanges?.attempts[0]?.response.terminal).toBe("eof")
})
test("concurrent owners get independent contexts, sidecars and owner-scoped detail/export", async () => {
  const otherKey = "capture_other" as ApiKeyId
  const otherOwner = "owner_other" as UserId
  await saveKey(otherKey, otherOwner)
  await saveUpstream(["chat_completions"])
  await saveUpstream(["chat_completions"], "up_other", otherOwner)
  const responses = await Promise.all([request("/v1/chat/completions", chatInput), request("/v1/chat/completions", chatInput, otherKey)])
  const records = await Promise.all(responses.map((response, i) => recordFor(response, i === 0 ? keyId : otherKey)))
  expect(records.map(record => record.upstreamExchanges?.attempts[0]?.upstreamId)).toEqual(["up_capture", "up_other"])
  expect(records.map(record => record.upstreamExchanges?.attempts[0]?.parentCallId)).toEqual(["call_1", "call_1"])
  for (const [i, record] of records.entries()) {
    const own = i === 0 ? keyId : otherKey
    const wrong = i === 0 ? otherKey : keyId
    const path = `/api/keys/${own}/records/${record.meta.id}`
    const detail = await app.fetch(new Request(`http://local.test${path}`, { headers: { authorization: `Bearer raw_${own}` } }))
    expect(detail.status).toBe(200)
    expect((await detail.json() as { upstreamExchanges: unknown }).upstreamExchanges).toEqual(record.upstreamExchanges)
    expect((await app.fetch(new Request(`http://local.test${path}`, { headers: { authorization: `Bearer raw_${wrong}` } }))).status).toBe(403)
    const exported = await app.fetch(new Request(`http://local.test${path}/export`, { headers: { authorization: `Bearer raw_${own}` } }))
    expect(exported.status).toBe(200)
    expect(await exported.text()).not.toContain("upstream-secret-credential")
  }
})
test("retention off opens no accumulator, observation context, sidecar or response wrapper", async () => {
  await saveKey(keyId, ownerId, null)
  await saveUpstream(["embeddings"])
  const original = DumpAccumulator.prototype.upstreamDialObservation
  let allocated = 0
  DumpAccumulator.prototype.upstreamDialObservation = function () { allocated++; return original.call(this) }
  try {
    const response = await request("/v1/embeddings", { model: "model", input: "hello" })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-dump-record-id")).toBeNull()
    await response.text()
    await drain()
    expect(allocated).toBe(0)
    expect(db.query("SELECT id FROM dump_records").all()).toHaveLength(0)
    expect(db.query("SELECT file_key FROM spilled_files").all()).toHaveLength(0)
    const bindings = await listProviderBindings({ ownerId })
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    replies = () => new Response(body)
    const result = await bindings[0]?.provider.fetch({ endpoint: "embeddings", payload: { model: "model", input: "hi" }, headers: new Headers(), sourceApi: "openai" })
    expect(result?.body).toBe(body)
  } finally { DumpAccumulator.prototype.upstreamDialObservation = original }
})

async function newDump() {
  const key = await repo.apiKeys.getById(keyId)
  if (!key) throw new Error("fixture key missing")
  let dump: DumpAccumulator | null = null
  const opener = new Hono()
  opener.post("/open", c => {
    dump = openDumpAccumulator(c, "POST", key, { bytes: new TextEncoder().encode("{}"), streamError: null })
    return new Response(null)
  })
  await opener.request("http://local.test/open", { method: "POST" })
  if (dump === null) throw new Error("retained dump missing")
  return dump as DumpAccumulator
}
async function finishDump(dump: DumpAccumulator) {
  dump.finalize(200, [])
  await drain()
  const record = await store.get(keyId, dump.recordId)
  if (!record) throw new Error("missing dump")
  return record
}

test("request-token Copilot uses direct application egress with safe ID; models remain excluded", async () => {
  const dump = await newDump()
  const bindings = await listProviderBindings({ ownerId, copilot: { copilotToken: "request-token-secret", accountType: "individual" }, dump })
  expect(calls).toHaveLength(1)
  const binding = bindings.find(item => item.model.id === "model")
  if (!binding) throw new Error("missing token binding")
  const result = await binding.provider.fetch({ endpoint: "chat_completions", payload: chatInput, headers: new Headers(), sourceApi: "openai" })
  await new Response(result.body).text()
  const record = await finishDump(dump)
  expect(record.upstreamExchanges?.attempts.map(item => [item.upstreamId, item.operation])).toEqual([["copilot_request", "chat.completions"]])
  expect(JSON.stringify(record.upstreamExchanges)).not.toContain("request-token-secret")
  expect(calls.some(url => url.endsWith("/models"))).toBe(true)
})

test("ordinary discovery and explicit probes allocate no observations while retained discovery emits no child", async () => {
  await saveUpstream(["chat_completions"])
  const listing = await app.fetch(new Request("http://local.test/v1/models", { headers: { authorization: `Bearer raw_${keyId}` } }))
  expect(listing.status).toBe(200)
  await listing.text()
  expect(db.query("SELECT id FROM dump_records").all()).toHaveLength(0)
  const dump = await newDump()
  const bindings = await listProviderBindings({ ownerId, dump })
  await bindings[0]?.provider.probe()
  const record = await finishDump(dump)
  expect(record.upstreamExchanges?.attempts).toEqual([])
  expect(calls.filter(url => url.endsWith("/models")).length).toBeGreaterThanOrEqual(2)
})

test.each([401, 403])("Copilot %i refresh and 429 retry record application calls only", async (rejectedStatus) => {
  const upstream = await saveUpstream(["chat_completions"])
  await repo.upstreams.save({ ...upstream, provider: "copilot", config: { githubToken: `synthetic-github-${crypto.randomUUID()}`, accountType: "individual" } })
  const baseReplies = replies
  const realNow = Date.now
  let offset = 0
  let applications = 0
  let exchanges = 0
  let discardedReads = 0
  let discardedCancels = 0
  Date.now = () => realNow() + offset
  replies = (url, init) => {
    if (url.includes("/copilot_internal/v2/token")) {
      exchanges++
      return json({ token: `session-${exchanges}`, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 3000 })
    }
    if (url.endsWith("/chat/completions")) {
      applications++
      if (applications === 1) { offset = 61_000; return new Response("unauthorized", { status: rejectedStatus }) }
      if (applications === 2) return new Response(new ReadableStream({
        pull(controller) { discardedReads++; controller.enqueue(new TextEncoder().encode("not drained")) },
        cancel() { discardedCancels++ },
      }, { highWaterMark: 0 }), { status: 429 })
    }
    return baseReplies(url, init)
  }
  try {
    const record = await recordFor(await request("/v1/chat/completions", chatInput))
    expect(exchanges).toBe(2)
    expect(applications).toBe(3)
    expect(discardedReads).toBe(0)
    expect(discardedCancels).toBe(1)
    const attempts = record.upstreamExchanges?.attempts
    expect(attempts?.map(item => item.parentCallId)).toEqual(["call_1", "call_2", "call_3"])
    expect(attempts?.map(item => item.status)).toEqual([rejectedStatus, 429, 200])
    expect(attempts?.[1]?.response).toMatchObject({ terminal: "cancelled", observedBytes: 0, capturedBytes: 0, totalBytes: null })
    expect(attempts?.every(item => item.operation === "chat.completions")).toBe(true)
  } finally { Date.now = realNow }
})

test.each(["complete", "malformed"])("route parser %s SSE preserves adapter terminal semantics", async mode => {
  await saveUpstream(["chat_completions"])
  const encoded = new TextEncoder().encode(mode === "complete"
    ? `data: ${JSON.stringify({ id: "chat_stream", object: "chat.completion.chunk", model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\n`
    : "data: {invalid json}\n\n")
  const baseReplies = replies
  let pulls = 0
  replies = (url, init) => url.endsWith("/models") ? baseReplies(url, init) : new Response(new ReadableStream({
    pull(controller) { if (pulls++ === 0) controller.enqueue(encoded); else controller.close() },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
  const record = await recordFor(await request("/v1/chat/completions", { ...chatInput, stream: true }))
  const attempt = record.upstreamExchanges?.attempts[0]
  expect(attempt?.response.capturedBytes).toBe(encoded.byteLength)
  expect(attempt?.response.observedBytes).toBe(encoded.byteLength)
  // The parser reads this complete transport before reporting a protocol error.
  expect(attempt?.response.terminal).toBe("eof")
  expect(attempt?.response.totalBytes).toBe(encoded.byteLength)
  if (mode === "malformed") expect(record.meta.error).not.toBeNull()
})

test.each(["unread", "cancelled", "read_error"])("real binding %s response never drains for capture", async mode => {
  await saveUpstream(["embeddings"])
  const dump = await newDump()
  const bindings = await listProviderBindings({ ownerId, dump })
  const binding = bindings[0]
  if (!binding) throw new Error("binding missing")
  let reads = 0
  let cancels = 0
  replies = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { reads++; if (mode === "read_error") controller.error(new Error("synthetic source error")); else controller.enqueue(new Uint8Array([1, 2, 3])) },
    cancel() { cancels++ },
  }, { highWaterMark: 0 }))
  const result = await binding.provider.fetch({ endpoint: "embeddings", payload: { model: "model", input: "hello" }, headers: new Headers(), sourceApi: "openai" })
  expect(reads).toBe(0)
  if (mode === "cancelled") await result.body?.cancel("caller cancelled")
  if (mode === "read_error") await expect(new Response(result.body).text()).rejects.toThrow("synthetic source error")
  const record = await finishDump(dump)
  expect(record.upstreamExchanges?.attempts[0]?.response).toMatchObject({
    terminal: mode === "unread" ? "not_consumed" : mode,
    totalBytes: null, observedBytes: 0, capturedBytes: 0,
  })
  expect(reads).toBe(mode === "read_error" ? 1 : 0)
  expect(cancels).toBe(mode === "cancelled" ? 1 : 0)
  if (mode === "unread") await result.body?.cancel()
})

test("synthetic credentials in upstream URL and headers never reach stored sidecar, detail or export", async () => {
  const secret = "ADVERSARIAL_CREDENTIAL_7c"
  await saveUpstream(["chat_completions"], "up_capture", ownerId, {
    baseUrl: `https://${secret}:${secret}@${secret}.invalid/${secret}?token=${secret}#${secret}`,
    models: ["model"], defaultHeaders: { "x-custom-account-secret": secret },
  })
  replies = (_url, init) => {
    expect(new Headers(init?.headers).get("x-custom-account-secret")).toBe(secret)
    return new Response(JSON.stringify(chatBody), { headers: { "content-type": `application/json; credential=${secret}`, "x-response-secret": secret } })
  }
  const record = await recordFor(await request("/v1/chat/completions", chatInput))
  const exchanges = record.upstreamExchanges
  expect(exchanges?.attempts[0]?.url).toBe("url_omitted")
  expect(JSON.stringify(exchanges)).not.toContain(secret)
  const descriptor = db.query<{ upstream_exchanges_descriptor: string }, []>("SELECT upstream_exchanges_descriptor FROM dump_records").get()
  const file = JSON.parse(descriptor?.upstream_exchanges_descriptor ?? "null") as { key: string }
  const bytes = await new FsFileProvider(join(root, "files")).get(file.key)
  if (!bytes) throw new Error("missing sidecar")
  const sidecar = gunzipSync(new Uint8Array(await new Response(bytes.body).arrayBuffer())).toString("utf8")
  expect(JSON.parse(sidecar)).toEqual(exchanges)
  expect(sidecar).not.toContain(secret)
  const path = `/api/keys/${keyId}/records/${record.meta.id}`
  for (const suffix of ["", "/export"]) {
    const detail = await app.fetch(new Request(`http://local.test${path}${suffix}`, { headers: { authorization: `Bearer raw_${keyId}` } }))
    expect(detail.status).toBe(200)
    expect(await detail.text()).not.toContain(secret)
  }
})

test("diagnostic setup failure leaves successful inference and ordinary transport intact", async () => {
  await saveUpstream(["chat_completions"])
  const original = DumpAccumulator.prototype.upstreamDialObservation
  DumpAccumulator.prototype.upstreamDialObservation = () => { throw new Error("diagnostic unavailable") }
  try {
    const record = await recordFor(await request("/v1/chat/completions", chatInput))
    expect(record.upstreamExchanges).toBeNull()
  } finally { DumpAccumulator.prototype.upstreamDialObservation = original }
})

test("a proxy failure and direct fallback share one parent under real registry dispatch", async () => {
  const upstream = await saveUpstream(["chat_completions"], "up_capture", ownerId, { models: ["model"] })
  await repo.proxies.save({ id: "px_capture", name: "capture", url: "socks5://127.0.0.1:1080", dialTimeoutSeconds: 1 })
  await repo.upstreams.save({ ...upstream, proxyFallbackList: [{ id: "px_capture" }, { id: "direct_fetch" }] })
  let dials = 0
  initSocketDial({ async connect() { dials++; throw new Error("synthetic connection refused") } })
  const record = await recordFor(await request("/v1/chat/completions", chatInput))
  expect(dials).toBe(1)
  const attempts = record.upstreamExchanges?.attempts
  expect(attempts?.map(item => item.parentCallId)).toEqual(["call_1", "call_1"])
  expect(attempts?.map(item => item.response.terminal)).toEqual(["fetch_error", "eof"])
  expect(attempts?.map(item => item.order)).toEqual([1, 2])
  expect((await repo.proxyBackoffs.listForUpstream("up_capture")).length).toBe(1)
})

test("hosted image tool and re-entrant Responses turns share the same capture and unique call IDs", async () => {
  const upstream = await saveUpstream(["responses"], "up_capture", ownerId, { models: ["model"] })
  await repo.upstreams.save({ ...upstream, flagOverrides: { "responses-image-generation-shim": true } })
  await saveUpstream(["images_generations"], "up_image", ownerId, { models: ["gpt-image-1"] })
  let turns = 0
  const baseReplies = replies
  replies = (url, init) => {
    if (url.endsWith("/responses") && ++turns === 1) return json({ ...responsesBody, output: [{ id: "fc_capture", type: "function_call", call_id: "image_call", name: "image_generation", arguments: '{"prompt":"cat"}', status: "completed" }] })
    return baseReplies(url, init)
  }
  const record = await recordFor(await request("/v1/responses", { ...responseInput, tools: [{ type: "image_generation", model: "gpt-image-1", action: "generate" }] }))
  expect(turns).toBe(2)
  const attempts = record.upstreamExchanges?.attempts
  expect(attempts?.map(item => [item.parentCallId, item.upstreamId, item.operation])).toEqual([
    ["call_1", "up_capture", "responses.create"],
    ["call_2", "up_image", "images.generate"],
    ["call_3", "up_capture", "responses.create"],
  ])
  expect(attempts?.every(item => item.response.terminal === "eof")).toBe(true)
})

test("local alpha-search retains its logical dump without an application sidecar", async () => {
  const record = await recordFor(await request("/v1/alpha/search", { commands: { search_query: [{ q: "hello" }] } }))
  expect(record.upstreamExchanges).toBeNull()
  expect(calls).toEqual([])
})

test("caller abort cancels a streaming route and stores only observed upstream bytes", async () => {
  await saveUpstream(["chat_completions"])
  const first = new TextEncoder().encode(`data: ${JSON.stringify({ id: "chat_abort", object: "chat.completion.chunk", model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "first" }, finish_reason: null }] })}\n\n`)
  const baseReplies = replies
  let sent = false
  let cancelled = 0
  replies = (url, init) => url.endsWith("/models") ? baseReplies(url, init) : new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(first) } },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
  const controller = new AbortController()
  const response = await app.fetch(new Request("http://local.test/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer raw_${keyId}`, "content-type": "application/json" },
    body: JSON.stringify({ ...chatInput, stream: true }), signal: controller.signal,
  }))
  const reader = response.body?.getReader()
  if (!reader) throw new Error("stream missing")
  expect((await reader.read()).done).toBe(false)
  controller.abort()
  while (!(await reader.read()).done) { /* consume final gateway frames */ }
  await drain()
  const record = await store.get(keyId, response.headers.get("x-dump-record-id") as DumpRecordId)
  expect(cancelled).toBe(1)
  expect(record?.upstreamExchanges?.attempts[0]?.response).toMatchObject({ terminal: "cancelled", observedBytes: first.byteLength, totalBytes: null, capturedBytes: first.byteLength })
})

test("local alpha-search excludes engine HTTP even with a retained request", async () => {
  const key = await saveKey(keyId, ownerId)
  await repo.apiKeys.save({ ...key, webSearchEnabled: true, webSearchLangsearchKey: "engine-secret", webSearchPriority: ["langsearch"] })
  replies = url => {
    expect(url).toBe("https://api.langsearch.com/v1/web-search")
    return json({ code: 200, data: { webPages: { value: [{ name: "Result", url: "https://example.test", snippet: "answer" }] } } })
  }
  const record = await recordFor(await request("/v1/alpha/search", { commands: { search_query: [{ q: "hello" }] } }))
  expect(calls).toEqual(["https://api.langsearch.com/v1/web-search"])
  expect(record.upstreamExchanges).toBeNull()
  expect(db.query("SELECT file_key FROM spilled_files WHERE owner_kind = 'dump-upstream'").all()).toEqual([])
})

test("route observation counts full bodies after per-attempt prefix limits without changing inference", async () => {
  await saveUpstream(["chat_completions"], "up_capture", ownerId, { models: ["model"] })
  const text = "x".repeat(300 * 1024)
  const upstreamBody = JSON.stringify({ ...chatBody, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] })
  let preparedLength = 0
  replies = (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("expected native string body")
    preparedLength = new TextEncoder().encode(init.body).byteLength
    return new Response(upstreamBody, { headers: { "content-type": "application/json" } })
  }
  const response = await request("/v1/chat/completions", { model: "model", messages: [{ role: "user", content: "q".repeat(70 * 1024) }] })
  const clientBody = await response.clone().json() as { choices: Array<{ message: { content: string } }> }
  const record = await recordFor(response)
  const attempt = record.upstreamExchanges?.attempts[0]
  expect(attempt?.request).toMatchObject({ source: "prepared", totalBytes: preparedLength, observedBytes: preparedLength, capturedBytes: 64 * 1024, truncated: true })
  expect(attempt?.response).toMatchObject({ terminal: "eof", totalBytes: upstreamBody.length, observedBytes: upstreamBody.length, capturedBytes: 256 * 1024, truncated: true })
  expect(clientBody.choices[0]?.message.content).toBe(text)
})
