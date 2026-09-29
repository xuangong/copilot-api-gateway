import { UpstreamContentionError } from "@vibe-core/upstream-repo"
import type { ProxyRecord } from "@vibe-core/proxy-repo"
import type { UpstreamId } from "../branded-ids.ts"
import type { UpstreamRepo } from "../types.ts"
import {
  catalogFingerprint, validCatalogModels,
  type CatalogErrorCode, type CatalogFailure, type CatalogIdentity, type CatalogLease,
  type CatalogModels, type CatalogObservation, type CatalogRepo, type CatalogSnapshot,
} from "../catalogs.ts"
import type { SqlExecutor } from "./executor.ts"

const NOW = "(CAST(strftime('%s','now') AS INTEGER) * 1000)"
const ERROR_CODES: readonly CatalogErrorCode[] = ["timeout", "aborted", "upstream_error", "invalid_catalog", "unavailable"]
const CURRENT = `EXISTS (SELECT 1 FROM upstreams u WHERE u.id = model_catalogs.upstream_id
  AND u.row_incarnation = ? AND u.catalog_generation = ? AND u.owner_id = ? AND u.provider = ?)`
const OWNED = `upstream_id = ? AND catalog_revision = ? AND row_incarnation = ?
  AND configuration_generation = ? AND configuration_fingerprint = ? AND lease_token = ?
  AND lease_until_ms > ${NOW} AND ${CURRENT}`

interface CatalogRow {
  publication_version: number | null
  row_incarnation: string | null
  configuration_generation: number | null
  configuration_fingerprint: string | null
  models_json: string | null
  refreshed_at_ms: number | null
  refresh_after_ms: number | null
  lease_token: string | null
  lease_until_ms: number | null
  failure_count: number | null
  retry_at_ms: number | null
  last_error_code: string | null
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("Invalid catalog numeric option")
  return value
}

function validateIdentity(identity: CatalogIdentity): void {
  integer(identity.catalogRevision, 1, Number.MAX_SAFE_INTEGER)
  integer(identity.configurationGeneration, 0, Number.MAX_SAFE_INTEGER)
  if (!identity.upstreamId || !identity.rowIncarnation || !identity.provider || !/^[a-f0-9]{64}$/.test(identity.configurationFingerprint)) {
    throw new TypeError("Invalid catalog identity")
  }
}

function currentBinds(identity: CatalogIdentity): unknown[] {
  return [identity.rowIncarnation, identity.configurationGeneration, identity.ownerId ?? "", identity.provider]
}

function leaseBinds(lease: CatalogLease): unknown[] {
  validateIdentity(lease.identity)
  const i = lease.identity
  return [i.upstreamId, i.catalogRevision, i.rowIncarnation, i.configurationGeneration,
    i.configurationFingerprint, lease.token, ...currentBinds(i)]
}

function snapshot(row: CatalogRow, identity: CatalogIdentity): CatalogSnapshot | null {
  if (row.models_json === null || row.refreshed_at_ms === null || row.refresh_after_ms === null) return null
  if (!Number.isSafeInteger(row.refreshed_at_ms) || row.refreshed_at_ms < 0
    || !Number.isSafeInteger(row.refresh_after_ms) || row.refresh_after_ms < row.refreshed_at_ms) return null
  let models: unknown
  try { models = JSON.parse(row.models_json) } catch { return null }
  if (!validCatalogModels(models)) return null
  if (row.publication_version === null || !Number.isSafeInteger(row.publication_version) || row.publication_version < 1) return null
  return { identity: { ...identity }, publicationVersion: row.publication_version, models,
    refreshedAtMs: row.refreshed_at_ms, refreshAfterMs: row.refresh_after_ms }
}

function failure(row: CatalogRow): CatalogFailure {
  return {
    failureCount: row.failure_count ?? 0, retryAtMs: row.retry_at_ms ?? 0,
    lastErrorCode: ERROR_CODES.find(code => code === row.last_error_code) ?? null,
  }
}

export class SharedCatalogRepo implements CatalogRepo {
  constructor(private readonly sql: SqlExecutor, private readonly upstreams: UpstreamRepo) {}

