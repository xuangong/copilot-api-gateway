// Tests for FileDumpStore. Uses a real bun:sqlite database (via
// BunSqliteRepo migrations to lay down the dump_records + spilled_files
// schema) plus a tiny in-memory FileProvider fake — no mock.module, per the
// bun_mock_module_unrestorable memory.

import { test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo as SqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import type { FileProvider, FileGetResult } from "@vibe-core/platform"
import { FileDumpStore } from "../src/shared/repo/dump-store.ts"
import type { DumpMetadata, DumpWriteRecord, PreparedDumpRequestBody } from "../src/shared/dump/types.ts"
import type { ProtocolFrame } from "@vibe-core/result"

// Tiny in-memory FileProvider fake — returns gz bytes as a ReadableStream so
// the store's `new Response(got.body).arrayBuffer()` path is exercised.
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
}

async function setupCtx(retentionSeconds: number | null = 3600): Promise<Ctx> {
  const raw = new Database(":memory:")
  const repo = new SqliteRepo(raw) // runs all migrations incl. spilled_files/dump_records
  const db = new BunSqliteDatabase(raw)
  const files = new MemoryFiles()
  const store = new FileDumpStore(db, files)
  const now = new Date().toISOString()
  await repo.apiKeys.save({
    id: "k1",
    name: "test",
    key: "raw-k1",
    createdAt: now,
    ownerId: "u1",
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
  return { raw, db, files, store, repo }
}

const baseMeta = (id: string, completedAt: number, upstreamId: string | null = "ups-1"): DumpMetadata => ({
  id,
  startedAt: completedAt - 100,
  completedAt,
  method: "POST",
  path: "/v1/chat/completions",
  status: 200,
  upstream: upstreamId === null ? null : { id: upstreamId, name: "Copilot A", kind: "copilot" },
  model: "gpt-4",
  inputTokens: 10,
  outputTokens: 20,
  requestBytes: 5,
  responseBytes: 6,
  durationMs: 100,
  error: null,
})

async function prepared(store: FileDumpStore, bytes: Uint8Array): Promise<PreparedDumpRequestBody> {
  return await store.prepareRequestBody(bytes)
}

async function writeBytesRecord(
  ctx: Ctx,
  recordId: string,
  completedAt: number,
  responseBody: Uint8Array = new TextEncoder().encode("hello"),
): Promise<void> {
  const reqBytes = new TextEncoder().encode("world")
  const record: DumpWriteRecord = {
    meta: baseMeta(recordId, completedAt),
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: [["content-type", "application/json"]],
      body: await prepared(ctx.store, reqBytes),
    },
    response: {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: { type: "bytes", body: responseBody },
    },
  }
  await ctx.store.put("k1", record)
}

test("prepareRequestBody gzips and preserves decoded byte length", async () => {
  const ctx = await setupCtx()
  const raw = new TextEncoder().encode("some payload that should compress")
  const p = await ctx.store.prepareRequestBody(raw)
  expect(p.encoding).toBe("gzip")
  expect(p.decodedByteLength).toBe(raw.byteLength)
  expect(p.bytes.byteLength).toBeGreaterThan(0)
})

test("put writes files, inserts row, and adopts spilled_files to state=owned", async () => {
  const ctx = await setupCtx()
  await writeBytesRecord(ctx, "01H000000000000000000REC01", Date.now())

  // spilled_files rows should be adopted (state=owned) by the AFTER INSERT triggers.
  const rows = ctx.raw.query("SELECT owner_kind, state, collect_after FROM spilled_files").all() as Array<{
    owner_kind: string
    state: string
    collect_after: number | null
  }>
  expect(rows.length).toBe(2)
  for (const r of rows) {
    expect(r.state).toBe("owned")
    expect(r.collect_after).toBeNull()
  }
  const kinds = rows.map(r => r.owner_kind).sort()
  expect(kinds).toEqual(["dump-request", "dump-response"])

  // Two body files landed under the DUMP_FILE_PREFIX.
  expect(ctx.files.files.size).toBe(2)
  for (const k of ctx.files.files.keys()) {
    expect(k.startsWith("dumps/v1/k1/")).toBe(true)
  }
})

test("put with empty request body skips request file", async () => {
  const ctx = await setupCtx()
  const record: DumpWriteRecord = {
    meta: baseMeta("01H000000000000000000REC02", Date.now()),
    request: {
      method: "GET",
      path: "/v1/models",
      headers: [],
      body: { encoding: "identity", bytes: new Uint8Array(), decodedByteLength: 0 },
    },
    response: {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: { type: "bytes", body: new TextEncoder().encode("{}") },
    },
  }
  await ctx.store.put("k1", record)
  expect(ctx.files.files.size).toBe(1)
  const rows = ctx.raw.query("SELECT owner_kind FROM spilled_files").all() as Array<{ owner_kind: string }>
  expect(rows.length).toBe(1)
  expect(rows[0]?.owner_kind).toBe("dump-response")
})

test("put with response type=none writes no response file and leaves response_headers null", async () => {
  const ctx = await setupCtx()
  const reqBytes = new TextEncoder().encode("x")
  const record: DumpWriteRecord = {
    meta: baseMeta("01H000000000000000000REC03", Date.now()),
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: [],
      body: await prepared(ctx.store, reqBytes),
    },
    response: {
      status: null,
      headers: [["ignored", "yes"]],
      body: { type: "none" },
    },
  }
  await ctx.store.put("k1", record)
  const row = ctx.raw.query("SELECT response_headers_json, response_body_descriptor FROM dump_records").get() as {
    response_headers_json: string | null
    response_body_descriptor: string | null
  }
  expect(row.response_headers_json).toBeNull()
  expect(row.response_body_descriptor).toBeNull()
})

