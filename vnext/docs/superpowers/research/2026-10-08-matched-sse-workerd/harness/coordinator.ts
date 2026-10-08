import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, sha, verifyExecution, verifyFiles, type Manifest, type FileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { writeInstanceContext } from "../../2026-10-07-reference-stage-measurement/harness/instance-job"
import type { buildReference, readReferenceStorage } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import { referenceMigrationInputs } from "../../2026-10-07-reference-stage-measurement/harness/reference-qualify"
import { verifyReferenceReadback } from "../../2026-10-07-reference-stage-measurement/harness/reference-oracle"
import type { Dispatch, QualifiedRow } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { verifySavedAbSideEffects, verifyWarmInstanceArtifacts } from "../../2026-10-07-reference-stage-measurement/harness/warm"
import { verifyWarmWireRows } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { aggregateMatchedRun, freezeMatchedPlan, verifyUpstreamMetrics, type MatchedPlan, type MatchedWindowEvidence } from "./contracts"

import { runMatchedInstanceJob } from "./instance-job"
import { verifySavedNativeDumpReadback } from "./saved-dumps"
import { verifyMatchedBundleIdentity } from "./inputs"

type Obj = Record<string, unknown>
export interface MatchedContext {
  /** The old A slot is a type adapter only; this coordinator never reads it. */
  manifest: Manifest
  referenceRoot: string
  reference: Awaited<ReturnType<typeof buildReference>>
  plan?: MatchedPlan
}
export function verifyMatchedWindowIndex(output: string, plan: MatchedPlan) {
  const index = readJson<{ completed: boolean; expected: number; fatal?: unknown; windows: { id: string; arm: string; directory: string; receipt: string; observations: string }[] }>(join(output, "window-index.json"))
  if (index.completed !== true || index.fatal !== undefined || index.expected !== plan.expectedWindows || !Array.isArray(index.windows) || index.windows.length !== plan.windows.length || new Set(index.windows.map(window => window.id)).size !== plan.windows.length) throw new Error("Incomplete/fatal/duplicate matched window index")
  for (const [position, window] of plan.windows.entries()) {
    const entry = index.windows[position], directory = resolve(output, "windows", window.id)
    if (!entry || entry.id !== window.id || entry.arm !== window.arm || resolve(entry.directory) !== directory || resolve(entry.receipt) !== join(directory, "receipt.json") || resolve(entry.observations) !== join(directory, "observations.json")) throw new Error(`Matched window index differs from frozen order: ${window.id}`)
  }
  const windowsRoot = join(output, "windows")
  if (existsSync(windowsRoot)) for (const entry of readdirSync(windowsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !plan.windows.some(window => window.id === entry.name)) throw new Error(`Unexpected matched window directory: ${entry.name}`)
  }
  return { passed: true as const }
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}
function assertEqual(left: unknown, right: unknown, label: string) {
  if (canonical(left) !== canonical(right)) throw new Error(`Saved matched artifact differs: ${label}`)
}

/** Verify B/R frozen sources and executable bytes; no historical A or tool manifest. */
export function verifyMatchedInputs(context: MatchedContext) {
  const { manifest, reference, referenceRoot } = context
  if (!manifest?.variants?.B?.files?.length || !reference?.inputs?.length || !referenceRoot || !manifest.execution) throw new Error("Missing frozen matched B/R inputs")
  verifyExecution(manifest.execution)
  verifyFiles([...manifest.variants.B.files, ...manifest.dependencies, ...manifest.artifacts])
  for (const bundle of [manifest.variants.B.bundle, reference.bundle]) {
    if (!manifest.artifacts.some(file => file.path === resolve(bundle))) throw new Error(`Matched bundle is missing frozen artifact identity: ${bundle}`)
  }
  for (const input of reference.inputs) {
    if (!resolve(input.path).startsWith(resolve(referenceRoot) + "/") || sha(readFileSync(input.path)) !== input.sha256) throw new Error(`Matched reference input drift: ${input.path}`)
  }
  referenceMigrationInputs(reference)
}

