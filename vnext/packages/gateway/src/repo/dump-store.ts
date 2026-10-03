// Ported from copilot-gateway/src/repo/dump-store.ts.
//
// vNext adjustments:
//   - No `deleted_at` on api_keys — vNext api_keys table has no soft-delete
//     column, so the JOIN drops the `AND k.deleted_at IS NULL` clause; the
//     "inactive" branch of `deleteExpiredBatch` is removed for the same
//     reason (a key row cannot be "logically deleted but still present").
//   - No `color` column on upstreams — `hydrateUpstream` no longer reads or
//     validates a color; `DumpUpstreamRef` has no color field.
//   - `provider` (not `kind`) is the vNext upstreams column name. The type is
//     `UpstreamKind` from protocols-llm/common; anything else in the row
//     falls back to 'custom' (the vNext catch-all).

import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from "../shared/dump/spilled-files-policy.ts"
import { safeUpstreamExchangesForPersistence } from "../shared/dump/upstream-attempts.ts"
import type { UpstreamExchanges } from "../shared/dump/upstream-attempts.ts"
import type { DumpListOptions, DumpStore } from "../shared/dump/store-contract.ts"
import type {
  DumpMetadata,
  DumpRecordId,
  DumpStreamEvent,
  DumpUpstreamRef,
  DumpWriteRecord,
  DumpWriteResponseBody,
  PreparedDumpRequestBody,
  StoredDumpRecord,
  StoredDumpRequest,
  StoredDumpResponse,
  StoredDumpResponseBody,
} from "../shared/dump/types.ts"
import type { FileProvider, SqlDatabase } from "@vibe-core/platform"
import type { UpstreamKind } from "@vibe-llm/protocols/common"
import type { UpstreamId, ApiKeyId } from "./branded-ids.ts"

const HOUR_MS = 60 * 60 * 1000

interface BodyDescriptor {
  key: string
  type: "bytes" | "events" | "upstreamExchanges"
}

interface DumpRow {
  upstream_id: string | null
  upstream_name: string | null
  upstream_provider: string | null
  meta_json: string
  request_headers_json: string
  response_headers_json: string | null
  request_body_descriptor: string | null
  response_body_descriptor: string | null
  upstream_exchanges_descriptor: string | null
}

const KNOWN_UPSTREAM_KINDS: Readonly<Record<UpstreamKind, true>> = {
  copilot: true,
  custom: true,
  azure: true,
  sdf: true,
  codex: true,
  "claude-code": true,
}

// A null `upstream_id` means no upstream was identified at capture time
// (auth/validation reject, no candidate matched); a non-null id with a null
// joined `upstream_name` means the referenced upstream was since deleted.
// Any provider value the schema doesn't recognize falls through to 'custom'
// so a bad row doesn't poison every read.
const hydrateUpstream = (row: Pick<DumpRow, "upstream_id" | "upstream_name" | "upstream_provider">): DumpUpstreamRef | null => {
  if (row.upstream_id === null || row.upstream_name === null) return null
  const kind: UpstreamKind = row.upstream_provider !== null && Object.hasOwn(KNOWN_UPSTREAM_KINDS, row.upstream_provider)
    ? (row.upstream_provider as UpstreamKind)
    : "custom"
  return { id: row.upstream_id as UpstreamId, name: row.upstream_name, kind }
}

const hourBucket = (ms: number): string => {
  const date = new Date(Math.floor(ms / HOUR_MS) * HOUR_MS)
  const y = date.getUTCFullYear().toString().padStart(4, "0")
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0")
  const d = date.getUTCDate().toString().padStart(2, "0")
  const h = date.getUTCHours().toString().padStart(2, "0")
  return `${y}${m}${d}${h}`
}

const bodyPath = (keyId: string, bucket: string, recordId: string, side: "req" | "resp" | "up"): string =>
  `${DUMP_FILE_PREFIX}${keyId}/${bucket}/${recordId}-${crypto.randomUUID()}.${side}.gz`

const ownedCompressedBytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer)

