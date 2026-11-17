import { expect, test } from "bun:test"
import { SharedTelemetryRepo } from "../src/repo/shared/telemetry"
import type { SqlExecutor, SqlStatement } from "../src/repo/shared/executor"
import { PUSH_LIMITS, parsePushBody } from "../src/control-plane/telemetry/protocol"
import { TELEMETRY_INSERT_CHUNK, type TelemetryPoint } from "../src/repo/telemetry"

// Cloudflare D1 free plan: 50 queries per invocation. A push is one batch, so its statement count must stay below that.
const D1_FREE_QUERY_LIMIT = 50
const WORST_CASE_STATEMENTS = 47

const nowMs = Date.UTC(2026, 10, 16, 12)
const hourNow = Math.floor(nowMs / 3_600_000) * 3600

function worstCaseBody() {
  const points = []
  for (let m = 0; m < PUSH_LIMITS.metrics; m++) {
    for (let i = 0; i < PUSH_LIMITS.points / PUSH_LIMITS.metrics; i++) {
      points.push({
        metric: `metric_${m}`, hour: new Date((hourNow - 3600 * ((i % 168) + 1)) * 1000).toISOString().replace(".000Z", "Z"),
        dims: { u: `user-${i}` }, value: 1, unit: "count",
      })
    }
  }
  return { version: 1, points }
}

test("the worst-case body (20 metrics, 20 000 points) is accepted and replaces hours in at most 47 statements", async () => {
  const points = parsePushBody(worstCaseBody(), nowMs)
  expect(points).toHaveLength(20_000)
  expect(PUSH_LIMITS.metrics).toBe(20)
  const seen: SqlStatement[] = []
  const executor: SqlExecutor = {
    all: async () => [], first: async () => null, run: async () => ({ changes: 1 }),
    batch: async statements => { seen.push(...statements); return statements.map(() => ({ changes: 1 })) },
  }
  expect(await new SharedTelemetryRepo(executor).replaceHours("tls_x", points, "2026-11-16T12:00:00.000Z")).toBe(true)
  // 20 DELETEs + 20 point INSERT chunks + 4 rollup chunks (3 360 metric-hours) + 1 UPDATE
  expect(seen.length).toBe(45)
  expect(seen.length).toBeLessThanOrEqual(WORST_CASE_STATEMENTS)
  expect(WORST_CASE_STATEMENTS).toBeLessThan(D1_FREE_QUERY_LIMIT)
})

const MAX_CHUNK_BYTES = 1_500_000
const spyRepo = (seen: SqlStatement[]) => new SharedTelemetryRepo({
  all: async () => [], first: async () => null, run: async () => ({ changes: 1 }),
  batch: async statements => { seen.push(...statements); return statements.map(() => ({ changes: 1 })) },
})
const chunkSizes = (seen: SqlStatement[]) => seen.filter(s => s.sql.startsWith("INSERT INTO telemetry_points")).map(s => new TextEncoder().encode(s.binds[1] as string).length)

test("a quote-heavy body within 2 MiB is split by size: at most 47 statements, every chunk value at most 1.5 MB", async () => {
  // Every character needs escaping twice (in the canonical dims text, then in the serialized rows).
  const nasty = '"'.repeat(256)
  const points = []
  for (let i = 0; points.length < 1250; i++) {
    points.push({
      metric: `metric_${i % 20}`, hour: new Date((hourNow - 3600 * ((i % 168) + 1)) * 1000).toISOString().replace(".000Z", "Z"),
      dims: { aaaa: `${i}${nasty}`.slice(0, 256), bbbb: nasty, cccc: nasty }, value: 1, unit: "count",
    })
  }
  const body = { version: 1, points }
  const size = new TextEncoder().encode(JSON.stringify(body)).length
  expect(size).toBeLessThanOrEqual(PUSH_LIMITS.bodyBytes)
  const parsed = parsePushBody(body, nowMs)
  const seen: SqlStatement[] = []
  await spyRepo(seen).replaceHours("tls_x", parsed, "2026-11-16T12:00:00.000Z")
  const sizes = chunkSizes(seen)
  expect(sizes.length).toBeGreaterThan(1)
  expect(seen.length).toBeLessThanOrEqual(WORST_CASE_STATEMENTS)
  for (const bytes of sizes) expect(bytes).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
})

test("a full-count chunk of maximal ASCII dims is split before it can reach D1's 2 MB value limit", async () => {
  const points: TelemetryPoint[] = Array.from({ length: TELEMETRY_INSERT_CHUNK }, (_, i) =>
    ({ metric: "m".repeat(64), hour: hourNow - 3600, dims: { aaaa: `${i}`.padEnd(256, "x"), bbbb: "y".repeat(256), cccc: "z".repeat(256) }, value: 1e15, unit: "bytes" }))
  const seen: SqlStatement[] = []
  await spyRepo(seen).replaceHours("tls_x", points, "2026-11-16T12:00:00.000Z")
  for (const bytes of chunkSizes(seen)) expect(bytes).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
})
