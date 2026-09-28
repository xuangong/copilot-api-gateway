import type { FileProvider, SqlDatabase } from "@vibe-core/platform"
import { collectDumpFiles, sweepDumpRecords } from "./repo/dump-maintenance.ts"
import { sweepResponsesSnapshots } from "./responses-maintenance.ts"

export { collectDumpFiles, sweepDumpRecords, sweepResponsesSnapshots }

/** A failed task must not prevent unrelated retention work from progressing. */
export async function sweepMaintenance(db: SqlDatabase, files: FileProvider, now: number): Promise<void> {
  for (const [operation, run] of [
    ["responses_expiration", () => sweepResponsesSnapshots(db, now)],
    ["dump_expiration", () => sweepDumpRecords(db, files, now)],
    ["dump_file_collection", () => collectDumpFiles(db, files, now)],
  ] as const) {
    try { await run() } catch { console.warn(JSON.stringify({ evt: "maintenance_failed", operation })) }
  }
}
