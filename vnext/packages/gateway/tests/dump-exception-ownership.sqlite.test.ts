import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { initBackground, type FileProvider } from "@vibe-core/platform"
import { serveTemplate, type ServeTemplateHooks } from "@vibe-core/chat-flow-kit"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { setupTestPlatform } from "./_setup-platform.ts"
import type { ApiKey } from "../src/repo/types.ts"
import type { ApiKeyId } from "../src/repo/branded-ids.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { DumpAccumulator } from "../src/shared/dump/accumulator.ts"
import { DumpCaptureBudget } from "../src/shared/dump/capture-budget.ts"
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"
import { dumpCodec } from "../src/shared/dump/codec.ts"
import { getDumpCaptureBudget, initDumpBroker, initDumpStore, resetDumpRegistryForTests } from "../src/shared/dump/registry.ts"
import type { PreparedDumpRequestBody } from "../src/shared/dump/types.ts"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"
import { serveChatCompletions } from "../src/data-plane/chat-flow/chat-completions/serve.ts"
import { serveMessages } from "../src/data-plane/chat-flow/messages/serve.ts"
import { serveGemini } from "../src/data-plane/chat-flow/gemini/serve.ts"
import { serveCountTokens } from "../src/data-plane/chat-flow/count-tokens/serve.ts"
import { serveGeminiCountTokens } from "../src/data-plane/chat-flow/gemini/count-tokens.ts"
import { embeddingsRouter } from "../src/data-plane/embeddings/routes.ts"
import { imagesRouter } from "../src/data-plane/images/routes.ts"
import { ollamaChatHandler } from "../src/data-plane/ollama/chat.ts"
import type { DataPlaneAuthCtx } from "../src/data-plane/models/routes.ts"

const key: ApiKey = { id: "exception-key" as ApiKeyId, name: "test", key: "exception-secret", createdAt: "2026-10-01",
  dumpRetentionSeconds: 86400, modelMappingsEnabled: false, modelMappings: [] }
let directory: string, raw: Database, db: BunSqliteDatabase, files: FsFileProvider, store: FileDumpStore
let pending: Promise<unknown>[]
const body = "x".repeat(200)
const messages = [{ role: "user", content: "hello" }]
const contents = [{ role: "user", parts: [{ text: "hello" }] }]

beforeEach(async () => {
  resetDumpRegistryForTests()
  const platform = setupTestPlatform()
  raw = platform.db
  db = new BunSqliteDatabase(raw)
  directory = await mkdtemp(join(tmpdir(), "dump-exception-ownership-"))
  files = new FsFileProvider(directory)
  store = new FileDumpStore(db, files)
  pending = []
  initBackground({ waitUntil: work => { pending.push(work) } })
  initDumpStore(store)
  initDumpBroker(new EventTargetChannelBroker(dumpCodec))
  await platform.repo.apiKeys.save(key)
  await platform.repo.upstreams.save({ id: "exception-upstream", name: "fixture", provider: "custom", enabled: true, sortOrder: 0,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "unused" }, flagOverrides: {}, disabledPublicModelIds: [],
    createdAt: key.createdAt, updatedAt: key.createdAt })
})

afterEach(async () => {
  await Promise.allSettled(pending)
  resetDumpRegistryForTests()
  raw.close()
  await rm(directory, { recursive: true, force: true })
})

function accumulator(budget: DumpCaptureBudget, waitUntil = (work: Promise<unknown>): void => { pending.push(work) }) {
  const bytes = new TextEncoder().encode(body)
  return new DumpAccumulator(key, { method: "POST", path: "/v1/chat/completions", headers: [], bodyByteLength: bytes.byteLength, streamError: null },
    bytes, Date.now(), { waitUntil }, budget)
}

function failEgressConfiguration(): void {
  raw.query("UPDATE upstreams SET proxy_fallback_list_json = ?").run(JSON.stringify([{ id: "missing-proxy" }]))
  raw.exec("ALTER TABLE proxies RENAME TO unavailable_proxies")
}

