import type { SqlDatabase } from "@vibe-core/platform"

const BATCH_SIZE = 100
const BATCHES_PER_TICK = 4

/** Independent of request traffic, so disabled keys and idle sites still release storage. */
export async function sweepResponsesSnapshots(db: SqlDatabase, now: number): Promise<void> {
  for (let batch = 0; batch < BATCHES_PER_TICK; batch++) {
    const expired = await db.prepare(`DELETE FROM responses_snapshots WHERE response_id IN (
      SELECT response_id FROM responses_snapshots WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
    ) RETURNING response_id`).bind(now, BATCH_SIZE).all<{ response_id: string }>()
    if (expired.results.length === BATCH_SIZE) continue
    const inactive = await db.prepare(`DELETE FROM responses_snapshots WHERE response_id IN (
      SELECT snapshot.response_id FROM responses_snapshots AS snapshot
      WHERE NOT EXISTS (
        SELECT 1 FROM api_keys WHERE api_keys.id = snapshot.api_key_id AND api_keys.responses_retention_seconds > 0
      ) LIMIT ?
    ) RETURNING response_id`).bind(BATCH_SIZE - expired.results.length).all<{ response_id: string }>()
    if (expired.results.length + inactive.results.length < BATCH_SIZE) break
  }
}
