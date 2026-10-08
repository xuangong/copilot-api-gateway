import { spawn, execFileSync } from "node:child_process"
import { closeSync, openSync, mkdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, sha, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import type { Dispatch } from "./runtime"
import type { WarmWindowPlan } from "./warm-contracts"
import type { buildReference } from "./reference-adapter"

type ReferenceBuild = Awaited<ReturnType<typeof buildReference>>
export interface InstanceContext { path: string; sha256: string }
export interface InstanceJob {
  kind: "ab-canary" | "reference-canary" | "warm-window"
  directory: string
  context: InstanceContext
  arm?: "A" | "B"
  bundle?: string
  hooks?: boolean
  window?: WarmWindowPlan
}
interface StoredJob extends InstanceJob { version: 1; parentPid: number }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function processTable() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8", timeout: 2000 }).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), name: match[4]! }] : []
  })
}
function remainingGroupMembers(group: number) {
  return processTable().filter(row => row.pgid === group && row.pid !== process.pid && !(row.ppid === process.pid && basename(row.name) === "ps"))
}

/** Inner children stay in the outer supervisor's group. No detached grandchildren. */
export async function runInheritedProcess(options: { command: string; args: string[]; directory: string; timeoutMs: number }) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid instance deadline")
  const parentGroup = processTable().find(row => row.pid === process.pid)?.pgid
  if (parentGroup !== process.pid || remainingGroupMembers(parentGroup).length) throw new Error("Instance coordinator requires its own empty supervised process group")
  const out = openSync(join(options.directory, "stdout.log"), "wx", 0o600)
  const err = openSync(join(options.directory, "stderr.log"), "wx", 0o600)
  const child = spawn(options.command, options.args, { detached: false, stdio: ["ignore", out, err] })
  closeSync(out); closeSync(err)
  let finished = false, exitCode: number | null = null, signal: string | null = null, spawnError: string | null = null
  child.once("error", error => { spawnError = String(error); finished = true })
  child.once("exit", (code, reason) => { exitCode = code; signal = reason; finished = true })
  const end = Date.now() + options.timeoutMs
  while (!finished && Date.now() < end) await pause(10)
  const timedOut = !finished
  if (timedOut) {
    child.kill("SIGTERM")
    const grace = Date.now() + 1000
    while (!finished && Date.now() < grace) await pause(10)
    if (!finished) child.kill("SIGKILL")
    const killEnd = Date.now() + 1000
    while (!finished && Date.now() < killEnd) await pause(10)
  }
  // Any surviving workerd invalidates this window; the outer supervisor then
  // terminates the entire owned group, including reparented descendants.
  const remaining = remainingGroupMembers(parentGroup)
  const receipt = { pid: child.pid ?? null, parentPid: process.pid, parentGroup, detached: false, exitCode, signal, spawnError, timedOut, finished, groupClean: remaining.length === 0, remaining }
  durableJson(join(options.directory, "instance-process.json"), receipt, true)
  return receipt
}

export function writeInstanceContext(path: string, value: unknown): InstanceContext {
  durableJson(path, value, true)
  const identity = fileIdentity(path)
  return { path: identity.path, sha256: identity.sha256 }
}

export async function runInstanceJob(job: InstanceJob): Promise<Dispatch[]> {
  mkdirSync(job.directory, { recursive: true })
  const path = join(job.directory, "instance-job.json")
  durableJson(path, { ...job, version: 1, parentPid: process.pid } satisfies StoredJob, true)
  const digest = fileIdentity(path).sha256
  const processReceipt = await runInheritedProcess({ command: process.execPath, args: [import.meta.path, path, digest], directory: job.directory, timeoutMs: 120000 })
  if (processReceipt.exitCode !== 0 || processReceipt.timedOut || processReceipt.spawnError || !processReceipt.groupClean) throw new Error(`Instance child failed: ${job.directory}; see instance-process.json and logs`)
  const result = JSON.parse(readFileSync(join(job.directory, "instance-result.json"), "utf8")) as { completed?: boolean; jobSha256?: string; dispatches?: Dispatch[] }
  if (result.completed !== true || result.jobSha256 !== digest || !Array.isArray(result.dispatches) || result.dispatches.length !== (job.window ? job.window.warmup + job.window.timed : 2)) throw new Error("Invalid instance completion receipt")
  return result.dispatches
}

async function executeJob(path: string, digest: string) {
  const bytes = readFileSync(path)
  if (!/^[a-f0-9]{64}$/.test(digest) || sha(bytes) !== digest) throw new Error("Instance job identity mismatch")
  const job = JSON.parse(bytes.toString()) as StoredJob
  if (job.version !== 1 || resolve(job.directory) !== dirname(resolve(path)) || job.parentPid !== process.ppid || processTable().find(row => row.pid === process.pid)?.pgid !== job.parentPid) throw new Error("Instance job/group ownership mismatch")
  const contextBytes = readFileSync(job.context.path)
  if (sha(contextBytes) !== job.context.sha256) throw new Error("Instance context changed")
  const context = JSON.parse(contextBytes.toString()) as { manifest: Manifest; referenceRoot: string; reference: ReferenceBuild; control: ReferenceBuild; probe: ReferenceBuild }
  try {
    let dispatches: Dispatch[]
    if (job.kind === "ab-canary" && (job.arm === "A" || job.arm === "B") && typeof job.bundle === "string" && typeof job.hooks === "boolean") {
      const { runAbInstance } = await import("./qualify")
      dispatches = await runAbInstance(context.manifest, job.arm, job.bundle, job.directory, job.hooks)
    } else if (job.kind === "reference-canary" && typeof job.hooks === "boolean") {
      const { runReferenceInstance } = await import("./reference-qualify")
      dispatches = await runReferenceInstance(context.referenceRoot, job.hooks ? context.probe : context.control, job.directory, job.hooks)
    } else if (job.kind === "warm-window" && job.window) {
      const { runWarmWindow } = await import("./warm")
      dispatches = await runWarmWindow(context.manifest, context.referenceRoot, context.reference, job.window, job.directory)
    } else throw new Error("Invalid instance job kind/parameters")
    durableJson(join(job.directory, "instance-result.json"), { completed: true, jobSha256: digest, contextSha256: job.context.sha256, dispatches }, true)
  } catch (error) {
    durableJson(join(job.directory, "instance-result.json"), { completed: false, jobSha256: digest, error: String(error) }, true)
    throw error
  }
}

if (import.meta.main) {
  const [path, digest] = process.argv.slice(2)
  if (!path || !digest) throw new Error("Use the supervised instance coordinator")
  await executeJob(path, digest)
}