test("list returns newest-first and honors limit + cursor pagination", async () => {
  const ctx = await setupCtx()
  const now = Date.now()
  await writeBytesRecord(ctx, "01H0000000000000000000REC1", now - 3000)
  await writeBytesRecord(ctx, "01H0000000000000000000REC2", now - 2000)
  await writeBytesRecord(ctx, "01H0000000000000000000REC3", now - 1000)

  const page1 = await ctx.store.list("k1", { limit: 2 })
  expect(page1.map(m => m.id)).toEqual(["01H0000000000000000000REC3", "01H0000000000000000000REC2"])

  const page2 = await ctx.store.list("k1", { limit: 2, before: "01H0000000000000000000REC2" })
  expect(page2.map(m => m.id)).toEqual(["01H0000000000000000000REC1"])

  // Unknown cursor → empty page.
  const bogus = await ctx.store.list("k1", { limit: 10, before: "01H000000000000000000BOGUS" })
  expect(bogus).toEqual([])
})

test("list hydrates upstream ref via join (current name, kind)", async () => {
  const ctx = await setupCtx()
  await writeBytesRecord(ctx, "01H0000000000000000000REC1", Date.now())
  // Rename the upstream after the fact — list should return the new name.
  ctx.raw.query("UPDATE upstreams SET name = 'Renamed' WHERE id = 'ups-1'").run()
  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.upstream).toEqual({ id: "ups-1", name: "Renamed", kind: "copilot" })
})

test("list filters by rolling retention window", async () => {
  const ctx = await setupCtx(1) // 1s retention
  const now = Date.now()
  await writeBytesRecord(ctx, "01H0000000000000000000OLD1", now - 60_000) // way old
  await writeBytesRecord(ctx, "01H0000000000000000000NEW1", now)           // fresh
  const rows = await ctx.store.list("k1", { limit: 10 })
  expect(rows.map(m => m.id)).toEqual(["01H0000000000000000000NEW1"])
})

test("list returns [] when api_keys.dump_retention_seconds is NULL (opt-out)", async () => {
  const ctx = await setupCtx(null)
  await writeBytesRecord(ctx, "01H0000000000000000000REC1", Date.now())
  const rows = await ctx.store.list("k1", { limit: 10 })
  expect(rows).toEqual([])
})

test("get rehydrates bytes response and request body", async () => {
  const ctx = await setupCtx()
  const respBytes = new TextEncoder().encode("resp-body")
  await writeBytesRecord(ctx, "01H000000000000000000GET01", Date.now(), respBytes)
  const rec = await ctx.store.get("k1", "01H000000000000000000GET01")
  expect(rec).not.toBeNull()
  expect(new TextDecoder().decode(rec!.request.body)).toBe("world")
  expect(rec!.response.body.type).toBe("bytes")
  if (rec!.response.body.type === "bytes") {
    expect(new TextDecoder().decode(rec!.response.body.body)).toBe("resp-body")
  }
})

test("get rehydrates stream events response", async () => {
  const ctx = await setupCtx()
  const events = [
    { frame: { type: "delta", value: "hi" } as ProtocolFrame<unknown>, ts: 1 },
    { frame: { type: "delta", value: "!" } as ProtocolFrame<unknown>, ts: 2 },
  ]
  const record: DumpWriteRecord = {
    meta: baseMeta("01H000000000000000000STR01", Date.now()),
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: [],
      body: await prepared(ctx.store, new TextEncoder().encode("req")),
    },
    response: {
      status: 200,
      headers: [["content-type", "text/event-stream"]],
      body: { type: "stream", events },
    },
  }
  await ctx.store.put("k1", record)
  const rec = await ctx.store.get("k1", "01H000000000000000000STR01")
  expect(rec!.response.body.type).toBe("stream")
  if (rec!.response.body.type === "stream") {
    expect(rec!.response.body.events.length).toBe(2)
    expect(rec!.response.body.events[0]?.ts).toBe(1)
  }
})