  async read(id: UpstreamId, catalogRevision: number): Promise<CatalogObservation | null> {
    integer(catalogRevision, 1, Number.MAX_SAFE_INTEGER)
    for (let attempt = 0; attempt < 4; attempt++) {
      const upstream = await this.upstreams.getById(id)
      if (!upstream) return null
      const proxies = await this.sql.all<ProxyRecord>(`SELECT id, name, url, dial_timeout_seconds AS dialTimeoutSeconds,
        created_at AS createdAt, updated_at AS updatedAt FROM proxies
        WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
          AND id NOT IN ('direct_fetch', 'direct_connect') ORDER BY id`,
      [JSON.stringify(upstream.proxyFallbackList)])
      // Proxy edits advance the same upstream generation. The final read fences
      // all preceding configuration/proxy reads without relying on a transaction.
      const row = await this.sql.first<CatalogRow & { database_now_ms: number }>(`SELECT c.*, ${NOW} AS database_now_ms
        FROM upstreams u LEFT JOIN model_catalogs c ON c.upstream_id = u.id AND c.catalog_revision = ?
        WHERE u.id = ? AND u.row_incarnation = ? AND u.catalog_generation = ?`,
      [catalogRevision, id, upstream.rowIncarnation, upstream.catalogGeneration])
      if (!row) continue
      const identity: CatalogIdentity = {
        upstreamId: upstream.id, rowIncarnation: upstream.rowIncarnation, ownerId: upstream.ownerId,
        provider: upstream.provider, configurationGeneration: upstream.catalogGeneration,
        configurationFingerprint: catalogFingerprint(upstream, proxies), catalogRevision,
      }
      const current = row.row_incarnation === identity.rowIncarnation
        && row.configuration_generation === identity.configurationGeneration
        && row.configuration_fingerprint === identity.configurationFingerprint
      return {
        upstream, proxies, identity, databaseNowMs: row.database_now_ms,
        snapshot: current ? snapshot(row, identity) : null,
        lease: current && row.lease_token !== null && row.lease_until_ms !== null
          ? { identity: { ...identity }, token: row.lease_token, leaseUntilMs: row.lease_until_ms } : null,
        ...(current ? failure(row) : { failureCount: 0, retryAtMs: 0, lastErrorCode: null }),
      }
    }
    throw new UpstreamContentionError(id)
  }

  async tryAcquire(identity: CatalogIdentity, options: { explicit?: boolean; leaseMs?: number } = {}): Promise<CatalogLease | null> {
    validateIdentity(identity)
    const leaseMs = integer(options.leaseMs ?? 30_000, 1, 300_000)
    const i = identity
    await this.sql.run(`INSERT INTO model_catalogs
      (upstream_id, catalog_revision, row_incarnation, configuration_generation, configuration_fingerprint, last_used_at_ms)
      SELECT id, ?, row_incarnation, catalog_generation, ?, ${NOW} FROM upstreams
      WHERE id = ? AND row_incarnation = ? AND catalog_generation = ? AND owner_id = ? AND provider = ?
      ON CONFLICT(upstream_id, catalog_revision) DO NOTHING`,
    [i.catalogRevision, i.configurationFingerprint, i.upstreamId, ...currentBinds(i)])
    const token = crypto.randomUUID()
    const row = await this.sql.first<{ lease_until_ms: number }>(`UPDATE model_catalogs SET
      models_json = CASE WHEN configuration_generation < ? THEN NULL ELSE models_json END,
      refreshed_at_ms = CASE WHEN configuration_generation < ? THEN NULL ELSE refreshed_at_ms END,
      refresh_after_ms = CASE WHEN configuration_generation < ? THEN NULL ELSE refresh_after_ms END,
      failure_count = CASE WHEN configuration_generation < ? THEN 0 ELSE failure_count END,
      retry_at_ms = CASE WHEN configuration_generation < ? THEN 0 ELSE retry_at_ms END,
      last_error_code = CASE WHEN configuration_generation < ? THEN NULL ELSE last_error_code END,
      configuration_generation = ?, configuration_fingerprint = ?, lease_token = ?, lease_until_ms = ${NOW} + ?, last_used_at_ms = ${NOW}
      WHERE upstream_id = ? AND catalog_revision = ? AND row_incarnation = ? AND configuration_generation <= ?
      AND (configuration_generation < ? OR (configuration_fingerprint = ? AND (lease_token IS NULL OR lease_until_ms <= ${NOW})
        AND (? = 1 OR retry_at_ms <= ${NOW}))) AND ${CURRENT}
      RETURNING lease_until_ms`,
    [...Array.from({ length: 7 }, () => i.configurationGeneration), i.configurationFingerprint, token, leaseMs,
      i.upstreamId, i.catalogRevision, i.rowIncarnation, i.configurationGeneration, i.configurationGeneration,
      i.configurationFingerprint, options.explicit ? 1 : 0, ...currentBinds(i)])
    return row ? { identity: { ...identity }, token, leaseUntilMs: row.lease_until_ms } : null
  }

