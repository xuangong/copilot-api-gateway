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
//     `UpstreamKind` from protocols-llm/common ('copilot'|'custom'|'azure'|
//     'sdf'); anything else in the row is a schema slip and coerces to
//     'custom' (the vNext catch-all).

import { DUMP_FILE_PREFIX, SPILLED_FILE_STAGE_GRACE_MS } from "../shared/dump/spilled-files-policy.ts"
import { safeUpstreamExchangesForPersistence } from "../shared/dump/upstream-attempts.ts"
import type { DumpListOptions, DumpStore } from "../shared/dump/store-contract.ts"
import type {
  DumpMetadata,
  DumpRecordId,
  DumpStreamEvent,
  DumpUpstreamRef,
  DumpWriteRecord,
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

const KNOWN_UPSTREAM_KINDS: ReadonlySet<UpstreamKind> = new Set(["copilot", "custom", "azure", "sdf"])

// A null `upstream_id` means no upstream was identified at capture time
// (auth/validation reject, no candidate matched); a non-null id with a null
// joined `upstream_name` means the referenced upstream was since deleted.
// Any provider value the schema doesn't recognize falls through to 'custom'
// so a bad row doesn't poison every read.
const hydrateUpstream = (row: Pick<DumpRow, "upstream_id" | "upstream_name" | "upstream_provider">): DumpUpstreamRef | null => {
  if (row.upstream_id === null || row.upstream_name === null) return null
  const kind: UpstreamKind = row.upstream_provider !== null && KNOWN_UPSTREAM_KINDS.has(row.upstream_provider as UpstreamKind)
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

// gzip/gunzip via Bun's native helpers (Bun 1.3 does not expose
// CompressionStream globally). Cloudflare Workers do expose CompressionStream;
// when this runs there we'd wrap that instead — for the Bun runtime we take
// the direct route.
const gzip = async (input: Uint8Array | string): Promise<Uint8Array> => {
  // Both sinks below reject a SharedArrayBuffer-backed view; nothing in the
  // gateway ever produces one, so narrow once here instead of at each call.
  const part = input as Uint8Array<ArrayBuffer> | string
  if (typeof CompressionStream !== "undefined") {
    const stream = new Response(new Blob([part]).stream().pipeThrough(new CompressionStream("gzip")))
    return new Uint8Array(await stream.arrayBuffer())
  }
  const bytes = typeof part === "string" ? new TextEncoder().encode(part) : part
  return Bun.gzipSync(bytes)
}

const gunzip = async (input: Uint8Array): Promise<Uint8Array> => {
  const bytes = input as Uint8Array<ArrayBuffer>
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")))
    return new Uint8Array(await stream.arrayBuffer())
  }
  return Bun.gunzipSync(bytes)
}

const putPreparedBody = async (
  files: FileProvider,
  key: string | null,
  bytes: Uint8Array | null,
): Promise<void> => {
  if (key !== null && bytes !== null) await files.put(key, bytes)
}

const fetchBody = async (files: FileProvider, descriptor: BodyDescriptor): Promise<Uint8Array> => {
  const got = await files.get(descriptor.key)
  if (!got) throw new Error(`dump body missing for key=${descriptor.key}`)
  const gz = new Uint8Array(await new Response(got.body).arrayBuffer())
  return await gunzip(gz)
}

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileProvider) {}

  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> {
    return {
      encoding: "gzip",
      bytes: await gzip(body),
      decodedByteLength: body.byteLength,
    }
  }

  async put(keyId: ApiKeyId, record: DumpWriteRecord): Promise<void> {
    const bucket = hourBucket(record.meta.completedAt)
    const requestFileKey = record.request.body.decodedByteLength === 0
      ? null
      : bodyPath(keyId, bucket, record.meta.id, "req")
    const responseFileKey = record.response.body.type === "bytes" && record.response.body.body.byteLength === 0
      ? null
      : record.response.body.type === "none"
        ? null
        : bodyPath(keyId, bucket, record.meta.id, "resp")
    // Validate and encode from a strict safe-field projection before a file
    // key is staged or a sidecar is created. A malformed optional capture
    // cannot prevent the canonical dump from being written.
    let upstreamBytes: Uint8Array | null = null
    if (record.upstreamExchanges != null) {
      try {
        const safe = safeUpstreamExchangesForPersistence(record.upstreamExchanges)
        upstreamBytes = await gzip(JSON.stringify(safe) ?? "")
      } catch { /* optional sidecar */ }
    }
    let upstreamFileKey = upstreamBytes === null ? null : bodyPath(keyId, bucket, record.meta.id, "up")
    const coreStaged = [
      ...(requestFileKey === null ? [] : [{ fileKey: requestFileKey, ownerKind: "dump-request" }]),
      ...(responseFileKey === null ? [] : [{ fileKey: responseFileKey, ownerKind: "dump-response" }]),
    ]
    let staged = [
      ...coreStaged,
      ...(upstreamFileKey === null ? [] : [{ fileKey: upstreamFileKey, ownerKind: "dump-upstream" }]),
    ]
    const stage = async (keys: typeof staged): Promise<void> => {
      await this.db
        .prepare(
          `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
           SELECT
             json_extract(value, '$.fileKey'),
             json_extract(value, '$.ownerKind'),
             json_array(?, ?),
             'staged',
             ?
           FROM json_each(?)`,
        )
        .bind(keyId, record.meta.id, Date.now() + SPILLED_FILE_STAGE_GRACE_MS, JSON.stringify(keys))
        .run()
    }
    if (staged.length > 0) {
      try {
        await stage(staged)
      } catch (error) {
        if (upstreamFileKey === null) throw error
        // The batch statement is atomic. Retry core staging without the
        // optional key if only sidecar staging was rejected.
        upstreamFileKey = null
        upstreamBytes = null
        staged = coreStaged
        if (staged.length > 0) await stage(staged)
      }
    }
    const retireUpstreamStage = async (): Promise<void> => {
      if (upstreamFileKey === null) return
      // A late external put can finish after the stage was collected. Upsert
      // a retired tombstone and fence the old collector's pending SQL delete.
      await this.db.prepare(`INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
        VALUES (?, 'dump-upstream', json_array(?, ?), 'retired', 0)
        ON CONFLICT(file_key) DO UPDATE SET state = 'retired', collect_after = 0, claim_token = NULL, claimed_at = NULL
        WHERE spilled_files.state != 'owned'`)
        .bind(upstreamFileKey, keyId, record.meta.id).run()
    }
    try {
      const requestDescriptor: BodyDescriptor | null = requestFileKey === null ? null : { key: requestFileKey, type: "bytes" }
      let requestBytes = requestFileKey === null
        ? null
        : record.request.body.encoding === "gzip" ? record.request.body.bytes : await gzip(record.request.body.bytes)

      // Prepare serially before starting any uploads. A preparation failure
      // cannot leave a sibling write running outside the cleanup barrier.
      let responseDescriptor: BodyDescriptor | null = null
      let responseBytes: Uint8Array | null = null
      if (record.response.body.type === "bytes") {
        if (responseFileKey !== null) {
          responseBytes = await gzip(record.response.body.body)
          responseDescriptor = { key: responseFileKey, type: "bytes" }
        }
      } else if (record.response.body.type === "stream") {
        responseBytes = await gzip(JSON.stringify(record.response.body.events) ?? "")
        responseDescriptor = { key: responseFileKey!, type: "events" }
      }

      // Fixed three-slot batch: only already prepared bytes are uploaded in
      // parallel. All started writes settle before publication or retirement,
      // including late/partial writes after an early sibling rejection.
      const [requestPut, responsePut, upstreamPut] = await Promise.allSettled([
        putPreparedBody(this.files, requestFileKey, requestBytes),
        putPreparedBody(this.files, responseFileKey, responseBytes),
        putPreparedBody(this.files, upstreamFileKey, upstreamBytes),
      ])
      requestBytes = responseBytes = upstreamBytes = null
      if (requestPut.status === "rejected") throw requestPut.reason
      if (responsePut.status === "rejected") throw responsePut.reason

      let upstreamDescriptor: { key: string; type: "upstreamExchanges"; version: 1 } | null = null
      if (upstreamFileKey !== null) {
        if (upstreamPut.status === "fulfilled") {
          upstreamDescriptor = { key: upstreamFileKey, type: "upstreamExchanges", version: 1 }
        } else {
          // Even a partially successful external put remains collectible.
          try { await retireUpstreamStage() }
          catch { /* keep the canonical dump independent of the sidecar */ }
        }
      }

      // Strip the in-memory `upstream` field; the ref is rebuilt from the join
      // at read time so renames and deletes are honored on historical rows.
      const { upstream: _upstream, ...metaToStore } = record.meta

      // Files before row — a partial failure leaves orphan files the sweep
      // collects, never an orphan row whose detail fetch would 404.
      const insertRow = async (sidecar: typeof upstreamDescriptor): Promise<void> => {
        await this.db.prepare(
          `INSERT INTO dump_records
           (key_id, id, created_at, upstream_id, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor, upstream_exchanges_descriptor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          keyId,
          record.meta.id,
          record.meta.completedAt,
          record.meta.upstream?.id ?? null,
          JSON.stringify(metaToStore),
          JSON.stringify(record.request.headers),
          record.response.body.type === "none" ? null : JSON.stringify(record.response.headers),
          requestDescriptor === null ? null : JSON.stringify(requestDescriptor),
          responseDescriptor === null ? null : JSON.stringify(responseDescriptor),
          sidecar === null ? null : JSON.stringify(sidecar),
        ).run()
      }
      try {
        await insertRow(upstreamDescriptor)
      } catch (error) {
        if (upstreamDescriptor === null) throw error
        // A slow sidecar put may outlive its stage's grace period while core
        // body stages remain valid. Retry only the canonical row without the
        // optional descriptor, then collect the orphan sidecar.
        try { await retireUpstreamStage() } catch { /* optional cleanup */ }
        await insertRow(null)
      }
    } catch (error) {
      // A put can outlive staging grace: collection may have already removed
      // its file/metadata before the put finishes and INSERT is rejected.
      // Recreate a retired tombstone and fence any collector still finishing
      // its SQL delete. Unique file keys prevent touching another writer.
      if (staged.length > 0) {
        await this.db.prepare(`INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
          SELECT json_extract(value, '$.fileKey'), json_extract(value, '$.ownerKind'), json_array(?, ?), 'retired', 0
          FROM json_each(?) WHERE true
          ON CONFLICT(file_key) DO UPDATE SET state = 'retired', collect_after = 0, claim_token = NULL, claimed_at = NULL
          WHERE spilled_files.state != 'owned'`)
          .bind(keyId, record.meta.id, JSON.stringify(staged)).run()
      }
      throw error
    }
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
