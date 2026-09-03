// Tests for DumpAccumulator — mid-flight hooks + finalize tee behavior.
// Uses a real BunSqliteRepo (SQLite migrations lay down dump_records/
// spilled_files/upstreams/api_keys tables) plus a tiny in-memory
// FileProvider and FileDumpStore, per the bun_mock_module_unrestorable
// memory. Broker is a real EventTargetChannelBroker so publish is
// exercised end-to-end.

import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono, type Context } from "hono"
import {
  __resetPlatformForTests,
  initSqlDatabase,
  initEnv,
  initBackground,
  initRuntimeLocation,
  initImageProcessor,
  type SqlDatabase,
} from "@vibe-core/platform"
import { MemoryCache } from "@vibe-core/cache"
import { InMemoryResponsesSnapshotStore } from "@vibe-llm/responses-store"
import { BunSqliteRepo as SqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { createInMemoryImageProcessor } from "@vibe-llm/platform-bun/src/memory-image-processor.ts"
import type { FileProvider, FileGetResult } from "@vibe-core/platform"

import { initRepo } from "../src/repo/index.ts"
import { initCache } from "../src/data-plane/cache/index.ts"
import { initResponsesStore } from "../src/data-plane/runtime/responses-store.ts"
import {
  initDumpBroker,
  initDumpStore,
  resetDumpRegistryForTests,
} from "../src/shared/dump/registry.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { EventTargetChannelBroker } from "../src/shared/runtime/event-target-channel-broker.ts"
import { dumpCodec } from "../src/shared/dump/codec.ts"
import {
  DumpAccumulator,
  openDumpAccumulator,
} from "../src/shared/dump/accumulator.ts"
import type { ApiKey } from "../src/repo/types.ts"
import type { ProtocolFrame } from "@vibe-core/result"

// In-memory FileProvider fake.
class MemoryFiles implements FileProvider {
  files = new Map<string, Uint8Array>()
  async put(key: string, body: ReadableStream | Uint8Array | string): Promise<void> {
    let bytes: Uint8Array
    if (typeof body === "string") bytes = new TextEncoder().encode(body)
    else if (body instanceof Uint8Array) bytes = body
    else bytes = new Uint8Array(await new Response(body).arrayBuffer())
    this.files.set(key, bytes)
  }
  async get(key: string): Promise<FileGetResult | null> {
    const bytes = this.files.get(key)
    if (!bytes) return null
    return { body: new Blob([bytes as BlobPart]).stream(), size: bytes.byteLength }
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key)
  }
}

interface Ctx {
  raw: Database
  db: BunSqliteDatabase
  files: MemoryFiles
  store: FileDumpStore
  repo: SqliteRepo
  drain: () => Promise<void>
  broker: EventTargetChannelBroker<import("../src/shared/dump/types.ts").DumpMetadata>
}

async function setupCtx(retentionSeconds: number | null = 3600): Promise<Ctx> {
  __resetPlatformForTests()
  resetDumpRegistryForTests()
  const raw = new Database(":memory:")
  const repo = new SqliteRepo(raw)
  const db = new BunSqliteDatabase(raw)
  const files = new MemoryFiles()
  const store = new FileDumpStore(db, files)
  const broker = new EventTargetChannelBroker(dumpCodec)

  const pending: Promise<unknown>[] = []
  initSqlDatabase(raw as unknown as SqlDatabase)
  initEnv(() => "")
  initBackground({ waitUntil: (p) => { pending.push(p.catch(() => {})) } })
  initRuntimeLocation("bun")
  initImageProcessor(createInMemoryImageProcessor())
  initRepo(repo)
  initCache(new MemoryCache())
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  initDumpStore(store)
  initDumpBroker(broker)

  const now = new Date().toISOString()
  await repo.apiKeys.save({
    id: "k1",
    name: "test",
    key: "raw-k1",
    createdAt: now,
    ownerId: "u1",
    modelMappingsEnabled: false,
    modelMappings: [],
    dumpRetentionSeconds: retentionSeconds,
  } as any)
  await repo.upstreams.save({
    id: "ups-1",
    provider: "copilot",
    name: "Copilot A",
    ownerId: "u1",
    enabled: true,
    sortOrder: 0,
    config: {},
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
  } as any)

  return {
    raw,
    db,
    files,
    store,
    repo,
    broker,
    drain: async () => { await Promise.all(pending.splice(0)) },
  }
}

afterEach(() => {
  __resetPlatformForTests()
  resetDumpRegistryForTests()
})

const apiKey = (retentionSeconds: number | null): ApiKey => ({
  id: "k1",
  name: "test",
  key: "raw-k1",
  createdAt: new Date().toISOString(),
  ownerId: "u1",
  dumpRetentionSeconds: retentionSeconds,
})

// Build a real hono Context so openDumpAccumulator can read c.req.path etc.
async function makeContext(path: string, headers: Record<string, string> = {}): Promise<Context> {
  const app = new Hono()
  let captured!: Context
  app.all("*", (c) => { captured = c; return c.text("ok") })
  const req = new Request(`http://local${path}`, { method: "POST", headers })
  await app.fetch(req)
  return captured
}

