import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { buildReference, readReferenceStorage, seedReference, type ReferenceInput } from "./reference-adapter.ts"
import { hookTargets, patchSource } from "./instrumentation.ts"
import { sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { runInstanceJob, writeInstanceContext } from "./instance-job.ts"
import type { Dispatch } from "./runtime.ts"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"

/** Native migrations are qualified from the exact bytes consumed by the real build. */
export function referenceMigrationInputs(build: { migrationRoot: string; inputs: ReferenceInput[] }): ReferenceInput[] {
  const files = build.inputs.filter(input => input.path.startsWith(build.migrationRoot + "/") && input.path.endsWith(".sql")).sort((a, b) => a.path.localeCompare(b.path))
  if (new Set(files.map(input => input.path)).size !== files.length) throw new Error("Reference migration inputs contain duplicate paths")
  if (files.length !== 86) throw new Error(`Reference qualification requires exactly 86 migrations; got ${files.length}`)
  return files
}

export function verifyReferenceBuildAgreement(control: ReferenceInput[], probe: ReferenceInput[]): void {
  const left = new Map(control.map(input => [input.path, input.sha256]))
  const right = new Map(probe.map(input => [input.path, input.sha256]))
  if (left.size !== control.length || right.size !== probe.length || left.size !== right.size) throw new Error("Reference control/probe frozen input population differs")
  for (const [path, hash] of left) if (right.get(path) !== hash) throw new Error(`Reference control/probe input changed: ${path}`)
}

export function referenceSinkCounts(storage: { objects: { size: number }[]; compressedBytes: number }) {
  if (storage.objects.some(item => !Number.isSafeInteger(item.size) || item.size < 0)) throw new Error("Invalid reference physical byte count")
  const compressedBytes = storage.objects.reduce((sum, item) => sum + item.size, 0)
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes !== storage.compressedBytes) throw new Error("Reference physical compressed byte totals disagree")
  return { objects: storage.objects.length, compressedBytes }
}

/** Execute one frozen R instance inside its fresh host child. */
export async function runReferenceInstance(root: string, build: Awaited<ReturnType<typeof buildReference>>, directory: string, hooks: boolean): Promise<Dispatch[]> {
  const { runQualifiedInstance, API_KEY, SECRET } = await import("./runtime.ts")
  const { unstable_splitSqlQuery } = await import("../../../../../apps/platform-cloudflare/node_modules/wrangler")
  const { verifyReferenceReadback } = await import("./reference-oracle.ts")
  const migrations = referenceMigrationInputs(build)
  return runQualifiedInstance({
    arm: "R", bundle: build.bundle, directory, hooks,
    async initialize(db, base) {
      for (const input of migrations) {
        const bytes = readFileSync(input.path)
        if (sha(bytes) !== input.sha256) throw new Error(`Reference migration changed before execution: ${input.path}`)
        for (const sql of unstable_splitSqlQuery(bytes.toString("utf8"))) await deadline("reference migration", 15000, () => db.prepare(sql).run())
      }
      const seed = await seedReference(db, { referenceRoot: root, baseUrl: base, apiKey: API_KEY, fixtureSecret: SECRET, dump: true, model: "bench-chat-ok" })
      if (seed.hostInputs.some(input => !build.inputs.some(frozen => frozen.path === input.path && frozen.sha256 === input.sha256))) throw new Error("Reference seed consumed an unfrozen native helper")
      durableJson(join(directory, "migration-receipt.json"), { completed: true, migrations, count: migrations.length, seed: "reference-native-isolated-fixture", seedInputs: seed.hostInputs }, true)
    },
    async readback(db, bucket, rows, dispatches) {
      const storage = await deadline("reference physical readback", 30000, () => readReferenceStorage(db, bucket))
      durableJson(join(directory, "reference-storage.json"), storage, true)
      const semantic = verifyReferenceReadback(storage, rows, dispatches)
      durableJson(join(directory, "reference-semantic-receipt.json"), semantic, true)
      const sink = referenceSinkCounts(storage)
      return { evidence: { storage, semantic }, objectCount: sink.objects, compressedBytes: sink.compressedBytes }
    },
  })
}

/** Called only in the supervisor child. This is a canary, never a performance benchmark. */
export async function qualifyReference(root: string, output: string) {
  root = realpathSync(root)
  mkdirSync(output, { recursive: true })
  durableJson(join(output, "disposition.json"), { completed: false, comparisonCompleted: false, scope: "R observer qualification only" }, true)
  const control = await deadline("reference control build", 120000, () => buildReference(root, join(output, "R-control-build")))
  const applied = new Set<string>()
  const probe = await deadline("reference diagnostic build", 120000, () => buildReference(root, join(output, "R-probe-build"), {
    transform(path, source) {
      const result = patchSource("R", path, source)
      if (result.applied.length) applied.add(path)
      return result
    },
  }))
  const missing = hookTargets("R").filter(path => !applied.has(path))
  durableJson(join(output, "R-hook-coverage.json"), { completed: !missing.length, expected: hookTargets("R"), applied: [...applied], missing }, true)
  if (missing.length) throw new Error(`Incomplete reference source hook coverage: ${missing.join(", ")}`)
  verifyReferenceBuildAgreement(control.inputs, probe.inputs)
  referenceMigrationInputs(control)
  referenceMigrationInputs(probe)
  const context = writeInstanceContext(join(output, "instance-context.json"), { referenceRoot: root, control, probe })
  const instances = []
  for (const hooks of [false, true]) {
    const directory = join(output, hooks ? "R-probe" : "R-control")
    const dispatches = await runInstanceJob({ kind: "reference-canary", directory, context, hooks })
    instances.push(dispatches)
  }
  const [before, after] = instances
  if (!before || !after || instances.length !== 2) throw new Error("Reference observer instances incomplete")
  if (before.length !== after.length || before.some((dispatch, index) => {
    const other = after[index]
    return !other || dispatch.normalizedRequestSha256 !== other.normalizedRequestSha256 || dispatch.bodyBytes !== other.bodyBytes || dispatch.requestedStream !== other.requestedStream || dispatch.responseBytes !== other.responseBytes
  })) throw new Error("Observer changed reference upstream work")
  durableJson(join(output, "R-observer-equivalence.json"), { completed: true, scope: "R control/probe full upstream request bytes normalized only for equal-length BENCH_ID; native source format retained", control: before, probe: after }, true)
  for (const input of control.inputs) if (sha(readFileSync(input.path)) !== input.sha256) throw new Error(`Reference input changed after qualification: ${input.path}`)
  durableJson(join(output, "disposition.json"), { completed: true, comparisonCompleted: false, scope: "R observer qualification only" })
}

if (import.meta.main) {
  const [root, output, supervised] = process.argv.slice(2)
  if (!root || !output || supervised !== "--supervised") throw new Error("Use run.ts qualify-reference --reference-root PATH --manifest PATH --out NEW_DIR")
  try { await qualifyReference(root, output) }
  catch (error) {
    durableJson(join(output, "disposition.json"), { completed: false, comparisonCompleted: false, fatal: String(error) })
    throw error
  }
}
