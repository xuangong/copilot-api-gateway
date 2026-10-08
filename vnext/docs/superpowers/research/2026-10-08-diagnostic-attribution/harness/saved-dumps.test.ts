import { test, expect } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha, fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import type { Database, Bucket, LogicalDump } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import { readAndSaveNativeDumps, verifySavedNativeDumpReadback } from "./saved-dumps"

function fixture(dump = true) {
  const directory = mkdtempSync(join(tmpdir(), "saved-native-dumps-"))
  const raw = new Sqlite(":memory:")
  raw.run("CREATE TABLE dump_records(key_id TEXT,id TEXT,meta_json TEXT,request_body_descriptor TEXT,response_body_descriptor TEXT,upstream_exchanges_descriptor TEXT)")
  raw.run("CREATE TABLE spilled_files(file_key TEXT,owner_kind TEXT,owner_key TEXT,state TEXT)")
  const request = "request"
  const response = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
  ].map(event => ({ ts: 0, frame: { type: "event", event } }))
  const logical: LogicalDump = { id: "logical", dumpRecordId: dump ? "dump" : null, requestSha256: sha(request), responseSha256: sha(response), protocol: "chat", upstream: "chat", scenario: "ok", bytes: 65536, stream: false, status: 200, wireBytes: request.length, responseBytes: Buffer.byteLength(response), ok: true, transportCompleted: true }
  const dispatch = { id: "logical", status: 200, protocol: "chat", bodyBytes: request.length, requestPrefixSha256: sha(request), responseBytes: Buffer.byteLength(response), responsePrefixSha256: sha(response), responsePrefixBase64: Buffer.from(response).toString("base64") }
  const envelope = { version: 1, representation: "fetch-body", omittedAttempts: 0, metadataTruncated: false, metadataBytes: 1024, capturedBodyBytes: request.length + Buffer.byteLength(response), attempts: [{ id: "attempt-1", parentCallId: "call_1", upstreamId: "upstream_omitted", order: 1, startedOffsetMs: 0, completedOffsetMs: 1, method: "POST", operation: "chat.completions", url: "url_omitted", status: 200, representation: "fetch-body", errorCategory: null, request: { source: "prepared", observedBytes: request.length, totalBytes: request.length, capturedBytes: request.length, prefixBase64: Buffer.from(request).toString("base64"), truncated: false }, response: { source: "fetch-body", observedBytes: Buffer.byteLength(response), totalBytes: Buffer.byteLength(response), capturedBytes: Buffer.byteLength(response), prefixBase64: Buffer.from(response).toString("base64"), truncated: false, terminal: "eof" } }] }
  const objects = new Map<string, Uint8Array>()
  const descriptor = (side: string, value: string) => {
    const key = `dumps/v1/architecture-key/dump/${side}`
    objects.set(key, Bun.gzipSync(value))
    raw.run("INSERT INTO spilled_files VALUES(?,?,?,?)", [key, `dump-${side}`, JSON.stringify(["architecture-key", "dump"]), "owned"])
    return JSON.stringify({ key, type: side === "upstream" ? "upstreamExchanges" : side === "response" ? "events" : "bytes", ...(side === "upstream" ? { version: 1 } : {}) })
  }
  if (dump) raw.run("INSERT INTO dump_records VALUES(?,?,?,?,?,?)", ["architecture-key", "dump", JSON.stringify({ id: "dump", method: "POST", path: "/v1/chat/completions", status: 200, requestBytes: request.length }), descriptor("request", request), descriptor("response", JSON.stringify([...frames, { ts: 0, frame: { type: "done" } }])), descriptor("upstream", JSON.stringify(envelope))])
  const calls = { gets: 0, lists: 0, sql: 0 }
  const db: Database = { prepare: sql => ({ async all<T>() { calls.sql++; return { results: raw.query(sql).all() as T[] } } }) }
  const bucket: Bucket = { async list() { calls.lists++; return { truncated: false, objects: [...objects].map(([key, value]) => ({ key, size: value.byteLength })) } }, async get(key) { calls.gets++; const bytes = objects.get(key); return bytes ? { async arrayBuffer() { return Uint8Array.from(bytes).buffer } } : null } }
  return { directory, raw, db, bucket, logical, dispatch, calls, cleanup() { raw.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const capture = (f: ReturnType<typeof fixture>, dump = true) => readAndSaveNativeDumps({ directory: f.directory, db: f.db, bucket: f.bucket, rows: [f.logical], dispatches: [f.dispatch], arm: "B", dump })
async function replay(f: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof capture>>, dump = true) {
  return verifySavedNativeDumpReadback({ directory: f.directory, rows: [f.logical], dispatches: [f.dispatch], arm: "B", dump, evidence: result.evidence, storage: result.storage })
}
function changeObject(f: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof capture>>, side: string, change: (text: string) => string) {
  const saved = JSON.parse(readFileSync(result.evidence.path, "utf8"))
  const object = saved.objects.find((value: { key: string }) => value.key.endsWith("/" + side))
  const bytes = Bun.gzipSync(change(new TextDecoder().decode(Bun.gunzipSync(Buffer.from(object.compressedBase64, "base64")))))
  object.compressedBase64 = Buffer.from(bytes).toString("base64"); object.bytes = bytes.byteLength; object.sha256 = sha(bytes)
  saved.inventory.objects.find((value: { key: string }) => value.key === object.key).size = bytes.byteLength
  writeFileSync(result.evidence.path, JSON.stringify(saved))
  return { ...result, evidence: fileIdentity(result.evidence.path) }
}

test("saved readback replays the same canonical and sidecar oracle without another physical get", async () => {
  const f = fixture()
  try {
    const result = await capture(f)
    expect(result.storage.ownedObjects).toBe(3)
    expect(await replay(f, result)).toEqual(result.storage)
    expect(f.calls).toEqual({ gets: 3, lists: 1, sql: 3 })
  } finally { f.cleanup() }
})
test("saved request bytes are verified beyond an internally consistent compressed digest", async () => {
  const f = fixture()
  try {
    const result = changeObject(f, await capture(f), "request", () => "wrong!!")
    await expect(replay(f, result)).rejects.toThrow("request digest")
  } finally { f.cleanup() }
})
test("saved canonical frames are parsed and checked rather than trusting prior semantic receipt", async () => {
  const f = fixture()
  try {
    const result = changeObject(f, await capture(f), "response", text => text.replace("BENCH_OK:65536", "wrong"))
    await expect(replay(f, result)).rejects.toThrow("Canonical upstream semantics")
  } finally { f.cleanup() }
})
test("saved upstream sidecar bytes are independently matched against the dispatch", async () => {
  const f = fixture()
  try {
    const result = changeObject(f, await capture(f), "upstream", text => text.replace('"order":1', '"order":2'))
    await expect(replay(f, result)).rejects.toThrow("attempt metadata")
  } finally { f.cleanup() }
})
test("missing saved object and source artifact drift fail closed", async () => {
  const f = fixture()
  try {
    const result = await capture(f)
    const saved = JSON.parse(readFileSync(result.evidence.path, "utf8")); saved.objects.pop()
    writeFileSync(result.evidence.path, JSON.stringify(saved))
    await expect(replay(f, result)).rejects.toThrow("identity")
    await expect(replay(f, { ...result, evidence: fileIdentity(result.evidence.path) })).rejects.toThrow("population")
  } finally { f.cleanup() }
})
test("dump-disabled readback preserves and replays empty native SQL and R2 inventory", async () => {
  const f = fixture(false)
  try {
    const result = await capture(f, false)
    expect(result.storage.ownedObjects).toBe(0)
    expect(await replay(f, result, false)).toEqual(result.storage)
    expect(f.calls).toEqual({ gets: 0, lists: 1, sql: 3 })
  } finally { f.cleanup() }
})

test("physical inventory snapshots only oracle fields from noncloneable runtime objects", async () => {
  const f = fixture()
  try {
    const list = f.bucket.list
    f.bucket.list = async options => {
      const inventory = await list(options)
      return new Proxy({ ...inventory, runtimeMethod() {}, objects: inventory.objects.map(object => new Proxy({ ...object, runtimeMethod() {} }, {})) }, {})
    }
    const result = await capture(f)
    const saved = JSON.parse(readFileSync(result.evidence.path, "utf8"))
    expect(Object.keys(saved.inventory).sort()).toEqual(["objects", "truncated"])
    expect(saved.inventory.objects.every((object: Record<string, unknown>) => Object.keys(object).sort().join(",") === "key,size")).toBe(true)
    expect(await replay(f, result)).toEqual(result.storage)
    expect(f.calls).toEqual({ gets: 3, lists: 1, sql: 3 })
  } finally { f.cleanup() }
})
