import { snapshotExpiresAt } from "./retention.ts"
/**
 * SQL-backed ResponsesSnapshotStore — runs against either D1 (CFW) or
 * bun:sqlite (local) via the SqlExecutor adapter. Storing items as JSON
 * TEXT keeps schema flat; both backends are SQLite under the hood so this
 * is the natural choice.
 *
 * Owner isolation uses a nullable-safe predicate (SQLite/D1 lack
 * IS NOT DISTINCT FROM): match when api_key_id = ? OR (api_key_id IS NULL
 * AND ? IS NULL). Pass apiKeyId twice as a bind.
 *
 * load() filters out expired rows in the WHERE clause so a deferred GC
 * sweep is purely a storage concern, never affecting correctness.
 *
 * save() attempts a bounded GC delete before its UPSERT (REPLACE INTO), so
 * expired snapshots can free space even when the database cannot grow.
 * GC is best-effort: a failure does not prevent attempting the save.
 */
import type { ResponsesSnapshot, ResponsesSnapshotStore, SnapshotLoadOptions, SqlExecutor } from './types.ts'
import { GC_BATCH_LIMIT } from './types.ts'

export interface SqliteStoreOptions {
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

interface Row {
  response_id: string
  api_key_id: string | null
  model: string
  items_json: string
  created_at: number
  expires_at: number
}

export class SqliteResponsesSnapshotStore implements ResponsesSnapshotStore {
  private readonly now: () => number

  constructor(private readonly exec: SqlExecutor, opts: SqliteStoreOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  async load(responseId: string, apiKeyId: string | null, options: SnapshotLoadOptions = {}): Promise<ResponsesSnapshot | null> {
    const now = this.now()
    const row = await this.exec.first<Row>(
      `SELECT response_id, api_key_id, model, items_json, created_at, expires_at
         FROM responses_snapshots
        WHERE response_id = ?
          AND (api_key_id = ? OR (api_key_id IS NULL AND ? IS NULL))
          AND expires_at > ?`,
      [responseId, apiKeyId, apiKeyId, now],
    )
    if (!row) return null
    let items: unknown[]
    try {
      items = JSON.parse(row.items_json) as unknown[]
    } catch {
      // A corrupt snapshot is functionally equivalent to a missing one.
      return null
    }
    if (options.refreshRetentionSeconds !== undefined) {
      const expiresAt = snapshotExpiresAt(now, options.refreshRetentionSeconds)
      if (expiresAt > row.expires_at) {
        // Update metadata only. MAX prevents an older concurrent request from
        // shortening the deadline; the predicates never recreate deleted state.
        const renewed = await this.exec.first<{ expires_at: number }>(
          `UPDATE responses_snapshots SET expires_at = MAX(expires_at, ?)
            WHERE response_id = ?
              AND (api_key_id = ? OR (api_key_id IS NULL AND ? IS NULL))
              AND expires_at > ?
            RETURNING expires_at`,
          [expiresAt, responseId, apiKeyId, apiKeyId, now],
        )
        if (!renewed) return null
        row.expires_at = renewed.expires_at
      }
    }
    return {
      responseId: row.response_id,
      apiKeyId: row.api_key_id,
      model: row.model,
      items,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  async save(snap: ResponsesSnapshot): Promise<void> {
    try {
      await this.exec.run(
        `DELETE FROM responses_snapshots
          WHERE response_id IN (
            SELECT response_id FROM responses_snapshots WHERE expires_at <= ? LIMIT ?
          )`,
        [this.now(), GC_BATCH_LIMIT],
      )
    } catch {
      // Cleanup failure must not prevent a write when capacity is available.
    }
    await this.exec.run(
      `INSERT OR REPLACE INTO responses_snapshots
         (response_id, api_key_id, model, items_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [snap.responseId, snap.apiKeyId, snap.model, JSON.stringify(snap.items), snap.createdAt, snap.expiresAt],
    )
  }
}
