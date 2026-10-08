import { expect, test } from "bun:test"
import { verifyAbSideEffects } from "./warm"
type Obj = Record<string, unknown>
function nativeTables(): Record<string, Obj[]> {
  const dims = { hour: "2026-10-08T06", key_id: "architecture-key", model: "bench-chat-ok", upstream: "custom:architecture-chat" }
  const perf = { ...dims, metric_scope: "request_total", source_api: "chat-completions", target_api: "chat-completions", stream: 0, runtime_location: "cloudflare", operation: null }
  const dimensions = JSON.stringify({ incomingModel: dims.model, model: dims.model, upstream: dims.upstream, sourceApi: perf.source_api, targetApi: perf.target_api, stream: false, runtimeLocation: "cloudflare", outcome: "success", inputBucket: "<1k", cacheStatus: "unknown", reasoningEffort: "unknown" })
  return { dump_records: [], spilled_files: [], responses_items: [], responses_snapshots: [], usage: [{ ...dims, model_key: dims.model, dimension: "input", tokens: 175 }, { ...dims, model_key: dims.model, dimension: "output", tokens: 75 }], usage_requests: [{ ...dims, model_key: dims.model, requests: 25 }], performance_summary: [{ ...perf, requests: 25, errors: 0, total_ms_sum: 500 }], performance_latency_buckets: [{ ...perf, lower_ms: 0, upper_ms: 100, count: 25 }], performance_metrics: [ { hour: dims.hour, key_id: dims.key_id, dimensions, metric: "__requests", upper: -1, count: 25, sum: 25, min: 0, max: 0 }, ...[["totalMs", 500], ["upstreamMs", 400], ["inputTokens", 175], ["outputTokens", 75]].flatMap(([metric, sum]) => [{ hour: dims.hour, key_id: dims.key_id, dimensions, metric, upper: -1, count: 25, sum, min: Number(sum) / 25, max: Number(sum) / 25 }, { hour: dims.hour, key_id: dims.key_id, dimensions, metric, upper: 100, count: 25, sum: 0, min: 0, max: 0 }]) ] }
}
test("native A/B success accounting qualifies independently of R TTFT/TPOT schema", () => {
  expect(verifyAbSideEffects(nativeTables(), 25, false).passed).toBe(true)
})
test("missing all performance work cannot qualify successful wire/usage", () => {
  const tables = nativeTables()
  tables.performance_summary = []; tables.performance_latency_buckets = []; tables.performance_metrics = []
  expect(() => verifyAbSideEffects(tables, 25, false)).toThrow()
})
test("native request_total overcount and errors are rejected", () => {
  for (const [field, value] of [["requests", 24], ["errors", 1], ["stream", 2]] as const) {
    const tables = nativeTables(); tables.performance_summary![0]![field] = value
    expect(() => verifyAbSideEffects(tables, 25, false)).toThrow()
  }
})
test("native latency histogram counts must match each summary dimension", () => {
  for (const change of ["missing", "count", "dimension", "duplicate"]) {
    const tables = nativeTables()
    if (change === "missing") tables.performance_latency_buckets = []
    if (change === "count") tables.performance_latency_buckets![0]!.count = 24
    if (change === "dimension") tables.performance_latency_buckets![0]!.source_api = "responses"
    if (change === "duplicate") tables.performance_latency_buckets!.push({ ...tables.performance_latency_buckets![0]! })
    expect(() => verifyAbSideEffects(tables, 25, false)).toThrow()
  }
})
test("modern native requests and required metric summaries/buckets cannot disappear", () => {
  for (const change of ["requests", "totalMs", "bucket", "dimensions"]) {
    const tables = nativeTables()
    if (change === "requests") tables.performance_metrics = tables.performance_metrics!.filter(row => row.metric !== "__requests")
    if (change === "totalMs") tables.performance_metrics = tables.performance_metrics!.filter(row => row.metric !== "totalMs")
    if (change === "bucket") tables.performance_metrics = tables.performance_metrics!.filter(row => !(row.metric === "totalMs" && row.upper !== -1))
    if (change === "dimensions") tables.performance_metrics![0]!.dimensions = "{}"
    expect(() => verifyAbSideEffects(tables, 25, false)).toThrow()
  }
})
test("dump-off rejects persisted rows and retained history", () => {
  for (const table of ["dump_records", "spilled_files", "responses_items", "responses_snapshots"]) {
    const tables = nativeTables(); tables[table]!.push({ id: "unexpected" })
    expect(() => verifyAbSideEffects(tables, 25, false)).toThrow()
  }
})

