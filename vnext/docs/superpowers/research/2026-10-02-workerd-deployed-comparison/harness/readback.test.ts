import { test, expect } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { readDumps, dumpStatusEvidence, validateSidecar, type Bucket, type Database, type LogicalDump } from "./readback.ts"
import { sha } from "./manifest.ts"
import { oracle } from "./oracle.ts"
import { UpstreamExchangeCollector } from "../../../../../packages/gateway/src/shared/dump/upstream-attempts.ts"

function storage(variant: "A" | "B") {
  const raw = new Sqlite(":memory:")
  raw.run(`CREATE TABLE dump_records(key_id TEXT,id TEXT,meta_json TEXT,request_body_descriptor TEXT,response_body_descriptor TEXT${variant === "B" ? ",upstream_exchanges_descriptor TEXT" : ""})`)
  raw.run("CREATE TABLE spilled_files(file_key TEXT,owner_kind TEXT,owner_key TEXT,state TEXT)")
  const request = "request", response = "response"
  const logical: LogicalDump = { variant, id: "logical", dumpRecordId: "dump", requestSha256: sha(request), responseSha256: sha(response), protocol: "responses", upstream: "responses", scenario: "ok", bytes: 65536, stream: false, status: 200, wireBytes: request.length, responseBytes: response.length, ok: true, transportCompleted: true }
  const objects = new Map<string, Uint8Array>()
  const descriptor = (side: string, value: string) => {
    const key = `dumps/v1/architecture-key/dump/${side}`
    objects.set(key, Bun.gzipSync(value))
    raw.run("INSERT INTO spilled_files VALUES(?,?,?,?)", [key, `dump-${side}`, JSON.stringify(["architecture-key", "dump"]), "owned"])
    return JSON.stringify({ key, type: side === "upstream" ? "upstreamExchanges" : "bytes", ...(side === "upstream" ? { version: 1 } : {}) })
  }
  const values = ["architecture-key", "dump", JSON.stringify({ id: "dump", method: "POST", path: "/v1/responses", status: 200, requestBytes: request.length }), descriptor("request", request), descriptor("response", response)]
  const dispatch = { id: "logical", status: 200, protocol: "responses", bodyBytes: request.length, requestPrefixSha256: sha(request), responseBytes: response.length, responsePrefixSha256: sha(response), responsePrefixBase64: Buffer.from(response).toString("base64") }
  const envelope = { version: 1, representation: "fetch-body", omittedAttempts: 0, metadataTruncated: false, metadataBytes: 1024, capturedBodyBytes: request.length + response.length, attempts: [{ id: "attempt-1", parentCallId: "call_1", upstreamId: "upstream_omitted", order: 1, startedOffsetMs: 0, completedOffsetMs: 1, method: "POST", operation: "responses.create", url: "url_omitted", status: 200, representation: "fetch-body", errorCategory: null, request: { source: "prepared", observedBytes: request.length, totalBytes: request.length, capturedBytes: request.length, prefixBase64: Buffer.from(request).toString("base64"), truncated: false }, response: { source: "fetch-body", observedBytes: response.length, totalBytes: response.length, capturedBytes: response.length, prefixBase64: Buffer.from(response).toString("base64"), truncated: false, terminal: "eof" } }] }
  if (variant === "B") values.push(descriptor("upstream", JSON.stringify(envelope)))
  raw.run(`INSERT INTO dump_records VALUES(${values.map(() => "?").join(",")})`, values)
  const db: Database = { prepare: sql => ({ async all<T>() { return { results: raw.query(sql).all() as T[] } } }) }
  const bucket: Bucket = { async list() { return { truncated: false, objects: [...objects].map(([key, value]) => ({ key, size: value.byteLength })) } }, async get(key) { const bytes = objects.get(key); return bytes ? { async arrayBuffer() { return Uint8Array.from(bytes).buffer } } : null } }
  return { raw, db, bucket, logical, objects, dispatch, envelope }
}
test("sidecar accepts the producer's one-based first attempt and rejects invalid order, operation and status", async () => {
  const s = storage("B")
  try {
    const collector = new UpstreamExchangeCollector()
    const capture = collector.begin({ parentCallId: "call_1", upstreamId: "custom:architecture-chat", method: "POST", operation: "responses.create" })
    if (!capture) throw new Error("Producer did not create attempt")
    capture.observePreparedText("request")
    const observed = capture.observeResponse(200, [], new Response("response").body)
    expect(await new Response(observed).text()).toBe("response")
    const envelope = collector.finish()
    const attempt = envelope.attempts[0]
    if (!attempt) throw new Error("Producer missing first attempt")
    expect(attempt.id).toBe("attempt-1")
    expect(attempt.order).toBe(1)
    validateSidecar(envelope, s.logical, s.dispatch)
    for (const patch of [{ order: 0 }, { order: 2 }, { operation: "chat.completions" }, { status: 201 }]) {
      const invalid = { ...envelope, attempts: [{ ...attempt, ...patch }] }
      expect(() => validateSidecar(invalid, s.logical, s.dispatch)).toThrow("Native attempt metadata mismatch")
    }
  } finally { s.raw.close() }
})
test("legacy A reads actual legacy SQL without fabricating a sidecar", async () => {
  const s = storage("A")
  try { const result = await readDumps(s.db, s.bucket, [s.logical], [s.dispatch], { checked: new Set() }, "A"); expect(result.ownedObjects).toBe(2) } finally { s.raw.close() }
})
test("current B requires a sidecar and rejects missing owned R2 bytes", async () => {
  const s = storage("B")
  try {
    expect((await readDumps(s.db, s.bucket, [s.logical], [s.dispatch], { checked: new Set() }, "B")).ownedObjects).toBe(3)
    s.raw.run("UPDATE dump_records SET upstream_exchanges_descriptor=NULL")
    await expect(readDumps(s.db, s.bucket, [s.logical], [s.dispatch], { checked: new Set() }, "B")).rejects.toThrow("sidecar")
  } finally { s.raw.close() }
  const missing = storage("A")
  try { missing.objects.delete([...missing.objects.keys()][0] ?? ""); await expect(readDumps(missing.db, missing.bucket, [missing.logical], [], { checked: new Set() }, "A")).rejects.toThrow("ownership") } finally { missing.raw.close() }
})
test("physical status exception cannot leak into deployed A or unrelated cells", () => {
  const s = storage("A")
  const row = { ...s.logical, protocol: "responses", upstream: "messages", scenario: "refusal", classification: "expected_refusal" }
  expect(dumpStatusEvidence(row, 502, { kind: "failed", reason: "policy" }).accepted).toBe(false)
  expect(dumpStatusEvidence({ ...row, variant: "B" }, 502, { kind: "failed", reason: "policy" }).accepted).toBe(true)
  expect(dumpStatusEvidence({ ...row, variant: "B", stream: true }, 502, { kind: "failed", reason: "policy" }).accepted).toBe(false)
  s.raw.close()
})
test("deployed completed text refusal remains an explicit semantic failure", () => {
  const event = { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "BENCH_REFUSAL" }] }], usage: { input_tokens: 7, output_tokens: 3 } }
  const cell = { variant: "A" as const, protocol: "responses", upstream: "messages", scenario: "refusal", bytes: 65536, stream: false }
  expect(oracle(200, [event], false, cell).ok).toBe(false)
  expect(oracle(200, [event], false, { ...cell, variant: "B" }).ok).toBe(false)
  expect(oracle(200, [event], false, { ...cell, upstream: "responses" }).ok).toBe(false)
})

test("sidecar rejects incomplete bytes and arbitrary terminals; only source-scoped complete cancellation is accepted", () => {
  const s = storage("B")
  try {
    validateSidecar(s.envelope, s.logical, s.dispatch)
    const attempt = s.envelope.attempts[0]
    if (!attempt) throw new Error("Fixture missing attempt")
    attempt.response.terminal = "cancelled"
    expect(() => validateSidecar(s.envelope, s.logical, s.dispatch)).toThrow("terminal")
    const chat = { ...s.logical, stream: true, upstream: "chat" }
    const total: unknown = null
    const cancelled = { ...s.envelope, attempts: [{ ...attempt, response: { ...attempt.response, totalBytes: total } }] }
    validateSidecar(cancelled, chat, s.dispatch)
    expect(() => validateSidecar(cancelled, { ...chat, scenario: "truncated" }, s.dispatch)).toThrow("terminal")
    const partial = { ...cancelled, attempts: [{ ...cancelled.attempts[0], response: { ...attempt.response, observedBytes: 1, totalBytes: null } }] }
    expect(() => validateSidecar(partial, chat, s.dispatch)).toThrow("Incomplete")
  } finally { s.raw.close() }
})
