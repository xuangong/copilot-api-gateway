// packages/gateway/src/repo/shared/protection.ts
import {
  COUNTED_CLASSES, ERROR_CLASSES, PROTECTION_MINUTES_RETENTION_DAYS, PROTECTION_PAUSES_RETENTION_DAYS, PROTECTION_PURGE_CHUNK,
  PROTECTION_PURGE_MAX_CHUNKS, PROTECTION_SAMPLES_PER_STATUS, emptyCounts,
  type ClassCounts, type ErrorBucket, type ErrorClass, type ErrorSample, type NewPause, type PauseMode, type PauseReason, type PauseRecord,
  type PauseResolver, type PauseTargetKind, type ProtectionRepo, type ProtectionSettings, type UpstreamResponseRecord, type WindowSummary,
} from "../protection.ts"
import type { SqlExecutor, SqlStatement } from "./executor.ts"

type CountRow = { [K in keyof ClassCounts]: number | null }
const SUMS = `SUM(requests) AS requests, SUM(rate_limited) AS rate_limited, SUM(rejected) AS rejected, SUM(auth) AS auth,
  SUM(upstream) AS upstream, SUM(network) AS network, SUM(other) AS other`
const toCounts = (row: Partial<CountRow>): ClassCounts => ({
  requests: Number(row.requests ?? 0), rate_limited: Number(row.rate_limited ?? 0), rejected: Number(row.rejected ?? 0), auth: Number(row.auth ?? 0),
  upstream: Number(row.upstream ?? 0), network: Number(row.network ?? 0), other: Number(row.other ?? 0),
})

/** `cls` comes from the closed `ErrorClass` union, so the column name is safe to inline. */
const upsertSql = (cls: ErrorClass): string => {
  if (!(ERROR_CLASSES as readonly string[]).includes(cls)) throw new Error(`unknown error class: ${cls}`)
  const column = cls === "ok" ? null : cls
  return `INSERT INTO upstream_request_minutes (minute, upstream_id, key_id, model, requests${column ? `, ${column}` : ""})
    VALUES (?, ?, ?, ?, 1${column ? ", 1" : ""})
    ON CONFLICT (upstream_id, minute, key_id, model) DO UPDATE SET requests = requests + 1${column ? `, ${column} = ${column} + 1` : ""}`
}

const INSERT_SAMPLE_SQL = `INSERT INTO upstream_error_samples (upstream_id, status, at, key_id, model, code, message) VALUES (?, ?, ?, ?, ?, ?, ?)`
const TRIM_SAMPLES_SQL = `DELETE FROM upstream_error_samples WHERE upstream_id = ? AND status = ? AND rowid NOT IN
  (SELECT rowid FROM upstream_error_samples WHERE upstream_id = ? AND status = ? ORDER BY at DESC, rowid DESC LIMIT ${PROTECTION_SAMPLES_PER_STATUS})`

interface PauseRow {
  id: string; target_kind: PauseTargetKind; target_id: string; upstream_id: string; mode: PauseMode; reason_json: string
  started_at: number; ends_at: number; resolved_at: number | null; resolved_by: PauseResolver | null
}
const PAUSE_COLS = "id, target_kind, target_id, upstream_id, mode, reason_json, started_at, ends_at, resolved_at, resolved_by"
const parseReason = (json: string): PauseReason => {
  try { return JSON.parse(json) as PauseReason } catch {
    return { windowMinutes: 0, requests: 0, risky: 0, counts: { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0, topKeys: [], trigger: "ratio", keyShare: null }
  }
}
const toPause = (row: PauseRow): PauseRecord => ({
  id: row.id, targetKind: row.target_kind, targetId: row.target_id, upstreamId: row.upstream_id, mode: row.mode, reason: parseReason(row.reason_json),
  startedAt: Number(row.started_at), endsAt: Number(row.ends_at), resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at), resolvedBy: row.resolved_by,
})

export class SharedProtectionRepo implements ProtectionRepo {
  constructor(private readonly x: SqlExecutor) {}

  async recordResponse(input: UpstreamResponseRecord): Promise<void> {
    const upsert: SqlStatement = { sql: upsertSql(input.cls), binds: [input.minute, input.upstreamId, input.keyId, input.model] }
    const sample = input.sample
    if (!sample) { await this.x.run(upsert.sql, upsert.binds); return }
    if (!this.x.batch) throw new Error("protection samples need an executor with batch support")
    await this.x.batch([
      upsert,
      { sql: INSERT_SAMPLE_SQL, binds: [input.upstreamId, sample.status, sample.at, input.keyId, input.model, sample.code, sample.message] },
      { sql: TRIM_SAMPLES_SQL, binds: [input.upstreamId, sample.status, input.upstreamId, sample.status] },
    ])
  }

