import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, sha, verifyFiles, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { cells } from "../../2026-10-07-reference-stage-measurement/harness/contracts"
import { runInheritedProcess, writeInstanceContext, type InstanceContext } from "../../2026-10-07-reference-stage-measurement/harness/instance-job"
import { runAbWarmWindow, type AbWarmWindowPlan } from "../../2026-10-07-reference-stage-measurement/harness/warm"
import type { Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import type { ObserverConfig, ObserverMode } from "./observer"

export interface ObserverWindow extends AbWarmWindowPlan { arm: "B"; warmup: 5; timed: 30; observer: ObserverConfig }
export interface ObserverPlan {
  schema: "diagnostic-observer-plan-v1"
  windows: ObserverWindow[]
  expectedWindows: 12
  expectedWarmup: 60
  expectedTimed: 360
  expectedTotal: 420
  scope: string
}
export function freezeObserverPlan(): ObserverPlan {
  const windows: ObserverWindow[] = []
  const orders: ObserverMode[][] = [["none", "attached", "cpu"], ["cpu", "attached", "none"]]
  for (const [block, order] of orders.entries()) for (const id of ["json-string-full", "json-string-common"]) {
    const cell = cells.find(cell => cell.id === id)
    if (!cell) throw new Error(`Missing declared observer cell: ${id}`)
    for (const [orderPosition, mode] of order.entries()) windows.push({ id: `diagnostic-observer-v1-b${block}-${id.padEnd(18, "_")}-${mode.padEnd(8, "_")}`, block, orderPosition, arm: "B", cell: { ...cell }, warmup: 5, timed: 30, observer: { mode } })
  }
  return { schema: "diagnostic-observer-plan-v1", windows, expectedWindows: 12, expectedWarmup: 60, expectedTimed: 360, expectedTotal: 420, scope: "B JSON string diagnostics on/off; two reversed observer-order blocks; exploratory observer effects and source leads; no noise/overhead/statistical bound; no source hooks or heap queries" }
}
export interface ObserverJob { version: 1; kind: "observer-window"; directory: string; parentPid: number; context: InstanceContext; window: ObserverWindow }
export function validateObserverJob(bytes: Uint8Array, digest: string, contextBytes: Uint8Array, path: string, parentPid: number, group: number): ObserverJob {
  if (!/^[a-f0-9]{64}$/.test(digest) || sha(bytes) !== digest) throw new Error("Observer job SHA mismatch")
  const job = JSON.parse(Buffer.from(bytes).toString("utf8")) as ObserverJob
  if (job.version !== 1 || job.kind !== "observer-window" || typeof job.directory !== "string" || resolve(job.directory) !== dirname(resolve(path)) || !Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || job.parentPid !== parentPid || group !== parentPid) throw new Error("Observer child/job/group identity mismatch")
  const expected = freezeObserverPlan().windows.find(window => window.id === job.window?.id)
  if (!expected || JSON.stringify(job.window) !== JSON.stringify(expected)) throw new Error("Observer window differs from frozen plan")
  if (!job.context || typeof job.context.path !== "string" || !/^[a-f0-9]{64}$/.test(job.context.sha256) || sha(contextBytes) !== job.context.sha256) throw new Error("Observer context SHA mismatch")
  return job
}

async function instance(path: string, digest: string) {
  const bytes = readFileSync(path)
  const untrusted = JSON.parse(bytes.toString("utf8")) as ObserverJob
  const contextBytes = readFileSync(untrusted.context.path)
  const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000 }).trim())
  const job = validateObserverJob(bytes, digest, contextBytes, path, process.ppid, group)
  const context = JSON.parse(contextBytes.toString("utf8")) as { manifest: Manifest }
  try {
    const dispatches = await runAbWarmWindow(context.manifest, "B", job.window, job.directory, job.window.observer)
    durableJson(join(job.directory, "instance-result.json"), { completed: true, jobSha256: digest, contextSha256: job.context.sha256, dispatches }, true)
  } catch (error) {
    durableJson(join(job.directory, "instance-result.json"), { completed: false, jobSha256: digest, contextSha256: job.context.sha256, error: String(error) }, true)
    throw error
  }
}
export async function collectObserverRun(manifest: Manifest, output: string) {
  const plan = freezeObserverPlan()
  durableJson(join(output, "experiment-plan.json"), plan, true)
  const frozen = [...manifest.variants.B.files, ...manifest.dependencies, ...manifest.artifacts]
  verifyFiles(frozen)
  const context = writeInstanceContext(join(output, "instance-context.json"), { manifest })
  durableJson(join(output, "disposition.json"), { completed: false, observerComparisonCompleted: false, comparisonCompleted: false }, true)
  const completed: { id: string; directory: string; observer: ObserverMode }[] = []
  for (const window of plan.windows) {
    const directory = join(output, "windows", window.id)
    mkdirSync(directory, { recursive: true })
    const job: ObserverJob = { version: 1, kind: "observer-window", directory, parentPid: process.pid, context, window }
    const path = join(directory, "instance-job.json")
    durableJson(path, job, true)
    const digest = fileIdentity(path).sha256
    const processReceipt = await runInheritedProcess({ command: process.execPath, args: [import.meta.path, "--instance", path, digest], directory, timeoutMs: 120000 })
    if (processReceipt.exitCode !== 0 || processReceipt.timedOut || processReceipt.spawnError !== null || !processReceipt.groupClean || !processReceipt.finished) throw new Error(`Observer child failed: ${window.id}`)
    const result = JSON.parse(readFileSync(join(directory, "instance-result.json"), "utf8")) as { completed: boolean; jobSha256: string; contextSha256: string; dispatches: Dispatch[] }
    if (result.completed !== true || result.jobSha256 !== digest || result.contextSha256 !== context.sha256 || !Array.isArray(result.dispatches) || result.dispatches.length !== window.warmup + window.timed) throw new Error("Observer child completion identity/population mismatch")
    const observer = JSON.parse(readFileSync(join(directory, "observer-receipt.json"), "utf8")) as { completed: boolean; mode: ObserverMode }
    const cleanup = JSON.parse(readFileSync(join(directory, "cleanup-receipt.json"), "utf8")) as { completed: boolean }
    if (observer.completed !== true || observer.mode !== window.observer.mode || cleanup.completed !== true) throw new Error("Observer lifecycle/cleanup did not qualify")
    completed.push({ id: window.id, directory, observer: window.observer.mode })
    durableJson(join(output, "window-progress.json"), { completed, expectedWindows: plan.expectedWindows, comparisonCompleted: false })
  }
  verifyFiles(frozen)
  if (fileIdentity(context.path).sha256 !== context.sha256) throw new Error("Observer context changed during collection")
  durableJson(join(output, "window-index.json"), { completed: true, windows: completed }, true)
  durableJson(join(output, "disposition.json"), { completed: true, observerComparisonCompleted: true, comparisonCompleted: false, independentlyAnalyzed: false, scope: plan.scope })
}

if (import.meta.main) {
  const [command, first, second] = process.argv.slice(2)
  if (command === "--instance" && first && second) await instance(first, second)
  else if (command === "--coordinator" && first && second) {
    try { await collectObserverRun(JSON.parse(readFileSync(first, "utf8")) as Manifest, second) }
    catch (error) { durableJson(join(second, "disposition.json"), { completed: false, observerComparisonCompleted: false, comparisonCompleted: false, error: String(error) }); throw error }
  } else throw new Error("Use the supervised observer runner")
}