async function expectRecovered(budget: DumpCaptureBudget, abandoned: DumpAccumulator): Promise<void> {
  await Promise.allSettled(pending.splice(0))
  expect(budget.retainedBytes).toBe(0)
  expect(await store.get(key.id, abandoned.recordId)).toBeNull()
  const next = accumulator(budget)
  await next.finalizeTurn(200, [])
  const row = await store.get(key.id, next.recordId)
  expect(row?.meta.capture).toBeUndefined()
  expect(row?.request.body).toEqual(new TextEncoder().encode(body))
  expect(budget.retainedBytes).toBe(0)
}

for (const protocol of ["chat", "messages", "gemini"] as const) test(`${protocol} cancelled production preparation returns capture admission to later requests`, async () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const dump = accumulator(budget)
  const controller = new AbortController()
  controller.abort()
  const shared = { auth: { apiKeyId: key.id }, obsCtx: { apiKeyId: key.id }, signal: controller.signal, dump }
  const serving = protocol === "chat" ? serveChatCompletions({ ...shared, raw: { model: "model", messages } })
    : protocol === "messages" ? serveMessages({ ...shared, raw: { model: "model", max_tokens: 32, messages } })
    : serveGemini({ ...shared, raw: { contents }, model: "model", forceStream: false })
  await expect(serving).rejects.toThrow("Model catalog aborted")
  await expectRecovered(budget, dump)
})

function rejectRespond(dump: DumpAccumulator, error: unknown): Promise<unknown> {
  const hooks: ServeTemplateHooks<{ model: string }, undefined> = {
    endpointTag: "test_endpoint", parse: () => ({ model: "model" }), wantsStream: () => false,
    preProcess: async payload => ({ kind: "continue", payload, extra: undefined }),
    runAttempt: async () => undefined, respond: async () => { throw error },
  }
  return serveTemplate(hooks, { raw: {}, auth: {}, obsCtx: {}, extras: {}, dump }, {
    runQuotaGate: async () => null, jsonErrorWrap: (status, value) => Response.json(value, { status }), buildTelemetryCtx: () => undefined,
  })
}

test("respond rejection preserves its exact error and holds abandoned accounting until request preparation settles", async () => {
  const release = Promise.withResolvers<void>()
  class HeldStore extends FileDumpStore {
    override async prepareRequestBody(bytes: Uint8Array): Promise<PreparedDumpRequestBody> {
      await release.promise
      return super.prepareRequestBody(bytes)
    }
  }
  initDumpStore(new HeldStore(db, files))
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const dump = accumulator(budget)
  const original = new Error("respond failed")
  try {
    expect(await rejectRespond(dump, original).catch(error => error as unknown)).toBe(original)
    const reserved = budget.retainedBytes
    expect(reserved).toBeGreaterThan(0)
    dump.frame({ type: "event", event: { text: "late frame" } })
    dump.success({ upstream: "exception-upstream", model: "late model" }, null)
    const terminal = dump.finalizeTurn(503, [], { late: true })
    expect(dump.finalizeTurn(500, [])).toBe(terminal)
    expect(budget.retainedBytes).toBe(reserved)
    expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
  } finally { release.resolve() }
  await expectRecovered(budget, dump)
})

for (const failure of ["prepare", "scheduler", "collector"] as const) test(`${failure} cleanup failure cannot replace the serve error or leak admission`, async () => {
  if (failure === "prepare") {
    class RejectingStore extends FileDumpStore {
      override prepareRequestBody(): Promise<PreparedDumpRequestBody> { return Promise.reject(new Error("prepare failed")) }
    }
    initDumpStore(new RejectingStore(db, files))
  }
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const dump = accumulator(budget, work => { pending.push(work); if (failure === "scheduler") throw new Error("scheduler failed") })
  const original = new Error("respond failed")
  const collector = failure === "collector" ? spyOn(UpstreamExchangeCollector.prototype, "abandon")
    .mockImplementation(() => { throw new Error("collector failed") }) : undefined
  try {
    if (collector) dump.upstreamDialObservation()
    expect(await rejectRespond(dump, original).catch(error => error as unknown)).toBe(original)
    await Promise.allSettled(pending.splice(0))
    expect(budget.retainedBytes).toBe(0)
    expect(await store.get(key.id, dump.recordId)).toBeNull()
  } finally { collector?.mockRestore() }
  initDumpStore(store)
  await expectRecovered(budget, dump)
})

