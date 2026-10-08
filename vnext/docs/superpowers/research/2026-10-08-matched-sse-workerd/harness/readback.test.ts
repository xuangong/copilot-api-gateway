import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileIdentity, sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { validateSidecar, type Bucket, type Database, type LogicalDump } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import type { Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { validateMatchedSidecar } from "./readback"
import { readAndSaveNativeDumps, verifySavedNativeDumpReadback } from "./saved-dumps"

interface SavedFixtureEvidence {
  schema: string
  completed: boolean
  error?: string
  queries: { sql: string; results: unknown[] }[]
  inventory: { truncated: boolean; objects: { key: string; size: number }[] }
  objects: { key: string; compressedBase64: string; bytes: number; sha256: string }[]
}
const savedEvidence = (path: string) => JSON.parse(readFileSync(path, "utf8")) as SavedFixtureEvidence

function fixture(dump = true) {
  const directory = mkdtempSync(join(tmpdir(), "matched-sse-readback-"))
  const db = new Sqlite(":memory:")
  db.run("CREATE TABLE dump_records(key_id TEXT,id TEXT,meta_json TEXT,request_body_descriptor TEXT,response_body_descriptor TEXT,upstream_exchanges_descriptor TEXT)")
  db.run("CREATE TABLE spilled_files(file_key TEXT,owner_kind TEXT,owner_key TEXT,state TEXT)")
  const request = "request", id = "matched_readback"
  const events = [
    { id: "chatcmpl_matched_readback", object: "chat.completion.chunk", created: 1790726400, model: "bench-chat-ok", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: "chatcmpl_matched_readback", object: "chat.completion.chunk", created: 1790726400, model: "bench-chat-ok", choices: [{ index: 0, delta: { content: "BENCH_OK:65536" }, finish_reason: null }] },
    { id: "chatcmpl_matched_readback", object: "chat.completion.chunk", created: 1790726400, model: "bench-chat-ok", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  ]
  const upstream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  const response = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
  const row: LogicalDump = { variant: "B", id, dumpRecordId: dump ? "dump" : null, requestSha256: sha(request), responseSha256: sha(response), protocol: "chat", upstream: "chat", scenario: "ok", bytes: 65536, stream: false, status: 200, wireBytes: request.length, responseBytes: Buffer.byteLength(response), ok: true, transportCompleted: true }
  const dispatch: Dispatch = { id, protocol: "chat", status: 200, bodyBytes: request.length, requestPrefixSha256: sha(request), requestSha256: sha(request), normalizedRequestSha256: sha(request), responseBytes: Buffer.byteLength(upstream), responsePrefixSha256: sha(upstream), responsePrefixBase64: Buffer.from(upstream).toString("base64"), requestedStream: true, completed: true, cancelled: false, requestHeaders: [], responseHeaders: [["content-type", "text/event-stream"]], url: "http://127.0.0.1/v1/chat/completions", method: "POST", upstreamId: "custom:architecture-chat" }
  const body = (value: string, source: string) => ({ source, observedBytes: Buffer.byteLength(value), totalBytes: Buffer.byteLength(value) as number | null, capturedBytes: Buffer.byteLength(value), prefixBase64: Buffer.from(value).toString("base64"), truncated: false })
  const envelope = { version: 1, representation: "fetch-body", omittedAttempts: 0, metadataTruncated: false, metadataBytes: 1024, capturedBodyBytes: request.length + Buffer.byteLength(upstream), attempts: [{ id: "attempt-1", parentCallId: "call_1", upstreamId: "upstream_omitted", order: 1, startedOffsetMs: 0, completedOffsetMs: 25, method: "POST", operation: "chat.completions", url: "url_omitted", status: 200, representation: "fetch-body", errorCategory: null, request: body(request, "prepared"), response: { ...body(upstream, "fetch-body"), totalBytes: null as number | null, terminal: "cancelled" } }] }
  const objects = new Map<string, Uint8Array>()
  const descriptor = (side: string, value: string) => {
    const key = `dumps/v1/architecture-key/dump/${side}`
    objects.set(key, Bun.gzipSync(value))
    db.run("INSERT INTO spilled_files VALUES(?,?,?,?)", [key, `dump-${side}`, JSON.stringify(["architecture-key", "dump"]), "owned"])
    return JSON.stringify({ key, type: side === "upstream" ? "upstreamExchanges" : side === "response" ? "events" : "bytes", ...(side === "upstream" ? { version: 1 } : {}) })
  }
  if (dump) db.run("INSERT INTO dump_records VALUES(?,?,?,?,?,?)", ["architecture-key", "dump", JSON.stringify({ id: "dump", method: "POST", path: "/v1/chat/completions", status: 200, requestBytes: request.length }), descriptor("request", request), descriptor("response", JSON.stringify([...events.map(event => ({ ts: 0, frame: { type: "event", event } })), { ts: 0, frame: { type: "done" } }])), descriptor("upstream", JSON.stringify(envelope))])
  const database: Database = { prepare: sql => ({ async all<T>() { return { results: db.query(sql).all() as T[] } } }) }
  const bucket: Bucket = { async list() { return { truncated: false, objects: [...objects].map(([key, bytes]) => ({ key, size: bytes.byteLength })) } }, async get(key) { const bytes = objects.get(key); return bytes ? { async arrayBuffer() { return Uint8Array.from(bytes).buffer } } : null } }
  return { directory, db, database, bucket, row, dispatch, envelope, objects, cleanup() { db.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const capture = (f: ReturnType<typeof fixture>, dump = true) => readAndSaveNativeDumps({ directory: f.directory, db: f.database, bucket: f.bucket, rows: [f.row], dispatches: [f.dispatch], arm: "B", dump })
const replay = (f: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof capture>>, dump = true) => verifySavedNativeDumpReadback({ directory: f.directory, rows: [f.row], dispatches: [f.dispatch], arm: "B", dump, evidence: result.evidence, storage: result.storage })

test("matched JSON downstream accepts complete SSE protocol-end cancellation without changing legacy policy or the row", () => {
  const f = fixture()
  try {
    const original = JSON.stringify(f.row)
    expect(() => validateSidecar(f.envelope, f.row, f.dispatch)).toThrow("terminal")
    expect(() => validateMatchedSidecar(f.envelope, f.row, f.dispatch)).not.toThrow()
    expect(JSON.stringify(f.row)).toBe(original)
  } finally { f.cleanup() }
})

test("matched sidecar requires actual SSE source and all four fixture frames even for a streaming downstream", () => {
  const f = fixture()
  try {
    for (const patch of [{ requestedStream: false }, { completed: false }, { cancelled: true }, { responseHeaders: [["content-type", "application/json"]] as [string, string][] }, { responseBytes: f.dispatch.responseBytes - 1 }]) {
      expect(() => validateMatchedSidecar(f.envelope, { ...f.row, stream: true }, { ...f.dispatch, ...patch })).toThrow()
    }
    const bytes = Buffer.from(f.dispatch.responsePrefixBase64, "base64").toString().replace("data: [DONE]\n\n", "")
    const missingDone = { ...f.dispatch, responseBytes: Buffer.byteLength(bytes), responsePrefixBase64: Buffer.from(bytes).toString("base64"), responsePrefixSha256: sha(bytes) }
    expect(() => validateMatchedSidecar(f.envelope, f.row, missingDone)).toThrow("frames/terminal/usage")
  } finally { f.cleanup() }
})

test("matched cancellation keeps strict sidecar bytes, total, terminal and scope checks", () => {
  const f = fixture()
  try {
    for (const patch of [{ observedBytes: 1 }, { capturedBytes: 1 }, { prefixBase64: "AAAA" }, { totalBytes: f.dispatch.responseBytes }, { terminal: "truncated" }, { terminal: "error" }, { source: "prepared" }]) {
      const envelope = structuredClone(f.envelope)
      const attempt = envelope.attempts[0]
      if (!attempt) throw new Error("Fixture attempt missing")
      Object.assign(attempt.response, patch)
      expect(() => validateMatchedSidecar(envelope, f.row, f.dispatch)).toThrow()
    }
    for (const patch of [{ id: "different" }, { variant: "A" as const }, { ok: false }, { protocol: "responses" }, { scenario: "failed" }]) {
      expect(() => validateMatchedSidecar(f.envelope, { ...f.row, ...patch }, f.dispatch)).toThrow()
    }
  } finally { f.cleanup() }
})

test("matched complete physical EOF still requires the exact observed total", () => {
  const f = fixture()
  try {
    const envelope = structuredClone(f.envelope)
    const attempt = envelope.attempts[0]
    if (!attempt) throw new Error("Fixture attempt missing")
    attempt.response.terminal = "eof"
    attempt.response.totalBytes = f.dispatch.responseBytes
    expect(() => validateMatchedSidecar(envelope, f.row, f.dispatch)).not.toThrow()
    attempt.response.totalBytes = null
    expect(() => validateMatchedSidecar(envelope, f.row, f.dispatch)).toThrow("terminal/total")
  } finally { f.cleanup() }
})

test("matched saved readback preserves raw gzip and repeats the oracle from saved evidence", async () => {
  const f = fixture()
  try {
    const result = await capture(f)
    expect(result.storage.ownedObjects).toBe(3)
    const saved = savedEvidence(result.evidence.path)
    expect(saved.schema).toBe("matched-sse-native-dump-evidence-v1")
    for (const object of saved.objects) {
      const expected = f.objects.get(object.key)
      if (!expected) throw new Error("Original fixture gzip missing")
      expect(Buffer.from(object.compressedBase64, "base64")).toEqual(Buffer.from(expected))
    }
    f.bucket.get = async () => { throw new Error("Offline replay touched live R2") }
    f.database.prepare = () => { throw new Error("Offline replay touched live SQL") }
    expect(await replay(f, result)).toEqual(result.storage)
    expect(f.row.stream).toBe(false)
  } finally { f.cleanup() }
})

test("failed matched readback durably retains the original rejected sidecar gzip", async () => {
  const f = fixture()
  try {
    const attempt = f.envelope.attempts[0]
    if (!attempt) throw new Error("Fixture attempt missing")
    attempt.response.terminal = "error"
    const key = "dumps/v1/architecture-key/dump/upstream"
    const rejectedBytes = Bun.gzipSync(JSON.stringify(f.envelope))
    f.objects.set(key, rejectedBytes)
    await expect(capture(f)).rejects.toThrow("terminal/total")
    const path = join(f.directory, "native-dump-evidence.json")
    const saved = savedEvidence(path)
    expect(saved.completed).toBe(false)
    expect(saved.error).toContain("terminal/total")
    expect(saved.queries).toHaveLength(3)
    expect(saved.objects).toHaveLength(3)
    const object = saved.objects.find(value => value.key === key)
    if (!object) throw new Error("Rejected sidecar evidence missing")
    expect(Buffer.from(object.compressedBase64, "base64")).toEqual(Buffer.from(rejectedBytes))
    expect(object.sha256).toBe(sha(rejectedBytes))
    await expect(verifySavedNativeDumpReadback({ directory: f.directory, rows: [f.row], dispatches: [f.dispatch], arm: "B", dump: true, evidence: fileIdentity(path), storage: {} })).rejects.toThrow("identity/policy")
  } finally { f.cleanup() }
})

test("offline matched sidecar rejects internally rehashed wrong terminal and bytes", async () => {
  for (const patch of [{ terminal: "truncated" }, { observedBytes: 1 }, { totalBytes: 1 }]) {
    const f = fixture()
    try {
      const result = await capture(f)
      const saved = savedEvidence(result.evidence.path)
      const object = saved.objects.find(value => value.key.endsWith("/upstream"))
      if (!object) throw new Error("Fixture sidecar evidence missing")
      const envelope = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(Buffer.from(object.compressedBase64, "base64")))) as typeof f.envelope
      const attempt = envelope.attempts[0]
      if (!attempt) throw new Error("Fixture attempt missing")
      Object.assign(attempt.response, patch)
      const gzip = Bun.gzipSync(JSON.stringify(envelope))
      object.compressedBase64 = Buffer.from(gzip).toString("base64"); object.bytes = gzip.byteLength; object.sha256 = sha(gzip)
      const inventoryObject = saved.inventory.objects.find(value => value.key === object.key)
      if (!inventoryObject) throw new Error("Fixture sidecar inventory missing")
      inventoryObject.size = gzip.byteLength
      writeFileSync(result.evidence.path, JSON.stringify(saved))
      await expect(replay(f, { ...result, evidence: fileIdentity(result.evidence.path) })).rejects.toThrow()
    } finally { f.cleanup() }
  }
})

test("matched dump-disabled windows save and reverify the empty native inventory", async () => {
  const f = fixture(false)
  try {
    const result = await capture(f, false)
    expect(result.storage.ownedObjects).toBe(0)
    expect(await replay(f, result, false)).toEqual(result.storage)
  } finally { f.cleanup() }
})