  async publish(lease: CatalogLease, models: CatalogModels, options: { freshnessMs?: number } = {}): Promise<CatalogSnapshot | null> {
    if (!validCatalogModels(models)) throw new TypeError("Invalid model catalog")
    const freshnessMs = integer(options.freshnessMs ?? 120_000, 1, 86_400_000)
    const row = await this.sql.first<CatalogRow>(`UPDATE model_catalogs SET models_json = ?, publication_version = publication_version + 1,
      refreshed_at_ms = ${NOW}, refresh_after_ms = ${NOW} + ?, lease_token = NULL, lease_until_ms = NULL,
      failure_count = 0, retry_at_ms = 0, last_error_code = NULL, last_used_at_ms = ${NOW}
      WHERE ${OWNED} RETURNING *`, [JSON.stringify(models), freshnessMs, ...leaseBinds(lease)])
    return row ? snapshot(row, lease.identity) : null
  }

  async recordFailure(lease: CatalogLease, code: CatalogErrorCode, options: { backoffMs?: number } = {}): Promise<CatalogFailure | null> {
    if (!ERROR_CODES.includes(code)) throw new TypeError("Invalid catalog error category")
    const delay = options.backoffMs === undefined ? null : integer(options.backoffMs, 1, 300_000)
    const jitter = 0.8 + Math.random() * 0.4
    const row = await this.sql.first<CatalogRow>(`UPDATE model_catalogs SET
      retry_at_ms = ${NOW} + COALESCE(?, MIN(300000, CAST(30000 * (1 << MIN(failure_count, 4)) * ? AS INTEGER))),
      failure_count = MIN(failure_count + 1, 2147483647), last_error_code = ?,
      lease_token = NULL, lease_until_ms = NULL, last_used_at_ms = ${NOW}
      WHERE ${OWNED} RETURNING *`, [delay, jitter, code, ...leaseBinds(lease)])
    return row ? failure(row) : null
  }

  async deleteInactiveRevisions(options: { activeRevisions: readonly number[]; inactiveBeforeMs: number; limit: number }): Promise<number> {
    const limit = integer(options.limit, 1, 512)
    integer(options.inactiveBeforeMs, 0, Number.MAX_SAFE_INTEGER)
    if (options.activeRevisions.length === 0 || options.activeRevisions.length > 32) throw new TypeError("Active catalog revisions required")
    for (const revision of options.activeRevisions) integer(revision, 1, Number.MAX_SAFE_INTEGER)
    const rows = await this.sql.all<{ upstream_id: string }>(`DELETE FROM model_catalogs WHERE rowid IN (
      SELECT rowid FROM model_catalogs WHERE catalog_revision NOT IN (${options.activeRevisions.map(() => "?").join(",")})
      AND last_used_at_ms < ? AND (lease_token IS NULL OR lease_until_ms <= ${NOW})
      ORDER BY last_used_at_ms, upstream_id, catalog_revision LIMIT ?
    ) RETURNING upstream_id`, [...options.activeRevisions, options.inactiveBeforeMs, limit])
    return rows.length
  }
}