/** Re-parse wire bytes and native tables instead of trusting the cached aggregate. */
export async function reaggregateMatchedOutput(output: string) {
  const plan = readJson<MatchedPlan>(join(output, "experiment-plan.json"))
  const evidence: MatchedWindowEvidence[] = [], artifactErrors: string[] = []
  let checkedRows = 0, nativeWindows = 0, upstreamTtftSamples = 0
  let context: MatchedContext | undefined
  try { context = readJson<MatchedContext>(join(output, "instance-context.json")) } catch (error) { artifactErrors.push(`Missing matched source context: ${String(error)}`) }
  try { verifyMatchedWindowIndex(output, plan) } catch (error) { artifactErrors.push(`Run index: ${String(error)}`) }
  for (const window of plan.windows) {
    const directory = join(output, "windows", window.id)
    let current: MatchedWindowEvidence | undefined
    try {
      // Preserve measured rows/resources even when readback or completion never succeeded.
      const observations = readJson<MatchedWindowEvidence["observations"] & { rows: QualifiedRow[]; dispatches: Dispatch[] }>(join(directory, "observations.json"))
      current = { id: window.id, block: window.block, arm: window.arm, cell: window.cell.id, completed: false, identity: { hooks: true, inspector: { missing: true } }, observations, readback: {} }
      evidence.push(current)
      current.identity = readJson<MatchedWindowEvidence["identity"]>(join(directory, "identity.json"))
      if (!context) throw new Error("Missing matched source context")
      verifyMatchedBundleIdentity(context, window.arm, (current.identity as { workerBundle?: unknown }).workerBundle)
      const receipt = readJson<{ completed: boolean; readback: MatchedWindowEvidence["readback"] }>(join(directory, "receipt.json"))
      current.completed = receipt.completed
      current.readback = receipt.readback
      verifyWarmInstanceArtifacts(directory, window, observations.dispatches)
      for (const name of ["instance-job.json", "instance-result.json"]) if (readJson<{ adapter?: unknown }>(join(directory, name)).adapter !== "matched-sse-instance-v1") throw new Error("Matched instance adapter identity mismatch")
      checkedRows += verifyWarmWireRows(observations.rows).checkedRows
      if (window.arm === "R") {
        const readback = receipt.readback as { storage: Awaited<ReturnType<typeof readReferenceStorage>>; semantic: unknown }
        const storage = readJson<Awaited<ReturnType<typeof readReferenceStorage>>>(join(directory, "reference-storage.json"))
        assertEqual(storage, readback.storage, "R native storage")
        const semantic = verifyReferenceReadback(storage, observations.rows, observations.dispatches)
        assertEqual(semantic, readback.semantic, "R runtime semantic receipt")
        assertEqual(semantic, readJson<unknown>(join(directory, "reference-semantic-receipt.json")), "R saved semantic receipt")
      } else {
        const saved = readJson<{ tables: Record<string, Obj[]>; semantic: unknown }>(join(directory, "ab-side-effects.json"))
        verifySavedAbSideEffects(saved, receipt.readback as typeof saved, observations.rows.length, window.cell.dump)
        const physical = receipt.readback as typeof saved & { storage: unknown; nativeDumpEvidence: FileIdentity }
        await verifySavedNativeDumpReadback({ directory, rows: observations.rows, dispatches: observations.dispatches, arm: "B", dump: window.cell.dump, evidence: physical.nativeDumpEvidence, storage: physical.storage })
        upstreamTtftSamples += verifyUpstreamMetrics(saved.tables, observations.dispatches.length, window.cell.stream).upstreamTtftSamples
      }
      nativeWindows++
    } catch (error) {
      artifactErrors.push(`${window.id}: ${String(error)}`)
      // Resource and offered-work denominators remain visible for an unqualified window.
      if (current) current.completed = false
    }
  }
  const aggregate = aggregateMatchedRun(plan, evidence)
  return { ...aggregate, comparisonQualified: aggregate.comparisonQualified && artifactErrors.length === 0, errors: [...aggregate.errors, ...artifactErrors], rawWire: { comparator: "warm-raw-wire-v1", passed: artifactErrors.length === 0, checkedRows }, nativeReadback: { passed: artifactErrors.length === 0, checkedWindows: nativeWindows, upstreamTtftSamples, scope: "native physical dump readback during each instance; saved B SQL, inventory and original compressed R2 bytes replayed through the versioned reader; R native decoded storage/semantic receipts reverified; no fresh offline R2 read" } }
}