// Keep input preparation synchronous. The output reaction owns only the
// compressed buffer; the stream still owns its pending input.
const gzip = (input: Uint8Array | string, ownership: "borrowed" | "transferred" = "borrowed"): Promise<Uint8Array> => {
  try {
    // Both sinks below reject a SharedArrayBuffer-backed view; nothing in the
    // gateway ever produces one, so narrow once here instead of at each call.
    const part = input as Uint8Array<ArrayBuffer> | string
    if (typeof CompressionStream !== "undefined") {
      // Transferred byte inputs are private immutable snapshots or fresh owned
      // buffers. Borrowed bytes retain Blob's synchronous input snapshot.
      const source = typeof part === "string" || ownership === "borrowed"
        ? new Blob([part]).stream()
        : new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(part); controller.close() } })
      return new Response(source.pipeThrough(new CompressionStream("gzip")))
        .arrayBuffer().then(ownedCompressedBytes)
    }
    const bytes = typeof part === "string" ? new TextEncoder().encode(part) : part
    return Promise.resolve(Bun.gzipSync(bytes))
  } catch (error) { return Promise.reject(error) }
}

const gunzip = async (input: Uint8Array): Promise<Uint8Array> => {
  const bytes = input as Uint8Array<ArrayBuffer>
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")))
    return new Uint8Array(await stream.arrayBuffer())
  }
  return Bun.gunzipSync(bytes)
}

interface PreparedDumpWrite {
  keyId: ApiKeyId
  recordId: DumpRecordId
  completedAt: number
  upstreamId: UpstreamId | null
  metaJson: string
  requestHeadersJson: string
  responseHeadersJson: string | null
  requestFileKey: string | null
  responseFileKey: string | null
  upstreamFileKey: string | null
  requestDescriptorJson: string | null
  responseDescriptorJson: string | null
  upstreamDescriptorJson: string | null
  bodies: [Uint8Array | null, Uint8Array | null, Uint8Array | null]
}

type StagedDumpFile = { fileKey: string; ownerKind: string }

interface DumpPreparation {
  prepared: PreparedDumpWrite
  upstreamExchanges: UpstreamExchanges | null
  requestBody: PreparedDumpRequestBody | null
  responseBody: DumpWriteResponseBody | null
}

// This synchronous boundary is the only preparation scope that sees the raw
// record. Snapshot borrowed identity bytes before any asynchronous sidecar work;
// prepared gzip bytes already follow the immutable preparation contract.
const createDumpPreparation = (keyId: ApiKeyId, record: DumpWriteRecord): DumpPreparation => {
  const { upstream, ...metaToStore } = record.meta
  const recordId = metaToStore.id
  const completedAt = metaToStore.completedAt
  const bucket = hourBucket(completedAt)
  const requestBody = record.request.body
  const responseBody = record.response.body
  const metaJson = JSON.stringify(metaToStore)
  const requestHeadersJson = JSON.stringify(record.request.headers)
  const responseHeadersJson = responseBody.type === "none" ? null : JSON.stringify(record.response.headers)
  const requestFileKey = requestBody.decodedByteLength === 0 ? null : bodyPath(keyId, bucket, recordId, "req")
  const responseFileKey = responseBody.type === "none"
    || (responseBody.type === "bytes" && responseBody.body.byteLength === 0)
    ? null : bodyPath(keyId, bucket, recordId, "resp")
  return {
    prepared: {
      keyId, recordId, completedAt, upstreamId: upstream?.id ?? null,
      metaJson, requestHeadersJson, responseHeadersJson,
      requestFileKey, responseFileKey, upstreamFileKey: null,
      requestDescriptorJson: requestFileKey === null ? null : JSON.stringify({ key: requestFileKey, type: "bytes" }),
      responseDescriptorJson: responseFileKey === null ? null
        : JSON.stringify({ key: responseFileKey, type: responseBody.type === "stream" ? "events" : "bytes" }),
      upstreamDescriptorJson: null,
      bodies: [null, null, null],
    },
    upstreamExchanges: record.upstreamExchanges ?? null,
    requestBody: requestFileKey === null ? null : {
      encoding: requestBody.encoding,
      bytes: requestBody.encoding === "gzip" ? requestBody.bytes : new Uint8Array(requestBody.bytes),
      decodedByteLength: requestBody.decodedByteLength,
    },
    responseBody: responseFileKey === null ? null : responseBody.type === "bytes"
      ? { type: "bytes", body: responseBody.ownership === "transferred" ? responseBody.body : new Uint8Array(responseBody.body), ownership: "transferred" }
      : responseBody.type === "stream" ? { type: "stream", events: responseBody.events } : null,
  }
}

const omitOptionalBody = (): null => null

