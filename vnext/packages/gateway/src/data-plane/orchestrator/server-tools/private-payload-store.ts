import { decodeWebSearchPrivatePayload, type WebSearchCallPrivatePayload } from "./private-payload"

/** Explicit legacy injection remains externally owned and unknown-valued. */

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

export interface ServerToolPrivatePayloadReader {
  getPrivatePayload(itemId: string): WebSearchCallPrivatePayload | undefined
}
export interface ServerToolPrivatePayloadWriter {
  registerPrivatePayload(itemId: string, payload: WebSearchCallPrivatePayload): undefined
}
export interface OwnedServerToolPrivatePayloadScope {
  readonly reader: ServerToolPrivatePayloadReader
  readonly writer: ServerToolPrivatePayloadWriter
  dispose(): undefined
}
export interface OwnedServerToolPrivatePayloadSource {
  readonly ownership: "owned"
  createScope(): OwnedServerToolPrivatePayloadScope
}
export type ServerToolPrivatePayloadDependency = OwnedServerToolPrivatePayloadSource | PrivatePayloadStore

export function isOwnedPrivatePayloadSource(dependency: ServerToolPrivatePayloadDependency): dependency is OwnedServerToolPrivatePayloadSource {
  return "ownership" in dependency && dependency.ownership === "owned"
}

export function borrowPrivatePayloadStore(store: PrivatePayloadStore): OwnedServerToolPrivatePayloadScope {
  let closed = false
  return {
    reader: { getPrivatePayload: id => closed ? undefined : decodeWebSearchPrivatePayload(store.getPrivatePayload(id)) },
    writer: { registerPrivatePayload(id, payload) {
      if (closed) throw new Error("Server-tool private state is closed")
      store.registerPrivatePayload(id, payload)
      return undefined
    } },
    dispose() { closed = true; return undefined },
  }
}

/** Compatibility TTL for explicitly injected shared storage, not live owned state. */
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

/** A descriptor has no retained entries. Only an active hosted invocation opens a scope. */
export const defaultPrivatePayloadStore: OwnedServerToolPrivatePayloadSource = {
  ownership: "owned",
  createScope() {
    const entries = new Map<string, WebSearchCallPrivatePayload>()
    let closed = false
    return {
      reader: { getPrivatePayload: id => closed ? undefined : entries.get(id) },
      writer: { registerPrivatePayload(id, payload) {
        if (closed) throw new Error("Server-tool private state is closed")
        entries.set(id, payload)
        return undefined
      } },
      dispose() { closed = true; entries.clear(); return undefined },
    }
  },
}
