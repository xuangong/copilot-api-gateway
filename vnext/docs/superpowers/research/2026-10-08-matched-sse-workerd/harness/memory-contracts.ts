import { createHash } from "node:crypto"
import { cells } from "../../2026-10-07-reference-stage-measurement/harness/contracts"
import type { WarmWindowPlan } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { diffProcessResource, type ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"

export const RSS_MEASUREMENT = "whole-workerd sampled RSS maximum; lower bound on the true peak; not isolate memory or the CFW 128 MiB limit"
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
const record = (value: unknown): Record<string, unknown> => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid memory trace object")
  return value as Record<string, unknown>
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const resource = (value: unknown): ProcessResource => {
  const sample = value as ProcessResource
  diffProcessResource(sample, sample)
  return sample
}

export function verifyMemoryWindow(window: WarmWindowPlan) {
  check(window && ["B", "R"].includes(window.arm) && window.warmup === 5 && window.timed === 20 && typeof window.id === "string" && window.id.length > 0, "Invalid memory window arm or population")
  const cell = cells.find(value => value.id === window.cell?.id && ["json-string-common", "sse-string-common"].includes(value.id))
  check(cell && JSON.stringify(window.cell) === JSON.stringify(cell), "Memory window differs from the frozen diagnostics-off common cell")
}

export function freezeMemoryPlan(runId: string) {
  check(/^[A-Za-z0-9_-]{1,64}$/.test(runId), "Invalid memory run id")
  const windows: WarmWindowPlan[] = []
  for (let block = 0; block < 3; block++) {
    for (const cellId of ["json-string-common", "sse-string-common"]) {
      const cell = cells.find(value => value.id === cellId)
      if (!cell) throw new Error(`Missing memory fixture: ${cellId}`)
      const order = block % 2 === 0 ? ["B", "R"] as const : ["R", "B"] as const
      for (const [orderPosition, arm] of order.entries()) windows.push({ id: `${runId}-b${block}-${cell.id}-${arm}`, block, orderPosition, arm, cell: { ...cell }, warmup: 5, timed: 20 })
    }
  }
  return {
    schema: "br-memory-study-v1" as const, runId, windows,
    expectedWindows: 12, expectedWarmup: 60, expectedTimed: 240,
    populationSha256: createHash("sha256").update(JSON.stringify(windows)).digest("hex"),
    requestedIntervalMs: 20 as const, maxQualifiedSampleGapMs: 250 as const,
    cadence: "requested interval only; host timer coalescing can delay samples; actual gaps are reported per window",
    scope: "independent local RSS experiment; no Inspector; sampled runs excluded from CPU/latency comparisons",
    measurement: RSS_MEASUREMENT,
    comparability: { sse: "B and R SSE-to-SSE, diagnostics off", json: "B and R SSE-to-JSON, diagnostics off", equalWorkClaim: false as const },
  }
}

/** The saved host-monotonic boundary probes define the interval independently of the sampler. */
export function qualifyMemoryTrace(events: readonly unknown[], interval: { ownerPid: number; processStart: ProcessResource; processEnd: ProcessResource }) {
  check(events.length >= 4, "Incomplete memory trace")
  const start = resource(interval.processStart), end = resource(interval.processEnd)
  diffProcessResource(start, end)
  check(start.executableName === "workerd" && end.observedAtMs > start.observedAtMs, "Invalid measured workerd interval")
  const ready = record(events[0]), stopped = record(events.at(-1))
  check(ready.kind === "ready" && ready.schema === "sampled-rss-v1" && ready.requestedIntervalMs === 20 && ready.targetGroup === interval.ownerPid, "Invalid sampler ready/owner record")
  const owner = resource(ready.owner), sampler = resource(ready.sampler)
  check(owner.pid === interval.ownerPid && sampler.pid !== owner.pid && ready.samplerGroup === sampler.pid, "Invalid sampler process group ownership")
  check(finite(ready.atMs) && ready.atMs >= owner.observedAtMs && ready.atMs >= sampler.observedAtMs, "Invalid sampler ready timestamp")
  const samples: ProcessResource[] = []
  let lastAt = ready.atMs as number, exited = false
  for (const raw of events.slice(1, -1)) {
    const event = record(raw)
    if (event.kind === "sample") {
      check(!exited && event.targetGroup === owner.pid && event.ownerIdentity === owner.startIdentity, "Sampling resumed after exit or owner identity changed")
      const value = resource(event.resource)
      check(value.pid === start.pid && value.startIdentity === start.startIdentity && value.executableName === "workerd" && value.scope === start.scope, "Sampled workerd identity mismatch")
      check(value.observedAtMs > lastAt, "Memory sample timestamps must be strictly monotonic")
      const previous = samples.at(-1)
      if (previous) diffProcessResource(previous, value)
      samples.push(value)
      lastAt = value.observedAtMs
    } else {
      check(event.kind === "workerd-exited" && !exited && samples.length > 0 && event.pid === start.pid && event.startIdentity === start.startIdentity && finite(event.atMs) && event.atMs > lastAt, "Invalid or repeated workerd exit record")
      exited = true
      lastAt = event.atMs as number
    }
  }
  check(stopped.kind === "stopped" && stopped.completed === true && stopped.error === null && stopped.sampleCount === samples.length && samples.length > 0 && stopped.ownerIdentity === owner.startIdentity && Array.isArray(stopped.remainingWorkerdPids) && stopped.remainingWorkerdPids.length === 0 && finite(stopped.atMs) && stopped.atMs >= lastAt, "Sampler completion or process cleanup failed")
  const selected = record(stopped.workerd)
  check(selected.pid === start.pid && selected.startIdentity === start.startIdentity && exited, "Sampler did not resolve the measured workerd exit")
  const first = samples[0], last = samples.at(-1)
  check(first && last && first.observedAtMs <= start.observedAtMs && last.observedAtMs >= end.observedAtMs, "Memory trace does not cover the measured interval")
  const before = samples.filter(value => value.observedAtMs <= start.observedAtMs).at(-1)
  const after = samples.find(value => value.observedAtMs >= end.observedAtMs)
  if (!before || !after) throw new Error("Memory trace does not cover the boundary probes")
  const covering = samples.filter(value => value.observedAtMs >= before.observedAtMs && value.observedAtMs <= after.observedAtMs)
  const timed = samples.filter(value => value.observedAtMs >= start.observedAtMs && value.observedAtMs <= end.observedAtMs)
  check(timed.length > 0, "No memory samples inside measured interval")
  const gaps = covering.slice(1).map((value, index) => value.observedAtMs - (covering[index]?.observedAtMs ?? value.observedAtMs))
  const maxSampleGapMs = Math.max(...gaps)
  check(finite(maxSampleGapMs) && maxSampleGapMs <= 250, "Memory sample gap exceeds 250 ms qualification bound")
  const sampledMaxRssBytes = Math.max(start.rssBytes, end.rssBytes, ...timed.map(value => value.rssBytes))
  return {
    qualified: true as const, pid: start.pid, startIdentity: start.startIdentity,
    samplerPid: sampler.pid, ownerPid: owner.pid, ownerIdentity: owner.startIdentity,
    measurement: RSS_MEASUREMENT, interval: "post-warmup timed requests through settlement; excludes physical readback" as const,
    requestedIntervalMs: 20, maxQualifiedSampleGapMs: 250, elapsedMs: end.observedAtMs - start.observedAtMs,
    observedFromMs: start.observedAtMs, observedToMs: end.observedAtMs,
    bracketFromMs: before.observedAtMs, bracketToMs: after.observedAtMs,
    timedSamples: timed.length, totalProcessSamples: samples.length, maxSampleGapMs,
    startRssBytes: start.rssBytes, endRssBytes: end.rssBytes,
    sampledMaxRssBytes, sampledMaxDeltaFromStartBytes: sampledMaxRssBytes - start.rssBytes,
    endDeltaFromStartBytes: end.rssBytes - start.rssBytes,
  }
}