test("offline A/B semantic gate rechecks saved tables rather than trusting passed flags", async () => {
  const { verifySavedAbSideEffects } = await import("./warm")
  const tables = nativeTables(), semantic = verifyAbSideEffects(tables, 25, false)
  expect(verifySavedAbSideEffects({ tables, semantic }, { tables: structuredClone(tables), semantic }, 25, false).passed).toBe(true)
  const corrupted = structuredClone(tables)
  corrupted.performance_summary = []; corrupted.performance_latency_buckets = []; corrupted.performance_metrics = []
  expect(() => verifySavedAbSideEffects({ tables: corrupted, semantic }, { tables: corrupted, semantic }, 25, false)).toThrow()
  const mismatch = structuredClone(tables)
  mismatch.performance_summary![0]!.total_ms_sum = 999
  expect(() => verifySavedAbSideEffects({ tables, semantic }, { tables: mismatch, semantic }, 25, false)).toThrow("artifact mismatch")
  expect(() => verifySavedAbSideEffects({ tables, semantic: { passed: true } }, { tables, semantic }, 25, false)).toThrow("semantic receipt")
})

test("offline fresh-host qualification rejects altered jobs, contexts, dispatches and process ownership", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { sha } = await import("../../2026-10-02-workerd-deployed-comparison/harness/manifest")
  const { freezeWarmPlan } = await import("./warm-contracts")
  const { verifyWarmInstanceArtifacts } = await import("./warm")
  const directory = mkdtempSync(join(tmpdir(), "warm-instance-receipts-"))
  const window = freezeWarmPlan({ runId: "test" }).windows[0]!
  const contextPath = join(directory, "context.json")
  const contextBytes = JSON.stringify({ frozen: true })
  const contextSha256 = sha(contextBytes)
  const job = { version: 1, kind: "warm-window", directory, parentPid: 123, context: { path: contextPath, sha256: contextSha256 }, window }
  const processReceipt = { pid: 124, parentPid: 123, parentGroup: 123, detached: false, exitCode: 0, timedOut: false, spawnError: null, signal: null, finished: true, groupClean: true, remaining: [] }
  function reset() {
    writeFileSync(contextPath, contextBytes)
    const bytes = JSON.stringify(job)
    writeFileSync(join(directory, "instance-job.json"), bytes)
    writeFileSync(join(directory, "instance-result.json"), JSON.stringify({ completed: true, jobSha256: sha(bytes), contextSha256, dispatches: [] }))
    writeFileSync(join(directory, "instance-process.json"), JSON.stringify(processReceipt))
  }
  function change(file: string, patch: Record<string, unknown>) {
    const path = join(directory, file)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }))
  }
  try {
    reset()
    expect(verifyWarmInstanceArtifacts(directory, window, []).passed).toBe(true)
    const corruptions = [
      () => writeFileSync(contextPath, "{}"),
      () => change("instance-job.json", { kind: "reference-canary" }),
      () => change("instance-job.json", { window: { ...window, timed: 19 } }),
      () => change("instance-job.json", { directory: directory + "-wrong" }),
      () => change("instance-job.json", { parentPid: 999 }),
      () => change("instance-result.json", { completed: false }),
      () => change("instance-result.json", { jobSha256: "f".repeat(64) }),
      () => change("instance-result.json", { contextSha256: "f".repeat(64) }),
      () => change("instance-result.json", { dispatches: [{}] }),
      ...[{ exitCode: 1 }, { timedOut: true }, { spawnError: "failed" }, { groupClean: false }, { detached: true }, { parentGroup: 999 }, { parentPid: 999 }, { pid: null }, { finished: false }, { signal: "SIGTERM" }, { remaining: [{ pid: 125 }] }].map(patch => () => change("instance-process.json", patch)),
    ]
    for (const corrupt of corruptions) {
      reset(); corrupt()
      expect(() => verifyWarmInstanceArtifacts(directory, window, [])).toThrow()
    }
    reset()
    writeFileSync(join(directory, "instance-job.json"), readFileSync(join(directory, "instance-job.json"), "utf8") + "\n")
    expect(() => verifyWarmInstanceArtifacts(directory, window, [])).toThrow("result identity")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