const consumeUpstreamBody = (packet: DumpPreparation): Promise<Uint8Array | null> => {
  const envelope = packet.upstreamExchanges
  packet.upstreamExchanges = null
  if (envelope === null) return Promise.resolve(null)
  try {
    return gzip(JSON.stringify(safeUpstreamExchangesForPersistence(envelope)) ?? "").catch(omitOptionalBody)
  } catch { return Promise.resolve(null) }
}

const consumeRequestBody = (packet: DumpPreparation): Promise<Uint8Array | null> => {
  const body = packet.requestBody
  packet.requestBody = null
  if (body === null) return Promise.resolve(null)
  return body.encoding === "gzip" ? Promise.resolve(body.bytes) : gzip(body.bytes, "transferred")
}

const consumeResponseBody = (packet: DumpPreparation): Promise<Uint8Array | null> => {
  const body = packet.responseBody
  packet.responseBody = null
  if (body === null || body.type === "none") return Promise.resolve(null)
  return body.type === "bytes" ? gzip(body.body, "transferred") : gzip(JSON.stringify(body.events) ?? "")
}

const consumeDumpPreparation = async (packet: DumpPreparation): Promise<PreparedDumpWrite> => {
  const prepared = packet.prepared
  try {
    // Keep serial compression and lazy JSON serialization. Each helper takes
    // its raw input out of the packet before entering asynchronous compression.
    prepared.bodies[2] = await consumeUpstreamBody(packet)
    if (prepared.bodies[2] !== null) {
      prepared.upstreamFileKey = bodyPath(prepared.keyId, hourBucket(prepared.completedAt), prepared.recordId, "up")
      prepared.upstreamDescriptorJson = JSON.stringify({ key: prepared.upstreamFileKey, type: "upstreamExchanges", version: 1 })
    }
    prepared.bodies[0] = await consumeRequestBody(packet)
    prepared.bodies[1] = await consumeResponseBody(packet)
    return prepared
  } catch (error) {
    releasePreparedBodies(prepared)
    throw error
  } finally {
    packet.upstreamExchanges = packet.requestBody = packet.responseBody = null
  }
}

const prepareDumpWrite = (keyId: ApiKeyId, record: DumpWriteRecord): Promise<PreparedDumpWrite> => {
  try { return consumeDumpPreparation(createDumpPreparation(keyId, record)) }
  catch (error) { return Promise.reject(error) }
}

const releasePreparedBodies = (prepared: PreparedDumpWrite): void => {
  // Only clear this private packet's slots; never mutate caller bytes/arrays.
  prepared.bodies[0] = prepared.bodies[1] = prepared.bodies[2] = null
}

const putPreparedBody = async (
  files: FileProvider,
  key: string | null,
  prepared: PreparedDumpWrite,
  slot: 0 | 1 | 2,
): Promise<void> => {
  const bytes = prepared.bodies[slot]
  // Each sibling takes its own upload input. A completed fast put must not
  // retain its bytes in the packet while a slower sibling remains in flight.
  prepared.bodies[slot] = null
  if (key !== null && bytes !== null) return files.put(key, bytes)
}

const putPreparedDumpBodies = async (
  files: FileProvider,
  prepared: PreparedDumpWrite,
  upstreamFileKey: string | null,
): Promise<boolean> => {
  try {
    // The async put wrapper converts synchronous provider throws into
    // rejections, so every sibling starts and settles before retirement.
    const [requestPut, responsePut, upstreamPut] = await Promise.allSettled([
      putPreparedBody(files, prepared.requestFileKey, prepared, 0),
      putPreparedBody(files, prepared.responseFileKey, prepared, 1),
      putPreparedBody(files, upstreamFileKey, prepared, 2),
    ])
    if (requestPut.status === "rejected") throw requestPut.reason
    if (responsePut.status === "rejected") throw responsePut.reason
    // Do not carry an optional provider's rejection object into row I/O.
    return upstreamPut.status === "fulfilled"
  } finally {
    releasePreparedBodies(prepared)
  }
}

const stageDumpFiles = async (db: SqlDatabase, prepared: PreparedDumpWrite, keys: StagedDumpFile[]): Promise<void> => {
  await db.prepare(
    `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
     SELECT
       json_extract(value, '$.fileKey'),
       json_extract(value, '$.ownerKind'),
       json_array(?, ?),
       'staged',
       ?
     FROM json_each(?)`,
  ).bind(prepared.keyId, prepared.recordId, Date.now() + SPILLED_FILE_STAGE_GRACE_MS, JSON.stringify(keys)).run()
}

