import type { UserId } from "../branded-ids.ts"
import type { SyncDeviceRecord, SyncDeviceRepo, SyncSourceRecord, SyncSourceRepo, SyncSourceResult, SyncSourceStatus } from "../sync.ts"
import type { SqlExecutor } from "./executor.ts"

const DEVICE_COLS = "id, owner_id, label, secret_hash, upstream_ids_json, created_at, last_sync_at"
const SOURCE_COLS = "id, owner_id, origin, device_id, secret, etag, last_attempt_at, last_success_at, status, last_error"

interface DeviceRow {
  id: string
  owner_id: string
  label: string
  secret_hash: string
  upstream_ids_json: string
  created_at: string
  last_sync_at: string | null
}

interface SourceRow {
  id: string
  owner_id: string
  origin: string
  device_id: string
  secret: string
  etag: string | null
  last_attempt_at: string | null
  last_success_at: string | null
  status: SyncSourceStatus
  last_error: string | null
}

function parseIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  } catch { return [] }
}

const toDevice = (row: DeviceRow): SyncDeviceRecord => ({
  id: row.id, ownerId: row.owner_id as UserId, label: row.label, secretHash: row.secret_hash,
  upstreamIds: parseIds(row.upstream_ids_json), createdAt: row.created_at, lastSyncAt: row.last_sync_at,
})

const toSource = (row: SourceRow): SyncSourceRecord => ({
  id: row.id, ownerId: row.owner_id as UserId, origin: row.origin, deviceId: row.device_id, secret: row.secret, etag: row.etag,
  lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, status: row.status, lastError: row.last_error,
})

export class SharedSyncDeviceRepo implements SyncDeviceRepo {
  constructor(private readonly x: SqlExecutor) {}

  async listByOwner(ownerId: UserId): Promise<SyncDeviceRecord[]> {
    const rows = await this.x.all<DeviceRow>(`SELECT ${DEVICE_COLS} FROM sync_devices WHERE owner_id = ? ORDER BY created_at ASC, id ASC`, [ownerId])
    return rows.map(toDevice)
  }

  async getById(id: string): Promise<SyncDeviceRecord | null> {
    const row = await this.x.first<DeviceRow>(`SELECT ${DEVICE_COLS} FROM sync_devices WHERE id = ?`, [id])
    return row ? toDevice(row) : null
  }

  async findBySecretHash(secretHash: string): Promise<SyncDeviceRecord | null> {
    const row = await this.x.first<DeviceRow>(`SELECT ${DEVICE_COLS} FROM sync_devices WHERE secret_hash = ?`, [secretHash])
    return row ? toDevice(row) : null
  }

  async createWithinLimit(device: SyncDeviceRecord, limit: number): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO sync_devices (${DEVICE_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM sync_devices WHERE owner_id = ?) < ?`,
      [device.id, device.ownerId, device.label, device.secretHash, JSON.stringify(device.upstreamIds), device.createdAt,
        device.lastSyncAt, device.ownerId, limit],
    )
    return result.changes > 0
  }

  async update(id: string, ownerId: UserId, patch: { label?: string; upstreamIds?: readonly string[] }): Promise<SyncDeviceRecord | null> {
    const row = await this.x.first<DeviceRow>(
      `UPDATE sync_devices SET label = COALESCE(?, label), upstream_ids_json = COALESCE(?, upstream_ids_json)
       WHERE id = ? AND owner_id = ? RETURNING ${DEVICE_COLS}`,
      [patch.label ?? null, patch.upstreamIds === undefined ? null : JSON.stringify(patch.upstreamIds), id, ownerId],
    )
    return row ? toDevice(row) : null
  }

  async delete(id: string, ownerId: UserId): Promise<boolean> {
    const result = await this.x.run("DELETE FROM sync_devices WHERE id = ? AND owner_id = ?", [id, ownerId])
    return result.changes > 0
  }

  async deleteByOwner(ownerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM sync_devices WHERE owner_id = ?", [ownerId])
  }

  async touchLastSync(id: string, now: string, notBefore: string): Promise<void> {
    await this.x.run("UPDATE sync_devices SET last_sync_at = ? WHERE id = ? AND (last_sync_at IS NULL OR last_sync_at < ?)", [now, id, notBefore])
  }
}

export class SharedSyncSourceRepo implements SyncSourceRepo {
  constructor(private readonly x: SqlExecutor) {}

  async get(): Promise<SyncSourceRecord | null> {
    const row = await this.x.first<SourceRow>(`SELECT ${SOURCE_COLS} FROM sync_sources LIMIT 1`, [])
    return row ? toSource(row) : null
  }

  async create(source: SyncSourceRecord): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO sync_sources (${SOURCE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [source.id, source.ownerId, source.origin, source.deviceId, source.secret, source.etag, source.lastAttemptAt,
        source.lastSuccessAt, source.status, source.lastError],
    )
    return result.changes > 0
  }

  async replaceDocument(id: string, document: { origin: string; deviceId: string; secret: string }, now: string): Promise<SyncSourceRecord | null> {
    const row = await this.x.first<SourceRow>(
      `UPDATE sync_sources SET origin = ?, device_id = ?, secret = ?, etag = NULL, last_attempt_at = ?, last_success_at = NULL,
         status = 'active', last_error = NULL WHERE id = ? RETURNING ${SOURCE_COLS}`,
      [document.origin, document.deviceId, document.secret, now, id],
    )
    return row ? toSource(row) : null
  }

  async recordResult(id: string, secret: string, result: SyncSourceResult): Promise<boolean> {
    const setEtag = result.etag !== undefined
    const outcome = await this.x.run(
      `UPDATE sync_sources SET last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at),
         etag = CASE WHEN ? = 1 THEN ? ELSE etag END, last_error = ?, status = COALESCE(?, status)
       WHERE id = ? AND secret = ?`,
      [result.attemptAt, result.successAt ?? null, setEtag ? 1 : 0, result.etag ?? null, result.error, result.status ?? null, id, secret],
    )
    return outcome.changes > 0
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.x.run("DELETE FROM sync_sources WHERE id = ?", [id])
    return result.changes > 0
  }
}