  async windowSummary(upstreamId: string, fromMinute: number, toMinute: number): Promise<WindowSummary> {
    const rows = await this.x.all<CountRow & { key_id: string }>(
      `SELECT key_id, ${SUMS} FROM upstream_request_minutes WHERE upstream_id = ? AND minute >= ? AND minute <= ? GROUP BY key_id`,
      [upstreamId, fromMinute, toMinute])
    const totals = emptyCounts()
    const byKey = rows.map(row => ({ keyId: row.key_id, ...toCounts(row) }))
    for (const key of byKey) {
      totals.requests += key.requests
      for (const cls of COUNTED_CLASSES) totals[cls] += key[cls]
    }
    return { totals, byKey }
  }

  async errorBuckets(upstreamId: string, fromSec: number, toSec: number, bucketSeconds: 60 | 3600, keyId?: string): Promise<ErrorBucket[]> {
    const size = bucketSeconds === 3600 ? 3600 : 60 // inlined: only these two literals ever reach the SQL text
    const from = Math.floor(fromSec / size) * size // the first bucket is always complete
    // `+key_id` keeps SQLite on the (upstream_id, minute, ...) primary key instead of the (key_id, minute) index.
    const rows = await this.x.all<CountRow & { t: number }>(
      `SELECT (minute / ${size}) * ${size} AS t, ${SUMS} FROM upstream_request_minutes
       WHERE upstream_id = ? AND minute >= ? AND minute < ?${keyId === undefined ? "" : " AND +key_id = ?"} GROUP BY t ORDER BY t`,
      keyId === undefined ? [upstreamId, from, toSec] : [upstreamId, from, toSec, keyId])
    return rows.map(row => ({ t: Number(row.t), ...toCounts(row) }))
  }

  async listSamples(upstreamId: string): Promise<ErrorSample[]> {
    const rows = await this.x.all<{ upstream_id: string; status: number; at: number; key_id: string; model: string; code: string; message: string }>(
      `SELECT upstream_id, status, at, key_id, model, code, message FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY status ORDER BY at DESC, rowid DESC) AS rn
         FROM upstream_error_samples WHERE upstream_id = ?) WHERE rn <= ${PROTECTION_SAMPLES_PER_STATUS}
       ORDER BY status ASC, at DESC, rn ASC`, [upstreamId])
    return rows.map(row => ({ upstreamId: row.upstream_id, status: Number(row.status), at: Number(row.at), keyId: row.key_id, model: row.model, code: row.code, message: row.message }))
  }

