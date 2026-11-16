export const SYNC_VERSION = 1 as const
export const SYNC_DEVICE_ID_PATTERN = /^sdv_[a-f0-9]{32}$/
export const SYNC_DEVICE_SECRET_PATTERN = /^sds_[a-f0-9]{64}$/
export const SYNC_MAX_DEVICES_PER_OWNER = 16
export const SYNC_MAX_DEVICE_UPSTREAMS = 256
/** `last_sync_at` is written at most this often per device. */
export const SYNC_LAST_SYNC_STAMP_MS = 10 * 60 * 1000

/** The one-time document handed to a device. */
export interface SyncDocument {
  version: typeof SYNC_VERSION
  kind: "gateway-sync"
  gatewayOrigin: string
  deviceId: string
  deviceSecret: string
}

export function syncDocument(gatewayOrigin: string, deviceId: string, deviceSecret: string): SyncDocument {
  return { version: SYNC_VERSION, kind: "gateway-sync", gatewayOrigin, deviceId, deviceSecret }
}

/** One upstream as it travels. `config` and `state` are the provider's `syncView` output. */
export interface SyncedUpstream {
  id: string
  provider: string
  name: string
  config: Record<string, unknown>
  state: unknown
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
}

export interface SyncSnapshot {
  version: typeof SYNC_VERSION
  deviceId: string
  upstreams: SyncedUpstream[]
}


export const SYNC_INTERVAL_MS = 60_000
export const SYNC_FETCH_TIMEOUT_MS = 15_000
export const SYNC_MAX_SNAPSHOT_BYTES = 1_048_576

/** Fixed codes stored in `sync_sources.last_error`. */
export type SyncErrorCode = "unreachable" | "http_error" | "bad_response" | "id_conflict" | "unsupported_provider" | "apply_failed"

export class SyncDocumentError extends Error {
  constructor(message = "invalid_sync_document") { super(message) }
}

/** A bare HTTPS origin normalized to `URL.origin`; null for userinfo, a path beyond "/", a query, a fragment or anything unparsable. */
export function normalizeHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[?#\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : null
  } catch { return null }
}

const DOCUMENT_KEYS = ["version", "kind", "gatewayOrigin", "deviceId", "deviceSecret"]

/** Strict: unknown fields, a wrong kind or malformed identifiers throw `SyncDocumentError`. */
export function parseSyncDocument(value: unknown): SyncDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncDocumentError()
  const doc = value as Record<string, unknown>
  const origin = normalizeHttpsOrigin(doc.gatewayOrigin)
  if (Object.keys(doc).some(key => !DOCUMENT_KEYS.includes(key)) || doc.version !== SYNC_VERSION || doc.kind !== "gateway-sync" || !origin
    || typeof doc.deviceId !== "string" || !SYNC_DEVICE_ID_PATTERN.test(doc.deviceId)
    || typeof doc.deviceSecret !== "string" || !SYNC_DEVICE_SECRET_PATTERN.test(doc.deviceSecret)) throw new SyncDocumentError()
  return syncDocument(origin, doc.deviceId, doc.deviceSecret)
}

const UPSTREAM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,256}$/
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
/** The one rule for what may travel: devices reject a snapshot containing an entry that fails it. */
export const isSyncableWireUpstream = (upstream: { id: string; name: string }): boolean =>
  UPSTREAM_ID_PATTERN.test(upstream.id) && upstream.name.length > 0 && upstream.name.length <= 256
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

/**
 * Known fields must validate; unknown fields on an entry are ignored so an older device keeps working against a newer
 * central. Throws `SyncDocumentError("bad_snapshot")`.
 */
export function parseSyncSnapshot(text: string, deviceId: string): SyncSnapshot {
  const bad = () => new SyncDocumentError("bad_snapshot")
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw bad() }
  const body = asRecord(raw)
  if (!body || body.version !== SYNC_VERSION || body.deviceId !== deviceId || !Array.isArray(body.upstreams)
    || body.upstreams.length > SYNC_MAX_DEVICE_UPSTREAMS) throw bad()
  const seen = new Set<string>()
  const upstreams = body.upstreams.map((item): SyncedUpstream => {
    const entry = asRecord(item)
    const config = asRecord(entry?.config)
    const flags = asRecord(entry?.flagOverrides)
    if (!entry || !config || !flags || typeof entry.id !== "string" || seen.has(entry.id)
      || typeof entry.provider !== "string" || !PROVIDER_PATTERN.test(entry.provider)
      || typeof entry.name !== "string" || !isSyncableWireUpstream({ id: entry.id, name: entry.name })
      || !Object.values(flags).every(flag => typeof flag === "boolean")
      || !Array.isArray(entry.disabledPublicModelIds) || !entry.disabledPublicModelIds.every(id => typeof id === "string")) throw bad()
    seen.add(entry.id)
    return { id: entry.id, provider: entry.provider, name: entry.name, config, state: entry.state ?? null,
      flagOverrides: flags as Record<string, boolean>, disabledPublicModelIds: entry.disabledPublicModelIds as string[] }
  })
  return { version: SYNC_VERSION, deviceId, upstreams }
}