/** The caller supplies already-built artifacts and an outer supervised process group. */
export async function runMatchedComparison(contextPath: string, output: string): Promise<void> {
  output = resolve(output)
  if (existsSync(output)) throw new Error(`Matched output already exists: ${output}`)
  const contextBytes = readFileSync(contextPath), context = JSON.parse(contextBytes.toString("utf8")) as MatchedContext
  const plan = context.plan ?? freezeMatchedPlan({ runId: "matched-sse-v1" })
  assertEqual(plan, freezeMatchedPlan({ runId: plan.runId }), "frozen plan")
  verifyMatchedInputs(context)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  durableJson(join(output, "experiment-plan.json"), plan, true)
  durableJson(join(output, "disposition.json"), { completed: false, comparisonCompleted: false, scope: plan.scope }, true)
  const instanceContext = writeInstanceContext(join(output, "instance-context.json"), context)
  durableJson(join(output, "run-context.json"), { scope: plan.scope, sourceContext: fileIdentity(contextPath), contextSha256: sha(contextBytes), candidate: { head: context.manifest.variants.B.head, root: context.manifest.variants.B.root, bundle: fileIdentity(context.manifest.variants.B.bundle) }, reference: { root: context.referenceRoot, bundle: fileIdentity(context.reference.bundle) }, runtime: context.manifest.runtime, compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"], concurrency: 1, diagnostics: "hooks=false; observer absent; Inspector absent", windowStorage: "fresh owned child and isolated native D1/R2 for each window; five warmup and twenty timed offers", sourceFormat: "both B and R request upstream SSE for JSON and SSE downstream", measurement: "workerd process CPU through settlement and client EOF; RSS endpoints only; no client TTFT or peak-memory measurement" }, true)
  const completed: { id: string; arm: string; directory: string; receipt: string; observations: string }[] = []
  let fatal: unknown
  try {
    for (const window of plan.windows) {
      const directory = join(output, "windows", window.id)
      await runMatchedInstanceJob({ kind: "warm-window", directory, context: instanceContext, window })
      completed.push({ id: window.id, arm: window.arm, directory, receipt: join(directory, "receipt.json"), observations: join(directory, "observations.json") })
      durableJson(join(output, "window-progress.json"), { completed, expected: plan.windows.length, comparisonCompleted: false })
      console.log(`Matched SSE window ${completed.length}/${plan.windows.length}: ${window.id}`)
    }
    if (sha(readFileSync(contextPath)) !== sha(contextBytes)) throw new Error("Source matched context changed during run")
    verifyMatchedInputs(context)
  } catch (error) { fatal = error }
  durableJson(join(output, "window-index.json"), { completed: !fatal && completed.length === plan.windows.length, windows: completed, expected: plan.windows.length, comparisonCompleted: false, ...(fatal ? { fatal: String(fatal) } : {}) }, true)
  const summary = await reaggregateMatchedOutput(output)
  if (fatal) {
    summary.comparisonQualified = false
    summary.errors.push(`Coordinator failed: ${String(fatal)}`)
  }
  durableJson(join(output, "matched-summary.json"), summary, true)
  durableJson(join(output, "disposition.json"), { completed: !fatal && summary.comparisonQualified, matchedComparisonCompleted: !fatal && summary.comparisonQualified, comparisonCompleted: false, scope: plan.scope, formalStatisticsCompleted: false, peakMemoryMeasured: false, ...(fatal ? { fatal: String(fatal) } : {}) })
  if (fatal) throw fatal
  if (!summary.comparisonQualified) throw new Error("Matched SSE artifact qualification failed; inspect matched-summary.json")
}

if (import.meta.main) {
  const [first, second, supervised] = process.argv.slice(2)
  if (first === "--aggregate" && second && !supervised) console.log(JSON.stringify(await reaggregateMatchedOutput(resolve(second)), null, 2))
  else {
    if (!first || !second || supervised !== "--supervised") throw new Error("Use supervised coordinator.ts <context.json> <new-output> --supervised, or --aggregate <output>")
    await runMatchedComparison(resolve(first), resolve(second))
  }
}
