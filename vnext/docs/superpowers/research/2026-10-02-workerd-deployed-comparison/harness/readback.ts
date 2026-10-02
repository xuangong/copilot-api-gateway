// Adapted from the previous canonical reader; explicit A/B schemas and no A refusal-status exemption.
import { createHash } from "node:crypto"
import type { Variant } from "./types.ts"
import { oracle } from "./oracle.ts"

type Obj = Record<string, unknown>
export interface Database { prepare(sql: string): { all<T>(): Promise<{ results: T[] }> } }
export interface Bucket { list(options: { limit: number }): Promise<{ truncated: boolean; objects: { key: string; size: number }[] }>; get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> }
const obj = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored dump object")
  return value as Obj
}
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
interface Descriptor { key: string; type: string; version?: number }
interface SqlDump {
  upstream_id?: string; key_id: string; id: string; meta_json: string
  request_body_descriptor: string | null; response_body_descriptor: string | null
  upstream_exchanges_descriptor: string | null
}
export interface LogicalDump {
  variant?: Variant; id: string; dumpRecordId: string | null; requestSha256: string; responseSha256: string
  protocol: string; upstream: string; scenario: string; bytes: number; stream: boolean
  wireEvents?: unknown[]; wireDone?: boolean; status: number; wireBytes: number; responseBytes: number; ok: boolean
  classification?: string
  transportCompleted?: boolean
}
export interface CapturedDispatch {
  id: string; status?: number; protocol?: string; bodyBytes: number; requestPrefixSha256: string
  responseBytes: number; responsePrefixSha256: string
  responsePrefixBase64: string
}
export interface DumpState { checked: Set<string> }

export function dumpStatusEvidence(row: LogicalDump, dumpStatus: unknown, metadataError?: unknown) {
  const error = metadataError === undefined || metadataError === null ? null : obj(metadataError)
  const inheritedRefusal = row.variant === "B" && row.ok && row.transportCompleted === true && row.classification === "expected_refusal" && row.protocol === "responses"
    && row.upstream === "messages" && row.scenario === "refusal" && !row.stream
    && row.status === 200 && dumpStatus === 502 && error?.kind === "failed"
    && typeof error.reason === "string" && error.reason.trim().length > 0
  const classification = dumpStatus === row.status ? "matching_wire_status"
    : inheritedRefusal ? "inherited_json_policy_refusal_dump_failure_status" : "status_mismatch"
  return { accepted: classification !== "status_mismatch", wireStatus: row.status, dumpStatus, classification }
}

/** JSON capture observes source frames; SSE capture observes translated egress. */
export function canonicalDumpOracle(row: LogicalDump, data: unknown[], done: boolean, metadataError?: unknown) {
  const error = metadataError === undefined || metadataError === null ? null : obj(metadataError)
  const failureRecorded = error?.kind === "failed" && typeof error.reason === "string" && error.reason.trim().length > 0
  const canonical = { wireStream: row.stream, failureRecorded }
  const expectedProtocol = row.stream ? row.protocol : row.upstream
  const protocols = new Set(data.flatMap(value => {
    const event = obj(value), type = String(event.type ?? "")
    return type.startsWith("response.") ? ["responses"]
      : ["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop"].includes(type) ? ["messages"]
      : Array.isArray(event.choices) ? ["chat"] : []
  }))
  if (protocols.size !== 1 || !protocols.has(expectedProtocol)) return { ok: false, errors: [`Stored canonical protocol mismatch ${row.id}: ${[...protocols].join(",")}/${expectedProtocol}`], classification: "canonical_protocol_mismatch" }
  if (!row.stream && expectedProtocol === "responses") {
    // Native JSON projects complete output items without incremental deltas.
    // Validate every full terminal result, including exact terminal cardinality,
    // output/refusal/tool identity and arguments, usage and success/fault policy.
    const results = data.flatMap(value => {
      const event = obj(value)
      return ["response.completed", "response.failed", "response.incomplete"].includes(String(event.type)) ? [obj(event.response)] : []
    })
    return oracle(row.status, results, false, { ...row, protocol: expectedProtocol, stream: false }, canonical)
  }
  return oracle(row.status, data, done, { ...row, protocol: expectedProtocol, stream: true }, canonical)
}