test("openDumpAccumulator returns null when dumpRetentionSeconds is null", async () => {
  await setupCtx(null)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(null), {
    bytes: new TextEncoder().encode("{}"),
    streamError: null,
  })
  expect(acc).toBeNull()
})

test("openDumpAccumulator returns instance when retention configured", async () => {
  await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("{}"),
    streamError: null,
  })
  expect(acc).toBeInstanceOf(DumpAccumulator)
})

test("finalize(status, headers) records payload bytes + isStream from frames", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!
  acc.requestedModel("gpt-4")
  acc.frame({ type: "delta", value: "hi" } as unknown as ProtocolFrame<unknown>)
  acc.frame({ type: "delta", value: "!" } as unknown as ProtocolFrame<unknown>)
  acc.success(
    { model: "gpt-4", upstream: "ups-1" } as never,
    { input: 3, output: 5 } as never,
  )
  acc.recordSentPayloadBytes(42)
  acc.finalize(200, [["content-type", "text/event-stream"]])
  await ctx.drain()

  const rows = await ctx.store.list("k1", { limit: 10 })
  expect(rows.length).toBe(1)
  const meta = rows[0]!
  expect(meta.model).toBe("gpt-4")
  expect(meta.upstream?.id).toBe("ups-1")
  expect(meta.inputTokens).toBe(3)
  expect(meta.outputTokens).toBe(5)
  expect(meta.responseBytes).toBe(42)
  expect(meta.status).toBe(200)

  const rec = await ctx.store.get("k1", meta.id)
  expect(rec!.response.body.type).toBe("stream")
  if (rec!.response.body.type === "stream") {
    expect(rec!.response.body.events.length).toBe(2)
  }
})

test("finalize(response) tees body so client stream and captured bytes match", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!
  acc.success({ model: "gpt-4", upstream: "ups-1" } as never, null)
  const payload = new TextEncoder().encode("hello-world")
  const upstreamResp = new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  const teed = acc.finalize(upstreamResp)
  const clientBytes = new Uint8Array(await teed.arrayBuffer())
  expect(new TextDecoder().decode(clientBytes)).toBe("hello-world")
  await ctx.drain()

  const [meta] = await ctx.store.list("k1", { limit: 10 })
  const rec = await ctx.store.get("k1", meta!.id)
  expect(rec!.response.body.type).toBe("bytes")
  if (rec!.response.body.type === "bytes") {
    expect(new TextDecoder().decode(rec!.response.body.body)).toBe("hello-world")
  }
})

test("error('upstream', upstreamId) stamps upstream ref + error kind", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!
  acc.error("upstream", "ups-1")
  acc.finalize(502, [])
  await ctx.drain()

  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.error).toEqual({ kind: "upstream" })
  expect(meta!.upstream?.id).toBe("ups-1")
  expect(meta!.status).toBe(502)
})

test("failed(reason) records categorized failure with one-line reason", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!
  acc.failed(new Error("upstream\ntimed out\nafter\t5s"))
  acc.finalize(500, [])
  await ctx.drain()

  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.error?.kind).toBe("failed")
  if (meta!.error?.kind === "failed") {
    expect(meta!.error.reason).toBe("upstream timed out after 5s")
  }
})

test("requestSnapshot.streamError propagates to meta.error when no explicit error stamp", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new Uint8Array(),
    streamError: "client aborted upload",
  })!
  acc.finalize(400, [])
  await ctx.drain()

  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.error).toEqual({ kind: "failed", reason: "client aborted upload" })
})

test("finalize publishes to broker channel keyed by apiKey id", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!

  const ac = new AbortController()
  const iter = ctx.broker.subscribe("k1", ac.signal)[Symbol.asyncIterator]()

  acc.success({ model: "gpt-4", upstream: "ups-1" } as never, null)
  acc.finalize(200, [])
  await ctx.drain()

  const { value, done } = await iter.next()
  expect(done).toBe(false)
  expect(value.status).toBe(200)
  expect(value.model).toBe("gpt-4")
  ac.abort()
})

test("finalize(response) with null body falls back to (status, headers) path", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!
  // Response with null body (e.g. 204).
  const resp = new Response(null, { status: 204 })
  const returned = acc.finalize(resp)
  expect(returned.status).toBe(204)
  expect(returned.headers.get('x-dump-record-id')).toBe(acc.recordId)
  expect(returned.headers.get('x-dump-key-id')).toBe('k1')
  await ctx.drain()

  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.status).toBe(204)
})

test("finalize(response) stamps X-Dump-Record-Id + X-Dump-Key-Id headers", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/chat/completions")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), {
    bytes: new TextEncoder().encode("req"),
    streamError: null,
  })!
  const resp = new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const returned = acc.finalize(resp)
  expect(returned.headers.get('x-dump-record-id')).toBe(acc.recordId)
  expect(returned.headers.get('x-dump-key-id')).toBe('k1')
  // Header from source must be preserved.
  expect(returned.headers.get('content-type')).toBe('application/json')
  // Client-visible id must match the row that gets persisted.
  await ctx.drain()
  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.id).toBe(acc.recordId)
})
