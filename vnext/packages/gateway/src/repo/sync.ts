import type { UpstreamKind } from "@vibe-llm/protocols/common"
import type { UserId } from "./branded-ids.ts"

export interface SyncDeviceRecord {
  id: string
  ownerId: UserId
  label: string
  /** SHA-256 hex of the device secret; the secret itself is never stored. */
  secretHash: string
  upstreamIds: string[]
  createdAt: string
  lastSyncAt: string | null
}

export interface SyncDeviceRepo {
  /** Oldest first. */
  listByOwner(ownerId: UserId): Promise<SyncDeviceRecord[]>
  getById(id: string): Promise<SyncDeviceRecord | null>
  findBySecretHash(secretHash: string): Promise<SyncDeviceRecord | null>
  /** Inserts unless the owner already holds `limit` devices. False means the limit was reached. */
  createWithinLimit(device: SyncDeviceRecord, limit: number): Promise<boolean>
  /** Updates only supplied fields; null when the device does not exist or belongs to another owner. */
  update(id: string, ownerId: UserId, patch: { label?: string; upstreamIds?: readonly string[] }): Promise<SyncDeviceRecord | null>
  delete(id: string, ownerId: UserId): Promise<boolean>
  deleteByOwner(ownerId: UserId): Promise<void>
  /** Stamps `last_sync_at = now` unless it already holds a value at or after `notBefore`. */
  touchLastSync(id: string, now: string, notBefore: string): Promise<void>
}

export type SyncSourceStatus = "active" | "revoked"

export interface SyncSourceRecord {
  id: string
  /** The device user the synced upstreams belong to. */
  ownerId: UserId
  origin: string
  deviceId: string
  secret: string
  etag: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  status: SyncSourceStatus
  lastError: string | null
}

export interface SyncSourceResult {
  attemptAt: string
  successAt?: string
  /** Undefined keeps the stored ETag, null clears it, a string replaces it. */
  etag?: string | null
  error: string | null
  status?: SyncSourceStatus
}

export interface SyncSourceRepo {
  get(): Promise<SyncSourceRecord | null>
  /** False when a source already exists. */
  create(source: SyncSourceRecord): Promise<boolean>
  /** Replaces origin, device and secret in place and resets etag, error, success time and status. Null when gone. */
  replaceDocument(id: string, document: { origin: string; deviceId: string; secret: string }, now: string): Promise<SyncSourceRecord | null>
  /** Fenced on the secret so a result computed for a replaced document is dropped (false). */
  recordResult(id: string, secret: string, result: SyncSourceResult): Promise<boolean>
  delete(id: string): Promise<boolean>
}

/** One snapshot entry as the device writes it. Local fields (enabled, sort order, proxies) are not part of it. */
export interface SyncedUpstreamInput {
  id: string
  ownerId: string
  provider: UpstreamKind
  name: string
  config: Record<string, unknown>
  state: unknown
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
}

/** `conflict`: a row with this id exists that this source does not own. */
export type SyncedUpstreamOutcome = "created" | "updated" | "unchanged" | "conflict"