/** Physical readback deliberately bypasses numeric-zero history visibility. */
export async function readDumps(db: Database, bucket: Bucket, logical: LogicalDump[], dispatches: CapturedDispatch[], state: DumpState, variant: Variant) {
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
    const meta = obj(JSON.parse(stored.meta_json))
    const statusEvidence = dumpStatusEvidence({ ...row, variant }, meta.status, meta.error)
    if (meta.id !== stored.id || meta.method !== "POST" || meta.path !== (row.protocol === "responses" ? "/v1/responses" : row.protocol === "messages" ? "/v1/messages" : "/v1/chat/completions") || !statusEvidence.accepted || meta.requestBytes !== row.wireBytes) throw new Error(`Dump metadata mismatch ${row.id}`)
    const req = descriptor(stored.request_body_descriptor, "bytes")
    const parsedResponse = stored.response_body_descriptor ? obj(JSON.parse(stored.response_body_descriptor)) : null
    const resp = descriptor(stored.response_body_descriptor, parsedResponse?.type === "events" ? "events" : "bytes")
    const up = variant === "B" ? descriptor(stored.upstream_exchanges_descriptor, "upstreamExchanges") : null
    if (!req || row.responseBytes > 0 && !resp || variant === "B" && !up) throw new Error(`Missing fixture dump body/sidecar ${row.id}`)
    let canonicalEvidence: unknown = null
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
        if (value.type === "bytes") {
          if (sha(decoded) !== row.responseSha256) throw new Error(`Dump response digest mismatch ${row.id}`)
        } else {
          const events: unknown = JSON.parse(new TextDecoder().decode(decoded))
          if (!Array.isArray(events)) throw new Error("Dump frame log is not an array")
          const data: unknown[] = []
          let done = false
          for (const event of events) {
            const entry = obj(event), frame = obj(entry.frame)
            if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts) || entry.ts < 0) throw new Error("Invalid dump frame timestamp")
            if (frame.type === "event") data.push(frame.event)
            else if (frame.type === "done") done = true
            else throw new Error("Invalid stored protocol frame")
          }
          const result = canonicalDumpOracle({ ...row, variant }, data, done, meta.error)
          canonicalEvidence = { wireOraclePassed: row.ok, canonicalOraclePassed: result.ok, errors: result.errors, classification: result.classification, protocol: row.stream ? row.protocol : row.upstream }
          if (row.stream) {
            if (!Array.isArray(row.wireEvents)) throw new Error("Missing independent parsed wire evidence")
            const exactFrames = JSON.stringify(data) === JSON.stringify(row.wireEvents) && done === row.wireDone
            const extra = row.wireEvents.slice(data.length)
            const appendedFailure = ["failed", "truncated"].includes(row.scenario) && obj(meta.error).kind === "failed"
              && JSON.stringify(data) === JSON.stringify(row.wireEvents.slice(0, data.length))
              && extra.length === 1 && obj(extra[0]).type === "error" && typeof obj(extra[0]).message === "string"
              && done === row.wireDone
            if (!exactFrames && !appendedFailure) throw new Error(`Canonical/wire frame fidelity mismatch ${row.id}`)
          } else if (!result.ok) throw new Error(`Canonical upstream semantics mismatch ${row.id}: ${result.errors.join(",")}`)

        }
      } else {
        const actual = dispatches.filter(dispatch => dispatch.id === row.id)
        if (actual.length !== 1) throw new Error("Native sidecar requires exactly one independent dispatch")
        const dispatch = actual[0]
        if (!dispatch) throw new Error("Missing fixture dispatch")
        validateSidecar(JSON.parse(new TextDecoder().decode(decoded)), row, dispatch)
      }
    }
    if (!state.checked.has(stored.id)) {
      state.checked.add(stored.id)
      newRecords.push({ logicalId: row.id, recordId: stored.id, status: row.status, statusEvidence, canonicalEvidence, objects, metadataSha256: sha(stored.meta_json) })
    }
  }
  if (inventory.size !== references.size || files.length !== references.size) throw new Error("Unexpected unreferenced/staged R2 dump files")
  return { checkedRecords: state.checked.size, sqlRows: rows.length, ownedObjects: references.size, newRecords, r2Objects: inventory.size }
}