const retireUpstreamFile = async (db: SqlDatabase, prepared: PreparedDumpWrite, fileKey: string): Promise<void> => {
  // Repair a late put's tombstone even when collection removed its stage, and
  // fence the old collector's pending SQL delete without retiring owned data.
  await db.prepare(`INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
    VALUES (?, 'dump-upstream', json_array(?, ?), 'retired', 0)
    ON CONFLICT(file_key) DO UPDATE SET state = 'retired', collect_after = 0, claim_token = NULL, claimed_at = NULL
    WHERE spilled_files.state != 'owned'`)
    .bind(fileKey, prepared.keyId, prepared.recordId).run()
}

const retireDumpFiles = async (db: SqlDatabase, prepared: PreparedDumpWrite, keys: StagedDumpFile[]): Promise<void> => {
  if (keys.length === 0) return
  await db.prepare(`INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
    SELECT json_extract(value, '$.fileKey'), json_extract(value, '$.ownerKind'), json_array(?, ?), 'retired', 0
    FROM json_each(?) WHERE true
    ON CONFLICT(file_key) DO UPDATE SET state = 'retired', collect_after = 0, claim_token = NULL, claimed_at = NULL
    WHERE spilled_files.state != 'owned'`)
    .bind(prepared.keyId, prepared.recordId, JSON.stringify(keys)).run()
}

