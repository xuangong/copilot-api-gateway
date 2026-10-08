import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, sha, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { runInheritedProcess, type InstanceContext } from "../../2026-10-07-reference-stage-measurement/harness/instance-job"
import type { buildReference } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import type { Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import type { WarmWindowPlan } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { verifyMemorySamplerIdentity, type MemorySamplerIdentity } from "./memory-barrier"
import { verifyMemoryWindow } from "./memory-contracts"

export const MEMORY_INSTANCE_ADAPTER = "matched-sse-memory-instance-v1"
export interface MemoryInstanceJob {
  kind: "warm-window"
  directory: string
  context: InstanceContext
  window: WarmWindowPlan
  sampler: MemorySamplerIdentity
}
export interface StoredMemoryJob extends MemoryInstanceJob { version: 1; adapter: typeof MEMORY_INSTANCE_ADAPTER; parentPid: number }
interface Context { manifest: Manifest; referenceRoot: string; reference: Awaited<ReturnType<typeof buildReference>> }

/** The memory-only child binds the same immutable inputs plus the independent sampler. */
export function readMemoryInstanceJob(path: string, digest: string, ownership: { parentPid: number; group: number }): { job: StoredMemoryJob; context: Context } {
  const bytes = readFileSync(path)
  if (!/^[a-f0-9]{64}$/.test(digest) || sha(bytes) !== digest) throw new Error("Memory instance job identity mismatch")
  const job = JSON.parse(bytes.toString("utf8")) as StoredMemoryJob
  if (job.version !== 1 || job.adapter !== MEMORY_INSTANCE_ADAPTER || job.kind !== "warm-window") throw new Error("Invalid memory instance adapter/version/kind")
  if (typeof job.directory !== "string" || resolve(job.directory) !== dirname(resolve(path)) || !Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || job.parentPid !== ownership.parentPid || ownership.group !== job.parentPid) throw new Error("Memory instance job/group ownership mismatch")
  verifyMemoryWindow(job.window)
  verifyMemorySamplerIdentity(job.sampler, job.parentPid)
  if (!job.context || typeof job.context.path !== "string" || !/^[a-f0-9]{64}$/.test(job.context.sha256)) throw new Error("Invalid memory instance context identity")
  const contextBytes = readFileSync(job.context.path)
  if (sha(contextBytes) !== job.context.sha256) throw new Error("Memory instance context changed")
  return { job, context: JSON.parse(contextBytes.toString("utf8")) as Context }
}

export async function runMemoryInstanceJob(job: MemoryInstanceJob): Promise<Dispatch[]> {
  verifyMemoryWindow(job.window)
  verifyMemorySamplerIdentity(job.sampler, process.pid)
  mkdirSync(job.directory, { recursive: true })
  const path = join(job.directory, "instance-job.json")
  durableJson(path, { ...job, version: 1, adapter: MEMORY_INSTANCE_ADAPTER, parentPid: process.pid } satisfies StoredMemoryJob, true)
  const digest = fileIdentity(path).sha256
  const processReceipt = await runInheritedProcess({ command: process.execPath, args: [import.meta.path, path, digest], directory: job.directory, timeoutMs: 120_000 })
  if (processReceipt.exitCode !== 0 || processReceipt.timedOut || processReceipt.spawnError || !processReceipt.groupClean) throw new Error(`Memory instance child failed: ${job.directory}; see instance-process.json and logs`)
  const result = JSON.parse(readFileSync(join(job.directory, "instance-result.json"), "utf8")) as { completed?: boolean; adapter?: string; jobSha256?: string; contextSha256?: string; dispatches?: Dispatch[] }
  if (result.completed !== true || result.adapter !== MEMORY_INSTANCE_ADAPTER || result.jobSha256 !== digest || result.contextSha256 !== job.context.sha256 || !Array.isArray(result.dispatches) || result.dispatches.length !== 25) throw new Error("Invalid memory instance completion receipt")
  return result.dispatches
}

async function executeJob(path: string, digest: string) {
  const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2_000 }).trim())
  const { job, context } = readMemoryInstanceJob(path, digest, { parentPid: process.ppid, group })
  try {
    const { runMemoryWarmWindow } = await import("./memory-window")
    const dispatches = await runMemoryWarmWindow(context.manifest, context.referenceRoot, context.reference, job.window, job.directory, job.sampler)
    durableJson(join(job.directory, "instance-result.json"), { completed: true, adapter: job.adapter, jobSha256: digest, contextSha256: job.context.sha256, dispatches }, true)
  } catch (error) {
    durableJson(join(job.directory, "instance-result.json"), { completed: false, adapter: job.adapter, jobSha256: digest, contextSha256: job.context.sha256, error: String(error) }, true)
    throw error
  }
}

if (import.meta.main) {
  const [path, digest] = process.argv.slice(2)
  if (!path || !digest) throw new Error("Use the supervised memory instance coordinator")
  await executeJob(path, digest)
}