test("get returns null for type=none response body reconstruction", async () => {
  const ctx = await setupCtx()
  const record: DumpWriteRecord = {
    meta: baseMeta("01H000000000000000000NON01", Date.now()),
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: [],
      body: await prepared(ctx.store, new TextEncoder().encode("x")),
    },
    response: {
      status: null,
      headers: [],
      body: { type: "none" },
    },
  }
  await ctx.store.put("k1", record)
  const rec = await ctx.store.get("k1", "01H000000000000000000NON01")
  expect(rec!.response.body.type).toBe("none")
})

test("get returns null outside retention window", async () => {
  const ctx = await setupCtx(1)
  await writeBytesRecord(ctx, "01H0000000000000000000OLD1", Date.now() - 60_000)
  const rec = await ctx.store.get("k1", "01H0000000000000000000OLD1")
  expect(rec).toBeNull()
})

test("get returns null for missing record", async () => {
  const ctx = await setupCtx()
  const rec = await ctx.store.get("k1", "01H0000000000000000MISSING")
  expect(rec).toBeNull()
})

test("delete triggers retire spilled_files to state=retired with collect_after=0", async () => {
  const ctx = await setupCtx()
  await writeBytesRecord(ctx, "01H000000000000000000DEL01", Date.now())
  ctx.raw.query("DELETE FROM dump_records WHERE id = '01H000000000000000000DEL01'").run()
  const rows = ctx.raw.query("SELECT state, collect_after FROM spilled_files").all() as Array<{
    state: string
    collect_after: number | null
  }>
  expect(rows.length).toBe(2)
  for (const r of rows) {
    expect(r.state).toBe("retired")
    expect(r.collect_after).toBe(0)
  }
})

test("deleteExpiredBatch active branch drops rows past retention, respects limit", async () => {
  const ctx = await setupCtx(1) // 1s retention
  const now = Date.now()
  await writeBytesRecord(ctx, "01H0000000000000000000OLD1", now - 60_000)
  await writeBytesRecord(ctx, "01H0000000000000000000OLD2", now - 61_000)
  await writeBytesRecord(ctx, "01H0000000000000000000OLD3", now - 62_000)
  const deleted = await ctx.store.deleteExpiredBatch("k1", now, 2)
  expect(deleted).toBe(2)
  const remaining = (ctx.raw.query("SELECT COUNT(*) AS c FROM dump_records").get() as { c: number }).c
  expect(remaining).toBe(1)
})

test("deleteExpiredBatch orphan branch sweeps rows for hard-deleted key", async () => {
  const ctx = await setupCtx()
  await writeBytesRecord(ctx, "01H0000000000000000000ORP1", Date.now())
  await writeBytesRecord(ctx, "01H0000000000000000000ORP2", Date.now())
  ctx.raw.query("DELETE FROM api_keys WHERE id = 'k1'").run()
  const deleted = await ctx.store.deleteExpiredBatch("k1", Date.now(), 10)
  expect(deleted).toBe(2)
  const remaining = (ctx.raw.query("SELECT COUNT(*) AS c FROM dump_records").get() as { c: number }).c
  expect(remaining).toBe(0)
})

test("deleteExpiredBatch orphan branch sweeps rows when retention cleared to NULL", async () => {
  const ctx = await setupCtx()
  await writeBytesRecord(ctx, "01H0000000000000000000CLR1", Date.now())
  ctx.raw.query("UPDATE api_keys SET dump_retention_seconds = NULL WHERE id = 'k1'").run()
  const deleted = await ctx.store.deleteExpiredBatch("k1", Date.now(), 10)
  expect(deleted).toBe(1)
})

test("findOldestCreatedAt returns oldest and null when empty", async () => {
  const ctx = await setupCtx()
  expect(await ctx.store.findOldestCreatedAt("k1")).toBeNull()
  const t = Date.now()
  await writeBytesRecord(ctx, "01H0000000000000000000AGE1", t - 5000)
  await writeBytesRecord(ctx, "01H0000000000000000000AGE2", t - 2000)
  expect(await ctx.store.findOldestCreatedAt("k1")).toBe(t - 5000)
})

test("unknown upstream provider falls back to 'custom'", async () => {
  const ctx = await setupCtx()
  // Force an unknown provider value in the upstreams row.
  ctx.raw.query("UPDATE upstreams SET provider = 'bogus-kind' WHERE id = 'ups-1'").run()
  await writeBytesRecord(ctx, "01H0000000000000000000UPK1", Date.now())
  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.upstream!.kind).toBe("custom")
})

test("deleted upstream yields null upstream ref on read", async () => {
  const ctx = await setupCtx()
  await writeBytesRecord(ctx, "01H0000000000000000000DEL2", Date.now())
  ctx.raw.query("DELETE FROM upstreams WHERE id = 'ups-1'").run()
  const [meta] = await ctx.store.list("k1", { limit: 10 })
  expect(meta!.upstream).toBeNull()
})
