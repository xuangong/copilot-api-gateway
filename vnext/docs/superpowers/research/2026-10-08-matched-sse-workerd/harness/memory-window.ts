import { readFileSync } from "node:fs"
import { join } from "node:path"
import { unstable_splitSqlQuery } from "../../../../../apps/platform-cloudflare/node_modules/wrangler"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { sha, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { readReferenceStorage, seedReference, type buildReference } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import { verifyReferenceReadback } from "../../2026-10-07-reference-stage-measurement/harness/reference-oracle"
import { referenceMigrationInputs, referenceSinkCounts } from "../../2026-10-07-reference-stage-measurement/harness/reference-qualify"
import type { ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"
import { API_KEY, SECRET, runQualifiedInstance, type TestDatabase, type Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { verifyAbSideEffects } from "../../2026-10-07-reference-stage-measurement/harness/warm"
import type { WarmWindowPlan } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { verifyMatchedDispatch, verifyUpstreamMetrics } from "./contracts"
import { waitForMemoryAfterSample, type MemorySamplerIdentity } from "./memory-barrier"
import { verifyMemoryWindow } from "./memory-contracts"

type Obj = Record<string, unknown>
async function migrate(db: TestDatabase, files: { path: string; sha256: string }[]) {
  if (!files.length) throw new Error("Memory migration population is empty")
  for (const file of files) {
    const bytes = readFileSync(file.path)
    if (sha(bytes) !== file.sha256) throw new Error(`Memory migration input drift: ${file.path}`)
    for (const sql of unstable_splitSqlQuery(bytes.toString("utf8"))) await deadline("memory migration", 15_000, () => db.prepare(sql).run())
  }
}

/** Preserve native warm-window semantics; hold readback until the sampler brackets processEnd. */
export async function runMemoryWarmWindow(manifest: Manifest, referenceRoot: string, reference: Awaited<ReturnType<typeof buildReference>>, window: WarmWindowPlan, directory: string, sampler: MemorySamplerIdentity): Promise<Dispatch[]> {
  verifyMemoryWindow(window)
  const { arm, cell } = window
  if (arm !== "B" && arm !== "R") throw new Error("Memory window requires B or R")
  const migrations = arm === "R" ? referenceMigrationInputs(reference) : manifest.variants.B.files.filter(file => file.path.startsWith(manifest.variants.B.migrationRoot + "/") && file.path.endsWith(".sql")).sort((a, b) => a.path.localeCompare(b.path))
  return runQualifiedInstance({
    arm, bundle: arm === "R" ? reference.bundle : manifest.variants.B.bundle, directory, hooks: false,
    window: { id: window.id, cell, warmup: window.warmup, timed: window.timed },
    async initialize(db, base) {
      await migrate(db, migrations)
      if (arm === "R") {
        const seed = await seedReference(db, { referenceRoot, baseUrl: base, apiKey: API_KEY, fixtureSecret: SECRET, dump: false, model: "bench-chat-ok" })
        for (const input of seed.hostInputs) if (!reference.inputs.some(frozen => frozen.path === input.path && frozen.sha256 === input.sha256)) throw new Error(`Memory reference seed helper differs from build inputs: ${input.path}`)
        durableJson(join(directory, "seed-receipt.json"), seed, true)
        return
      }
      const now = "2026-10-07T00:00:00.000Z"
      await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("architecture-owner", "Fixture", "fixture@example.invalid", now).run()
      await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("architecture-key", "Fixture", API_KEY, now, "architecture-owner", 0, null).run()
      const config = { name: "Fixture", baseUrl: `${base}/v1`, apiKey: SECRET, authStyle: "bearer", endpoints: ["chat_completions"], models: ["bench-chat-ok"] }
      await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind("custom:architecture-chat", "architecture-owner", "custom", "Fixture", JSON.stringify(config), '[{"id":"direct_fetch"}]', now, now).run()
    },
    async readback(db, bucket, rows, dispatches) {
      const observations = JSON.parse(readFileSync(join(directory, "observations.json"), "utf8")) as { processStart: ProcessResource; processEnd: ProcessResource }
      await waitForMemoryAfterSample({ directory, windowId: window.id, sampler, processStart: observations.processStart, processEnd: observations.processEnd })
      if (rows.length !== 25 || dispatches.length !== rows.length) throw new Error("Memory window full population mismatch")
      for (const dispatch of dispatches) verifyMatchedDispatch(dispatch)
      if (arm === "R") {
        const storage = await readReferenceStorage(db, bucket)
        durableJson(join(directory, "reference-storage.json"), storage, true)
        const semantic = verifyReferenceReadback(storage, rows, dispatches)
        durableJson(join(directory, "reference-semantic-receipt.json"), semantic, true)
        const sink = referenceSinkCounts(storage)
        return { evidence: { storage, semantic }, objectCount: sink.objects, compressedBytes: sink.compressedBytes }
      }
      const tables: Record<string, Obj[]> = {}
      for (const table of ["dump_records", "spilled_files", "responses_items", "responses_snapshots", "usage", "usage_requests", "performance_summary", "performance_latency_buckets", "performance_metrics"]) tables[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Obj>()).results
      const semantic = verifyAbSideEffects(tables, rows.length, false)
      verifyUpstreamMetrics(tables, dispatches.length, cell.stream)
      durableJson(join(directory, "ab-side-effects.json"), { tables, semantic }, true)
      if (rows.some(row => row.dumpRecordId !== null)) throw new Error("Dump-disabled memory window returned dump identity")
      const list = await bucket.list({ limit: 1 })
      if (list.truncated || list.objects.length) throw new Error("Dump-disabled memory window persisted R2 objects")
      return { evidence: { tables, semantic }, objectCount: 0, compressedBytes: 0 }
    },
  })
}
