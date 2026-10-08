import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { unstable_splitSqlQuery } from "../../../../../apps/platform-cloudflare/node_modules/wrangler"
import { fileIdentity, loadManifest, sha, verifyFiles, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { readDumps } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { API_KEY, SECRET, runQualifiedInstance, type TestDatabase, type TestBucket, type QualifiedRow, type Dispatch } from "./runtime"
import { buildReference, readReferenceStorage, seedReference } from "./reference-adapter"
import { verifyReferenceReadback } from "./reference-oracle"
import { referenceMigrationInputs, referenceSinkCounts } from "./reference-qualify"
import { aggregateWarmRun, freezeWarmPlan, verifyWarmWireRows, type WarmPlan, type WarmWindowEvidence, type WarmWindowPlan } from "./warm-contracts"
import { runInstanceJob, writeInstanceContext } from "./instance-job.ts"
import type { ObserverConfig } from "../../2026-10-08-diagnostic-attribution/harness/observer"
import { readAndSaveNativeDumps } from "../../2026-10-08-diagnostic-attribution/harness/saved-dumps"
import type { Arm, Cell } from "./contracts"

type Obj = Record<string, unknown>
async function migrate(db: TestDatabase, files: { path: string; sha256: string }[]) {
  for (const file of files) {
    const bytes = readFileSync(file.path)
    if (sha(bytes) !== file.sha256) throw new Error(`Warm migration input drift: ${file.path}`)
    for (const sql of unstable_splitSqlQuery(bytes.toString("utf8"))) await deadline("warm migration", 15000, () => db.prepare(sql).run())
  }
}
async function initializeAb(db: TestDatabase, base: string, manifest: Manifest, arm: "A" | "B", cell: Cell) {
  const variant = manifest.variants[arm]
  await migrate(db, variant.files.filter(file => file.path.startsWith(variant.migrationRoot + "/") && file.path.endsWith(".sql")).sort((a, b) => a.path.localeCompare(b.path)))
  const now = "2026-10-07T00:00:00.000Z"
  await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("architecture-owner", "Fixture", "fixture@example.invalid", now).run()
  await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("architecture-key", "Fixture", API_KEY, now, "architecture-owner", 0, cell.dump ? 3600 : null).run()
  const config = { name: "Fixture", baseUrl: `${base}/v1`, apiKey: SECRET, authStyle: "bearer", endpoints: ["chat_completions"], models: ["bench-chat-ok"] }
  await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind("custom:architecture-chat", "architecture-owner", "custom", "Fixture", JSON.stringify(config), '[{"id":"direct_fetch"}]', now, now).run()
}
async function abTables(db: TestDatabase) {
  const tables: Record<string, Obj[]> = {}
  // Both frozen A/B schemas contain these native tables. Do not use R's metric projection.
  for (const table of ["dump_records", "spilled_files", "responses_items", "responses_snapshots", "usage", "usage_requests", "performance_summary", "performance_latency_buckets", "performance_metrics"]) tables[table] = (await db.prepare(`SELECT * FROM ${table}`).all<Obj>()).results
  return tables
}
export function verifyAbSideEffects(tables: Record<string, Obj[]>, count: number, dump: boolean) {
  for (const table of ["responses_items", "responses_snapshots"]) if (tables[table]!.length) throw new Error(`Unexpected warm retained history: ${table}`)
  if (!dump && (tables.dump_records!.length || tables.spilled_files!.length)) throw new Error("Dump-disabled A/B window persisted diagnostic rows")
  const usage = tables.usage!, requests = tables.usage_requests!
  const dimensions = (row: Obj) => row.key_id === "architecture-key" && row.model === "bench-chat-ok" && row.upstream === "custom:architecture-chat" && row.model_key === "bench-chat-ok" && typeof row.hour === "string"
  if (!usage.length || !requests.length || usage.some(row => !dimensions(row) || !["input", "output"].includes(String(row.dimension)) || !Number.isSafeInteger(row.tokens) || Number(row.tokens) < 0) || requests.some(row => !dimensions(row) || !Number.isSafeInteger(row.requests) || Number(row.requests) <= 0)) throw new Error("Invalid native A/B usage dimensions")
  for (const [dimension, tokens] of [["input", 7], ["output", 3]] as const) if (usage.filter(row => row.dimension === dimension).reduce((sum, row) => sum + Number(row.tokens), 0) !== count * tokens) throw new Error(`A/B warm usage mismatch: ${dimension}`)
  if (requests.reduce((sum, row) => sum + Number(row.requests), 0) !== count) throw new Error("A/B warm request count mismatch")
  const summaries = tables.performance_summary ?? [], buckets = tables.performance_latency_buckets ?? []
  const nativeDimensions = ["hour", "key_id", "model", "upstream", "metric_scope", "source_api", "target_api", "stream", "runtime_location", "operation"]
  const identity = (row: Obj) => JSON.stringify(nativeDimensions.map(key => row[key]))
  const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  const validPerformance = (row: Obj) => typeof row.hour === "string" && row.key_id === "architecture-key" && row.model === "bench-chat-ok" && row.upstream === "custom:architecture-chat" && row.metric_scope === "request_total" && row.source_api === "chat-completions" && row.target_api === "chat-completions" && [0, 1].includes(Number(row.stream)) && typeof row.stream === "number" && row.runtime_location === "cloudflare" && row.operation === null
  if (!summaries.length || new Set(summaries.map(identity)).size !== summaries.length || summaries.some(row => !validPerformance(row) || !integer(row.requests) || Number(row.requests) <= 0 || row.errors !== 0 || !integer(row.total_ms_sum)) || summaries.reduce((sum, row) => sum + Number(row.requests), 0) !== count) throw new Error("Invalid native A/B performance summary counts/dimensions")
  if (!buckets.length || new Set(buckets.map(row => JSON.stringify([identity(row), row.lower_ms, row.upper_ms]))).size !== buckets.length || buckets.some(row => !validPerformance(row) || !integer(row.count) || Number(row.count) <= 0 || !integer(row.lower_ms) || !(row.upper_ms === null || integer(row.upper_ms) && Number(row.upper_ms) > Number(row.lower_ms)) || !summaries.some(summary => identity(summary) === identity(row)))) throw new Error("Invalid native A/B performance latency buckets")
  for (const summary of summaries) if (buckets.filter(row => identity(row) === identity(summary)).reduce((sum, row) => sum + Number(row.count), 0) !== summary.requests) throw new Error("Native A/B latency bucket coverage mismatch")
  const metrics = tables.performance_metrics ?? []
  if (!metrics.length || new Set(metrics.map(row => JSON.stringify([row.hour, row.key_id, row.dimensions, row.metric, row.upper]))).size !== metrics.length) throw new Error("Missing/duplicate native A/B modern performance metrics")
  const groups = new Map<string, { summary: Obj; rows: Obj[] }>()
  for (const row of metrics) {
    if (row.key_id !== "architecture-key" || typeof row.hour !== "string" || typeof row.dimensions !== "string" || !integer(row.count) || Number(row.count) <= 0 || typeof row.upper !== "number" || !Number.isFinite(row.upper) || row.upper < -1 || ["sum", "min", "max"].some(key => typeof row[key] !== "number" || !Number.isFinite(row[key]) || Number(row[key]) < 0) || Number(row.min) > Number(row.max)) throw new Error("Invalid native A/B modern metric row")
    const dims = JSON.parse(row.dimensions) as Obj
    if (!dims || typeof dims !== "object" || Array.isArray(dims) || dims.incomingModel !== "bench-chat-ok" || dims.model !== "bench-chat-ok" || dims.upstream !== "custom:architecture-chat" || dims.sourceApi !== "chat-completions" || dims.targetApi !== "chat-completions" || typeof dims.stream !== "boolean" || dims.runtimeLocation !== "cloudflare" || dims.outcome !== "success" || dims.inputBucket !== "<1k" || dims.cacheStatus !== "unknown" || dims.reasoningEffort !== "unknown") throw new Error("Invalid native A/B modern metric dimensions")
    const matches = summaries.filter(summary => summary.hour === row.hour && summary.stream === Number(dims.stream))
    if (matches.length !== 1) throw new Error("Native A/B modern metric has no corresponding summary")
    const key = JSON.stringify([row.hour, row.dimensions])
    const group = groups.get(key) ?? { summary: matches[0]!, rows: [] }
    group.rows.push(row); groups.set(key, group)
  }
  if (groups.size !== summaries.length) throw new Error("Native A/B modern group population mismatch")
  for (const { summary, rows } of groups.values()) {
    const requests = rows.filter(row => row.metric === "__requests")
    if (requests.length !== 1 || requests[0]!.upper !== -1 || requests[0]!.count !== summary.requests || requests[0]!.sum !== summary.requests || requests[0]!.min !== 0 || requests[0]!.max !== 0) throw new Error("Native A/B modern request coverage mismatch")
    for (const metric of ["totalMs", "upstreamMs", "inputTokens", "outputTokens", ...(summary.stream === 1 ? ["ttftMs", "firstTextMs"] : [])]) {
      const points = rows.filter(row => row.metric === metric && row.upper === -1)
      if (points.length !== 1 || points[0]!.count !== summary.requests) throw new Error(`Native A/B required metric coverage mismatch: ${metric}`)
    }
    const point = (metric: string) => rows.find(row => row.metric === metric && row.upper === -1)!
    if (point("totalMs").sum !== summary.total_ms_sum || point("inputTokens").sum !== Number(summary.requests) * 7 || point("outputTokens").sum !== Number(summary.requests) * 3) throw new Error("Native A/B modern metric totals disagree with legacy/usage")
    for (const metric of new Set(rows.filter(row => row.metric !== "__requests").map(row => String(row.metric)))) {
      const points = rows.filter(row => row.metric === metric && row.upper === -1), histogram = rows.filter(row => row.metric === metric && row.upper !== -1)
      if (points.length !== 1 || points[0]!.count !== summary.requests || !histogram.length || histogram.some(row => row.upper === -1 || row.sum !== 0 || row.min !== 0 || row.max !== 0) || histogram.reduce((sum, row) => sum + Number(row.count), 0) !== points[0]!.count) throw new Error(`Native A/B modern histogram coverage mismatch: ${metric}`)
    }
  }
  return { passed: true as const, historyDisabled: true as const, requests: count, performanceQualification: "native request_total summary, latency buckets and modern metric populations/counts verified" }
}
async function emptyBucket(bucket: TestBucket) {
  const list = await bucket.list({ limit: 1 })
  if (list.truncated || list.objects.length) throw new Error("Dump-disabled A/B window persisted R2 objects")
}

function artifactIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(artifactIdentity).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Obj
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${artifactIdentity(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
function assertArtifactEqual(left: unknown, right: unknown, label: string) {
  if (artifactIdentity(left) !== artifactIdentity(right)) throw new Error(`Saved readback artifact mismatch: ${label}`)
}
export function verifySavedAbSideEffects(saved: { tables: Record<string, Obj[]>; semantic: unknown }, readback: { tables: Record<string, Obj[]>; semantic: unknown }, count: number, dump: boolean) {
  assertArtifactEqual(saved.tables, readback.tables, "A/B native tables")
  const semantic = verifyAbSideEffects(saved.tables, count, dump)
  assertArtifactEqual(semantic, saved.semantic, "A/B saved semantic receipt")
  assertArtifactEqual(semantic, readback.semantic, "A/B runtime semantic receipt")
  return semantic
}

/** Independently qualify the saved fresh-host job and process receipts. */
export function verifyWarmInstanceArtifacts(directory: string, window: WarmWindowPlan, dispatches: Dispatch[]) {
  const bytes = readFileSync(join(directory, "instance-job.json"))
  const job = JSON.parse(bytes.toString("utf8")) as { version: number; kind: string; directory: string; parentPid: number; context: { path: string; sha256: string }; window: WarmWindowPlan }
  const result = JSON.parse(readFileSync(join(directory, "instance-result.json"), "utf8")) as { completed: boolean; jobSha256: string; contextSha256: string; dispatches: Dispatch[] }
  const processReceipt = JSON.parse(readFileSync(join(directory, "instance-process.json"), "utf8")) as { pid: number; parentPid: number; parentGroup: number; detached: boolean; exitCode: number; timedOut: boolean; spawnError: string | null; signal: string | null; finished: boolean; groupClean: boolean; remaining: unknown[] }
  if (job.version !== 1 || job.kind !== "warm-window" || typeof job.directory !== "string" || resolve(job.directory) !== resolve(directory)) throw new Error("Saved warm instance job identity mismatch")
  assertArtifactEqual(job.window, window, "warm instance frozen window")
  if (!job.context || typeof job.context.path !== "string" || !/^[a-f0-9]{64}$/.test(job.context.sha256) || sha(readFileSync(job.context.path)) !== job.context.sha256) throw new Error("Saved warm instance context SHA mismatch")
  if (result.completed !== true || result.jobSha256 !== sha(bytes) || result.contextSha256 !== job.context.sha256 || !Array.isArray(result.dispatches)) throw new Error("Saved warm instance result identity mismatch")
  assertArtifactEqual(result.dispatches, dispatches, "warm instance dispatches")
  if (!Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || processReceipt.parentPid !== job.parentPid || processReceipt.parentGroup !== processReceipt.parentPid || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 0 || processReceipt.pid === processReceipt.parentPid || processReceipt.exitCode !== 0 || processReceipt.timedOut !== false || processReceipt.spawnError !== null || processReceipt.signal !== null || processReceipt.finished !== true || processReceipt.groupClean !== true || processReceipt.detached !== false || !Array.isArray(processReceipt.remaining) || processReceipt.remaining.length !== 0) throw new Error("Saved warm instance process qualification failed")
  return { passed: true as const, jobSha256: result.jobSha256, contextSha256: result.contextSha256 }
}

/** Re-read artifacts and raw wire independently; never trust a cached aggregate result. */
export function reaggregateWarmOutput(output: string) {
  const plan = JSON.parse(readFileSync(join(output, "experiment-plan.json"), "utf8")) as WarmPlan
  const evidence: WarmWindowEvidence[] = []
  const artifactErrors: string[] = []
  let checkedRows = 0
  for (const window of plan.windows) {
    const directory = join(output, "windows", window.id)
    try {
      const identity = JSON.parse(readFileSync(join(directory, "identity.json"), "utf8")) as WarmWindowEvidence["identity"]
      const observations = JSON.parse(readFileSync(join(directory, "observations.json"), "utf8")) as WarmWindowEvidence["observations"] & { rows: QualifiedRow[]; dispatches: Dispatch[] }
      const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")) as { completed: boolean; readback: WarmWindowEvidence["readback"] }
      // Preserve the resource/population evidence even if independent wire verification fails.
      evidence.push({ id: window.id, block: window.block, arm: window.arm, cell: window.cell.id, completed: receipt.completed, identity, observations, readback: receipt.readback })
      verifyWarmInstanceArtifacts(directory, window, observations.dispatches)
      checkedRows += verifyWarmWireRows(observations.rows).checkedRows
      if (window.arm === "R") {
        const readback = receipt.readback as { storage: Awaited<ReturnType<typeof readReferenceStorage>>; semantic: unknown }
        const storage = JSON.parse(readFileSync(join(directory, "reference-storage.json"), "utf8")) as Awaited<ReturnType<typeof readReferenceStorage>>
        assertArtifactEqual(storage, readback.storage, "R saved native storage")
        const semantic = verifyReferenceReadback(storage, observations.rows, observations.dispatches)
        assertArtifactEqual(semantic, readback.semantic, "R runtime semantic receipt")
        const saved = JSON.parse(readFileSync(join(directory, "reference-semantic-receipt.json"), "utf8")) as unknown
        assertArtifactEqual(semantic, saved, "R saved semantic receipt")
      } else {
        const saved = JSON.parse(readFileSync(join(directory, "ab-side-effects.json"), "utf8")) as { tables: Record<string, Obj[]>; semantic: unknown }
        verifySavedAbSideEffects(saved, receipt.readback as { tables: Record<string, Obj[]>; semantic: unknown }, observations.rows.length, window.cell.dump)
      }
    } catch (error) { artifactErrors.push(`${window.id}: ${String(error)}`) }
  }
  const aggregate = aggregateWarmRun(plan, evidence)
  return { ...aggregate, comparisonQualified: aggregate.comparisonQualified && artifactErrors.length === 0, errors: [...aggregate.errors, ...artifactErrors], rawWire: { comparator: "warm-raw-wire-v1", passed: artifactErrors.length === 0, checkedRows }, offlineReadback: "saved native storage/table evidence and semantic receipts reverified; no fresh physical R2 read", comparability: { matchedFormatDiagnosticsOffCell: "sse-string-common", equalWorkClaim: false, completeDiagnostics: "full cells preserve different diagnostic guarantees", json: "A/B JSON-to-JSON; R SSE-to-JSON" } }
}

/** Execute one frozen window; the coordinator owns building and input qualification. */
export async function runWarmWindow(manifest: Manifest, referenceRoot: string, reference: Awaited<ReturnType<typeof buildReference>>, window: WarmWindowPlan, directory: string): Promise<Dispatch[]> {
  return runWindow(manifest, referenceRoot, reference, window, directory)
}

export type AbWarmWindowPlan = Omit<WarmWindowPlan, "warmup" | "timed" | "arm"> & { arm: "A" | "B"; warmup: number; timed: number }
export async function runAbWarmWindow(manifest: Manifest, arm: "A" | "B", window: AbWarmWindowPlan, directory: string, observer?: ObserverConfig): Promise<Dispatch[]> {
  if (window.arm !== arm) throw new Error("A/B warm window arm mismatch")
  return runWindow(manifest, "", undefined, window, directory, observer)
}

async function runWindow(manifest: Manifest, referenceRoot: string, reference: Awaited<ReturnType<typeof buildReference>> | undefined, window: Omit<WarmWindowPlan, "warmup" | "timed"> & { warmup: number; timed: number }, directory: string, observer?: ObserverConfig): Promise<Dispatch[]> {
  if (window.arm === "R" && !reference) throw new Error("Reference warm window requires its frozen build")
  const migrations = reference ? referenceMigrationInputs(reference) : []
  const { arm, cell } = window
  let bundle: string
  if (arm === "R") { if (!reference) throw new Error("Missing reference build"); bundle = reference.bundle }
  else bundle = manifest.variants[arm].bundle
  return runQualifiedInstance({ arm, bundle, directory, hooks: false, ...(observer ? { observer } : {}), window: { id: window.id, cell, warmup: window.warmup, timed: window.timed },
    async initialize(db, base) {
      if (arm !== "R") return initializeAb(db, base, manifest, arm, cell)
      if (!reference) throw new Error("Missing reference build during initialization")
      await migrate(db, migrations)
      const seed = await seedReference(db, { referenceRoot, baseUrl: base, apiKey: API_KEY, fixtureSecret: SECRET, dump: cell.dump, model: "bench-chat-ok" })
      for (const input of seed.hostInputs) if (!reference.inputs.some(frozen => frozen.path === input.path && frozen.sha256 === input.sha256)) throw new Error(`Reference seed host helper differs from build inputs: ${input.path}`)
      durableJson(join(directory, "seed-receipt.json"), seed, true)
    },
    async readback(db, bucket, rows, dispatches) {
      if (rows.length !== window.warmup + window.timed || dispatches.length !== rows.length) throw new Error("Warm window full population mismatch")
      if (arm === "R") {
        const storage = await readReferenceStorage(db, bucket)
        durableJson(join(directory, "reference-storage.json"), storage, true)
        const semantic = verifyReferenceReadback(storage, rows, dispatches)
        durableJson(join(directory, "reference-semantic-receipt.json"), semantic, true)
        const sink = referenceSinkCounts(storage)
        return { evidence: { storage, semantic }, objectCount: sink.objects, compressedBytes: sink.compressedBytes }
      }
      const tables = await abTables(db)
      const semantic = verifyAbSideEffects(tables, rows.length, cell.dump)
      durableJson(join(directory, "ab-side-effects.json"), { tables, semantic }, true)
      const nativeDump = observer ? await readAndSaveNativeDumps({ directory, db, bucket, rows, dispatches, arm, dump: cell.dump }) : null
      if (!cell.dump) {
        if (rows.some(row => row.dumpRecordId !== null)) throw new Error("Dump-disabled window returned dump identity")
        if (!nativeDump) await emptyBucket(bucket)
        return { evidence: { tables, semantic, ...(nativeDump ? { storage: nativeDump.storage, nativeDumpEvidence: nativeDump.evidence } : {}) }, objectCount: 0, compressedBytes: 0 }
      }
      const storage = nativeDump?.storage ?? await readDumps(db, bucket, rows.map(row => ({ ...row, variant: arm })), dispatches, { checked: new Set() }, arm)
      const objects = storage.newRecords.flatMap(value => {
        const record = value as { objects?: { compressedBytes: number }[] }
        if (!Array.isArray(record.objects) || record.objects.some(object => !Number.isSafeInteger(object.compressedBytes) || object.compressedBytes < 0)) throw new Error("Invalid A/B physical receipt")
        return record.objects
      })
      return { evidence: { storage, tables, semantic, ...(nativeDump ? { nativeDumpEvidence: nativeDump.evidence } : {}) }, objectCount: objects.length, compressedBytes: objects.reduce((sum, object) => sum + object.compressedBytes, 0) }
    },
  })
}

/** Fixed bounded pilot. Cold independent windows receive identical premeasurement warmup. */
export async function warmComparison(manifestPath: string, referenceRoot: string, output: string) {
  const manifest = loadManifest(manifestPath)
  mkdirSync(output, { recursive: true })
  const plan = freezeWarmPlan({ runId: "warm-pilot-v1" })
  durableJson(join(output, "experiment-plan.json"), plan, true)
  durableJson(join(output, "run-context.json"), { scope: "bounded-pilot; not formal statistical qualification", concurrency: 1, sourceManifest: fileIdentity(manifestPath), runtime: manifest.runtime, compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"], diagnostics: "hooks=false; no Inspector, heap or trace collection; EOF and settlement preserved", windowStorage: "independent isolated instance for every window; readback includes warmup and timed populations", commonSourceFormatDiagnosticsOffCells: ["sse-string-common"], jsonSourceFormat: "A/B JSON-to-JSON; R SSE-to-JSON, including json-string-common; complete behavior only" }, true)
  durableJson(join(output, "disposition.json"), { completed: false, comparisonCompleted: false, scope: "bounded warm three-arm pilot" }, true)
  verifyFiles([...manifest.variants.A.files, ...manifest.variants.B.files, ...manifest.dependencies, ...manifest.artifacts])
  const reference = await deadline("warm reference build", 120000, () => buildReference(referenceRoot, join(output, "R-build")))
  referenceMigrationInputs(reference)
  durableJson(join(output, "reference-inputs.json"), { root: referenceRoot, inputs: reference.inputs, bundle: fileIdentity(reference.bundle), resolutionNotes: reference.resolutionNotes }, true)
  const context = writeInstanceContext(join(output, "instance-context.json"), { manifest, referenceRoot, reference })
  const completed: { id: string; arm: Arm; directory: string; receipt: string; observations: string }[] = []
  for (const window of plan.windows) {
    const { arm } = window
    const directory = join(output, "windows", window.id)
    await runInstanceJob({ kind: "warm-window", directory, context, window })
    completed.push({ id: window.id, arm, directory, receipt: join(directory, "receipt.json"), observations: join(directory, "observations.json") })
    durableJson(join(output, "window-progress.json"), { completed, expected: plan.windows.length, comparisonCompleted: false })
  }
  verifyFiles([...manifest.variants.A.files, ...manifest.variants.B.files, ...manifest.dependencies, ...manifest.artifacts])
  for (const input of reference.inputs) if (sha(readFileSync(input.path)) !== input.sha256) throw new Error(`Warm reference input drift: ${input.path}`)
  durableJson(join(output, "window-index.json"), { completed: true, windows: completed, comparisonCompleted: false, scope: "bounded-pilot; root aggregator must verify window population before statistical interpretation" }, true)
  const summary = reaggregateWarmOutput(output)
  durableJson(join(output, "warm-summary.json"), summary, true)
  if (!summary.comparisonQualified) throw new Error("Warm pilot artifact qualification failed; preserve warm-summary.json")
  durableJson(join(output, "disposition.json"), { completed: true, warmComparisonCompleted: true, comparisonCompleted: false, scope: "bounded warm three-arm pilot; complete profile, peak and stress remain unmeasured" })
}
if (import.meta.main) {
  const [manifest, root, output, supervised] = process.argv.slice(2)
  if (!manifest || !root || !output || supervised !== "--supervised") throw new Error("Use supervised run.ts warm-pilot")
  try { await warmComparison(manifest, root, output) }
  catch (error) { durableJson(join(output, "disposition.json"), { completed: false, comparisonCompleted: false, fatal: String(error) }); throw error }
}
