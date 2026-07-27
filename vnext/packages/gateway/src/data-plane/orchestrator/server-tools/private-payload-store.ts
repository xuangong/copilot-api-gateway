/**
 * In-memory private-payload store for server-tool slots.
 *
 * Server-tool result slots (e.g. image-generation partial images, web-search
 * intermediate query results) sometimes need to persist server-only blobs
 * that never leave the gateway — the wire-visible item id keys them, but
 * the payload itself must not be echoed back to the client.
 *
 * Reference: copilot-gateway's `StatefulResponsesStore.registerPrivatePayload`
 * (server-tool-shim.ts:846). That store is D1-backed for cross-request
 * replay; here we keep an in-memory Map with a 5-minute TTL because the
 * shim only reads the payload later in the same request via `transformItems`
 * on the next loop turn. Cross-request replay lands with the real store in
 * a later phase.
 *
 * TTL is deliberately loose: the loop consumes payloads within one request's
 * lifetime (seconds), so the TTL only bounds leak risk when a request is
 * abandoned mid-flight. A cheap sweep on write is enough — no timer.
 */

export interface PrivatePayloadStore {
  /** Register a server-only payload keyed by wire item id. */
  registerPrivatePayload: (itemId: string, payload: unknown) => void
  /** Lookup a previously-registered payload. Returns `undefined` when unknown or expired. */
  getPrivatePayload: (itemId: string) => unknown
}

interface Entry {
  payload: unknown
  expiresAt: number
}

/** 5 minutes matches the reference project's read-window guarantee. */
export const PRIVATE_PAYLOAD_TTL_MS = 5 * 60 * 1000

export const createInMemoryPrivatePayloadStore = (
  options: { ttlMs?: number; now?: () => number } = {},
): PrivatePayloadStore => {
  const ttlMs = options.ttlMs ?? PRIVATE_PAYLOAD_TTL_MS
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()

  const sweep = (): void => {
    const cutoff = now()
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= cutoff) entries.delete(id)
    }
  }

  return {
    registerPrivatePayload: (itemId, payload) => {
      sweep()
      entries.set(itemId, { payload, expiresAt: now() + ttlMs })
    },
    getPrivatePayload: (itemId) => {
      const entry = entries.get(itemId)
      if (entry === undefined) return undefined
      if (entry.expiresAt <= now()) {
        entries.delete(itemId)
        return undefined
      }
      return entry.payload
    },
  }
}

/** Process-wide default store — used when no explicit store is injected. */
export const defaultPrivatePayloadStore: PrivatePayloadStore = createInMemoryPrivatePayloadStore()
