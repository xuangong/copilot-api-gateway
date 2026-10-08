import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { sha, verifyFiles, type Manifest, type FileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { selectTarget, type Inspector } from "../../2026-10-02-workerd-deployed-comparison/harness/inspector"
import { diffProcessResource, type ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"
import { verifyWarmWireRows, requestIdentity, type WarmSettlement } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { verifySavedAbSideEffects } from "../../2026-10-07-reference-stage-measurement/harness/warm"
import type { Dispatch, QualifiedRow } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { freezeObserverPlan, validateObserverJob, type ObserverPlan, type ObserverJob } from "./runner"
import { verifySavedNativeDumpReadback } from "./saved-dumps"
import { freezeMappingRuntimeInputs } from "./run"
import { type ObserverReceipt, type ObserverMode } from "./observer"
import { createProfileMapper, validateProfile, summarizeProfile, type FrameMapper } from "./profile"

type Obj = Record<string, unknown>
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null
export function verifyObserverLifecycle(receipt: ObserverReceipt, mode: ObserverMode) {
  check(receipt.mode === mode && receipt.completed === true && receipt.prepared === true && receipt.started === true && receipt.stopped === true && receipt.closeAttempted === true && receipt.closed === true && Array.isArray(receipt.errors) && receipt.errors.length === 0, "Incomplete observer lifecycle")
  if (mode === "none") check(receipt.inspector === null, "Unexpected Inspector in none mode")
  else {
    check(receipt.inspector !== null, "Missing Inspector identity")
    selectTarget([receipt.inspector.target], "reference-stage-B-control", new URL(receipt.inspector.inspectorURL))
  }
  if (mode !== "cpu") check(receipt.profile === null && receipt.v8 === null && receipt.startCommand === null && receipt.stopCommand === null && receipt.intervalUs === null, "Non-profile observer acquired CPU profile")
  else {
    check(receipt.profile && receipt.v8 && receipt.intervalUs === 1000, "Missing CPU profile receipt")
    const start = receipt.startCommand, stop = receipt.stopCommand
    check(start && stop && [start.beginMs, start.endMs, stop.beginMs, stop.endMs].every(value => Number.isFinite(value) && value >= 0) && start.beginMs <= start.endMs && start.endMs <= stop.beginMs && stop.beginMs <= stop.endMs, "Invalid host/CDP command ordering")
  }
}
export function frozenIdentity(inputs: readonly FileIdentity[], path: string): FileIdentity {
  const matches = inputs.filter(file => file.path === path)
  const first = matches[0]
  check(first, `Missing frozen identity: ${path}`)
  check(matches.every(file => equal(file, first)), `Conflicting frozen identities: ${path}`)
  return first
}
export function verifyProcessOwnership(outerPid: number, child: { pid: number; parentPid: number; parentGroup: number }, discovered: ProcessResource, start: ProcessResource) {
  check(Number.isSafeInteger(outerPid) && outerPid > 0 && child.parentPid === outerPid && child.parentGroup === outerPid && child.pid !== outerPid, "Child differs from outer process ownership")
  check(discovered.executableName === "workerd" && discovered.pid !== child.pid && discovered.pid !== outerPid, "Discovery is not a distinct workerd process")
  diffProcessResource(discovered, start)
}
function settled(value: WarmSettlement) {
  check(value.active === 0 && value.pending === 0 && Number.isSafeInteger(value.registered) && value.registered >= 0 && value.registered === value.settled && Array.isArray(value.failures) && !value.failures.length && value.observerFailures === 0 && value.unowned === 0, "Incomplete settlement")
}

/** Reopen saved evidence. This is not another physical storage read. */
export async function analyzeObserverRun(output: string) {
  const plan = read<ObserverPlan>(join(output, "experiment-plan.json")), expected = freezeObserverPlan()
  check(equal(plan, expected), "Observer plan differs from declared bounded design")
  const manifest = read<Manifest>(join(output, "frozen-manifest.json"))
  check(manifest.id === "05f341af-02b0-4c30-8c5d-9958b29ac722", "Wrong product manifest")
  const frozen = read<{ inputs: FileIdentity[]; mappingRuntimeInputs: FileIdentity[] }>(join(output, "inputs.json"))
  verifyFiles(frozen.inputs)
  check(equal(frozen.mappingRuntimeInputs, freezeMappingRuntimeInputs()), "Mapping runtime differs from frozen execution closure")
  for (const input of frozen.mappingRuntimeInputs) check(equal(input, frozenIdentity(frozen.inputs, input.path)), "Mapping runtime missing from experiment inputs")
  const supervision = read<{ pid: number; exitCode: number; signal: unknown; timedOut: boolean; interrupted: boolean; cleanupComplete: boolean }>(join(output, "supervision.json"))
  check(supervision.signal === null && supervision.exitCode === 0 && supervision.timedOut === false && supervision.interrupted === false && supervision.cleanupComplete === true, "Outer supervision failed")
  check(readdirSync(join(output, "windows")).sort().join("\n") === expected.windows.map(window => window.id).sort().join("\n"), "Window directory population differs")
  const errors: string[] = [], mappingFailures: string[] = []
  const windows: { id: string; cell: string; mode: ObserverMode; block: number; timed: number; cpuMs: number; cpuPerRequestMs: number; eofP50Ms: number | null; eofP95Ms: number | null; rssEndBytes: number; profile: ReturnType<typeof summarizeProfile> | null; mappingQualified: boolean | null }[] = []
  const workerdIdentities = new Set<string>(), childPids = new Set<number>(), normalizedRequests = new Map<string, Set<string>>()
  let warmup = 0, timed = 0
  for (const window of expected.windows) {
    const directory = join(output, "windows", window.id)
    try {
      const jobPath = join(directory, "instance-job.json"), jobBytes = readFileSync(jobPath), jobRaw = read<ObserverJob>(jobPath)
      const process = read<{ pid: number; parentPid: number; parentGroup: number; detached: boolean; exitCode: number; signal: unknown; timedOut: boolean; finished: boolean; spawnError: unknown; groupClean: boolean; remaining: unknown[] }>(join(directory, "instance-process.json"))
      validateObserverJob(jobBytes, sha(jobBytes), readFileSync(jobRaw.context.path), jobPath, process.parentPid, process.parentGroup)
      check(equal(jobRaw.window, window), "Wrong job window")
      const context = read<{ manifest: Manifest }>(jobRaw.context.path)
      check(equal(context.manifest, manifest), "Job context differs from frozen manifest")
      check(Number.isSafeInteger(process.pid) && process.pid > 0 && !childPids.has(process.pid) && process.detached === false && process.exitCode === 0 && process.signal === null && process.timedOut === false && process.finished === true && process.spawnError === null && process.groupClean === true && Array.isArray(process.remaining) && process.remaining.length === 0, "Child process ownership/cleanup failed")
      childPids.add(process.pid)
      const result = read<{ completed: boolean; jobSha256: string; contextSha256: string; dispatches: Dispatch[] }>(join(directory, "instance-result.json"))
      check(result.completed === true && result.jobSha256 === sha(jobBytes) && result.contextSha256 === jobRaw.context.sha256, "Invalid child result")
      const cleanup = read<{ completed: boolean; observerClosed: boolean; disposed: boolean; fixtureStopped: boolean; errors: unknown[] }>(join(directory, "cleanup-receipt.json"))
      check(cleanup.completed === true && cleanup.observerClosed === true && cleanup.disposed === true && cleanup.fixtureStopped === true && Array.isArray(cleanup.errors) && cleanup.errors.length === 0, "Incomplete runtime cleanup")
      const observer = read<ObserverReceipt>(join(directory, "observer-receipt.json"))
      verifyObserverLifecycle(observer, window.observer.mode)
      const identity = read<{ arm: string; hooks: boolean; observer: unknown; inspector: Inspector["identity"] | null; entry: FileIdentity; entryMap: FileIdentity; entrySource: FileIdentity; workerBundle: FileIdentity; processIdentity: ProcessResource }>(join(directory, "identity.json"))
      check(identity.arm === "B" && identity.hooks === false && equal(identity.observer, window.observer) && equal(identity.inspector, observer.inspector), "Observer/runtime identity mismatch")
      verifyFiles([identity.entry, identity.entryMap, identity.entrySource, identity.workerBundle])
      check(equal(identity.workerBundle, frozenIdentity(frozen.inputs, manifest.variants.B.bundle)), "Wrong frozen product bundle")
      const obs = read<{ rows: QualifiedRow[]; dispatches: Dispatch[]; rejected: number; processStart: ProcessResource; processEnd: ProcessResource; resources: ReturnType<typeof diffProcessResource>; warmupSettlement: WarmSettlement; settlement: WarmSettlement; traceResult: { traces: unknown[]; unowned: number; observerFailures: number } }>(join(directory, "observations.json"))
      verifyProcessOwnership(supervision.pid, process, identity.processIdentity, obs.processStart)
      const ids = (["warmup", "timed"] as const).flatMap(phase => Array.from({ length: phase === "warmup" ? window.warmup : window.timed }, (_, i) => requestIdentity(window.id, phase, i)))
      check(obs.rows.length === ids.length && new Set(obs.rows.map(row => row.id)).size === ids.length && ids.every(id => obs.rows.some(row => row.id === id)), "Wrong offer population")
      verifyWarmWireRows(obs.rows)
      for (const row of obs.rows) {
        const phase = row.id.startsWith(window.id + "-warmup-") ? "warmup" : "timed"
        check(row.arm === "B" && row.phase === phase && row.cell === window.cell.id && row.dump === window.cell.dump && row.stream === false && row.ok === true && row.status === 200 && Number.isFinite(row.eofMs) && row.eofMs >= 0, "Invalid terminal outcome")
        const offer = read<{ id: string; arm: string; cell: unknown; phase: string; requestSha256: string }>(join(directory, row.id + ".offer.json"))
        const terminal = read<{ id: string; arm: string; cell: string; phase: string; completed: boolean; ok: boolean }>(join(directory, row.id + ".terminal.json"))
        check(offer.id === row.id && offer.arm === "B" && equal(offer.cell, window.cell) && offer.phase === phase && offer.requestSha256 === row.requestSha256 && terminal.id === row.id && terminal.arm === "B" && terminal.cell === row.cell && terminal.phase === phase && terminal.completed === true && terminal.ok === true, "Offered/terminal journal mismatch")
        check(window.cell.dump ? typeof row.dumpRecordId === "string" && row.dumpRecordId.length > 0 : row.dumpRecordId === null, "Wrong dump policy")
      }
      check(obs.dispatches.length === ids.length && new Set(obs.dispatches.map(d => d.id)).size === ids.length && equal(result.dispatches, obs.dispatches) && obs.rejected === 0, "Wrong dispatch population")
      for (const dispatch of obs.dispatches) {
        check(ids.includes(dispatch.id) && dispatch.status === 200 && dispatch.requestedStream === false && dispatch.completed === true && dispatch.cancelled === false, "Wrong upstream format/outcome")
        const phase = dispatch.id.startsWith(window.id + "-warmup-") ? "warmup" : "timed"
        const hashes = normalizedRequests.get(phase) ?? new Set<string>()
        hashes.add(dispatch.normalizedRequestSha256); normalizedRequests.set(phase, hashes)
      }
      settled(obs.warmupSettlement); settled(obs.settlement)
      check(obs.settlement.registered >= obs.warmupSettlement.registered && Array.isArray(obs.traceResult.traces) && obs.traceResult.traces.length === 0 && obs.traceResult.unowned === 0 && obs.traceResult.observerFailures === 0, "Unexpected hooks/settlement regression")
      const delta = diffProcessResource(obs.processStart, obs.processEnd)
      check(equal(delta, obs.resources), "Resource delta mismatch")
      const processId = JSON.stringify([obs.processStart.pid, obs.processStart.startIdentity])
      check(!workerdIdentities.has(processId), "Reused workerd process")
      workerdIdentities.add(processId)
      const receipt = read<{ completed: boolean; qualifiedRequests: number; readback: { tables: Record<string, Obj[]>; semantic: unknown; nativeDumpEvidence: FileIdentity; storage: unknown } }>(join(directory, "receipt.json"))
      check(receipt.completed === true && receipt.qualifiedRequests === ids.length, "Invalid native readback receipt")
      verifySavedAbSideEffects(read(join(directory, "ab-side-effects.json")), receipt.readback, ids.length, window.cell.dump)
      await verifySavedNativeDumpReadback({ directory, rows: obs.rows, dispatches: obs.dispatches, arm: "B", dump: window.cell.dump, evidence: receipt.readback.nativeDumpEvidence, storage: receipt.readback.storage })
      let summary: ReturnType<typeof summarizeProfile> | null = null, mappingQualified: boolean | null = null
      if (window.observer.mode === "cpu") {
        check(observer.profile, "Missing profile")
        verifyFiles([observer.profile])
        const raw = read<unknown>(observer.profile.path), profile = validateProfile(raw)
        check(equal(read<{ profile: unknown }>(join(directory, "profiler-stop-result.json")).profile, raw) && equal(observer.v8, { startTime: profile.startTime, endTime: profile.endTime }), "Profile reply/identity mismatch")
        let mapper: FrameMapper = () => null
        try {
          mapper = createProfileMapper({ generatedConvention: "bun-1.3.0-crlf-double", entry: identity.entry, entryMap: identity.entryMap, bundle: identity.workerBundle, bundleMap: frozenIdentity(frozen.inputs, identity.workerBundle.path + ".map"), approved: [...manifest.variants.B.files, ...manifest.dependencies], harness: [identity.entrySource, ...frozen.inputs.filter(file => file.path.endsWith("/harness/probe-runtime.ts"))] })
          mappingQualified = true
        } catch (error) { mappingQualified = false; mappingFailures.push(`${window.id}: ${String(error)}`) }
        summary = summarizeProfile(profile, mapper)
      }
      warmup += window.warmup; timed += window.timed
      const latencies = obs.rows.filter(row => row.phase === "timed").map(row => row.eofMs)
      windows.push({ id: window.id, cell: window.cell.id, mode: window.observer.mode, block: window.block, timed: window.timed, cpuMs: delta.cpuUs / 1000, cpuPerRequestMs: delta.cpuUs / 1000 / window.timed, eofP50Ms: quantile(latencies, .5), eofP95Ms: quantile(latencies, .95), rssEndBytes: obs.processEnd.rssBytes, profile: summary, mappingQualified })
    } catch (error) { errors.push(`${window.id}: ${String(error)}`) }
  }
  for (const [phase, hashes] of normalizedRequests) check(hashes.size === 1, `Observer changed normalized upstream request bytes for ${phase}`)
  if (warmup !== expected.expectedWarmup || timed !== expected.expectedTimed || windows.length !== expected.expectedWindows) errors.push("Incomplete bounded experiment population")
  return { schema: "diagnostic-observer-analysis-v1", runtimeEvidenceQualified: errors.length === 0, sourceMapConvention: "bun-1.3.0-crlf-double; explicit generated-coordinate correction at both levels, original coordinates unchanged", sourceMappingQualified: errors.length === 0 && mappingFailures.length === 0, formalStatisticsCompleted: false, warmup, timed, total: warmup + timed, errors, mappingFailures, windows, scope: "B-only observer exploration; 2 reversed blocks do not establish noise/overhead bounds. Native storage was physically read during runtime; this analysis replays the same oracle from saved SQL/inventory/gzip bytes. Process CPU includes Profiler commands. Profile weights are not CPU. RSS endpoints are not peak or isolate memory." }
}

if (import.meta.main) {
  const [output, destination] = process.argv.slice(2)
  if (!output || !destination) throw new Error("Use analyze.ts RUN_DIR NEW_RESULT_PATH")
  const summary = await analyzeObserverRun(resolve(output))
  durableJson(resolve(destination), summary, true)
  console.log(JSON.stringify({ runtimeEvidenceQualified: summary.runtimeEvidenceQualified, sourceMappingQualified: summary.sourceMappingQualified, total: summary.total, errors: summary.errors, mappingFailures: summary.mappingFailures }))
  if (!summary.runtimeEvidenceQualified) process.exitCode = 2
}
