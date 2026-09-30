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
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"
import {
  DumpAccumulator,
  openDumpAccumulator,
} from "../src/shared/dump/accumulator.ts"
import type { ApiKey } from "../src/repo/types.ts"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { serveTemplate } from "@vibe-core/chat-flow-kit"
import { llmEventResult, type TelemetryModelIdentity } from "@vibe-llm/protocols/common"
import { respondChatCompletions } from "../src/data-plane/chat-flow/chat-completions/respond"
import { respondMessages } from "../src/data-plane/chat-flow/messages/respond"
import { respondGemini } from "../src/data-plane/chat-flow/gemini/respond"

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

test("optional collector writes an empty envelope while an unattached dump keeps legacy null", async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext("/v1/responses")
  const first = openDumpAccumulator(c, "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!first) throw new Error("dump expected")
  first.attachUpstreamExchangeCollector(new UpstreamExchangeCollector())
  first.finalize(200, [])
  await ctx.drain()
  expect((await ctx.store.get("k1", first.recordId))?.upstreamExchanges?.attempts).toEqual([])

  const second = openDumpAccumulator(c, "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!second) throw new Error("dump expected")
  second.finalize(200, [])
  await ctx.drain()
  expect((await ctx.store.get("k1", second.recordId))?.upstreamExchanges).toBeNull()
})

test("broker publication can read the committed sidecar and canonical row", async () => {
  const ctx = await setupCtx(3600)
  let published = false
  initDumpBroker({
    async publish(keyId, meta) {
      const row = await ctx.store.get(keyId, meta.id)
      expect(row?.upstreamExchanges?.attempts).toEqual([])
      expect(ctx.raw.query<{ upstream_exchanges_descriptor: string | null }, []>("SELECT upstream_exchanges_descriptor FROM dump_records").get()?.upstream_exchanges_descriptor).not.toBeNull()
      published = true
      await ctx.broker.publish(keyId, meta)
    },
    subscribe: ctx.broker.subscribe.bind(ctx.broker),
    closeChannel: ctx.broker.closeChannel.bind(ctx.broker),
  })
  const c = await makeContext("/v1/responses")
  const acc = openDumpAccumulator(c, "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!acc) throw new Error("dump expected")
  acc.attachUpstreamExchangeCollector(new UpstreamExchangeCollector())
  acc.finalize(200, [])
  await ctx.drain()
  expect(published).toBe(true)
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

test('cancelled dump survives later abort failure and preserves observed tokens', async () => {
  const ctx = await setupCtx(3600)
  const c = await makeContext('/v1/responses')
  const acc = openDumpAccumulator(c, 'POST', apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!acc) throw new Error('dump expected')
  acc.success({ incomingModel: 'm', model: 'm', modelKey: 'm', upstream: 'ups-1', cost: null }, { input: 7, output: 2 })
  acc.cancelled()
  acc.failed(new Error('private cancellation detail'))
  acc.finalize(200, [])
  await ctx.drain()
  const [meta] = await ctx.store.list('k1', { limit: 10 })
  expect(meta?.error).toEqual({ kind: 'cancelled', reason: 'client_cancelled' })
  expect(meta?.inputTokens).toBe(7)
  expect(meta?.outputTokens).toBe(2)
})

for (const scenario of ["legacy-json", "snapshot-error", "upstream-error"] as const) {
  test(`turn-owned dump preserves canonical no-frame body: ${scenario}`, async () => {
    const { createResponsesTurn } = await import("../src/data-plane/chat-flow/responses/turn")
    const { renderResponsesTurn } = await import("../src/data-plane/chat-flow/responses/respond")
    const ctx = await setupCtx(3600)
    const c = await makeContext("/v1/responses")
    const dump = openDumpAccumulator(c, "POST", apiKey(3600), { bytes: new TextEncoder().encode("{}"), streamError: null })
    if (!dump) throw new Error("dump expected")
    const completed = { id: "resp-legacy", object: "response", status: "completed", model: "m", output: [] }
    const upstreamError = { error: { message: "slow down" } }
    const turn = createResponsesTurn(scenario === "upstream-error"
      ? { type: "upstream-error", status: 429, headers: new Headers(), body: new TextEncoder().encode(JSON.stringify(upstreamError)) }
      : { kind: "bridged-response", response: Response.json(completed) }, {
      wantsStream: false, dump, finalizeDump: true,
      ...(scenario === "snapshot-error" ? { onCompleted: async () => { throw new Error("private storage detail") } } : {}),
    })
    try {
      const response = await renderResponsesTurn(turn)
      const wire = await response.text()
      expect(response.status).toBe(scenario === "upstream-error" ? 429 : scenario === "snapshot-error" ? 502 : 200)
      expect(JSON.parse(wire)).toEqual(scenario === "upstream-error" ? upstreamError : scenario === "snapshot-error"
        ? { error: { type: "api_error", message: "Unable to persist response continuation state." } } : completed)
      expect((await turn.completion).cleanupComplete).toBe(true)
      await ctx.drain()
      const stored = await ctx.store.get("k1", dump.recordId)
      expect(stored?.response.status).toBe(response.status)
      expect(stored?.meta.responseBytes).toBe(new TextEncoder().encode(wire).byteLength)
      expect(stored?.response.body.type).toBe("bytes")
      if (stored?.response.body.type !== "bytes") throw new Error("canonical body bytes expected")
      expect(new TextDecoder().decode(stored.response.body.body)).toBe(wire)
    } finally {
      turn.abortController.abort()
      await ctx.drain()
      ctx.raw.close()
    }
  })
}

test("canonical completion keeps dump capture behind client demand and waits for late metadata", async () => {
  const ctx = await setupCtx()
  const dump = openDumpAccumulator(await makeContext("/v1/messages"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!dump) throw new Error("dump expected")
  const completed = Promise.withResolvers<void>()
  let pulls = 0
  const response = dump.finalize(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (pulls <= 3) {
        dump.frame({ type: "event", event: { text: "late" } })
        controller.enqueue(new TextEncoder().encode("abc"))
      } else controller.close()
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }), { settled: completed.promise })
  await new Promise(resolve => setTimeout(resolve, 10))
  const readsBeforeClient = pulls
  try {
    expect(await response.text()).toBe("abcabcabc")
    expect(readsBeforeClient).toBe(0)
    expect(await ctx.store.get("k1", dump.recordId)).toBeNull()
    dump.success({ incomingModel: "m", model: "m", modelKey: "m", upstream: "ups-1", cost: null }, { input: 2, output: 4 })
  } finally { completed.resolve(); await ctx.drain() }
  const record = await ctx.store.get("k1", dump.recordId)
  expect(record?.meta.responseBytes).toBe(9)
  expect(record?.meta.outputTokens).toBe(4)
  expect(record?.response.body.type).toBe("stream")
  if (record?.response.body.type === "stream") expect(record.response.body.events).toHaveLength(3)
})

test("canonical completion preserves transport failure and sent bytes", async () => {
  const ctx = await setupCtx()
  const dump = openDumpAccumulator(await makeContext("/v1/messages"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!dump) throw new Error("dump expected")
  let pulls = 0
  const response = dump.finalize(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) { dump.frame({ type: "event", event: { text: "one" } }); controller.enqueue(new Uint8Array(7)) }
      else controller.error(new Error("transport broke"))
    },
  }, { highWaterMark: 0 })), { settled: Promise.resolve() })
  await expect(response.text()).rejects.toThrow("transport broke")
  await ctx.drain()
  const record = await ctx.store.get("k1", dump.recordId)
  expect(record?.meta.responseBytes).toBe(7)
  expect(record?.meta.error).toEqual({ kind: "failed", reason: "transport broke" })
})


