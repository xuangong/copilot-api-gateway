import { expect, test } from "bun:test"
import { freezeMemoryPlan, qualifyMemoryTrace } from "./memory-contracts"
import type { ProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"

const sample = (at: number, rssBytes = 1_000): ProcessResource => ({
  pid: 42, startIdentity: "darwin-abstime:100", executableName: "workerd",
  userUs: 100, systemUs: 100, rssBytes, observedAtMs: at,
  scope: "darwin-process-libproc-rusage-v2",
})
const owner = { ...sample(70), pid: 7, startIdentity: "darwin-abstime:50", executableName: "bun" }
function trace(): Record<string, unknown>[] {
  return [
    { kind: "ready", schema: "sampled-rss-v1", targetGroup: 7, owner, sampler: { ...owner, pid: 8 }, samplerGroup: 8, requestedIntervalMs: 20, atMs: 70 },
    ...[[80, 8_000], [100, 1_000], [120, 3_000], [140, 2_000], [160, 9_000]].map(([at, rss]) => ({ kind: "sample", resource: sample(at ?? 0, rss), targetGroup: 7, ownerIdentity: owner.startIdentity })),
    { kind: "workerd-exited", atMs: 180, pid: 42, startIdentity: "darwin-abstime:100" },
    { kind: "stopped", atMs: 200, completed: true, error: null, sampleCount: 5, workerd: { pid: 42, startIdentity: "darwin-abstime:100" }, remainingWorkerdPids: [], ownerIdentity: owner.startIdentity },
  ]
}
const interval = { ownerPid: 7, processStart: sample(95, 1_500), processEnd: sample(145, 2_500) }

test("freezes all paired memory windows with matched upstream SSE for both downstream formats", () => {
  const plan = freezeMemoryPlan("memory-test")
  expect(plan.windows).toHaveLength(12)
  expect(plan.windows.map(window => window.arm)).toEqual(["B", "R", "B", "R", "R", "B", "R", "B", "B", "R", "B", "R"])
  expect(plan.windows.filter(window => window.cell.stream)).toHaveLength(6)
  expect(new Set(plan.windows.map(window => window.id)).size).toBe(12)
  expect(plan.windows.every(window => window.warmup === 5 && window.timed === 20 && !window.cell.dump)).toBe(true)
  expect(plan.comparability.json).toBe("B and R SSE-to-JSON, diagnostics off")
  expect(plan.comparability.equalWorkClaim).toBe(false)
})

test("clips RSS samples to the timed interval while retaining its bracketing evidence", () => {
  const result = qualifyMemoryTrace(trace(), interval)
  expect(result.sampledMaxRssBytes).toBe(3_000)
  expect(result.sampledMaxDeltaFromStartBytes).toBe(1_500)
  expect(result.startRssBytes).toBe(1_500)
  expect(result.endRssBytes).toBe(2_500)
  expect(result.timedSamples).toBe(3)
  expect(result.maxSampleGapMs).toBe(20)
  expect(result.measurement).toBe("whole-workerd sampled RSS maximum; lower bound on the true peak; not isolate memory or the CFW 128 MiB limit")
})

test("a boundary probe can be the largest observed RSS value", () => {
  expect(qualifyMemoryTrace(trace(), { ...interval, processEnd: sample(145, 4_000) }).sampledMaxRssBytes).toBe(4_000)
})

test.each([
  ["PID reuse", (rows: Record<string, unknown>[]) => { rows[3] = { ...rows[3], resource: { ...sample(120), startIdentity: "darwin-abstime:101" } } }],
  ["clock regression", (rows: Record<string, unknown>[]) => { rows[3] = { ...rows[3], resource: sample(90) } }],
  ["unresolved workerd", (rows: Record<string, unknown>[]) => { rows[7] = { ...rows[7], remainingWorkerdPids: [42] } }],
  ["missing completion", (rows: Record<string, unknown>[]) => { rows.pop() }],
  ["wrong owner", (rows: Record<string, unknown>[]) => { rows[2] = { ...rows[2], ownerIdentity: "darwin-abstime:51" } }],
  ["missing samples", (rows: Record<string, unknown>[]) => { rows.splice(1, 5) }],
  ["observer error", (rows: Record<string, unknown>[]) => { rows[7] = { ...rows[7], error: "sampling failed", completed: false } }],
] as const)("rejects %s without qualifying a smaller observation set", (_name, mutate) => {
  const rows = trace()
  mutate(rows)
  expect(() => qualifyMemoryTrace(rows, interval)).toThrow()
})

test("requires samples before and after the entire measured interval", () => {
  expect(() => qualifyMemoryTrace(trace(), { ...interval, processStart: sample(75) })).toThrow(/cover/)
  expect(() => qualifyMemoryTrace(trace(), { ...interval, processEnd: sample(165) })).toThrow(/cover/)
})

test("rejects a long sampling gap even if endpoint coverage exists", () => {
  const rows = trace()
  rows[4] = { ...rows[4], resource: sample(390) }
  rows[5] = { ...rows[5], resource: sample(410) }
  rows[6] = { ...rows[6], atMs: 430 }
  rows[7] = { ...rows[7], atMs: 450 }
  expect(() => qualifyMemoryTrace(rows, { ...interval, processEnd: sample(400) })).toThrow(/gap/)
})
