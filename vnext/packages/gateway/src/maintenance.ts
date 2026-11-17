import { env } from "@vibe-core/platform"
import { getRepo } from "./repo/index.ts"
import { sweepCatalogs } from "./catalog-maintenance.ts"
import type { FileProvider, SqlDatabase } from "@vibe-core/platform"
import { collectDumpFiles, sweepDumpRecords } from "./repo/dump-maintenance.ts"
import { TELEMETRY_PURGE_CHUNK } from "./repo/telemetry.ts"
import { sweepResponsesSnapshots } from "./responses-maintenance.ts"

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
export const resetTelemetryRetentionState = (): void => { orphanBacklog = false }

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
  ] as const) {
    try { await run() } catch { console.warn(JSON.stringify({ evt: "maintenance_failed", operation })) }
  }
}
