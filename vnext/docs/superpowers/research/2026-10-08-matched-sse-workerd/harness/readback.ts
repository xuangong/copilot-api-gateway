// Matched-SSE v1: retain the prior physical ownership/capture oracle while
// deriving sidecar terminal eligibility from independently verified upstream wire.
import { readFileSync } from "node:fs"
import { sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { parseWireResponse } from "../../2026-10-02-workerd-deployed-comparison/harness/wire"
import { canonicalDumpOracle, dumpStatusEvidence, validateSidecar, verifyWireEvidence, type Database, type Bucket, type LogicalDump, type DumpState, type CaptureFidelity } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import type { Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { verifyMatchedDispatch } from "./contracts"
export type { Database, Bucket, LogicalDump, DumpState } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored dump object")
  return value as Obj
}
interface Descriptor { key: string; type: string; version?: number }
interface SqlDump {
  key_id: string; id: string; meta_json: string
  request_body_descriptor: string | null; response_body_descriptor: string | null
  upstream_exchanges_descriptor: string | null
}

/** Never infer upstream transport from the client's rendering preference. */
export function validateMatchedSidecar(input: unknown, row: LogicalDump, dispatch: Dispatch): void {
  if (row.variant !== "B" || row.id !== dispatch.id || row.protocol !== "chat" || row.upstream !== "chat" || row.scenario !== "ok"
    || row.status !== 200 || row.ok !== true || row.transportCompleted !== true || row.bytes !== 65536
    || dispatch.protocol !== "chat" || dispatch.method !== "POST" || dispatch.upstreamId !== "custom:architecture-chat") throw new Error("Matched sidecar scope mismatch")
  verifyMatchedDispatch(dispatch)
  // This transient policy input is used only by the historical sidecar validator.
  // Original rows, canonical JSON semantics and persisted evidence stay unchanged.
  // Its exact prefix/observedBytes/terminal/total checks remain authoritative.
  validateSidecar(input, { ...row, stream: dispatch.requestedStream }, dispatch)
}

function differences(stored: unknown, wire: unknown, path = ""): unknown[] {
  if (JSON.stringify(stored) === JSON.stringify(wire)) return []
  if (stored && wire && typeof stored === "object" && typeof wire === "object" && Array.isArray(stored) === Array.isArray(wire)) {
    const a = stored as Obj, b = wire as Obj
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => !Object.hasOwn(a, key) || !Object.hasOwn(b, key)
      ? [{ path: `${path}/${key}`, storedPresent: Object.hasOwn(a, key), wirePresent: Object.hasOwn(b, key), stored: a[key] ?? null, wire: b[key] ?? null }]
      : differences(a[key], b[key], `${path}/${key}`))
  }
  return [{ path, stored, wire }]
}

