import { test, expect } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { readDumps, type Bucket, type Database, type LogicalDump } from "./readback.ts"
import { sha } from "./manifest.ts"

interface CapturedFixture {
  name: string
  requestTemplate: string
  payloadBytes: number
  wireResponse: string
  row: LogicalDump
  record: { key_id: string; id: string; meta_json: string; request_body_descriptor: string; response_body_descriptor: string }
  storedFrames: { frame: { type: string; event?: Record<string, unknown> }; ts: number }[]
}
// Exact decoded D1/R2 frames and independent wire rows from formal-01 A-matrix.
// Only the repeated request padding is represented by a lossless template.
const captured = JSON.parse(readFileSync(new URL("./matrix-reader-fixtures.json", import.meta.url), "utf8")) as CapturedFixture[]
function storage(name: string) {
  const original = captured.find(fixture => fixture.name === name)
  if (!original) throw new Error(`Missing captured fixture ${name}`)
  const fixture = structuredClone(original)
  const raw = new Sqlite(":memory:")
  raw.run("CREATE TABLE dump_records(key_id TEXT,id TEXT,meta_json TEXT,request_body_descriptor TEXT,response_body_descriptor TEXT)")
  raw.run("CREATE TABLE spilled_files(file_key TEXT,owner_kind TEXT,owner_key TEXT,state TEXT)")
  const request = fixture.requestTemplate.replace("{{FIXTURE_PAYLOAD}}", "x".repeat(fixture.payloadBytes))
  const record = fixture.record
  raw.run("INSERT INTO dump_records VALUES(?,?,?,?,?)", [record.key_id, record.id, record.meta_json, record.request_body_descriptor, record.response_body_descriptor])
  const objects = new Map<string, Uint8Array>()
  for (const [side, descriptor, body] of [["request", record.request_body_descriptor, request], ["response", record.response_body_descriptor, JSON.stringify(fixture.storedFrames)]] as const) {
    const { key } = JSON.parse(descriptor) as { key: string }
    objects.set(key, Bun.gzipSync(body))
    raw.run("INSERT INTO spilled_files VALUES(?,?,?,?)", [key, `dump-${side}`, JSON.stringify([record.key_id, record.id]), "owned"])
  }
  const db: Database = { prepare: sql => ({ async all<T>() { return { results: raw.query(sql).all() as T[] } } }) }
  const bucket: Bucket = { async list() { return { truncated: false, objects: [...objects].map(([key, bytes]) => ({ key, size: bytes.byteLength })) } }, async get(key) { const bytes = objects.get(key); return bytes ? { async arrayBuffer() { return Uint8Array.from(bytes).buffer } } : null } }
  const read = () => readDumps(db, bucket, [fixture.row], [], { checked: new Set() }, "A")
  const metadataError = (error: unknown) => raw.run("UPDATE dump_records SET meta_json=?", [JSON.stringify({ ...JSON.parse(record.meta_json), error })])
  return { fixture, raw, request, read, metadataError }
}

test("actual truncated A_33 exact frames accept null metadata error", async () => {
  const s = storage("A_33")
  try {
    expect(sha(s.request)).toBe(s.fixture.row.requestSha256)
    expect(Buffer.byteLength(s.request)).toBe(s.fixture.row.wireBytes)
    expect(sha(s.fixture.wireResponse)).toBe(s.fixture.row.responseSha256)
    expect(JSON.parse(s.fixture.record.meta_json).error).toBeNull()
    expect(s.fixture.row.ok).toBe(true)
    expect((await s.read()).checkedRecords).toBe(1)
  } finally { s.raw.close() }
})

test("actual chat and messages catch frames match each protocol's appended error shape", async () => {
  for (const name of ["A_87", "A_129"]) {
    const s = storage(name)
    try {
      expect(sha(s.request)).toBe(s.fixture.row.requestSha256)
      expect(sha(s.fixture.wireResponse)).toBe(s.fixture.row.responseSha256)
      expect((await s.read()).checkedRecords).toBe(1)
    } finally { s.raw.close() }
  }
})

test("appended errors cannot waive protocol shape, exact prefix, cardinality, done or source scope", async () => {
  for (const name of ["A_87", "A_129"]) {
    for (const mutation of ["wrong_protocol", "empty_message", "extra_field", "two_errors", "changed_prefix", "changed_done", "no_failure_metadata", "empty_failure_reason", "unrelated_scenario"]) {
      const s = storage(name)
      try {
        const row = s.fixture.row
        const events = row.wireEvents
        if (!events) throw new Error("Captured wire events absent")
        const error = events.at(-1) as Record<string, unknown>
        if (mutation === "wrong_protocol") events[events.length - 1] = { type: "error", message: "Synthetic partial failure" }
        else if (mutation === "empty_message") (error.error as Record<string, unknown>).message = " "
        else if (mutation === "extra_field") error.unexpected = true
        else if (mutation === "two_errors") events.push(structuredClone(error))
        else if (mutation === "changed_prefix") events[0] = { changed: true }
        else if (mutation === "changed_done") row.wireDone = !row.wireDone
        else if (mutation === "no_failure_metadata") s.metadataError(null)
        else if (mutation === "empty_failure_reason") s.metadataError({ kind: "failed", reason: " " })
        else if (mutation === "unrelated_scenario") row.scenario = "ok"
        await expect(s.read()).rejects.toThrow("Canonical/wire frame fidelity mismatch")
      } finally { s.raw.close() }
    }
  }
})

test("actual A_53 mutable early output remains a strict capture fidelity failure", async () => {
  const s = storage("A_53")
  try {
    const stored = s.fixture.storedFrames[0]?.frame.event?.response as { output: unknown[] }
    const wire = s.fixture.row.wireEvents?.[0] as { response: { output: unknown[] } }
    expect(stored.output.length).toBe(1)
    expect(wire.response.output.length).toBe(0)
    await expect(s.read()).rejects.toThrow("Canonical/wire frame fidelity mismatch")
  } finally { s.raw.close() }
})
