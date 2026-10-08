import { createHash } from "node:crypto"
import { cells } from "../../2026-10-07-reference-stage-measurement/harness/contracts"
import { diffProcessResource } from "../../2026-10-07-reference-stage-measurement/harness/process-resources"
import { requestIdentity, type WarmBlockAggregate, type WarmDispatch, type WarmWindowEvidence, type WarmWindowPlan } from "../../2026-10-07-reference-stage-measurement/harness/warm-contracts"

type Obj = Record<string, unknown>
export type MatchedArm = "B" | "R"
export type MatchedWindow = Omit<WarmWindowPlan, "arm"> & { arm: MatchedArm }
export interface MatchedPlan {
  schema: "matched-sse-warm-v1"
  runId: string
  scope: "exploratory-warmed-matched-sse-no-inspector"
  windows: MatchedWindow[]
  expectedWindows: number
  expectedWarmup: number
  expectedTimed: number
  populationSha256: string
}
export interface MatchedDispatch extends WarmDispatch {
  bodyBytes: number
  requestSha256: string
  normalizedRequestSha256: string
  responseBytes: number
  responsePrefixSha256: string
  responsePrefixBase64: string
  responseHeaders: [string, string][]
}
export interface MatchedWindowEvidence extends Omit<WarmWindowEvidence, "observations"> {
  observations: Omit<WarmWindowEvidence["observations"], "dispatches"> & { observer?: unknown; dispatches: MatchedDispatch[] }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
const selectedCells = ["json-string-common", "sse-string-common", "json-containers-full", "sse-string-full"].map(id => {
  const cell = cells.find(value => value.id === id)
  if (!cell) throw new Error(`Missing shared fixture cell: ${id}`)
  return cell
})

export function freezeMatchedPlan(options: { runId: string }): MatchedPlan {
  check(/^[A-Za-z0-9_-]{1,64}$/.test(options.runId), "Invalid matched run id")
  const windows: MatchedWindow[] = []
  for (let block = 0; block < 6; block++) {
    const order: MatchedArm[] = block % 2 === 0 ? ["B", "R"] : ["R", "B"]
    for (const cell of selectedCells) for (const [orderPosition, arm] of order.entries()) {
      windows.push({ id: `${options.runId}-b${block}-${cell.id}-${arm}`, block, orderPosition, arm, cell: { ...cell }, warmup: 5, timed: 20 })
    }
  }
  return { schema: "matched-sse-warm-v1", runId: options.runId, scope: "exploratory-warmed-matched-sse-no-inspector", windows, expectedWindows: 48, expectedWarmup: 240, expectedTimed: 960, populationSha256: hash(windows) }
}

/** The fixture stores its entire small response, not a truncated prefix. */
export function verifyMatchedDispatch(dispatch: MatchedDispatch) {
  check(dispatch.status === 200 && dispatch.completed === true && dispatch.cancelled === false && dispatch.requestedStream === true, "Upstream SSE source/completion mismatch")
  check(Number.isSafeInteger(dispatch.bodyBytes) && dispatch.bodyBytes > 0 && /^[a-f0-9]{64}$/.test(dispatch.requestSha256) && /^[a-f0-9]{64}$/.test(dispatch.normalizedRequestSha256), "Invalid upstream request identity")
  check(dispatch.responseHeaders.some(([key, value]) => key.toLowerCase() === "content-type" && value === "text/event-stream"), "Upstream SSE MIME mismatch")
  const response = Buffer.from(dispatch.responsePrefixBase64, "base64")
  check(response.toString("base64") === dispatch.responsePrefixBase64 && response.length === dispatch.responseBytes && sha(response) === dispatch.responsePrefixSha256, "Upstream complete SSE byte/hash mismatch")
  const chunk = (delta: Obj, finish_reason: string | null, usage?: Obj) => `data: ${JSON.stringify({ id: `chatcmpl_${dispatch.id}`, object: "chat.completion.chunk", created: 1790726400, model: "bench-chat-ok", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`
  const expected = [chunk({ role: "assistant" }, null), chunk({ content: "BENCH_OK:65536" }, null), chunk({}, "stop", { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }), "data: [DONE]\n\n"].join("")
  check(response.toString("utf8") === expected, "Upstream SSE frames/terminal/usage mismatch")
  return { frames: 4, responseBytes: response.length, normalizedResponseSha256: sha(expected.replaceAll(dispatch.id, "NORMALIZED")) }
}

/** Each request in this fixture makes exactly one successful upstream call. */
export function verifyUpstreamMetrics(tables: Record<string, Obj[]>, count: number, stream: boolean) {
  const metrics = tables.performance_metrics ?? []
  check(metrics.length > 0 && metrics.every(row => typeof row.dimensions === "string" && (JSON.parse(row.dimensions) as Obj).stream === stream), "Matched metric downstream stream dimension mismatch")
  const points = metrics.filter(row => row.metric === "upstreamTtftMs" && row.upper === -1)
  const buckets = metrics.filter(row => row.metric === "upstreamTtftMs" && row.upper !== -1)
  const samples = (rows: Obj[]) => rows.reduce((sum, row) => sum + Number(row.count), 0)
  check(points.length > 0 && points.every(row => Number.isSafeInteger(row.count) && Number(row.count) > 0) && samples(points) === count && buckets.length > 0 && samples(buckets) === count, "Missing or incorrect upstreamTtftMs per-call coverage")
  if (!stream) check(!metrics.some(row => row.metric === "ttftMs" || row.metric === "firstTextMs"), "JSON downstream has fabricated streaming first-output metric")
  return { passed: true as const, upstreamTtftSamples: samples(points), providerInvocations: count, downstreamStream: stream }
}

const quantile = (values: number[], p: number): number | null => {
  if (!values.length) return null
  const value = [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * values.length) - 1)]
  if (value === undefined) throw new Error("Quantile index is outside the measured population")
  return value
}
const ratio = (value: number, count: number) => count > 0 ? value / count : null