const insertPreparedDumpRow = async (db: SqlDatabase, prepared: PreparedDumpWrite, sidecar: string | null): Promise<void> => {
  await db.prepare(
    `INSERT INTO dump_records
     (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor, upstream_exchanges_descriptor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    prepared.keyId, prepared.recordId, prepared.completedAt, prepared.upstreamId,
    prepared.metaJson, prepared.requestHeadersJson, prepared.responseHeadersJson,
    prepared.requestDescriptorJson, prepared.responseDescriptorJson, sidecar,
  ).run()
}

const persistPreparedDump = async (db: SqlDatabase, files: FileProvider, prepared: PreparedDumpWrite): Promise<void> => {
  const coreStaged: StagedDumpFile[] = [
    ...(prepared.requestFileKey === null ? [] : [{ fileKey: prepared.requestFileKey, ownerKind: "dump-request" }]),
    ...(prepared.responseFileKey === null ? [] : [{ fileKey: prepared.responseFileKey, ownerKind: "dump-response" }]),
  ]
  let upstreamFileKey = prepared.upstreamFileKey
  let staged = [...coreStaged, ...(upstreamFileKey === null ? [] : [{ fileKey: upstreamFileKey, ownerKind: "dump-upstream" }])]
  try {
    if (staged.length > 0) {
      try {
        await stageDumpFiles(db, prepared, staged)
      } catch (error) {
        if (upstreamFileKey === null) throw error
        // The stage statement is atomic. Retry core staging without the
        // optional key; core staging errors still propagate without uploads.
        upstreamFileKey = null
        prepared.bodies[2] = null
        staged = coreStaged
        if (staged.length > 0) await stageDumpFiles(db, prepared, staged)
      }
    }
    try {
      const upstreamUploaded = await putPreparedDumpBodies(files, prepared, upstreamFileKey)
      let upstreamDescriptor = upstreamFileKey === null ? null : prepared.upstreamDescriptorJson
      if (upstreamFileKey !== null && !upstreamUploaded) {
        upstreamDescriptor = null
        try { await retireUpstreamFile(db, prepared, upstreamFileKey) }
        catch { /* keep the canonical dump independent of the sidecar */ }
      }
      // Files precede the row; after all puts settle this scope retains only
      // descriptor/metadata strings, never body bytes or the caller's record.
      try {
        await insertPreparedDumpRow(db, prepared, upstreamDescriptor)
      } catch (error) {
        if (upstreamDescriptor === null || upstreamFileKey === null) throw error
        // A slow optional put can outlive its stage. Retry the canonical row
        // without that descriptor and keep the orphan sidecar collectible.
        try { await retireUpstreamFile(db, prepared, upstreamFileKey) } catch { /* optional cleanup */ }
        await insertPreparedDumpRow(db, prepared, null)
      }
    } catch (error) {
      await retireDumpFiles(db, prepared, staged)
      throw error
    }
  } finally {
    // Also release prepared bytes if staging itself fails before any upload.
    releasePreparedBodies(prepared)
  }
}

const persistDumpWith = (db: SqlDatabase, files: FileProvider) =>
  (prepared: PreparedDumpWrite): Promise<void> => persistPreparedDump(db, files, prepared)

const fetchBody = async (files: FileProvider, descriptor: BodyDescriptor): Promise<Uint8Array> => {
  const got = await files.get(descriptor.key)
  if (!got) throw new Error(`dump body missing for key=${descriptor.key}`)
  const gz = new Uint8Array(await new Response(got.body).arrayBuffer())
  return await gunzip(gz)
}

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileProvider) {}

  prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
    try {
      const decodedByteLength = body.byteLength
      return gzip(body).then(bytes => ({ encoding: "gzip", bytes, decodedByteLength }))
    } catch (error) { return Promise.reject(error) }
  }

  put(keyId: ApiKeyId, record: DumpWriteRecord): Promise<void> {
    return prepareDumpWrite(keyId, record).then(persistDumpWith(this.db, this.files))
  }

  async list(keyId: ApiKeyId, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const beforeId = opts.before ?? null
    const beforeRow = beforeId !== null
      ? await this.db.prepare(
        "SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?",
      ).bind(keyId, beforeId).first<{ created_at: number }>()
      : null
    if (beforeId !== null && beforeRow === null) return []
    const beforeTs = beforeRow?.created_at ?? null

    // Newest-first with a compound (created_at, id) cursor so rows sharing a
    // millisecond still page deterministically — ULID lex order matches
    // creation order within the ms.
    const select
      = "SELECT d.meta_json, d.upstream_id, u.name AS upstream_name, u.provider AS upstream_provider "
      + "FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id "
      + "JOIN api_keys k ON k.id = d.key_id AND k.dump_retention_seconds IS NOT NULL "
    const visible = "d.key_id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000"
    const sql = beforeTs === null
      ? `${select} WHERE ${visible} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`
      : `${select} WHERE ${visible} AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?)) ORDER BY d.created_at DESC, d.id DESC LIMIT ?`
    const now = Date.now()
    const stmt = beforeTs === null
      ? this.db.prepare(sql).bind(keyId, now, opts.limit)
      : this.db.prepare(sql).bind(keyId, now, beforeTs, beforeTs, beforeId, opts.limit)
    const { results } = await stmt.all<Pick<DumpRow, "meta_json" | "upstream_id" | "upstream_name" | "upstream_provider">>()
    return results.map(row => ({
      ...JSON.parse(row.meta_json) as Omit<DumpMetadata, "upstream">,
      upstream: hydrateUpstream(row),
    }))
  }

  async get(keyId: ApiKeyId, recordId: DumpRecordId): Promise<StoredDumpRecord | null> {
    const row = await this.db.prepare(
      "SELECT d.upstream_id, u.name AS upstream_name, u.provider AS upstream_provider, "
      + "d.meta_json, d.request_headers_json, d.response_headers_json, d.request_body_descriptor, d.response_body_descriptor, d.upstream_exchanges_descriptor "
      + "FROM dump_records d LEFT JOIN upstreams u ON u.id = d.upstream_id "
      + "JOIN api_keys k ON k.id = d.key_id AND k.dump_retention_seconds IS NOT NULL "
      + "WHERE d.key_id = ? AND d.id = ? AND d.created_at >= ? - k.dump_retention_seconds * 1000",
    ).bind(keyId, recordId, Date.now()).first<DumpRow>()
    if (!row) return null

    const meta: DumpMetadata = {
      ...JSON.parse(row.meta_json) as Omit<DumpMetadata, "upstream">,
      upstream: hydrateUpstream(row),
    }
    const requestHeaders = JSON.parse(row.request_headers_json) as Array<[string, string]>
    const requestDescriptor = row.request_body_descriptor ? JSON.parse(row.request_body_descriptor) as BodyDescriptor : null
    const responseHeaders = row.response_headers_json ? JSON.parse(row.response_headers_json) as Array<[string, string]> : null
    const responseDescriptor = row.response_body_descriptor ? JSON.parse(row.response_body_descriptor) as BodyDescriptor : null
    const upstreamDescriptor = row.upstream_exchanges_descriptor
      ? JSON.parse(row.upstream_exchanges_descriptor) as { key?: unknown; type?: unknown; version?: unknown }
      : null
    let upstreamKey: string | null = null
    if (upstreamDescriptor !== null) {
      const candidate = upstreamDescriptor.key
      if (typeof candidate !== "string" || upstreamDescriptor.type !== "upstreamExchanges" || upstreamDescriptor.version !== 1) {
        throw new Error("invalid upstream exchanges descriptor")
      }
      upstreamKey = candidate
    }

    const request: StoredDumpRequest = {
      method: meta.method,
      path: meta.path,
      headers: requestHeaders,
      body: requestDescriptor ? await fetchBody(this.files, requestDescriptor) : new Uint8Array(),
    }

    // Headers null iff `type: 'none'`; a null descriptor with headers is a
    // legitimate empty-body `bytes` response (nothing to gzip), reconstructed
    // here from a zero-length buffer so the discriminator round-trips.
    let responseBody: StoredDumpResponseBody
    if (responseHeaders === null) {
      responseBody = { type: "none" }
    } else if (responseDescriptor === null) {
      responseBody = { type: "bytes", body: new Uint8Array() }
    } else if (responseDescriptor.type === "events") {
      const parsed = JSON.parse(new TextDecoder().decode(await fetchBody(this.files, responseDescriptor))) as unknown
      if (!Array.isArray(parsed)) throw new Error(`dump events payload not an array at key=${responseDescriptor.key}`)
      responseBody = { type: "stream", events: parsed as DumpStreamEvent[] }
    } else {
      responseBody = { type: "bytes", body: await fetchBody(this.files, responseDescriptor) }
    }

    const response: StoredDumpResponse = {
      status: meta.status,
      headers: responseHeaders ?? [],
      body: responseBody,
    }
    const upstreamExchanges = upstreamKey === null
      ? null
      : safeUpstreamExchangesForPersistence(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(await fetchBody(this.files, { key: upstreamKey, type: "upstreamExchanges" }))) as unknown)
    return { meta, request, response, upstreamExchanges }
  }

  // vNext has no `api_keys.deleted_at`, so unlike the reference impl there is
  // no "inactive/orphan-key" branch to sweep — a missing api_keys row means
  // the key was hard-deleted and the sweep should still clean up trailing
  // dump_records via the second branch below.
  //
  // Counting uses `RETURNING id` rather than `changes` because bun:sqlite's
  // `changes` field aggregates trigger-driven row updates (each dump_records
  // DELETE fires two spilled_files UPDATE triggers), so a plain change count
  // would over-report by 3x.
  async deleteExpiredBatch(keyId: ApiKeyId, now: number, limit: number): Promise<number> {
    const active = await this.db
      .prepare(
        `DELETE FROM dump_records WHERE rowid IN (
           SELECT records.rowid
           FROM api_keys
           CROSS JOIN dump_records AS records
           WHERE api_keys.id = ?
             AND api_keys.dump_retention_seconds IS NOT NULL
             AND records.key_id = api_keys.id
             AND records.created_at < ? - api_keys.dump_retention_seconds * 1000
           ORDER BY records.created_at, records.rowid
           LIMIT ?
         ) RETURNING id`,
      )
      .bind(keyId, now, limit)
      .all<{ id: string }>()
    const activeDeleted = active.results.length
    if (activeDeleted >= limit) return activeDeleted
    // Orphans (key hard-deleted / retention cleared to NULL): sweep all rows
    // still tied to `keyId` when the api_keys row no longer opts in.
    // Evaluate retention in the statement's LIMIT before seeking history. A
    // row predicate (even an uncorrelated one) still scans every retained row.
    const inactive = await this.db
      .prepare(
        `DELETE FROM dump_records WHERE rowid IN (
           SELECT records.rowid FROM dump_records AS records
           WHERE records.key_id = ?
           ORDER BY records.created_at, records.rowid
           LIMIT CASE WHEN EXISTS (
             SELECT 1 FROM api_keys
             WHERE api_keys.id = ? AND api_keys.dump_retention_seconds IS NOT NULL
           ) THEN 0 ELSE ? END
         ) RETURNING id`,
      )
      .bind(keyId, keyId, limit - activeDeleted)
      .all<{ id: string }>()
    return activeDeleted + inactive.results.length
  }

  async findOldestCreatedAt(keyId: ApiKeyId): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT created_at FROM dump_records WHERE key_id = ? ORDER BY created_at LIMIT 1")
      .bind(keyId)
      .first<{ created_at: number }>()
    return row?.created_at ?? null
  }
}