async function finishViaTemplate(response: Response, dump: DumpAccumulator): Promise<Response> {
  const served = await serveTemplate({
    endpointTag: "test",
    parse: () => ({}), wantsStream: () => true,
    runAttempt: async () => response,
    respond: async result => result,
  }, { raw: {}, auth: {}, obsCtx: {}, extras: {}, dump }, {
    runQuotaGate: async () => null, jsonErrorWrap: (status, body) => Response.json(body, { status }),
    buildTelemetryCtx: () => ({}),
  })
  return served.response
}

const canonicalIdentity: TelemetryModelIdentity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "ups-1", cost: null }

for (const protocol of ["chat", "messages", "gemini"] as const) {
  for (const lateOutcome of ["absent", "resolve", "reject"] as const) {
    test(`${protocol} canonical in-progress SSE cancellation retains observed scalars (${lateOutcome})`, async () => {
      const ctx = await setupCtx()
      let publications = 0
      initDumpBroker({
        async publish(keyId, meta) { publications++; await ctx.broker.publish(keyId, meta) },
        subscribe: ctx.broker.subscribe.bind(ctx.broker),
        closeChannel: ctx.broker.closeChannel.bind(ctx.broker),
      })
      const dump = openDumpAccumulator(await makeContext("/v1/test"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
      if (!dump) throw new Error("dump expected")
      const metadata = Promise.withResolvers<{ modelIdentity: TelemetryModelIdentity }>()
      let sourceEnded = false
      let cleaned = false
      const text = "prefix".repeat(20_000)
      async function* events() {
        try {
          yield protocol === "gemini"
            ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }
            : eventFrame(protocol === "messages"
              ? { type: "message_start", message: { id: "x", model: "m", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 2, output_tokens: 0 } } }
              : { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: text } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
          sourceEnded = true
        } finally { cleaned = true }
      }
      const result = {
        ...llmEventResult(events(), canonicalIdentity),
        ...(lateOutcome === "absent" ? {} : { finalMetadata: metadata.promise }),
      }
      const abort = new AbortController()
      const options = { wantsStream: true, dump, downstreamAbortController: abort }
      const rendered = protocol === "chat" ? await respondChatCompletions(result as never, { ...options, includeUsageChunk: true })
        : protocol === "messages" ? await respondMessages(result as never, options) : await respondGemini(result, options)
      const response = await finishViaTemplate(rendered, dump)
      const reader = response.body?.getReader()
      if (!reader) throw new Error("body expected")
      try {
        const first = await reader.read()
        expect(sourceEnded).toBe(false)
        await reader.cancel()
        expect(await Promise.race([ctx.drain().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])).toBe(true)
        const record = await ctx.store.get("k1", dump.recordId)
        expect(record?.meta.model).toBe("m")
        expect(record?.meta.upstream).toEqual({ id: "ups-1", name: "Copilot A", kind: "copilot" })
        expect(record?.meta.inputTokens).toBe(2)
        expect(record?.meta.outputTokens).toBe(protocol === "messages" ? null : 3)
        expect(record?.meta.responseBytes).toBe(first.value?.byteLength)
        expect(record?.meta.error).toEqual({ kind: "cancelled", reason: "client_cancelled" })
        expect(abort.signal.aborted).toBe(true)
        expect(cleaned).toBe(true)
        expect(publications).toBe(1)
        if (lateOutcome === "reject") metadata.reject(new Error("late metadata failure"))
        else metadata.resolve({ modelIdentity: { ...canonicalIdentity, model: "late", upstream: "late-upstream" } })
        await new Promise(resolve => setTimeout(resolve, 10))
        await ctx.drain()
        expect(await ctx.store.get("k1", dump.recordId)).toEqual(record)
        expect(publications).toBe(1)
      } finally {
        metadata.resolve({ modelIdentity: canonicalIdentity })
        await reader.cancel()
        await ctx.drain()
      }
    })
  }
}

for (const protocol of ["chat", "messages", "gemini"] as const) {
  test(`${protocol} canonical dump integration preserves demand and cancellation with unresolved metadata`, async () => {
    const ctx = await setupCtx()
    const dump = openDumpAccumulator(await makeContext("/v1/test"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
    if (!dump) throw new Error("dump expected")
    let reads = 0
    let cleaned = false
    const text = "large".repeat(20_000)
    async function* events() {
      try {
        for (let i = 0; i < 20; i++) {
          reads++
          yield protocol === "gemini" ? { candidates: [{ content: { parts: [{ text }] } }] }
            : eventFrame(protocol === "messages"
              ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
              : { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: text } }] })
        }
      } finally { cleaned = true }
    }
    const result = { ...llmEventResult(events(), canonicalIdentity), finalMetadata: new Promise<never>(() => {}) }
    const abort = new AbortController()
    const options = { wantsStream: true, dump, downstreamAbortController: abort }
    const rendered = protocol === "chat" ? await respondChatCompletions(result as never, { ...options, includeUsageChunk: false })
      : protocol === "messages" ? await respondMessages(result as never, options) : await respondGemini(result, options)
    const response = await finishViaTemplate(rendered, dump)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reads).toBe(1)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("body expected")
    const first = await reader.read()
    await reader.cancel()
    const settled = await Promise.race([ctx.drain().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])
    expect(settled).toBe(true)
    expect(abort.signal.aborted).toBe(true)
    expect(cleaned).toBe(true)
    const record = await ctx.store.get("k1", dump.recordId)
    expect(record?.meta.responseBytes).toBe(first.value?.byteLength)
    expect(record?.meta.error).toEqual({ kind: "cancelled", reason: "client_cancelled" })
    expect(record?.response.body.type).toBe("stream")
  })

  test(`${protocol} canonical JSON errors with no frames retain the serialized response body`, async () => {
    const ctx = await setupCtx()
    const dump = openDumpAccumulator(await makeContext("/v1/test"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
    if (!dump) throw new Error("dump expected")
    const failed: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error("source failed before first frame") } }),
    }
    const result = llmEventResult(failed, canonicalIdentity)
    const options = { wantsStream: false, dump }
    const rendered = protocol === "chat" ? await respondChatCompletions(result, { ...options, includeUsageChunk: false })
      : protocol === "messages" ? await respondMessages(result, options) : await respondGemini(result, options)
    const response = await finishViaTemplate(rendered, dump)
    const wire = await response.text()
    expect(response.status).toBe(502)
    await ctx.drain()
    const record = await ctx.store.get("k1", dump.recordId)
    expect(record?.meta.responseBytes).toBe(new TextEncoder().encode(wire).byteLength)
    expect(record?.response.body.type).toBe("bytes")
    if (record?.response.body.type === "bytes") expect(new TextDecoder().decode(record.response.body.body)).toBe(wire)
  })
}

