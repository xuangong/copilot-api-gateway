import { readFileSync } from "node:fs"
import { join } from "node:path"
import { unstable_splitSqlQuery } from "../../../../../apps/platform-cloudflare/node_modules/wrangler"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { sha, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import type { Cell } from "../../2026-10-07-reference-stage-measurement/harness/contracts"
import type { buildReference } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import { API_KEY, SECRET, runQualifiedInstance, type TestDatabase, type Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { runWarmWindow, verifyAbSideEffects } from "../../2026-10-07-reference-stage-measurement/harness/warm"
import { verifyMatchedDispatch, type MatchedWindow } from "./contracts"
import { readAndSaveNativeDumps } from "./saved-dumps"

type Obj = Record<string, unknown>

async function initializeB(db: TestDatabase, base: string, manifest: Manifest, cell: Cell) {
  const variant = manifest.variants.B
  const files = variant.files.filter(file => file.path.startsWith(variant.migrationRoot + "/") && file.path.endsWith(".sql")).sort((a, b) => a.path.localeCompare(b.path))
  if (!files.length) throw new Error("Matched B migration population is empty")
  for (const file of files) {
    const bytes = readFileSync(file.path)
    if (sha(bytes) !== file.sha256) throw new Error(`Matched B migration input drift: ${file.path}`)
    for (const sql of unstable_splitSqlQuery(bytes.toString("utf8"))) await deadline("matched B migration", 15000, () => db.prepare(sql).run())
  }
  const now = "2026-10-07T00:00:00.000Z"
  await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("architecture-owner", "Fixture", "fixture@example.invalid", now).run()
  await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("architecture-key", "Fixture", API_KEY, now, "architecture-owner", 0, cell.dump ? 3600 : null).run()
  const config = { name: "Fixture", baseUrl: `${base}/v1`, apiKey: SECRET, authStyle: "bearer", endpoints: ["chat_completions"], models: ["bench-chat-ok"] }
  await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind("custom:architecture-chat", "architecture-owner", "custom", "Fixture", JSON.stringify(config), '[{"id":"direct_fetch"}]', now, now).run()
}

/** Scope the JSON-downstream/SSE-upstream dump adapter to this frozen study. */
export async function runMatchedWarmWindow(manifest: Manifest, referenceRoot: string, reference: Awaited<ReturnType<typeof buildReference>>, window: MatchedWindow, directory: string): Promise<Dispatch[]> {
  // R retains its native reader and saved decoded evidence scope.
  if (window.arm === "R") return runWarmWindow(manifest, referenceRoot, reference, window, directory)
  if (window.arm !== "B") throw new Error("Matched warm window requires B or R")
  const { cell } = window
  return runQualifiedInstance({
    arm: "B", bundle: manifest.variants.B.bundle, directory, hooks: false,
    window: { id: window.id, cell, warmup: window.warmup, timed: window.timed },
    async initialize(db, base) { await initializeB(db, base, manifest, cell) },
    async readback(db, bucket, rows, dispatches) {
      if (rows.length !== window.warmup + window.timed || dispatches.length !== rows.length) throw new Error("Matched B warm population mismatch")
      for (const dispatch of dispatches) verifyMatchedDispatch(dispatch)
      const tables: Record<string, Obj[]> = {}
      for (const table of ["dump_records", "spilled_files", "responses_items", "responses_snapshots", "usage", "usage_requests", "performance_summary", "performance_latency_buckets", "performance_metrics"]) tables[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Obj>()).results
      const semantic = verifyAbSideEffects(tables, rows.length, cell.dump)
      durableJson(join(directory, "ab-side-effects.json"), { tables, semantic }, true)
      const nativeDump = await readAndSaveNativeDumps({ directory, db, bucket, rows, dispatches, arm: "B", dump: cell.dump })
      const storage = nativeDump.storage
      const objects = storage.newRecords.flatMap(value => {
        const record = value as { objects?: { compressedBytes: number }[] }
        if (!Array.isArray(record.objects) || record.objects.some(object => !Number.isSafeInteger(object.compressedBytes) || object.compressedBytes < 0)) throw new Error("Invalid matched B physical receipt")
        return record.objects
      })
      return { evidence: { storage, tables, semantic, nativeDumpEvidence: nativeDump.evidence }, objectCount: objects.length, compressedBytes: objects.reduce((sum, object) => sum + object.compressedBytes, 0) }
    },
  })
}
