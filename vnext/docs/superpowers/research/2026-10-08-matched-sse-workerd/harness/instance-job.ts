import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, sha, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { runInheritedProcess, type InstanceContext } from "../../2026-10-07-reference-stage-measurement/harness/instance-job"
import type { buildReference } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import type { Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import type { MatchedWindow } from "./contracts"

export { writeInstanceContext } from "../../2026-10-07-reference-stage-measurement/harness/instance-job"

export interface MatchedInstanceJob {
  kind: "warm-window"
  directory: string
  context: InstanceContext
  window: MatchedWindow
}
interface StoredJob extends MatchedInstanceJob { version: 1; adapter: "matched-sse-instance-v1"; parentPid: number }
interface Context { manifest: Manifest; referenceRoot: string; reference: Awaited<ReturnType<typeof buildReference>> }

/** Validate immutable job/context bytes and inherited supervisor ownership. */
export function readMatchedInstanceJob(path: string, digest: string, ownership: { parentPid: number; group: number }): { job: StoredJob; context: Context } {
  const bytes = readFileSync(path)
  if (!/^[a-f0-9]{64}$/.test(digest) || sha(bytes) !== digest) throw new Error("Matched instance job identity mismatch")
  const job = JSON.parse(bytes.toString("utf8")) as StoredJob
  if (job.version !== 1 || job.adapter !== "matched-sse-instance-v1" || job.kind !== "warm-window") throw new Error("Invalid matched instance adapter/version/kind")
  if (typeof job.directory !== "string" || resolve(job.directory) !== dirname(resolve(path)) || !Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || job.parentPid !== ownership.parentPid || ownership.group !== job.parentPid) throw new Error("Matched instance job/group ownership mismatch")
  if (!job.window || !["B", "R"].includes(job.window.arm)) throw new Error("Invalid matched instance arm")
  if (!job.context || typeof job.context.path !== "string" || !/^[a-f0-9]{64}$/.test(job.context.sha256)) throw new Error("Invalid matched instance context identity")
  const contextBytes = readFileSync(job.context.path)
  if (sha(contextBytes) !== job.context.sha256) throw new Error("Matched instance context changed")
  const context = JSON.parse(contextBytes.toString("utf8")) as Context
  return { job, context }
}

/** Keep the existing process-group supervisor; version only this child entry. */
export async function runMatchedInstanceJob(job: MatchedInstanceJob): Promise<Dispatch[]> {
  mkdirSync(job.directory, { recursive: true })
  const path = join(job.directory, "instance-job.json")
  durableJson(path, { ...job, version: 1, adapter: "matched-sse-instance-v1", parentPid: process.pid } satisfies StoredJob, true)
  const digest = fileIdentity(path).sha256
  const processReceipt = await runInheritedProcess({ command: process.execPath, args: [import.meta.path, path, digest], directory: job.directory, timeoutMs: 120000 })
  if (processReceipt.exitCode !== 0 || processReceipt.timedOut || processReceipt.spawnError || !processReceipt.groupClean) throw new Error(`Matched instance child failed: ${job.directory}; see instance-process.json and logs`)
  const result = JSON.parse(readFileSync(join(job.directory, "instance-result.json"), "utf8")) as { completed?: boolean; adapter?: string; jobSha256?: string; contextSha256?: string; dispatches?: Dispatch[] }
  if (result.completed !== true || result.adapter !== "matched-sse-instance-v1" || result.jobSha256 !== digest || result.contextSha256 !== job.context.sha256 || !Array.isArray(result.dispatches) || result.dispatches.length !== job.window.warmup + job.window.timed) throw new Error("Invalid matched instance completion receipt")
  return result.dispatches
}

async function executeJob(path: string, digest: string) {
  const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000 }).trim())
  const { job, context } = readMatchedInstanceJob(path, digest, { parentPid: process.ppid, group })
  try {
    const { runMatchedWarmWindow } = await import("./warm-window")
    const dispatches = await runMatchedWarmWindow(context.manifest, context.referenceRoot, context.reference, job.window, job.directory)
    durableJson(join(job.directory, "instance-result.json"), { completed: true, adapter: job.adapter, jobSha256: digest, contextSha256: job.context.sha256, dispatches }, true)
  } catch (error) {
    durableJson(join(job.directory, "instance-result.json"), { completed: false, adapter: job.adapter, jobSha256: digest, contextSha256: job.context.sha256, error: String(error) }, true)
    throw error
  }
}

if (import.meta.main) {
  const [path, digest] = process.argv.slice(2)
  if (!path || !digest) throw new Error("Use the supervised matched instance coordinator")
  await executeJob(path, digest)
}