/** Exact cancellation groups are source-audited in sidecar-terminal-audit.md. */
export function validateSidecar(input: unknown, row: LogicalDump, dispatch: CapturedDispatch) {
  const envelope = obj(input)
  if (envelope.version !== 1 || envelope.representation !== "fetch-body" || !Array.isArray(envelope.attempts) || envelope.attempts.length !== 1 || envelope.omittedAttempts !== 0 || envelope.metadataTruncated !== false) throw new Error("Invalid native upstream capture envelope")
  const attempt = obj(envelope.attempts[0])
  const operation = dispatch.protocol === "chat" ? "chat.completions" : dispatch.protocol === "messages" ? "messages.create" : "responses.create"
  if (attempt.method !== "POST" || attempt.operation !== operation || attempt.status !== dispatch.status || attempt.representation !== "fetch-body" || attempt.url !== "url_omitted" || attempt.errorCategory !== null || attempt.order !== 0
    || typeof attempt.id !== "string" || typeof attempt.parentCallId !== "string" || typeof attempt.upstreamId !== "string"
    || typeof attempt.startedOffsetMs !== "number" || !Number.isFinite(attempt.startedOffsetMs) || attempt.startedOffsetMs < 0
    || typeof attempt.completedOffsetMs !== "number" || !Number.isFinite(attempt.completedOffsetMs) || attempt.completedOffsetMs < attempt.startedOffsetMs) throw new Error("Native attempt metadata mismatch")
  let capturedBytes = 0
  for (const [name, cap, actualBytes, expectedSha] of [["request", 65536, dispatch.bodyBytes, dispatch.requestPrefixSha256], ["response", 262144, dispatch.responseBytes, dispatch.responsePrefixSha256]] as const) {
    const capture = obj(attempt[name])
    if (typeof capture.prefixBase64 !== "string") throw new Error("Invalid upstream prefix")
    const prefix = Buffer.from(capture.prefixBase64, "base64")
    if (prefix.toString("base64") !== capture.prefixBase64 || capture.capturedBytes !== prefix.byteLength || prefix.byteLength !== Math.min(cap, actualBytes) || capture.observedBytes !== actualBytes || sha(prefix) !== expectedSha || capture.truncated !== (actualBytes > prefix.byteLength)) throw new Error("Incomplete/different native upstream body")
    capturedBytes += prefix.byteLength
    if (name === "request") {
      if (capture.source !== "prepared" || capture.totalBytes !== actualBytes) throw new Error("Prepared upstream request mismatch")
    } else {
      const cancellable = row.stream && (row.scenario === "failed" || row.upstream === "chat" && ["ok", "tool", "refusal", "slow"].includes(row.scenario))
      if (capture.source !== "fetch-body" || (capture.terminal === "eof" ? capture.totalBytes !== actualBytes : !cancellable || capture.terminal !== "cancelled" || capture.totalBytes !== null)) throw new Error("Unexpected upstream terminal/total")
    }
  }
  if (envelope.capturedBodyBytes !== capturedBytes || capturedBytes > 1048576 || typeof envelope.metadataBytes !== "number" || envelope.metadataBytes < 0 || envelope.metadataBytes > 65536) throw new Error("Native capture budget mismatch")
}
