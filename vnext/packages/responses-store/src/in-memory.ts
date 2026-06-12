/**
 * In-memory ResponsesSnapshotStore — for tests and local dev with no DB.
 *
 * Owner isolation is enforced inside load(); cross-owner reads return null.
 * `save` runs opportunistic GC by walking the map and dropping expired rows.
 */
import type { ResponsesSnapshot, ResponsesSnapshotStore } from './types.ts'
import { GC_BATCH_LIMIT } from './types.ts'

export interface InMemoryStoreOptions {
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

export class InMemoryResponsesSnapshotStore implements ResponsesSnapshotStore {
  private readonly rows = new Map<string, ResponsesSnapshot>()
  private readonly now: () => number

  constructor(opts: InMemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  async load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null> {
    const row = this.rows.get(responseId)
    if (!row) return null
    if (row.apiKeyId !== apiKeyId) return null
    if (row.expiresAt <= this.now()) return null
    return row
  }

  async save(snap: ResponsesSnapshot): Promise<void> {
    this.rows.set(snap.responseId, snap)
    this.gc()
  }

  /** Test/debug seam: total rows in storage, ignoring TTL. Not part of the public store contract. */
  _size(): number {
    return this.rows.size
  }

  private gc(): void {
    const cutoff = this.now()
    let evicted = 0
    for (const [id, row] of this.rows) {
      if (evicted >= GC_BATCH_LIMIT) break
      if (row.expiresAt <= cutoff) {
        this.rows.delete(id)
        evicted++
      }
    }
  }
}