  private parseSettings(json: string): Record<string, unknown> | null {
    try {
      const value: unknown = JSON.parse(json)
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch { return null }
  }

  async getSettings(upstreamId: string): Promise<Record<string, unknown> | null> {
    const row = await this.x.first<{ settings_json: string }>("SELECT settings_json FROM upstream_protection_settings WHERE upstream_id = ?", [upstreamId])
    return row ? this.parseSettings(row.settings_json) : null
  }

  async getSettingsMany(upstreamIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>()
    if (upstreamIds.length === 0) return out
    const rows = await this.x.all<{ upstream_id: string; settings_json: string }>(
      "SELECT upstream_id, settings_json FROM upstream_protection_settings WHERE upstream_id IN (SELECT value FROM json_each(?))", [JSON.stringify(upstreamIds)])
    for (const row of rows) {
      const parsed = this.parseSettings(row.settings_json)
      if (parsed) out.set(row.upstream_id, parsed)
    }
    return out
  }

  async setSettings(upstreamId: string, settings: ProtectionSettings, nowMs: number): Promise<void> {
    await this.x.run(
      `INSERT INTO upstream_protection_settings (upstream_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (upstream_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      [upstreamId, JSON.stringify(settings), nowMs])
  }

  async insertPauseIfNone(pause: NewPause, nowMs: number): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO protection_pauses (id, target_kind, target_id, upstream_id, mode, reason_json, started_at, ends_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM protection_pauses WHERE target_kind = ? AND target_id = ? AND resolved_at IS NULL AND ends_at > ? AND (? = 'notify' OR mode = 'pause'))`,
      [pause.id, pause.targetKind, pause.targetId, pause.upstreamId, pause.mode, JSON.stringify(pause.reason), pause.startedAt, pause.endsAt,
        pause.targetKind, pause.targetId, nowMs, pause.mode])
    return result.changes > 0
  }

  async countRecentPauses(kind: PauseTargetKind, targetId: string, mode: PauseMode, sinceMs: number): Promise<number> {
    const row = await this.x.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM protection_pauses WHERE target_kind = ? AND target_id = ? AND mode = ? AND started_at >= ?", [kind, targetId, mode, sinceMs])
    return Number(row?.n ?? 0)
  }

  async lastOwnerResolvedAt(upstreamId: string, sinceMs: number): Promise<number | null> {
    const row = await this.x.first<{ at: number | null }>(
      "SELECT MAX(resolved_at) AS at FROM protection_pauses WHERE upstream_id = ? AND resolved_by = 'owner' AND resolved_at >= ?", [upstreamId, sinceMs])
    return row?.at == null ? null : Number(row.at)
  }

  async listActive(nowMs: number): Promise<PauseRecord[]> {
    const rows = await this.x.all<PauseRow>(
      `SELECT ${PAUSE_COLS} FROM protection_pauses WHERE resolved_at IS NULL AND ends_at > ? ORDER BY started_at DESC, id DESC`, [nowMs])
    return rows.map(toPause)
  }

  async listPauses(upstreamId: string, limit: number): Promise<PauseRecord[]> {
    const rows = await this.x.all<PauseRow>(
      `SELECT ${PAUSE_COLS} FROM protection_pauses WHERE upstream_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`, [upstreamId, limit])
    return rows.map(toPause)
  }

  async getPause(id: string): Promise<PauseRecord | null> {
    const row = await this.x.first<PauseRow>(`SELECT ${PAUSE_COLS} FROM protection_pauses WHERE id = ?`, [id])
    return row ? toPause(row) : null
  }

  async resolvePause(id: string, by: PauseResolver, nowMs: number): Promise<boolean> {
    const result = await this.x.run("UPDATE protection_pauses SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL", [nowMs, by, id])
    return result.changes > 0
  }

  async deleteExpired(nowMs: number, options: { chunk?: number; maxChunks?: number; orphans?: boolean } = {}) {
    const orphans = options.orphans ?? true
    const chunk = options.chunk ?? PROTECTION_PURGE_CHUNK
    const maxChunks = options.maxChunks ?? PROTECTION_PURGE_MAX_CHUNKS
    /** Repeats a `... LIMIT ?` statement until it deletes less than a full chunk or the table's budget is used. */
    const drain = async (sql: string, binds: unknown[]): Promise<number> => {
      let total = 0
      for (let i = 0; i < maxChunks; i++) {
        const { changes } = await this.x.run(sql, [...binds, chunk])
        total += changes
        if (changes < chunk) break
      }
      return total
    }
    const resolved = (await this.x.run(
      `UPDATE protection_pauses SET resolved_at = ends_at, resolved_by = 'auto'
       WHERE id IN (SELECT id FROM protection_pauses WHERE resolved_at IS NULL AND ends_at <= ? LIMIT ?)`, [nowMs, chunk])).changes
    const minutes = await drain(
      "DELETE FROM upstream_request_minutes WHERE rowid IN (SELECT rowid FROM upstream_request_minutes WHERE minute < ? LIMIT ?)",
      [Math.floor(nowMs / 1000) - PROTECTION_MINUTES_RETENTION_DAYS * 86_400])
    const pauses = await drain(
      "DELETE FROM protection_pauses WHERE id IN (SELECT id FROM protection_pauses WHERE started_at < ? LIMIT ?)",
      [nowMs - PROTECTION_PAUSES_RETENTION_DAYS * 86_400_000])
    const samples = !orphans ? 0 : await drain(
      `DELETE FROM upstream_error_samples WHERE rowid IN
        (SELECT s.rowid FROM upstream_error_samples s WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = s.upstream_id) LIMIT ?)`, [])
    const settings = !orphans ? 0 : await drain(
      `DELETE FROM upstream_protection_settings WHERE upstream_id IN
        (SELECT p.upstream_id FROM upstream_protection_settings p WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = p.upstream_id) LIMIT ?)`, [])
    return { resolved, minutes, pauses, samples, settings }
  }
}