/** Frozen population and failures are retained; missing evidence never rebalances the run. */
export function aggregateMatchedRun(plan: MatchedPlan, windows: readonly MatchedWindowEvidence[]) {
  const expected = freezeMatchedPlan({ runId: plan.runId })
  check(hash(plan) === hash(expected), "Frozen matched plan differs from declared design")
  const errors: string[] = [], rowsByGroup = new Map<string, number[]>(), blocksByGroup = new Map<string, WarmBlockAggregate[]>()
  const wireByGroup = new Map<string, { requestBytes: Set<number>; requestHashes: Set<string>; sourceBytes: Set<number>; sourceHashes: Set<string>; responseBytes: number[]; responseEvents: number[] }>()
  const population = new Map<string, MatchedWindowEvidence[]>(), processOwners = new Map<string, string>()
  for (const window of windows) { const list = population.get(window.id) ?? []; list.push(window); population.set(window.id, list) }
  for (const id of population.keys()) if (!expected.windows.some(window => window.id === id)) errors.push(`Unexpected window ${id}`)
  let timedOffered = 0, warmupOffered = 0, timedSuccesses = 0, cpuMs = 0, cpuWindows = 0
  for (const window of expected.windows) {
    const found = population.get(window.id) ?? [], evidence = found.length === 1 ? found[0] : undefined
    const windowErrors: string[] = [], reject = (message: string) => windowErrors.push(`${window.id}: ${message}`)
    let offered = 0, successes = 0, windowCpu: number | null = null, rssStart: number | null = null, rssEnd: number | null = null, latencies: number[] = []
    const key = `${window.cell.id}/${window.arm}`
    const wire = wireByGroup.get(key) ?? { requestBytes: new Set<number>(), requestHashes: new Set<string>(), sourceBytes: new Set<number>(), sourceHashes: new Set<string>(), responseBytes: [], responseEvents: [] }
    wireByGroup.set(key, wire)
    if (!evidence) reject(found.length ? "Duplicate window" : "Missing window")
    else {
      const observations = evidence.observations, timed = observations.rows.filter(row => row.phase === "timed"), warmup = observations.rows.filter(row => row.phase === "warmup")
      offered = timed.length; successes = timed.filter(row => row.ok && row.status === 200).length
      timedOffered += offered; warmupOffered += warmup.length; timedSuccesses += successes
      if (!evidence.completed || evidence.id !== window.id || evidence.arm !== window.arm || evidence.cell !== window.cell.id || evidence.block !== window.block) reject("Window identity/completion mismatch")
      if (evidence.identity.hooks !== false || evidence.identity.inspector !== null || observations.observer !== undefined) reject("Control includes observer/Inspector")
      if (!observations.scope.includes("warmed") || !observations.scope.includes("settlement")) reject("Resource scope does not cover warmed work through settlement")
      const before = observations.warmupSettlement, after = observations.settlement
      for (const [name, state] of [["Warmup", before], ["Timed", after]] as const) if (!state || state.active !== 0 || state.pending !== 0 || state.registered !== state.settled || state.failures.length || state.observerFailures !== 0 || state.unowned !== 0) reject(`${name} settlement incomplete`)
      if (before && after.registered < before.registered) reject("Settlement counters regressed")
      const receipt = evidence.readback.semantic ?? evidence.readback
      if (receipt.passed !== true || receipt.historyDisabled !== true) reject("Readback contract failed")
      const expectedIds = (["warmup", "timed"] as const).flatMap(phase => Array.from({ length: phase === "warmup" ? window.warmup : window.timed }, (_, index) => requestIdentity(window.id, phase, index)))
      if (observations.rows.length !== expectedIds.length || new Set(observations.rows.map(row => row.id)).size !== expectedIds.length || expectedIds.some(id => !observations.rows.some(row => row.id === id))) reject("Offer population mismatch")
      for (const row of observations.rows) {
        const phase = row.id.startsWith(`${window.id}-warmup-`) ? "warmup" : row.id.startsWith(`${window.id}-timed-`) ? "timed" : null
        if (row.arm !== window.arm || row.phase !== phase || row.cell !== window.cell.id || row.dump !== window.cell.dump || row.stream !== window.cell.stream || row.wireBytes !== window.cell.bytes || !row.wireEvidence) reject("Row phase/configuration/identity mismatch")
        if (!Number.isFinite(row.eofMs) || row.eofMs < 0) reject("Invalid EOF latency")
        if (!row.ok || row.status !== 200) reject(`Unsuccessful offered request ${row.id}`)
        if (window.cell.dump && window.arm === "B" ? !row.dumpRecordId : row.dumpRecordId !== null) reject("Dump policy mismatch")
      }
      if (window.arm === "R" && window.cell.dump) {
        const records = evidence.readback.semantic?.records ?? []
        if (records.length !== observations.rows.length || new Set(records.map(row => row.logicalId)).size !== observations.rows.length || new Set(records.map(row => row.recordId)).size !== observations.rows.length || observations.rows.some(row => !records.some(record => record.logicalId === row.id && typeof record.recordId === "string" && record.recordId.length > 0 && record.passed === true && record.correlation?.basis === "sql-benchmark-header-and-full-request-bytes" && record.correlation.benchmarkId === row.id && record.correlation.requestSha256 === row.requestSha256 && record.correlation.requestBytes === row.wireBytes))) reject("Native R readback association mismatch")
      }
      const dumpIds = observations.rows.filter(row => row.dump && row.arm === "B").map(row => row.dumpRecordId)
      if (new Set(dumpIds).size !== dumpIds.length) reject("Repeated dump identity")
      if (observations.dispatches.length !== observations.rows.length || new Set(observations.dispatches.map(dispatch => dispatch.id)).size !== observations.rows.length || observations.dispatches.some(dispatch => !observations.rows.some(row => row.id === dispatch.id))) reject("Dispatch population mismatch")
      for (const dispatch of observations.dispatches) {
        try {
          const source = verifyMatchedDispatch(dispatch)
          wire.requestBytes.add(dispatch.bodyBytes); wire.requestHashes.add(dispatch.normalizedRequestSha256)
          wire.sourceBytes.add(source.responseBytes); wire.sourceHashes.add(source.normalizedResponseSha256)
        } catch (error) { reject(`${dispatch.id}: ${String(error)}`) }
      }
      for (const row of timed) {
        if (typeof row.responseBytes === "number") wire.responseBytes.push(row.responseBytes)
        if (Array.isArray(row.wireEvents)) wire.responseEvents.push(row.wireEvents.length)
      }
      latencies = timed.filter(row => Number.isFinite(row.eofMs) && row.eofMs >= 0).map(row => row.eofMs)
      try {
        if (observations.processStart.executableName !== "workerd" || observations.processEnd.executableName !== "workerd") throw new Error("CPU endpoints must identify workerd")
        const delta = diffProcessResource(observations.processStart, observations.processEnd)
        if (Object.entries(delta).some(([name, value]) => value !== (observations.resources as unknown as Obj)[name])) reject("Resource delta differs from independent PID samples")
        else { windowCpu = delta.cpuUs / 1000; cpuMs += windowCpu; cpuWindows++; rssStart = observations.processStart.rssBytes; rssEnd = observations.processEnd.rssBytes }
        const identity = `${delta.pid}/${delta.startIdentity}`, owner = processOwners.get(identity)
        if (owner) reject(`Workerd process reused from ${owner}`)
        else processOwners.set(identity, window.id)
      } catch (error) { reject(`Invalid process identity/counters: ${String(error)}`) }
    }
    const block: WarmBlockAggregate = { block: window.block, windowId: window.id, qualified: windowErrors.length === 0, errors: windowErrors, offered, successes, failures: offered - successes, cpuMs: windowCpu, cpuPerOfferedMs: windowCpu === null ? null : ratio(windowCpu, offered), cpuPerSuccessMs: windowCpu === null ? null : ratio(windowCpu, successes), medianEofMs: quantile(latencies, .5), p95EofMs: quantile(latencies, .95), rssStartBytes: rssStart, rssEndBytes: rssEnd }
    const blocks = blocksByGroup.get(key) ?? []; blocks.push(block); blocksByGroup.set(key, blocks)
    const prior = rowsByGroup.get(key) ?? []; prior.push(...latencies); rowsByGroup.set(key, prior)
    errors.push(...windowErrors)
  }
  const groups = [...blocksByGroup].map(([key, blocks]) => {
    const [cell, arm] = key.split("/"), latencies = rowsByGroup.get(key) ?? [], offered = blocks.reduce((sum, block) => sum + block.offered, 0), successes = blocks.reduce((sum, block) => sum + block.successes, 0)
    const validCpu = blocks.every(block => block.cpuMs !== null), groupCpu = blocks.reduce((sum, block) => sum + (block.cpuMs ?? 0), 0), wire = wireByGroup.get(key)
    if (!cell || (arm !== "B" && arm !== "R") || !wire) throw new Error(`Invalid matched aggregate group: ${key}`)
    return { cell, arm, sourceFormat: "sse" as const, qualified: blocks.every(block => block.qualified), offered, successes, cpuMs: validCpu ? groupCpu : null, cpuPerOfferedMs: validCpu ? ratio(groupCpu, offered) : null, cpuPerSuccessMs: validCpu ? ratio(groupCpu, successes) : null, eof: { n: latencies.length, p50Ms: quantile(latencies, .5), p95Ms: quantile(latencies, .95) }, wire: { upstreamRequestBytes: [...wire.requestBytes].sort((a, b) => a - b), normalizedUpstreamRequestHashes: [...wire.requestHashes].sort(), upstreamResponseBytes: [...wire.sourceBytes].sort((a, b) => a - b), normalizedUpstreamResponseHashes: [...wire.sourceHashes].sort(), downstreamResponseBytesP50: quantile(wire.responseBytes, .5), downstreamEventsP50: quantile(wire.responseEvents, .5) }, blocks }
  })
  return { schema: "matched-sse-warm-aggregate-v1" as const, runId: plan.runId, scope: plan.scope, comparisonQualified: errors.length === 0, formalStatisticsCompleted: false as const, quantileMethod: "nearest-rank" as const, latencyInterpretation: "client EOF only; warmup excluded; exploratory pooled p50/p95 without robust tail claim" as const, cpuInterpretation: "whole workerd process through settlement; all offered work retained; excludes host fixture/client and physical readback; not isolate or billed CPU" as const, rssMeasurement: "endpoints-only; not a peak" as const, comparability: { upstream: "SSE for both arms and downstream formats; exact fixture payload and four frames verified", nativeUpstreamRequestSerializationEqual: false, completeWorkEqual: false, diagnostics: "full cells retain native diagnostic guarantees and affinity behavior", firstOutput: "native upstreamTtftMs is a per-call server metric; client first semantic output unmeasured" }, totals: { expectedWindows: plan.expectedWindows, observedWindows: windows.length, warmupOffered, timedOffered, timedSuccesses, cpuMs: cpuWindows === plan.expectedWindows ? cpuMs : null, cpuPerOfferedMs: cpuWindows === plan.expectedWindows ? ratio(cpuMs, timedOffered) : null, cpuPerSuccessMs: cpuWindows === plan.expectedWindows ? ratio(cpuMs, timedSuccesses) : null }, groups, errors }
}
