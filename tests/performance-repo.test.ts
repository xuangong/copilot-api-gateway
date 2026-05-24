import { test, expect, beforeEach, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import type { PerformanceRecordInput } from "../src/repo/types"

let repo: SqliteRepo

function input(overrides: Partial<PerformanceRecordInput> = {}): PerformanceRecordInput {
  return {
    hour: "2026-05-25T10",
    metricScope: "request_total",
    keyId: "k1",
    model: "gpt-4",
    sourceApi: "chat-completions",
    targetApi: "chat-completions",
    stream: false,
    runtimeLocation: "test",
    durationMs: 50,
    isError: false,
    ...overrides,
  }
}

beforeEach(() => {
  repo = new SqliteRepo(new Database(":memory:"))
})

describe("PerformanceRepo (sqlite)", () => {
  test("record aggregates requests and total_ms_sum per slot", async () => {
    await repo.performance.record(input({ durationMs: 50 }))
    await repo.performance.record(input({ durationMs: 90 }))
    const { summary } = await repo.performance.query({ start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(summary).toHaveLength(1)
    expect(summary[0].requests).toBe(2)
    expect(summary[0].totalMsSum).toBe(140)
    expect(summary[0].errors).toBe(0)
  })

  test("error counter increments only when isError", async () => {
    await repo.performance.record(input({ isError: true }))
    await repo.performance.record(input({ isError: false }))
    const { summary } = await repo.performance.query({ start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(summary[0].errors).toBe(1)
    expect(summary[0].requests).toBe(2)
  })

  test("buckets accumulate by latency band", async () => {
    await repo.performance.record(input({ durationMs: 50 }))   // bucket [0,100]
    await repo.performance.record(input({ durationMs: 80 }))   // bucket [0,100]
    await repo.performance.record(input({ durationMs: 150 }))  // bucket [100, 142]→ next bucket up
    const { buckets } = await repo.performance.query({ start: "2026-05-25T00", end: "2026-05-25T23" })
    const base = buckets.find((b) => b.lowerMs === 0)
    expect(base?.count).toBe(2)
    const tail = buckets.find((b) => b.lowerMs > 100)
    expect(tail?.count).toBe(1)
  })

  test("query filter by keyIds", async () => {
    await repo.performance.record(input({ keyId: "k1" }))
    await repo.performance.record(input({ keyId: "k2" }))
    const { summary } = await repo.performance.query({ keyIds: ["k1"], start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(summary).toHaveLength(1)
    expect(summary[0].keyId).toBe("k1")
  })

  test("query filter by metricScope", async () => {
    await repo.performance.record(input({ metricScope: "request_total" }))
    await repo.performance.record(input({ metricScope: "upstream_success" }))
    const { summary } = await repo.performance.query({
      start: "2026-05-25T00",
      end: "2026-05-25T23",
      metricScope: "upstream_success",
    })
    expect(summary).toHaveLength(1)
    expect(summary[0].metricScope).toBe("upstream_success")
  })

  test("deleteAll wipes both tables", async () => {
    await repo.performance.record(input())
    await repo.performance.deleteAll()
    const { summary, buckets } = await repo.performance.query({ start: "2026-05-25T00", end: "2026-05-25T23" })
    expect(summary).toEqual([])
    expect(buckets).toEqual([])
  })
})