for (const protocol of ["chat", "messages", "gemini"] as const) {
  for (const wantsStream of [false, true]) {
    for (const lateOutcome of ["resolve", "reject"] as const) {
      test(`${protocol} canonical ${wantsStream ? "SSE after source EOF" : "JSON before bytes"} cancellation settles started metadata wait (${lateOutcome})`, async () => {
        const ctx = await setupCtx()
        let publications = 0
        initDumpBroker({
          async publish(keyId, meta) { publications++; await ctx.broker.publish(keyId, meta) },
          subscribe: ctx.broker.subscribe.bind(ctx.broker),
          closeChannel: ctx.broker.closeChannel.bind(ctx.broker),
        })
        const dump = openDumpAccumulator(await makeContext("/v1/test"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
        if (!dump) throw new Error("dump expected")
        const metadata = Promise.withResolvers<{ modelIdentity: TelemetryModelIdentity }>()
        const observed = Promise.withResolvers<void>()
        const eof = Promise.withResolvers<void>()
        let sourceEnded = false
        async function* events() {
          yield protocol === "gemini" ? { candidates: [{ content: { parts: [{ text: "prefix" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }
            : eventFrame(protocol === "messages"
              ? { type: "message_start", message: { id: "x", model: "m", role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }
              : { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "prefix" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
          if (wantsStream) await eof.promise
          else if (protocol === "chat") { sourceEnded = true; yield { type: "done" as const } }
          else if (protocol === "messages") yield eventFrame({ type: "message_stop" })
          sourceEnded = true
        }
        const result = {
          ...llmEventResult(events(), canonicalIdentity),
          get finalMetadata() { observed.resolve(); return metadata.promise },
        }
        const abort = new AbortController()
        const options = { wantsStream, dump, downstreamAbortController: abort }
        const rendered = protocol === "chat" ? await respondChatCompletions(result as never, { ...options, includeUsageChunk: false })
          : protocol === "messages" ? await respondMessages(result as never, options) : await respondGemini(result, options)
        const response = await finishViaTemplate(rendered, dump)
        expect(response.status).toBe(200)
        const reader = response.body?.getReader()
        if (!reader) throw new Error("body expected")
        let sentBytes = 0
        if (wantsStream) {
          const first = await reader.read()
          sentBytes = first.value?.byteLength ?? 0
          eof.resolve()
        }
        await observed.promise
        expect(sourceEnded).toBe(true)
        try {
          await reader.cancel()
          const settled = await Promise.race([ctx.drain().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])
          expect(settled).toBe(true)
          const record = await ctx.store.get("k1", dump.recordId)
          expect(record?.meta.responseBytes).toBe(sentBytes)
          expect(record?.meta.error).toEqual({ kind: "cancelled", reason: "client_cancelled" })
          expect(record?.meta.model).toBe("m")
          expect(record?.meta.upstream).toEqual({ id: "ups-1", name: "Copilot A", kind: "copilot" })
          expect(record?.meta.inputTokens).toBe(2)
          expect(record?.meta.outputTokens).toBe(protocol === "messages" ? null : 3)
          expect(publications).toBe(1)
          if (lateOutcome === "reject") metadata.reject(new Error("late metadata failure"))
          else metadata.resolve({ modelIdentity: { ...canonicalIdentity, model: "late", upstream: "late-upstream" } })
          await new Promise(resolve => setTimeout(resolve, 10))
          await ctx.drain()
          expect(await ctx.store.get("k1", dump.recordId)).toEqual(record)
          expect(publications).toBe(1)
        } finally {
          metadata.resolve({ modelIdentity: canonicalIdentity })
          eof.resolve()
          await ctx.drain()
        }
      })
    }
  }
}


test("Messages JSON cancellation retains metadata already supplied by the producer", async () => {
  const ctx = await setupCtx()
  const dump = openDumpAccumulator(await makeContext("/v1/messages"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!dump) throw new Error("dump expected")
  async function* events() {
    yield eventFrame({ type: "message_start", message: { id: "x", model: "m", role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } })
    yield eventFrame({ type: "message_stop" })
  }
  const result = {
    ...llmEventResult(events(), { ...canonicalIdentity, model: "fallback-model", upstream: "fallback-upstream" }),
    finalMetadata: Promise.resolve({ modelIdentity: { ...canonicalIdentity, model: "ready-authoritative-model" } }),
    __interceptorReplaced: true as const,
  }
  const response = await finishViaTemplate(await respondMessages(result as never, { wantsStream: false, dump }), dump)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("body expected")
  await reader.cancel()
  await ctx.drain()
  const record = await ctx.store.get("k1", dump.recordId)
  expect(record?.meta.model).toBe("ready-authoritative-model")
  expect(record?.meta.upstream).toEqual({ id: "ups-1", name: "Copilot A", kind: "copilot" })
  expect(record?.meta.inputTokens).toBe(2)
  expect(record?.meta.error).toEqual({ kind: "cancelled", reason: "client_cancelled" })
})

for (const protocol of ["chat", "messages", "gemini"] as const) {
  for (const wantsStream of [false, true]) {
    test(`${protocol} canonical ${wantsStream ? "SSE" : "JSON"} keeps successful late metadata authoritative`, async () => {
      const ctx = await setupCtx()
      const dump = openDumpAccumulator(await makeContext("/v1/test"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
      if (!dump) throw new Error("dump expected")
      const metadata = Promise.withResolvers<{ modelIdentity: TelemetryModelIdentity }>()
      async function* events() {
        yield protocol === "gemini" ? { candidates: [{ content: { parts: [{ text: "prefix" }] }, finishReason: "STOP" }] }
          : eventFrame(protocol === "messages"
            ? { type: "message_start", message: { id: "x", model: "m", role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }
            : { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "prefix" }, finish_reason: "stop" }] })
        if (protocol === "chat") yield { type: "done" as const }
        else if (protocol === "messages") yield eventFrame({ type: "message_stop" })
      }
      const result = { ...llmEventResult(events(), canonicalIdentity), finalMetadata: metadata.promise, __interceptorReplaced: true }
      const options = { wantsStream, dump }
      const rendered = protocol === "chat" ? await respondChatCompletions(result as never, { ...options, includeUsageChunk: false })
        : protocol === "messages" ? await respondMessages(result as never, options) : await respondGemini(result, options)
      const response = await finishViaTemplate(rendered, dump)
      expect(response.status).toBe(200)
      await response.text()
      expect(await ctx.store.get("k1", dump.recordId)).toBeNull()
      metadata.resolve({ modelIdentity: { ...canonicalIdentity, model: "late-authoritative-model" } })
      await ctx.drain()
      const record = await ctx.store.get("k1", dump.recordId)
      expect(record?.meta.model).toBe("late-authoritative-model")
      expect(record?.meta.error).toBeNull()
    })
  }
}


test("canonical cancellation hands off the sent prefix independently of unsettled semantic ownership", async () => {
  const ctx = await setupCtx()
  const dump = openDumpAccumulator(await makeContext("/v1/messages"), "POST", apiKey(3600), { bytes: new Uint8Array(), streamError: null })
  if (!dump) throw new Error("dump expected")
  const completed = Promise.withResolvers<void>()
  let cancellations = 0
  const response = dump.finalize(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      dump.frame({ type: "event", event: { text: "prefix" } })
      controller.enqueue(new Uint8Array(7))
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }), {
    settled: completed.promise, cancel() { cancellations++ },
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error("body expected")
  await reader.read()
  await reader.cancel()
  try {
    expect(await Promise.race([ctx.drain().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])).toBe(true)
    const record = await ctx.store.get("k1", dump.recordId)
    expect(record?.meta.responseBytes).toBe(7)
    expect(record?.meta.error).toEqual({ kind: "cancelled", reason: "client_cancelled" })
    expect(cancellations).toBe(1)
    completed.reject(new Error("late semantic rejection"))
    await Promise.resolve()
    expect(await ctx.store.get("k1", dump.recordId)).toEqual(record)
  } finally { completed.resolve(); await ctx.drain() }
})
