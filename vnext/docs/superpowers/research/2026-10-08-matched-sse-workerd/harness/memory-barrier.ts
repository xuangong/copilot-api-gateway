import { readFileSync, watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { diffProcessResource, type ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"

export const MEMORY_BARRIER_TIMEOUT_MS = 2_000
export interface MemorySamplerIdentity {
  pid: number
  startIdentity: string
  ownerPid: number
  ownerIdentity: string
}
export interface MemoryBarrierOptions {
  directory: string
  windowId: string
  sampler: MemorySamplerIdentity
  processStart: ProcessResource
  processEnd: ProcessResource
  timeoutMs?: number
}
export interface MemoryBarrierReceipt {
  schema: "memory-after-sample-barrier-v1"
  windowId: string
  sampler: MemorySamplerIdentity
  processStart: ProcessResource
  processEnd: ProcessResource
  timeoutMs: number
  after: { line: number; sha256: string; resource: ProcessResource }
}

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
const record = (value: unknown): Record<string, unknown> => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid memory barrier trace object")
  return value as Record<string, unknown>
}
function resource(value: unknown): ProcessResource {
  const sample = value as ProcessResource
  diffProcessResource(sample, sample)
  return sample
}
export function verifyMemorySamplerIdentity(value: MemorySamplerIdentity, ownerPid: number) {
  check(value && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647 && value.pid !== ownerPid && Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid <= 2_147_483_647 && value.ownerPid === ownerPid && /^darwin-abstime:[1-9]\d*$/.test(value.ownerIdentity) && /^darwin-abstime:[1-9]\d*$/.test(value.startIdentity), "Memory sampler identity/ownership mismatch")
}
function timeout(options: MemoryBarrierOptions) {
  const ms = options.timeoutMs ?? MEMORY_BARRIER_TIMEOUT_MS
  check(Number.isSafeInteger(ms) && ms > 0 && ms <= MEMORY_BARRIER_TIMEOUT_MS, "Invalid memory barrier deadline")
  return ms
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const a = Object.keys(left), b = Object.keys(right)
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/** Only complete independent sampler records can authorize native readback/disposal. */
function inspect(lines: string[], options: MemoryBarrierOptions): MemoryBarrierReceipt | undefined {
  const { sampler, processStart: start, processEnd: end } = options
  verifyMemorySamplerIdentity(sampler, sampler.ownerPid)
  diffProcessResource(start, end)
  check(start.executableName === "workerd" && start.pid !== sampler.pid && start.pid !== sampler.ownerPid && end.observedAtMs > start.observedAtMs, "Invalid memory barrier workerd interval")
  if (!lines.length) return undefined
  const first = lines[0]
  if (first === undefined) throw new Error("Memory barrier ready record is absent")
  const ready = record(JSON.parse(first)), owner = resource(ready.owner), observer = resource(ready.sampler)
  check(ready.kind === "ready" && ready.schema === "sampled-rss-v1" && ready.requestedIntervalMs === 20 && ready.targetGroup === sampler.ownerPid && ready.samplerGroup === sampler.pid && owner.pid === sampler.ownerPid && owner.startIdentity === sampler.ownerIdentity && observer.pid === sampler.pid && observer.startIdentity === sampler.startIdentity, "Memory barrier sampler/owner identity or ownership mismatch")
  check(typeof ready.atMs === "number" && Number.isFinite(ready.atMs) && ready.atMs >= owner.observedAtMs && ready.atMs >= observer.observedAtMs, "Invalid memory barrier ready timestamp")
  let lastAt = ready.atMs as number
  const samples: ProcessResource[] = []
  let after: MemoryBarrierReceipt["after"] | undefined
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue
    const event = record(JSON.parse(line))
    check(event.kind === "sample", `Memory barrier sampler ${String(event.kind)} before release: ${String(event.error ?? "")}`)
    check(event.targetGroup === sampler.ownerPid && event.ownerIdentity === sampler.ownerIdentity, "Memory barrier sample owner identity mismatch")
    const value = resource(event.resource)
    check(value.pid === start.pid && value.startIdentity === start.startIdentity && value.executableName === "workerd" && value.scope === start.scope, "Memory barrier workerd identity mismatch")
    check(value.observedAtMs > lastAt, "Memory barrier sample timestamps must be strictly monotonic")
    const previous = samples.at(-1)
    if (previous) diffProcessResource(previous, value)
    samples.push(value)
    lastAt = value.observedAtMs
    if (!after && value.observedAtMs >= end.observedAtMs) after = { line: index + 1, sha256: sha(line + "\n"), resource: value }
  }
  if (!after) return undefined
  const before = samples.filter(value => value.observedAtMs <= start.observedAtMs).at(-1)
  check(before, "Memory barrier has no independent before-start sample")
  const afterAt = after.resource.observedAtMs
  const covering = samples.filter(value => value.observedAtMs >= before.observedAtMs && value.observedAtMs <= afterAt)
  check(covering.some(value => value.observedAtMs >= start.observedAtMs && value.observedAtMs <= end.observedAtMs), "Memory barrier has no timed sample")
  let previous: ProcessResource | undefined
  for (const value of covering) {
    if (previous) check(value.observedAtMs - previous.observedAtMs <= 250, "Memory sample gap exceeds 250 ms qualification bound")
    previous = value
  }
  return { schema: "memory-after-sample-barrier-v1", windowId: options.windowId, sampler, processStart: start, processEnd: end, timeoutMs: timeout(options), after }
}

/** A bounded file notification wait keeps workerd alive outside the measured interval. */
export async function waitForMemoryAfterSample(options: MemoryBarrierOptions): Promise<MemoryBarrierReceipt> {
  const timeoutMs = timeout(options), path = join(options.directory, "memory-samples.jsonl")
  const expiresAt = performance.now() + timeoutMs
  return new Promise((accept, reject) => {
    let watcher: FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined, finished = false, previous = ""
    const complete = (error?: unknown, receipt?: MemoryBarrierReceipt) => {
      if (finished) return
      finished = true
      watcher?.close()
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else if (receipt) accept(receipt)
    }
    const read = () => {
      if (finished) return
      try {
        check(performance.now() <= expiresAt, `Memory after-sample barrier deadline exceeded (${timeoutMs} ms)`)
        const trace = readFileSync(path, "utf8")
        check(trace.startsWith(previous), "Memory barrier trace changed instead of appending")
        previous = trace
        const end = trace.lastIndexOf("\n"), completeLines = end < 0 ? [] : trace.slice(0, end).split("\n")
        const receipt = inspect(completeLines, options)
        if (receipt) {
          check(performance.now() <= expiresAt, `Memory after-sample barrier deadline exceeded (${timeoutMs} ms)`)
          durableJson(join(options.directory, "memory-barrier.json"), receipt, true)
          complete(undefined, receipt)
        }
      } catch (error) { complete(error) }
    }
    try {
      // Subscribe before the first read so an append cannot fall between them.
      watcher = watch(path, event => event === "rename" ? complete(new Error("Memory barrier trace replaced during wait")) : read())
      watcher.once("error", error => complete(error))
      timer = setTimeout(() => complete(new Error(`Memory after-sample barrier deadline exceeded (${timeoutMs} ms)`)), timeoutMs)
      read()
    } catch (error) { complete(error) }
  })
}

/** Rebuild the receipt from its exact raw sample line and independent endpoints. */
export function verifyMemoryBarrierReceipt(trace: string, saved: unknown, options: MemoryBarrierOptions): MemoryBarrierReceipt {
  const receipt = record(saved) as unknown as MemoryBarrierReceipt
  check(trace.endsWith("\n") && Number.isSafeInteger(receipt.after?.line) && receipt.after.line > 1, "Invalid saved memory barrier trace/sample line")
  const lines = trace.slice(0, -1).split("\n")
  check(receipt.after.line <= lines.length, "Saved memory barrier sample line is absent")
  const expected = inspect(lines.slice(0, receipt.after.line), options)
  check(expected && equal(expected, receipt), "Saved memory barrier receipt differs from raw sample or endpoint identity")
  return expected
}
