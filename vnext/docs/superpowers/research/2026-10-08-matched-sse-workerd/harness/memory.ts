import { execFileSync, spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, verifyFiles, type FileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { deadline, supervise } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import type { InstanceContext } from "../../2026-10-07-reference-stage-measurement/harness/instance-job"
import { readProcessResource, type ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"
import type { Dispatch, QualifiedRow } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { requestIdentity, verifyWarmWireRows, type WarmSettlement, type WarmWindowPlan } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { freezeMemoryPlan, qualifyMemoryTrace, RSS_MEASUREMENT } from "./memory-contracts"
import { verifyMatchedDispatch, verifyUpstreamMetrics } from "./contracts"
import type { MatchedContext } from "./coordinator"
import { verifyMatchedBundleIdentity } from "./inputs"
import type { readReferenceStorage } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import { verifyMemoryBarrierReceipt, verifyMemorySamplerIdentity } from "./memory-barrier"
import { MEMORY_INSTANCE_ADAPTER, runMemoryInstanceJob, type StoredMemoryJob } from "./memory-instance-job"

const pause = (ms: number) => new Promise<void>(accept => setTimeout(accept, ms))
function groupMembers(group: number): number[] {
  const output = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8", timeout: 2_000 })
  return output.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    return match && Number(match[2]) === group ? [Number(match[1])] : []
  })
}

