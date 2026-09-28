import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { computeWeightedTokens } from "@vibe-llm/protocols/quota"
import { aggregateUsageForDisplay } from "../src/control-plane/token-usage/aggregate"
import { recordCostUsd } from "../src/shared/usage-cost"
import type { ApiKeyId } from "../src/repo/branded-ids"
import type { UsageRecord } from "../src/repo/types"
import { adaptUsageRow } from "../../../apps/dashboard/src/api/usage"
import { projectQuotaUsage } from "../../../apps/dashboard/src/state/key-quota"

const keyId = "quota-key" as ApiKeyId
const keys = { quota_requests_per_month: 8, quota_tokens_per_month: 1000, quota_cost_per_month: 0.001 }

function record(hour: string, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    keyId, hour, incomingModel: "alias", model: "routed", modelKey: "price-a", upstream: null,
    client: "sdk", requests: 2,
    tokens: { input: 100, output: 20, input_cache_read: 40, input_cache_write: 8, input_image: 3, output_image: 2 },
    cost: { input: 0.1, output: 0.2, input_cache_read: 0, input_cache_write: 0.3, input_image: 0.1, output_image: 0.2 },
    ...over,
  }
}

function oldDashboardQuota(records: readonly UsageRecord[]) {
  const rows = aggregateUsageForDisplay(records).map(adaptUsageRow)
  let requests = 0
  let tokens = 0
  let cost = 0
  for (const row of rows) {
    requests += row.requests
    tokens += computeWeightedTokens(row.cacheReadTokens ?? 0, row.cacheCreationTokens ?? 0, row.inputTokens, row.outputTokens)
    cost += row.cost?.totalUSD ?? 0
  }
  return { requests, tokens, cost }
}

function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected) * 1e-10))
}

for (const [start, end, last] of [
  ["2025-02-01T00", "2025-03-01T00", "2025-02-28T23"],
  ["2024-02-01T00", "2024-03-01T00", "2024-02-29T23"],
  ["2026-04-01T00", "2026-05-01T00", "2026-04-30T23"],
  ["2026-07-01T00", "2026-08-01T00", "2026-07-31T23"],
  ["2026-12-01T00", "2027-01-01T00", "2026-12-31T23"],
] as const) {
  test(`selected-key quota total preserves old detail display for ${start}`, async () => {
    const db = new Database(":memory:")
    try {
      const repo = new BunSqliteRepo(db)
      await repo.usage.record(record(start))
      await repo.usage.record(record(last, { upstream: "other", modelKey: "price-b", model: "other", incomingModel: "other-alias", client: "other-sdk" }))
      await repo.usage.record(record(start, { upstream: "request-only", modelKey: "request-only", tokens: {}, requests: 1 }))
      await repo.usage.record(record(last, { upstream: "token-only", modelKey: "token-only", requests: 0, tokens: { output_image: 5 }, cost: { output_image: 0 } }))
      await repo.usage.record(record(end, { requests: 900 }))
      // Historical null/zero prices and signed imports are meaningful inputs to display projection.
      db.run("UPDATE usage SET unit_price=NULL WHERE key_id=? AND upstream='other' AND dimension='input_cache_read'", [keyId])
      db.run("UPDATE usage SET unit_price=NULL WHERE key_id=? AND upstream='other' AND dimension='input'", [keyId])
      db.run("UPDATE usage SET unit_price=0 WHERE key_id=? AND upstream='other' AND dimension='input_cache_write'", [keyId])
      db.run("UPDATE usage SET tokens=-7 WHERE key_id=? AND upstream='other' AND dimension='input'", [keyId])
      const detail = await repo.usage.query({ keyId, start, end })
      const old = oldDashboardQuota(detail)
      const overview = await repo.usage.queryOverview({ keyId, start, end, bucket: "day", axis: "key", limit: 1 })
      const projected = projectQuotaUsage(keys, overview.total)
      expect(projected.reqUsed).toBe(old.requests)
      near(projected.tokenUsed, old.tokens)
      near(projected.costUsed, old.cost)
      expect(projected.reqPercent).toBe(Math.round(old.requests / keys.quota_requests_per_month * 100))
      expect(projected.tokenPercent).toBe(Math.round(old.tokens / keys.quota_tokens_per_month * 100))
      expect(projected.costPercent).toBe(Math.round(old.cost / keys.quota_cost_per_month * 100))
      expect(overview.total.unpricedDimensionRows).toBeGreaterThan(0)
      expect(overview.total.observedDimensions).toHaveLength(6)
      expect(overview.breakdown.rows).toHaveLength(1)
      expect(overview.buckets).toHaveLength(Number(last.slice(8, 10)) > 1 ? 2 : 1)
      // Enforcement consumes raw signed records. Its token arithmetic may differ from positive display projection.
      const rawCost = detail.reduce((sum, row) => sum + recordCostUsd(row), 0)
      near(rawCost, old.cost)
      const rawTokens = detail.reduce((sum, row) => sum + computeWeightedTokens(
        row.tokens.input_cache_read ?? 0, row.tokens.input_cache_write ?? 0,
        (row.tokens.input ?? 0) + (row.tokens.input_image ?? 0),
        (row.tokens.output ?? 0) + (row.tokens.output_image ?? 0),
      ), 0)
      expect(rawTokens).toBeLessThan(old.tokens)
    } finally {
      db.close()
    }
  })
}

test("empty month is a successful zero; just-before rounding threshold matches old reducer", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    const query = { keyId, start: "2026-09-01T00", end: "2026-10-01T00", bucket: "day" as const, axis: "key" as const, limit: 1 }
    const empty = projectQuotaUsage(keys, (await repo.usage.queryOverview(query)).total)
    expect([empty.reqUsed, empty.tokenUsed, empty.costUsed]).toEqual([0, 0, 0])
    await repo.usage.record(record(query.start, { requests: 1, tokens: { input: 4.9949 }, cost: { input: 0.1 } }))
    const detail = await repo.usage.query({ keyId, start: query.start, end: query.end })
    const old = oldDashboardQuota(detail)
    const rawTokens = detail.reduce((sum, row) => sum + computeWeightedTokens(
      row.tokens.input_cache_read ?? 0, row.tokens.input_cache_write ?? 0,
      (row.tokens.input ?? 0) + (row.tokens.input_image ?? 0),
      (row.tokens.output ?? 0) + (row.tokens.output_image ?? 0),
    ), 0)
    near(rawTokens, old.tokens)
    const projected = projectQuotaUsage({ ...keys, quota_tokens_per_month: 100 }, (await repo.usage.queryOverview(query)).total)
    near(projected.tokenUsed, old.tokens)
    expect(projected.tokenPercent).toBe(Math.round(old.tokens))
  } finally {
    db.close()
  }
})
