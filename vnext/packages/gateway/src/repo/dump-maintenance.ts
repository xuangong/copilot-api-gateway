import type { FileProvider, SqlDatabase } from "@vibe-core/platform"
import type { ApiKeyId } from "./branded-ids.ts"
import { FileDumpStore } from "./dump-store.ts"

const KEYS_PER_TICK = 16
const RECORDS_PER_KEY = 25
const FILES_PER_TICK = 100
const CLAIM_TTL_MS = 5 * 60 * 1000

interface Cursor { cursor_key: string; cursor_time: number }
const readCursor = async (db: SqlDatabase, name: string): Promise<Cursor> =>
  await db.prepare("SELECT cursor_key, cursor_time FROM maintenance_cursors WHERE name = ?")
    .bind(name).first<Cursor>() ?? { cursor_key: "", cursor_time: -1 }
const saveCursor = async (db: SqlDatabase, name: string, key: string, time = -1): Promise<void> => {
  await db.prepare(`INSERT INTO maintenance_cursors (name, cursor_key, cursor_time) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET cursor_key = excluded.cursor_key, cursor_time = excluded.cursor_time`)
    .bind(name, key, time).run()
}

export async function sweepDumpRecords(db: SqlDatabase, files: FileProvider, now: number): Promise<number> {
  const store = new FileDumpStore(db, files)
  let { cursor_key: key } = await readCursor(db, "dump-records")
  let deleted = 0
  for (let i = 0; i < KEYS_PER_TICK; i++) {
    // Seek to the next key instead of grouping all history rows for each key.
    const next = await db.prepare("SELECT key_id FROM dump_records WHERE key_id > ? ORDER BY key_id LIMIT 1")
      .bind(key).first<{ key_id: ApiKeyId }>()
    if (!next) { key = ""; break }
    key = next.key_id
    deleted += await store.deleteExpiredBatch(next.key_id, now, RECORDS_PER_KEY)
  }
  await saveCursor(db, "dump-records", key)
  return deleted
}

export async function collectDumpFiles(db: SqlDatabase, files: FileProvider, now: number): Promise<number> {
  const cursor = await readCursor(db, "dump-files")
  // LIMIT applies BEFORE claim/reference checks. The dedicated partial index
  // bounds candidate traversal even when all candidates are referenced/claimed.
  const candidates = await db.prepare(`SELECT file_key, collect_after FROM spilled_files INDEXED BY idx_dump_files_collectible
    WHERE state != 'owned' AND owner_kind IN ('dump-request', 'dump-response', 'dump-upstream')
      AND file_key GLOB 'dumps/v1/*' AND collect_after <= ?
      AND (collect_after, file_key) > (?, ?)
    ORDER BY collect_after, file_key LIMIT ?`)
    .bind(now, cursor.cursor_time, cursor.cursor_key, FILES_PER_TICK)
    .all<{ file_key: string; collect_after: number }>()
  const last = candidates.results.at(-1)
  await saveCursor(db, "dump-files", last?.file_key ?? "", last?.collect_after ?? -1)
  if (!last) return 0

  const token = crypto.randomUUID()
  const claimed = await db.prepare(`UPDATE spilled_files SET claim_token = ?, claimed_at = ?
    WHERE file_key IN (SELECT value FROM json_each(?))
      AND state != 'owned' AND collect_after <= ?
      AND owner_kind IN ('dump-request', 'dump-response', 'dump-upstream') AND file_key GLOB 'dumps/v1/*'
      AND (claim_token IS NULL OR claimed_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM dump_file_references AS refs WHERE refs.file_key = spilled_files.file_key)
    RETURNING file_key`)
    .bind(token, now, JSON.stringify(candidates.results.map(row => row.file_key)), now, now - CLAIM_TTL_MS)
    .all<{ file_key: string }>()

  let deleted = 0
  let failed = 0
  for (const { file_key: key } of claimed.results) {
    try {
      // Writers cannot adopt a claimed stage, even after its lease expires.
      // Another collector may retry the same immutable file key after expiry;
      // external deletion is idempotent and metadata removal is token-fenced.
      await files.delete(key)
      const removed = await db.prepare(`DELETE FROM spilled_files WHERE file_key = ? AND claim_token = ?
        AND state != 'owned'
        AND NOT EXISTS (SELECT 1 FROM dump_file_references AS refs WHERE refs.file_key = spilled_files.file_key)
        RETURNING file_key`).bind(key, token).all<{ file_key: string }>()
      deleted += removed.results.length
    } catch {
      // Keep the claim and metadata for expiry-based retry, including cases
      // where the external delete succeeded but SQL deletion did not.
      failed++
    }
  }
  if (failed > 0) console.warn(JSON.stringify({ evt: "dump_file_collection_failed", count: failed }))
  return deleted
}
