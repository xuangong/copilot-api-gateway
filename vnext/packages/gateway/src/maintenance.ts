import { env } from "@vibe-core/platform"
import { getRepo } from "./repo/index.ts"
import { sweepCatalogs } from "./catalog-maintenance.ts"
import type { FileProvider, SqlDatabase } from "@vibe-core/platform"
import { collectDumpFiles, sweepDumpRecords } from "./repo/dump-maintenance.ts"
import { PROTECTION_PURGE_CHUNK } from "./repo/protection.ts"
import { TELEMETRY_PURGE_CHUNK } from "./repo/telemetry.ts"
import { sweepResponsesSnapshots } from "./responses-maintenance.ts"
import "./control-plane/quota-balance/fetcher.ts"
import { resetQuotaRetentionState, sweepQuotaBalance, sweepQuotaRetention } from "./quota-balance/sweep.ts"

export { collectDumpFiles, sweepDumpRecords, sweepResponsesSnapshots }

/**
 * Telemetry expiry (three index-ranged purges, each about one index probe when nothing expired) runs on every sweep, so a capped purge
 * continues on the next sweep and a Bun process that sweeps rarely or lives briefly still keeps up. The orphan loose scan walks every
 * distinct source id, so it runs once an hour, at this UTC minute (off the top of the hour, where agents push), and again on the next
 * sweep while the previous scan used up its budget.
 */
export const TELEMETRY_RETENTION_MINUTE = 17

export const isTelemetryRetentionDue = (now: number): boolean => new Date(now).getUTCMinutes() === TELEMETRY_RETENTION_MINUTE

let orphanBacklog = false
let protectionOrphanBacklog = false
export const resetTelemetryRetentionState = (): void => { orphanBacklog = false; protectionOrphanBacklog = false; resetQuotaRetentionState() }

/**
 * Protection retention: the date-based deletes run on every sweep; the two orphan scans (samples and settings of vanished upstreams,
 * anti-joins against `upstreams`) run hourly at the telemetry orphan minute, and again while the previous scan used up a full chunk.
 */
async function sweepProtection(now: number): Promise<void> {
  const orphans = protectionOrphanBacklog || isTelemetryRetentionDue(now)
  const result = await getRepo().protection.deleteExpired(now, { orphans })
  protectionOrphanBacklog = orphans && (result.samples >= PROTECTION_PURGE_CHUNK || result.settings >= PROTECTION_PURGE_CHUNK)
}

async function sweepTelemetry(now: number): Promise<void> {
  const orphans = orphanBacklog || isTelemetryRetentionDue(now)
  const { orphans: orphansDeleted } = await getRepo().telemetry.deleteExpired(now, { orphans })
  // An orphan scan that deleted a full chunk or more (expired rows do not count) probably left orphans behind. (State lives in the process; a fresh Worker isolate falls back to the hourly minute.)
  orphanBacklog = orphans && orphansDeleted >= TELEMETRY_PURGE_CHUNK
}

/** A failed task must not prevent unrelated retention work from progressing. */
export async function sweepMaintenance(db: SqlDatabase, files: FileProvider, now: number): Promise<void> {
  for (const [operation, run] of [
    ["catalog_revisions", () => {
      let policy: string
      try { policy = env("MODEL_CATALOG_ACTIVE_REVISIONS") } catch { return Promise.resolve() }
      return policy ? sweepCatalogs(getRepo().catalogs, now, policy) : Promise.resolve()
    }],
    ["responses_expiration", () => sweepResponsesSnapshots(db, now)],
    ["dump_expiration", () => sweepDumpRecords(db, files, now)],
    ["dump_file_collection", () => collectDumpFiles(db, files, now)],
    ["telemetry_retention", () => sweepTelemetry(now)],
    // One idle sweep is about three statements (stamp, minutes, pauses), five in an orphan-scan hour. A backlog is capped at 41 statements
    // (the stamp plus at most 10 chunked DELETEs on each of four tables) and continues on the next sweep.
    ["protection_retention", () => sweepProtection(now)],
    // Quota balancing: one directory read per minute when no group exists; with groups, the reads the scheduler asks for (staggered, a few a day per member).
    ["quota_balance", () => sweepQuotaBalance(now).then(() => {})],
    ["quota_balance_retention", () => sweepQuotaRetention(now, isTelemetryRetentionDue(now))],
  ] as const) {
    try { await run() } catch { console.warn(JSON.stringify({ evt: "maintenance_failed", operation })) }
  }
}