test("an exception after terminal persistence starts cannot release its reservation before storage settles", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const heldFiles: FileProvider = {
    async put(path, value, options) { entered.resolve(); await release.promise; await files.put(path, value, options) },
    get: files.get.bind(files), delete: files.delete.bind(files),
  }
  initDumpStore(new FileDumpStore(db, heldFiles))
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const dump = accumulator(budget)
  const writing = dump.finalizeTurn(200, [])
  try {
    await entered.promise
    const reserved = budget.retainedBytes
    const original = new Error("render failed after handoff")
    expect(await rejectRespond(dump, original).catch(error => error as unknown)).toBe(original)
    expect(dump.finalizeTurn(500, [])).toBe(writing)
    expect(budget.retainedBytes).toBe(reserved)
  } finally { release.resolve(); await writing }
  expect(budget.retainedBytes).toBe(0)
  expect((await store.get(key.id, dump.recordId))?.response.status).toBe(200)
})

for (const protocol of ["messages", "gemini"] as const) test(`${protocol} direct count-token binding failure relinquishes capture ownership`, async () => {
  failEgressConfiguration()
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1000 })
  const dump = accumulator(budget)
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const serving = protocol === "messages" ? serveCountTokens({ raw: { model: "model", messages }, auth: { apiKeyId: key.id }, forwardedHeaders: {}, dump })
      : serveGeminiCountTokens({ raw: { contents }, model: "model", auth: { apiKeyId: key.id }, dump })
    await expect(serving).rejects.toThrow("Gateway configuration temporarily unavailable")
    await expectRecovered(budget, dump)
  } finally { warning.mockRestore() }
})

for (const endpoint of ["/v1/embeddings", "/v1/images/generations", "/v1/images/edits", "/api/chat"] as const) test(`${endpoint} exceptional exit releases the directly opened capture`, async () => {
  const app = new Hono<{ Variables: { auth: DataPlaneAuthCtx } }>()
  app.use("*", async (c, next) => { c.set("auth", { apiKeyId: key.id }); await next() })
  let caught: unknown
  app.onError(error => { caught = error; return new Response(null, { status: 503 }) })
  app.route("/", embeddingsRouter)
  app.route("/", imagesRouter)
  app.post("/api/chat", ollamaChatHandler)
  const payload = endpoint === "/api/chat" ? { model: "model", messages: "invalid messages" }
    : endpoint.endsWith("edits") ? { model: "model", images: [{ image_url: "data:image/png;base64,aGVsbG8=" }] }
    : { model: "model", input: "hello", prompt: "hello" }
  const original = new Error("mid-flight diagnostic hook failed")
  let reservedAtFailure = 0
  const modelHook = endpoint === "/api/chat" ? undefined : spyOn(DumpAccumulator.prototype, "requestedModel").mockImplementation(() => {
    reservedAtFailure = getDumpCaptureBudget().retainedBytes
    throw original
  })
  const prepare = spyOn(store, "prepareRequestBody")
  try {
    const response = await app.request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    expect(response.status).toBe(503)
    expect(prepare).toHaveBeenCalledTimes(1)
    if (modelHook) { expect(caught).toBe(original); expect(reservedAtFailure).toBeGreaterThan(0) }
    else expect(caught).toBeInstanceOf(TypeError)
    await Promise.allSettled(pending)
    expect(getDumpCaptureBudget().retainedBytes).toBe(0)
    expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
  } finally { modelHook?.mockRestore(); prepare.mockRestore() }
})
