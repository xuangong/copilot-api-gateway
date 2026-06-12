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
 * save() does an UPSERT (REPLACE INTO) and follows up with an opportunistic
 * GC delete of up to GC_BATCH_LIMIT expired rows. GC is best-effort: a
 * failure logs nothing and does not surface — the caller's save semantics
 * already succeeded.
 */
import type { ResponsesSnapshot, ResponsesSnapshotStore, SqlExecutor } from './types.ts'
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

  async load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null> {
    const row = await this.exec.first<Row>(
      `SELECT response_id, api_key_id, model, items_json, created_at, expires_at
         FROM responses_snapshots
        WHERE response_id = ?
          AND (api_key_id = ? OR (api_key_id IS NULL AND ? IS NULL))
          AND expires_at > ?`,
      [responseId, apiKeyId, apiKeyId, this.now()],
    )
    if (!row) return null
    return {
      responseId: row.response_id,
      apiKeyId: row.api_key_id,
      model: row.model,
      items: JSON.parse(row.items_json) as unknown[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  async save(snap: ResponsesSnapshot): Promise<void> {
    await this.exec.run(
      `INSERT OR REPLACE INTO responses_snapshots
         (response_id, api_key_id, model, items_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [snap.responseId, snap.apiKeyId, snap.model, JSON.stringify(snap.items), snap.createdAt, snap.expiresAt],
    )
    try {
      await this.exec.run(
        `DELETE FROM responses_snapshots
          WHERE response_id IN (
            SELECT response_id FROM responses_snapshots WHERE expires_at <= ? LIMIT ?
          )`,
        [this.now(), GC_BATCH_LIMIT],
      )
    } catch {
      // GC is best-effort; the save itself already succeeded.
    }
  }
}
