import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { requestIdentity } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"
import { aggregateMatchedRun, freezeMatchedPlan, verifyMatchedDispatch, verifyUpstreamMetrics, type MatchedWindowEvidence } from "./contracts"

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
function fixtureAt<T>(values: readonly T[], index = 0): T {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing fixture at index ${index}`)
  return value
}
function dispatch(id: string) {
  const prefix = { id: `chatcmpl_${id}`, object: "chat.completion.chunk", created: 1790726400, model: "bench-chat-ok" }
  const frames = [
    { ...prefix, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { ...prefix, choices: [{ index: 0, delta: { content: "BENCH_OK:65536" }, finish_reason: null }] },
    { ...prefix, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  ]
  const response = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"
  return { id, status: 200, completed: true, cancelled: false, requestedStream: true, bodyBytes: 65536, requestSha256: "a".repeat(64), normalizedRequestSha256: "b".repeat(64), responseBytes: Buffer.byteLength(response), responsePrefixSha256: sha(response), responsePrefixBase64: Buffer.from(response).toString("base64"), responseHeaders: [["content-type", "text/event-stream"]] as [string, string][] }
}
function complete() {
  const plan = freezeMatchedPlan({ runId: "test" })
  const windows: MatchedWindowEvidence[] = plan.windows.map((w, index) => {
    const rows = (["warmup", "timed"] as const).flatMap(phase => Array.from({ length: phase === "warmup" ? 5 : 20 }, (_, ordinal) => ({ id: requestIdentity(w.id, phase, ordinal), arm: w.arm, phase, cell: w.cell.id, dump: w.cell.dump, stream: w.cell.stream, wireBytes: 65536, requestSha256: "c".repeat(64), status: 200, ok: true, eofMs: 20, dumpRecordId: w.cell.dump && w.arm === "B" ? `${w.id}-${phase}-${ordinal}` : null, wireEvidence: "independent.json" })))
    const start = { pid: 42 + index, startIdentity: `darwin-abstime:${index + 1}`, executableName: "workerd", scope: "darwin-process-libproc-rusage-v2", observedAtMs: 1, userUs: 10, systemUs: 5, rssBytes: 100 }
    const end = { ...start, observedAtMs: 100, userUs: 2010, systemUs: 1005, rssBytes: 200 }
    return { id: w.id, block: w.block, arm: w.arm, cell: w.cell.id, identity: { hooks: false, inspector: null }, observations: { rows, dispatches: rows.map(r => dispatch(r.id)), processStart: start, processEnd: end, resources: { pid: start.pid, startIdentity: start.startIdentity, scope: start.scope, elapsedMs: 99, userUs: 2000, systemUs: 1000, cpuUs: 3000 }, warmupSettlement: { active: 0, pending: 0, registered: 5, settled: 5, failures: [], observerFailures: 0, unowned: 0 }, settlement: { active: 0, pending: 0, registered: 25, settled: 25, failures: [], observerFailures: 0, unowned: 0 }, scope: "warmed-no-inspector-through-settlement" }, readback: { semantic: { passed: true, historyDisabled: true, records: w.cell.dump && w.arm === "R" ? rows.map(r => ({ logicalId: r.id, recordId: `native-${r.id}`, passed: true, correlation: { basis: "sql-benchmark-header-and-full-request-bytes", benchmarkId: r.id, requestSha256: r.requestSha256, requestBytes: r.wireBytes } })) : [] } }, completed: true }
  })
  return { plan, windows }
}

test("balanced matched SSE plan qualifies both JSON and SSE downstream with 960 timed offers", () => {
  const { plan, windows } = complete()
  const result = aggregateMatchedRun(plan, windows)
  expect(result.comparisonQualified).toBe(true)
  expect(result.totals).toMatchObject({ expectedWindows: 48, observedWindows: 48, warmupOffered: 240, timedOffered: 960, timedSuccesses: 960, cpuMs: 144 })
  expect(result.groups).toHaveLength(8)
  expect(plan.windows.filter(w => w.orderPosition === 0 && w.arm === "B")).toHaveLength(12)
  expect(plan.windows.filter(w => w.orderPosition === 0 && w.arm === "R")).toHaveLength(12)
  expect(result.groups.every(group => group.sourceFormat === "sse" && group.blocks.length === 6)).toBe(true)
  expect(result.rssMeasurement).toBe("endpoints-only; not a peak")
})

test("missing, duplicate or unexpected windows cannot become a smaller valid comparison", () => {
  for (const mutate of [
    (windows: MatchedWindowEvidence[]) => { windows.pop() },
    (windows: MatchedWindowEvidence[]) => { windows.push(fixtureAt(windows)) },
    (windows: MatchedWindowEvidence[]) => { windows.push({ ...fixtureAt(windows), id: "unexpected" }) },
  ]) {
    const value = complete()
    mutate(value.windows)
    expect(aggregateMatchedRun(value.plan, value.windows).comparisonQualified).toBe(false)
  }
})

test("JSON downstream still rejects JSON upstream and retains the failed window", () => {
  const value = complete()
  fixtureAt(fixtureAt(value.windows).observations.dispatches).requestedStream = false
  const result = aggregateMatchedRun(value.plan, value.windows)
  expect(result.comparisonQualified).toBe(false)
  expect(result.totals.timedOffered).toBe(960)
  expect(result.errors.some(error => error.includes("SSE"))).toBe(true)
})

test("failed timed requests keep CPU per offered work while success denominator stays zero", () => {
  const value = complete(), window = fixtureAt(value.windows)
  window.observations.rows.filter(row => row.phase === "timed").forEach(row => { row.ok = false })
  const result = aggregateMatchedRun(value.plan, value.windows)
  const group = result.groups.find(group => group.arm === window.arm && group.cell === window.cell)
  if (!group) throw new Error("Missing aggregate group for fixture window")
  const block = fixtureAt(group.blocks)
  expect(result.comparisonQualified).toBe(false)
  expect(block).toMatchObject({ offered: 20, successes: 0, failures: 20, cpuPerOfferedMs: 0.15, cpuPerSuccessMs: null })
})

test("process identity, observer, counter, settlement and row configuration drift fail qualification", () => {
  for (const mutate of [
    (w: MatchedWindowEvidence) => { w.identity.inspector = {} },
    (w: MatchedWindowEvidence) => { w.observations.observer = { mode: "none" } },
    (w: MatchedWindowEvidence) => { w.observations.processEnd = { ...w.observations.processEnd, pid: 1 } },
    (w: MatchedWindowEvidence) => { w.observations.resources = { ...w.observations.resources, cpuUs: 0 } },
    (w: MatchedWindowEvidence) => { w.observations.warmupSettlement.pending = 1 },
    (w: MatchedWindowEvidence) => { w.observations.settlement.registered = 1; w.observations.settlement.settled = 1 },
    (w: MatchedWindowEvidence) => { fixtureAt(w.observations.rows).phase = "timed" },
    (w: MatchedWindowEvidence) => { const row = fixtureAt(w.observations.rows); row.stream = !row.stream },
    (w: MatchedWindowEvidence) => { fixtureAt(w.observations.rows, 5).eofMs = -1 },
    (w: MatchedWindowEvidence) => { fixtureAt(w.observations.rows, 1).id = fixtureAt(w.observations.rows).id },
    (w: MatchedWindowEvidence) => { fixtureAt(w.observations.rows).dumpRecordId = "unexpected" },
  ]) {
    const value = complete()
    mutate(fixtureAt(value.windows))
    expect(aggregateMatchedRun(value.plan, value.windows).comparisonQualified).toBe(false)
  }
})

test("reusing one workerd identity across independent windows fails", () => {
  const value = complete(), first = fixtureAt(value.windows), second = fixtureAt(value.windows, 1)
  for (const field of ["processStart", "processEnd"] as const) second.observations[field] = { ...second.observations[field], pid: first.observations[field].pid, startIdentity: first.observations[field].startIdentity }
  second.observations.resources = { ...second.observations.resources, pid: first.observations.resources.pid, startIdentity: first.observations.resources.startIdentity }
  expect(aggregateMatchedRun(value.plan, value.windows).comparisonQualified).toBe(false)
})

test("CPU qualification rejects matching non-workerd endpoint identities", () => {
  const value = complete(), window = fixtureAt(value.windows)
  for (const field of ["processStart", "processEnd"] as const) window.observations[field] = { ...window.observations[field], executableName: "bun" }
  const result = aggregateMatchedRun(value.plan, value.windows)
  expect(result.comparisonQualified).toBe(false)
  expect(result.errors.some(error => error.includes("workerd"))).toBe(true)
  expect(result.totals).toMatchObject({ timedOffered: 960, timedSuccesses: 960, cpuMs: null })
})

test("mutated frozen population is rejected before aggregation", () => {
  const value = complete()
  value.plan.expectedTimed = 1
  expect(() => aggregateMatchedRun(value.plan, value.windows)).toThrow("plan")
})

test("R dump records require full native correlation with each offered request", () => {
  const value = complete()
  const records = value.windows.find(w => w.arm === "R" && (w.readback.semantic?.records?.length ?? 0) > 0)?.readback.semantic?.records
  if (!records?.length) throw new Error("Missing native R fixture records")
  records.pop()
  expect(aggregateMatchedRun(value.plan, value.windows).comparisonQualified).toBe(false)
})

test("upstream fixture verifies full SSE bytes, hash, usage and terminal ordering", () => {
  const good = dispatch("fixture")
  expect(verifyMatchedDispatch(good).frames).toBe(4)
  for (const bad of [
    { ...good, responseBytes: good.responseBytes + 1 },
    { ...good, responsePrefixSha256: "0".repeat(64) },
    { ...good, cancelled: true },
    { ...good, responseHeaders: [["content-type", "application/json"]] as [string, string][] },
  ]) expect(() => verifyMatchedDispatch(bad)).toThrow()
  const reordered = Buffer.from(good.responsePrefixBase64, "base64").toString().replace("data: [DONE]\n\n", "")
  const raw = "data: [DONE]\n\n" + reordered
  expect(() => verifyMatchedDispatch({ ...good, responsePrefixBase64: Buffer.from(raw).toString("base64"), responsePrefixSha256: sha(raw) })).toThrow()
})

test("upstream first-output metrics are required per invocation without fabricating downstream JSON TTFT", () => {
  const row = { dimensions: JSON.stringify({ stream: false }), metric: "upstreamTtftMs", upper: -1, count: 25 }
  const tables = { performance_metrics: [row, { ...row, upper: 100 }] }
  expect(verifyUpstreamMetrics(tables, 25, false)).toMatchObject({ upstreamTtftSamples: 25, providerInvocations: 25 })
  expect(() => verifyUpstreamMetrics({ performance_metrics: [] }, 25, false)).toThrow()
  expect(() => verifyUpstreamMetrics(tables, 26, false)).toThrow()
  expect(() => verifyUpstreamMetrics(tables, 25, true)).toThrow()
  expect(() => verifyUpstreamMetrics({ performance_metrics: [...tables.performance_metrics, { ...row, metric: "ttftMs" }] }, 25, false)).toThrow()
})