/** The sampler's separate group keeps the measured coordinator's group empty between jobs. */
export async function startMemorySampler(directory: string) {
  if (process.platform !== "darwin") throw new Error("Memory sampler supports Darwin only")
  mkdirSync(directory, { recursive: true })
  const owner = await readProcessResource(process.pid)
  const stderr = openSync(join(directory, "memory-sampler.stderr.log"), "wx", 0o600)
  const child = spawn("python3", ["-I", "-B", join(import.meta.dir, "memory-sampler.py"), String(process.pid), owner.startIdentity, join(directory, "memory-samples.jsonl")], { detached: true, stdio: ["pipe", "pipe", stderr] })
  closeSync(stderr)
  let finished = false, exitCode: number | null = null, signal: string | null = null, spawnError: string | null = null
  child.once("error", error => { spawnError = String(error); finished = true })
  child.once("exit", (code, reason) => { exitCode = code; signal = reason; finished = true })
  const childStdin = child.stdin, stdout = child.stdout, spawnedPid = child.pid
  if (!childStdin || !stdout || !spawnedPid) {
    child.kill("SIGTERM")
    throw new Error("Memory sampler failed to spawn with its control pipes")
  }
  const stdin = childStdin
  stdin.on("error", () => {})
  const pid = spawnedPid
  const lines = createInterface({ input: stdout })
  const iterator = lines[Symbol.asyncIterator]()
  let samplerIdentity: string | null = null
  let stopped: Promise<SamplerReceipt> | undefined
  async function cleanup(): Promise<SamplerReceipt> {
    const forced: string[] = []
    if (!finished) stdin.end("stop\n")
    const ends = Date.now() + 3_000
    while (!finished && Date.now() < ends) await pause(10)
    for (const reason of ["SIGTERM", "SIGKILL"] as const) {
      if (finished) break
      child.kill(reason)
      forced.push(reason)
      const until = Date.now() + 1_000
      while (!finished && Date.now() < until) await pause(10)
    }
    lines.close()
    const remaining = groupMembers(pid)
    const receipt = { pid, startIdentity: samplerIdentity, ownerPid: owner.pid, ownerIdentity: owner.startIdentity, detached: true as const, finished, exitCode, signal, spawnError, forced, remaining, cleanupComplete: finished && remaining.length === 0 }
    durableJson(join(directory, "memory-sampler-process.json"), receipt, true)
    return receipt
  }
  const stop = () => stopped ??= cleanup()
  try {
    const line = await deadline("sampler ready", 5_000, () => iterator.next())
    if (line.done || typeof line.value !== "string") throw new Error("Memory sampler exited before readiness")
    const ready = JSON.parse(line.value) as { kind?: string; owner?: ProcessResource; sampler?: ProcessResource; samplerGroup?: number; targetGroup?: number }
    if (ready.kind !== "ready" || ready.owner?.pid !== process.pid || ready.owner.startIdentity !== owner.startIdentity || ready.sampler?.pid !== pid || ready.samplerGroup !== pid || ready.targetGroup !== process.pid) throw new Error("Memory sampler readiness identity mismatch")
    const identity = { pid, startIdentity: ready.sampler.startIdentity, ownerPid: owner.pid, ownerIdentity: owner.startIdentity }
    verifyMemorySamplerIdentity(identity, process.pid)
    samplerIdentity = identity.startIdentity
    return { ...identity, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

export interface SamplerReceipt {
  pid: number; startIdentity: string | null; ownerPid: number; ownerIdentity: string; detached: true
  finished: boolean; exitCode: number | null; signal: string | null; spawnError: string | null
  forced: string[]; remaining: number[]; cleanupComplete: boolean
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T }

interface MemoryInputs {
  schema: "br-memory-inputs-v1"
  sourceContext: FileIdentity
  instanceContext: FileIdentity
}

/** Recheck both the source freeze and its byte-identical run snapshot before trusting windows. */
async function verifyMemoryRunInputs(directory: string) {
  const saved = readJson<MemoryInputs>(join(directory, "memory-inputs.json"))
  if (saved.schema !== "br-memory-inputs-v1" || !saved.sourceContext || !saved.instanceContext || saved.instanceContext.path !== resolve(directory, "instance-context.json") || saved.sourceContext.sha256 !== saved.instanceContext.sha256 || saved.sourceContext.bytes !== saved.instanceContext.bytes) throw new Error("Memory source and archived context identity mismatch")
  verifyFiles([saved.sourceContext, saved.instanceContext])
  const context = readJson<MatchedContext>(saved.instanceContext.path)
  // Runtime dependencies install process signal handlers; keep them out of the outer supervisor.
  const { verifyMatchedInputs } = await import("./coordinator")
  verifyMatchedInputs(context)
  return { saved, context }
}

async function qualifyWindow(directory: string, window: WarmWindowPlan, inputs: Awaited<ReturnType<typeof verifyMemoryRunInputs>>) {
  const identity = readJson<{ arm: string; hooks: boolean; inspector: unknown; workerBundle: unknown }>(join(directory, "identity.json"))
  const job = readJson<StoredMemoryJob>(join(directory, "instance-job.json"))
  if (job.context?.path !== inputs.saved.instanceContext.path || job.context.sha256 !== inputs.saved.instanceContext.sha256) throw new Error("Memory window differs from its frozen run context")
  if (identity.arm !== window.arm) throw new Error("Memory window bundle identity has the wrong arm")
  const workerBundle = verifyMatchedBundleIdentity(inputs.context, window.arm, identity.workerBundle)
  const observations = readJson<{ rows: QualifiedRow[]; dispatches: Dispatch[]; processStart: ProcessResource; processEnd: ProcessResource; warmupSettlement: WarmSettlement; settlement: WarmSettlement }>(join(directory, "observations.json"))
  const receipt = readJson<{ completed: boolean; readback: { passed?: boolean; historyDisabled?: boolean; semantic?: { passed?: boolean; historyDisabled?: boolean } } }>(join(directory, "receipt.json"))
  const sampler = readJson<SamplerReceipt>(join(directory, "memory-sampler-process.json"))
  const { verifyWarmInstanceArtifacts, verifySavedAbSideEffects } = await import("../../2026-10-07-reference-stage-measurement/harness/warm")
  verifyWarmInstanceArtifacts(directory, window, observations.dispatches)
  const result = readJson<{ adapter?: string }>(join(directory, "instance-result.json"))
  if (job.adapter !== MEMORY_INSTANCE_ADAPTER || result.adapter !== MEMORY_INSTANCE_ADAPTER) throw new Error("Memory window did not use the versioned live-barrier adapter")
  verifyMemorySamplerIdentity(job.sampler, job.parentPid)
  if (identity.hooks !== false || identity.inspector !== null) throw new Error("Memory window has source hooks or Inspector")
  const semantic = receipt.readback.semantic ?? receipt.readback
  if (receipt.completed !== true || semantic.passed !== true || semantic.historyDisabled !== true) throw new Error("Memory window readback failed")
  const rows = observations.rows
  if (rows.length !== 25 || rows.filter(row => row.phase === "warmup").length !== 5 || rows.filter(row => row.phase === "timed").length !== 20 || rows.some(row => !row.ok || row.status !== 200 || row.arm !== window.arm || row.cell !== window.cell.id || row.dump)) throw new Error("Memory window request population mismatch")
  const ids = (["warmup", "timed"] as const).flatMap(phase => Array.from({ length: phase === "warmup" ? 5 : 20 }, (_, index) => requestIdentity(window.id, phase, index)))
  if (ids.some(id => rows.filter(row => row.id === id && row.phase === (id.startsWith(`${window.id}-warmup-`) ? "warmup" : "timed")).length !== 1)) throw new Error("Memory window request identity/phase mismatch")
  for (const settlement of [observations.warmupSettlement, observations.settlement]) {
    if (settlement.active !== 0 || settlement.pending !== 0 || settlement.registered !== settlement.settled || settlement.failures.length || settlement.observerFailures !== 0 || settlement.unowned !== 0) throw new Error("Memory window has unsettled work")
  }
  if (observations.settlement.registered < observations.warmupSettlement.registered) throw new Error("Memory settlement counters regressed")
  const wire = verifyWarmWireRows(rows)
  if (observations.dispatches.length !== 25 || new Set(observations.dispatches.map(value => value.id)).size !== 25 || observations.dispatches.some(value => value.requestedStream !== true || value.status !== 200 || !value.completed || value.cancelled || !rows.some(row => row.id === value.id))) throw new Error("Memory window requires complete matched upstream SSE dispatches")
  for (const dispatch of observations.dispatches) verifyMatchedDispatch(dispatch)
  if (window.arm === "R") {
    const { verifyReferenceReadback } = await import("../../2026-10-07-reference-stage-measurement/harness/reference-oracle")
    const storage = readJson<Awaited<ReturnType<typeof readReferenceStorage>>>(join(directory, "reference-storage.json"))
    const readback = receipt.readback as { storage: typeof storage; semantic: unknown }
    const verified = verifyReferenceReadback(storage, rows, observations.dispatches)
    if (JSON.stringify(storage) !== JSON.stringify(readback.storage) || JSON.stringify(verified) !== JSON.stringify(readback.semantic) || JSON.stringify(verified) !== JSON.stringify(readJson<unknown>(join(directory, "reference-semantic-receipt.json")))) throw new Error("Memory reference saved readback mismatch")
  } else {
    const saved = readJson<{ tables: Record<string, Record<string, unknown>[]>; semantic: unknown }>(join(directory, "ab-side-effects.json"))
    verifySavedAbSideEffects(saved, receipt.readback as typeof saved, rows.length, false)
    verifyUpstreamMetrics(saved.tables, observations.dispatches.length, window.cell.stream)
  }
  if (sampler.ownerPid !== job.parentPid || sampler.pid !== job.sampler.pid || sampler.startIdentity !== job.sampler.startIdentity || sampler.ownerIdentity !== job.sampler.ownerIdentity || sampler.finished !== true || sampler.exitCode !== 0 || sampler.signal !== null || sampler.spawnError !== null || sampler.forced.length || sampler.remaining.length || sampler.cleanupComplete !== true || sampler.detached !== true) throw new Error("Memory sampler process cleanup did not qualify")
  const trace = readFileSync(join(directory, "memory-samples.jsonl"), "utf8")
  if (!trace.endsWith("\n")) throw new Error("Memory trace has an incomplete final record")
  const events: unknown[] = trace.trimEnd().split("\n").map(line => JSON.parse(line))
  const barrier = verifyMemoryBarrierReceipt(trace, readJson<unknown>(join(directory, "memory-barrier.json")), { directory, windowId: window.id, sampler: job.sampler, processStart: observations.processStart, processEnd: observations.processEnd })
  const memory = qualifyMemoryTrace(events, { ownerPid: job.parentPid, processStart: observations.processStart, processEnd: observations.processEnd })
  if (memory.samplerPid !== sampler.pid || memory.ownerIdentity !== sampler.ownerIdentity) throw new Error("Saved sampler trace/process identities differ")
  return { windowId: window.id, block: window.block, arm: window.arm, cell: window.cell.id, qualified: true as const, contextSha256: inputs.saved.instanceContext.sha256, workerBundle, warmup: 5, timed: 20, wire, barrier, memory }
}

export async function reaggregateMemoryStudy(directory: string) {
  const saved = readJson<ReturnType<typeof freezeMemoryPlan>>(join(directory, "memory-plan.json"))
  const expected = freezeMemoryPlan(saved.runId)
  if (JSON.stringify(saved) !== JSON.stringify(expected)) throw new Error("Memory plan differs from the frozen design")
  const windows: Awaited<ReturnType<typeof qualifyWindow>>[] = [], errors: string[] = [], identities = new Set<string>()
  let inputs: Awaited<ReturnType<typeof verifyMemoryRunInputs>> | undefined
  try { inputs = await verifyMemoryRunInputs(directory) }
  catch (error) { errors.push(`Memory inputs: ${String(error)}`) }
  for (const window of expected.windows) {
    try {
      if (!inputs) throw new Error("Memory inputs did not qualify")
      const result = await qualifyWindow(join(directory, "windows", window.id), window, inputs)
      const identity = `${result.memory.pid}/${result.memory.startIdentity}`
      if (identities.has(identity)) throw new Error("Memory windows reused a workerd process identity")
      identities.add(identity)
      windows.push(result)
    }
    catch (error) { errors.push(`${window.id}: ${String(error)}`) }
  }
  const groups = ["json-string-common", "sse-string-common"].flatMap(cell => ["B", "R"].map(arm => {
    const selected = windows.filter(window => window.cell === cell && window.arm === arm)
    return { cell, arm, qualified: selected.length === 3 && selected.every(window => window.qualified), blocks: selected }
  }))
  return {
    schema: "br-memory-aggregate-v1" as const, runId: expected.runId,
    comparisonQualified: errors.length === 0 && windows.length === expected.expectedWindows,
    expectedWindows: expected.expectedWindows, observedQualifiedWindows: windows.length,
    inputQualification: { passed: inputs !== undefined, ...(inputs ? { sourceContext: inputs.saved.sourceContext, instanceContext: inputs.saved.instanceContext } : {}) },
    measurement: RSS_MEASUREMENT, cpuLatencyExcluded: true as const,
    formalStatisticsCompleted: false as const, comparability: expected.comparability, groups, errors,
  }
}

/** Run only in a fresh group created by supervise(); no existing service is targeted. */
export async function runMemoryStudy(options: { context: InstanceContext; directory: string; runId: string }) {
  const directory = resolve(options.directory)
  mkdirSync(directory, { recursive: true })
  const plan = freezeMemoryPlan(options.runId)
  durableJson(join(directory, "memory-plan.json"), plan, true)
  const sourceContext = fileIdentity(options.context.path)
  if (sourceContext.sha256 !== options.context.sha256) throw new Error("Memory source context SHA mismatch")
  const contextPath = join(directory, "instance-context.json")
  writeFileSync(contextPath, readFileSync(sourceContext.path), { flag: "wx", mode: 0o600 })
  const instanceContext = fileIdentity(contextPath)
  durableJson(join(directory, "memory-inputs.json"), { schema: "br-memory-inputs-v1", sourceContext, instanceContext } satisfies MemoryInputs, true)
  const inputs = await verifyMemoryRunInputs(directory)
  let failure: unknown
  for (const window of plan.windows) {
    const windowDirectory = join(directory, "windows", window.id)
    mkdirSync(windowDirectory, { recursive: true })
    try {
      const sampler = await startMemorySampler(windowDirectory)
      const { stop, ...samplerIdentity } = sampler
      try { await runMemoryInstanceJob({ kind: "warm-window", context: { path: instanceContext.path, sha256: instanceContext.sha256 }, directory: windowDirectory, window, sampler: samplerIdentity }) }
      finally { await stop() }
      await qualifyWindow(windowDirectory, window, inputs)
    } catch (error) {
      failure = error
      durableJson(join(windowDirectory, "memory-failure.json"), { completed: false, error: String(error) }, true)
      break
    }
  }
  // Independent reaggregation repeats the full frozen-input checks after all measured windows.
  const result = await reaggregateMemoryStudy(directory)
  durableJson(join(directory, "memory-result.json"), result, true)
  if (failure || !result.comparisonQualified) throw new Error(`Memory study did not qualify: ${failure ? String(failure) : result.errors.join("; ")}`)
  return result
}

export async function withMemoryInterrupts<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController()
  const interrupt = () => abort.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  try { return await action(abort.signal) }
  finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
}

if (import.meta.main) {
  const [mode, contextPath, output, runId] = process.argv.slice(2)
  if ((mode !== "run" && mode !== "child") || !contextPath || !output || !runId) throw new Error("Usage: bun memory.ts run CONTEXT_JSON NEW_OUTPUT_DIRECTORY RUN_ID")
  const context = fileIdentity(resolve(contextPath))
  const directory = resolve(output)
  if (mode === "child") {
    await runMemoryStudy({ context: { path: context.path, sha256: context.sha256 }, directory, runId })
  } else {
    mkdirSync(directory, { recursive: false })
    const supervision = await withMemoryInterrupts(signal => supervise({ command: process.execPath, args: [import.meta.path, "child", context.path, directory, runId], directory, timeoutMs: 30 * 60_000, signal }))
    durableJson(join(directory, "memory-supervision.json"), supervision, true)
    if (supervision.exitCode !== 0 || supervision.timedOut || supervision.interrupted || !supervision.cleanupComplete) throw new Error("Memory coordinator failed; see memory-supervision.json and logs")
  }
}