/** Renderer catch frames are appended after canonical capture, with exact protocol-specific payloads. */
function appendedError(input: unknown, protocol: string) {
  const object = (value: unknown): Obj | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null
  const keys = (value: Obj, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
  const message = (value: unknown) => typeof value === "string" && value.trim().length > 0
  const event = object(input)
  if (!event) return false
  if (protocol === "responses") return keys(event, ["type", "message"]) && event.type === "error" && message(event.message)
  const error = object(event.error)
  if (!error) return false
  if (protocol === "chat") return keys(event, ["error"]) && keys(error, ["message"]) && message(error.message)
  if (protocol === "messages") return keys(event, ["type", "error"]) && event.type === "error" && keys(error, ["type", "message"]) && error.type === "api_error" && message(error.message)
  return false
}

/** Physical readback deliberately bypasses numeric-zero history visibility. */
export async function readDumps(db: Database, bucket: Bucket, logical: LogicalDump[], dispatches: Dispatch[], state: DumpState, variant: "B") {
  const schema = (await db.prepare("PRAGMA table_info(dump_records)").all<{ name: string }>()).results
  if (schema.some(column => column.name === "upstream_exchanges_descriptor") !== (variant === "B")) throw new Error("Declared A/B dump schema mismatch")
  const columns = "key_id,id,meta_json,request_body_descriptor,response_body_descriptor" + (variant === "B" ? ",upstream_exchanges_descriptor" : "")
  const rows = (await db.prepare(`SELECT ${columns} FROM dump_records ORDER BY id`).all<SqlDump>()).results
  const files = (await db.prepare("SELECT file_key,owner_kind,owner_key,state FROM spilled_files").all<{ file_key: string; owner_kind: string; owner_key: string; state: string }>()).results
  const r2 = await bucket.list({ limit: 1000 })
  if (r2.truncated || rows.length > 1000 || rows.length !== logical.length) throw new Error(`Dump SQL cardinality mismatch ${rows.length}/${logical.length}`)
  const requested = new Map(logical.map(row => [row.dumpRecordId, row]))
  if (requested.has(null) || requested.size !== logical.length) throw new Error("Missing or repeated X-Dump-Record-Id")
  const owned = new Map(files.map(file => [file.file_key, file]))
  const inventory = new Map(r2.objects.map(value => [value.key, value.size]))
  const references = new Set<string>()
  const newRecords: unknown[] = []
  const descriptor = (raw: string | null, type: string): Descriptor | null => {
    if (raw === null) return null
    const value = obj(JSON.parse(raw))
    if (typeof value.key !== "string" || !value.key.startsWith("dumps/v1/architecture-key/") || value.type !== type) throw new Error("Invalid dump descriptor")
    if (type === "upstreamExchanges" && value.version !== 1) throw new Error("Unknown upstream sidecar version")
    return value as unknown as Descriptor
  }
  for (const stored of rows) {
    const row = requested.get(stored.id)
    if (!row || stored.key_id !== "architecture-key") throw new Error("Unmatched physical dump row")
    if (row.phase !== undefined || row.wireEvidence !== undefined) verifyWireEvidence(row)
    const meta = obj(JSON.parse(stored.meta_json))
    const statusEvidence = dumpStatusEvidence({ ...row, variant }, meta.status, meta.error)
    if (meta.id !== stored.id || meta.method !== "POST" || meta.path !== (row.protocol === "responses" ? "/v1/responses" : row.protocol === "messages" ? "/v1/messages" : "/v1/chat/completions") || !statusEvidence.accepted || meta.requestBytes !== row.wireBytes) throw new Error(`Dump metadata mismatch ${row.id}`)
    const req = descriptor(stored.request_body_descriptor, "bytes")
    const parsedResponse = stored.response_body_descriptor ? obj(JSON.parse(stored.response_body_descriptor)) : null
    const resp = descriptor(stored.response_body_descriptor, parsedResponse?.type === "events" ? "events" : "bytes")
    const up = variant === "B" ? descriptor(stored.upstream_exchanges_descriptor, "upstreamExchanges") : null
    if (!req || !resp || variant === "B" && !up) throw new Error(`Missing fixture dump body/sidecar ${row.id}`)
    let canonicalEvidence: unknown = null
    let captureFidelity: CaptureFidelity | null = null
    const objects: { side: string; key: string; type: string; compressedBytes: number; decodedBytes: number; sha256: string }[] = []
    for (const [side, value] of [["request", req], ["response", resp], ["upstream", up]] as const) {
      if (!value) continue
      if (references.has(value.key)) throw new Error("Shared dump object ownership")
      references.add(value.key)
      const file = owned.get(value.key)
      const ownerKind = side === "upstream" ? "dump-upstream" : `dump-${side}`
      if (!file || file.state !== "owned" || file.owner_kind !== ownerKind || file.owner_key !== JSON.stringify(["architecture-key", stored.id]) || !inventory.has(value.key)) throw new Error(`Dump ownership/object mismatch ${row.id}/${side}`)
      if (state.checked.has(stored.id)) continue
      const object = await bucket.get(value.key)
      if (!object) throw new Error("Referenced R2 dump object missing")
      const compressed = new Uint8Array(await object.arrayBuffer())
      if (compressed.byteLength !== inventory.get(value.key)) throw new Error("R2 readback size mismatch")
      const decoded = Bun.gunzipSync(compressed)
      objects.push({ side, key: value.key, type: value.type, compressedBytes: compressed.byteLength, decodedBytes: decoded.byteLength, sha256: sha(decoded) })
      if (side === "request") {
        if (decoded.byteLength !== row.wireBytes || sha(decoded) !== row.requestSha256) throw new Error(`Dump request digest mismatch ${row.id}`)
      } else if (side === "response") {
        const fidelity = (passed: boolean, classification: CaptureFidelity["classification"], errors: string[], details: Record<string, unknown> = {}): CaptureFidelity => ({ comparator: "response-frame-fidelity-v1", passed, classification, errors, storedSha256: sha(decoded), wireSha256: row.responseSha256, evidence: { wireEvidence: row.wireEvidence ?? "", responseKey: value.key, responseType: value.type }, details })
        if (value.type === "bytes") {
          if (row.phase !== undefined || row.wireEvidence !== undefined) {
            const storedBody = parseWireResponse(new TextDecoder("utf-8", { fatal: true }).decode(decoded))
            if (storedBody.format !== parseWireResponse(String(obj(JSON.parse(readFileSync(row.wireEvidence ?? "", "utf8"))).response)).format) throw new Error("Stored response format mismatch")
          }
          const passed = sha(decoded) === row.responseSha256
          captureFidelity = fidelity(passed, passed ? "exact_wire_bytes" : "wire_bytes_mismatch", passed ? [] : [`Dump response digest mismatch ${row.id}`])
        } else {
          const events: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded))
          if (!Array.isArray(events)) throw new Error("Dump frame log is not an array")
          const data: unknown[] = []
          let done = false
          for (const event of events) {
            const entry = obj(event), frame = obj(entry.frame)
            if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts) || entry.ts < 0) throw new Error("Invalid dump frame timestamp")
            if (frame.type === "event") {
              const event = obj(frame.event)
              if (!(typeof event.type === "string" && event.type.length > 0) && !Array.isArray(event.choices)) throw new Error("Invalid stored protocol event")
              data.push(event)
            }
            else if (frame.type === "done") done = true
            else throw new Error("Invalid stored protocol frame")
          }
          const result = canonicalDumpOracle({ ...row, variant }, data, done, meta.error)
          canonicalEvidence = { wireOraclePassed: row.ok, canonicalOraclePassed: result.ok, errors: result.errors, classification: result.classification, protocol: row.stream ? row.protocol : row.upstream }
          if (row.stream) {
            if (!Array.isArray(row.wireEvents)) throw new Error("Missing independent parsed wire evidence")
            const exactFrames = JSON.stringify(data) === JSON.stringify(row.wireEvents) && done === row.wireDone
            const extra = row.wireEvents.slice(data.length)
            const error = meta.error === undefined || meta.error === null ? null : obj(meta.error)
            const appendedFailure = !exactFrames && ["failed", "truncated"].includes(row.scenario) && error?.kind === "failed"
              && typeof error.reason === "string" && error.reason.trim().length > 0
              && JSON.stringify(data) === JSON.stringify(row.wireEvents.slice(0, data.length))
              && extra.length === 1 && appendedError(extra[0], row.protocol)
              && done === row.wireDone
            const passed = exactFrames || appendedFailure
            captureFidelity = fidelity(passed, exactFrames ? "exact_wire_frames" : appendedFailure ? "renderer_appended_error" : "frame_value_mismatch", passed ? [] : [`Canonical/wire frame fidelity mismatch ${row.id}`], {
              storedEventsSha256: sha(JSON.stringify(data)), wireEventsSha256: sha(JSON.stringify(row.wireEvents)), storedDone: done, wireDone: row.wireDone,
              differences: passed ? [] : differences(data, row.wireEvents),
            })
          } else captureFidelity = fidelity(result.ok, result.ok ? "canonical_source_semantics" : "canonical_semantics_mismatch", result.ok ? [] : [`Canonical upstream semantics mismatch ${row.id}: ${result.errors.join(",")}`])

        }
        if (!captureFidelity) throw new Error("Missing capture fidelity result")
        if (row.phase !== "matrix" && !captureFidelity.passed) throw new Error(captureFidelity.errors.join(","))

      } else {
        const actual = dispatches.filter(dispatch => dispatch.id === row.id)
        if (actual.length !== 1) throw new Error("Native sidecar requires exactly one independent dispatch")
        const dispatch = actual[0]
        if (!dispatch) throw new Error("Missing fixture dispatch")
        validateMatchedSidecar(JSON.parse(new TextDecoder().decode(decoded)), row, dispatch)
      }
    }
    if (!state.checked.has(stored.id)) {
      if (!captureFidelity) throw new Error("Missing capture fidelity result")
      state.checked.add(stored.id)
      newRecords.push({ logicalId: row.id, recordId: stored.id, status: row.status, statusEvidence, canonicalEvidence, captureFidelity, objects, metadataSha256: sha(stored.meta_json) })
    }
  }
  if (inventory.size !== references.size || files.length !== references.size) throw new Error("Unexpected unreferenced/staged R2 dump files")
  return { checkedRecords: state.checked.size, sqlRows: rows.length, ownedObjects: references.size, newRecords, r2Objects: inventory.size }
}
