/**
 * Public types for @vnext/responses-store.
 *
 * A "snapshot" is the merged input + output items array from one /v1/responses
 * turn. The next turn — when the client sends previous_response_id — the
 * gateway loads this snapshot, prepends its `items` to the new request's
 * input, and deletes previous_response_id before forwarding upstream.
 */

/** Default snapshot TTL: 24 hours. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** Opportunistic GC: how many expired rows to delete per save call. */
export const GC_BATCH_LIMIT = 100

export interface ResponsesSnapshot {
  responseId: string
  /** Owner isolation key. null = anonymous; null callers can only read null rows. */
  apiKeyId: string | null
  model: string
  /** Full Responses-protocol items array (input + output for the turn). */
  items: unknown[]
  /** ms since epoch. */
  createdAt: number
  /** ms since epoch. After this time, load() must return null and GC may delete. */
  expiresAt: number
}

export interface ResponsesSnapshotStore {
  /** Returns the snapshot iff response_id matches AND owner matches (null-safe). */
  load(responseId: string, apiKeyId: string | null): Promise<ResponsesSnapshot | null>
  /** Inserts (or replaces) the snapshot. Implementations may also run opportunistic GC. */
  save(snap: ResponsesSnapshot): Promise<void>
}

/**
 * Minimal SQL adapter; mirrors apps/gateway/src/shared/repo/shared/executor.ts.
 * Duplicated here so the package has no dependency on @vnext/gateway.
 */
export interface SqlExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all<T = any>(sql: string, binds: unknown[]): Promise<T[]>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  first<T = any>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
}
