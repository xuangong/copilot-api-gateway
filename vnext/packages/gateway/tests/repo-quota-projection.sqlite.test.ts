import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { initSqlite } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BILLING_DIMENSIONS } from "@vibe-llm/protocols/common"
import { computeWeightedTokens } from "@vibe-llm/protocols/quota"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { checkQuota } from "../src/data-plane/observability/quota.ts"
import { runQuotaGate } from "../src/data-plane/chat-flow/shared/quota-gate.ts"
import type { ApiKeyId } from "../src/repo/branded-ids.ts"
import { initRepo } from "../src/repo/index.ts"
import { buildSharedRepo } from "../src/repo/shared/repos.ts"
import type { SqlExecutor } from "../src/repo/shared/executor.ts"
import type { ApiKey, Repo, UsageRecord } from "../src/repo/types.ts"
import { recordCostUsd } from "../src/shared/usage-cost.ts"

let db: Database
let repo: Repo
const reads: { sql: string; rows: number }[] = []
const keyId = "quota-key" as ApiKeyId
const range = { keyId, start: "2026-09-01T00", end: "2026-10-01T00" }

beforeEach(() => {
  db = new Database(":memory:")
  initSqlite(db)
  const executor: SqlExecutor = {
    async all<T>(sql: string, binds: unknown[]): Promise<T[]> {
      const rows = db.query(sql).all(...binds as SQLQueryBindings[]) as T[]
      reads.push({ sql, rows: rows.length })
      return rows
    },
    async first<T>(sql: string, binds: unknown[]): Promise<T | null> {
      const row = db.query(sql).get(...binds as SQLQueryBindings[]) as T | null
      reads.push({ sql, rows: row === null ? 0 : 1 })
      return row
    },
    async run(sql, binds) {
      return { changes: db.query(sql).run(...binds as SQLQueryBindings[]).changes }
    },
  }
  repo = buildSharedRepo(executor)
  initRepo(repo)
  reads.length = 0
})
afterEach(() => { __resetPlatformForTests(); db.close() })

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    keyId, incomingModel: "alias", model: "target", modelKey: "provider:model",
    upstream: null, client: "curl", hour: range.start, requests: 0, tokens: {}, cost: null,
    ...overrides,
  }
}

function insertDimension(dimension: string, tokens: number, price: number | null, overrides: Partial<UsageRecord> = {}): void {
  const r = record(overrides)
  db.query(`INSERT INTO usage
    (key_id, incoming_model, model, model_key, upstream, client, hour, dimension, tokens, unit_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.keyId, r.incomingModel, r.model, r.modelKey, r.upstream, r.client, r.hour, dimension, tokens, price)
}

function weighted(tokens: UsageRecord["tokens"]): number {
  return computeWeightedTokens(tokens.input_cache_read ?? 0, tokens.input_cache_write ?? 0,
    (tokens.input ?? 0) + (tokens.input_image ?? 0), (tokens.output ?? 0) + (tokens.output_image ?? 0))
}

async function expectLegacyParity(): Promise<void> {
  const legacy = await repo.usage.query(range)
  const projected = await repo.usage.queryQuota(range)
  expect(projected.requests).toBe(legacy.reduce((total, r) => total + r.requests, 0))
  for (const dimension of BILLING_DIMENSIONS) {
    expect(projected.tokens[dimension]).toBe(legacy.reduce((total, r) => total + (r.tokens[dimension] ?? 0), 0))
  }
  expect(projected.costUsd).toBeCloseTo(legacy.reduce((total, r) => total + recordCostUsd(r), 0), 12)
  expect(weighted(projected.tokens)).toBeCloseTo(legacy.reduce((total, r) => total + weighted(r.tokens), 0), 8)
}

test("quota projection returns one zero aggregate for an empty range", async () => {
  expect(await repo.usage.queryQuota(range)).toMatchObject({
    requests: 0, costUsd: 0,
    tokens: { input: 0, input_cache_read: 0, input_cache_write: 0, input_image: 0, output: 0, output_image: 0 },
  })
  expect(reads.map(r => r.rows)).toEqual([1])
})

test("quota projection preserves zero, unknown cost/dimensions, fallback, image/cache weights and independent buckets", async () => {
  await repo.usage.record(record({ requests: 3 }))
  insertDimension("input", 1_000_000, 2)
  insertDimension("input_cache_read", 1_000_000, null)
  insertDimension("input_cache_write", 1_000_000, 0)
  insertDimension("input_image", 100, null)
  insertDimension("output", 200, 4)
  insertDimension("output_image", 300, null)
  insertDimension("future_dimension", 1_000_000_000, 999)

  await repo.usage.record(record({ hour: "2026-09-02T01", model: "unpriced", requests: 4,
    tokens: { input: 100, input_cache_read: 300, input_cache_write: 400, input_image: 500, output: 200, output_image: 600 } }))
  await repo.usage.record(record({ model: "request-only", requests: 7 }))
  insertDimension("input", 20, 3, { model: "token-only" })

  const totals = await repo.usage.queryQuota(range)
  expect(totals.requests).toBe(14)
  expect(totals.tokens).toEqual({ input: 1_000_120, input_cache_read: 1_000_300, input_cache_write: 1_000_400,
    input_image: 600, output: 400, output_image: 900 })
  expect(totals.costUsd).toBeCloseTo(4.00226, 12)
  expect(weighted(totals.tokens)).toBe(2_357_750)
  expect(totals.roundoff.dimensionRows).toBe(13)
  expect(totals.roundoff.absoluteTokens).toEqual(totals.tokens)
  expect(totals.roundoff.absoluteCostUsd).toBe(totals.costUsd)
  await expectLegacyParity()
})

test("fallback uses all original identity columns, while null and empty upstream identify the same bucket", async () => {
  insertDimension("input", 0, 7)
  insertDimension("input_image", 100, null, { upstream: "" })
  insertDimension("output", 0, 0)
  insertDimension("output_image", 100, null, { upstream: "" })

  const siblings: Partial<UsageRecord>[] = [
    { incomingModel: "other-alias" }, { model: "other-model" }, { modelKey: "other-provider:model" },
    { upstream: "other-upstream" }, { client: "other-client" }, { hour: "2026-09-01T01" },
  ]
  for (const sibling of siblings) insertDimension("input_image", 100, null, sibling)
  insertDimension("input_cache_read", 100, null, { keyId: "other-key" as ApiKeyId })
  insertDimension("input", 100, 99, { incomingModel: "a\0b", model: "c" })
  insertDimension("input_image", 100, null, { incomingModel: "a", model: "b\0c" })

  const totals = await repo.usage.queryQuota(range)
  expect(totals.costUsd).toBeCloseTo(0.0106, 12)
  expect(totals.tokens.input_image).toBe(800)
  expect(totals.tokens.output_image).toBe(100)
  await expectLegacyParity()
})

test("quota range is key-scoped, start-inclusive and end-exclusive", async () => {
  for (const hour of ["2026-08-31T23", range.start, "2026-09-30T23", range.end]) {
    await repo.usage.record(record({ hour, requests: 2, tokens: { input: 100 }, cost: { input: 10 } }))
  }
  await repo.usage.record(record({ keyId: "other-key" as ApiKeyId, requests: 99, tokens: { input: 1_000_000 }, cost: { input: 100 } }))
  const totals = await repo.usage.queryQuota(range)
  expect(totals.requests).toBe(4)
  expect(totals.tokens.input).toBe(200)
  expect(totals.costUsd).toBeCloseTo(0.002, 12)
  await expectLegacyParity()
})

test("quota query transfers one aggregate row independent of hour/model cardinality", async () => {
  for (let day = 1; day <= 30; day++) {
    for (let model = 0; model < 4; model++) {
      await repo.usage.record(record({ hour: `2026-09-${String(day).padStart(2, "0")}T00`, model: `model-${model}`,
        requests: 1, tokens: { input: 10, output: 20, input_image: 5 }, cost: { input: 2, output: 3 } }))
    }
  }
  const legacy = await repo.usage.query(range)
  expect(legacy).toHaveLength(120)
  expect(reads.map(r => r.rows)).toEqual([360, 120])
  reads.length = 0

  const totals = await repo.usage.queryQuota(range)
  expect(totals.requests).toBe(120)
  expect(totals.costUsd).toBeCloseTo(0.0108, 12)
  expect(reads.map(r => r.rows)).toEqual([1])
  expect(reads[0]?.sql).toContain("SUM(")
})

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return { id: keyId, name: "quota key", key: "sk-quota", createdAt: "2026-01-01T00:00:00Z",
    modelMappingsEnabled: false, modelMappings: [], ...overrides }
}

function thisMonthHour(): string { return new Date().toISOString().slice(0, 10) + "T00" }
function usageReads() { return reads.filter(r => /\busage(?:_requests)?\b/.test(r.sql)) }

test("unconfigured quota and unknown keys never query usage", async () => {
  await repo.apiKeys.save(key())
  db.exec("DROP TABLE usage; DROP TABLE usage_requests")
  expect(await checkQuota(keyId)).toEqual({ allowed: true })
  expect(await checkQuota("unknown-key" as ApiKeyId)).toEqual({ allowed: true })
  expect(usageReads()).toHaveLength(0)
})

test("a real quota storage failure retains the existing fail-open gate", async () => {
  await repo.apiKeys.save(key({ quotaTokensPerMonth: 1 }))
  db.exec("DROP TABLE usage")
  await expect(checkQuota(keyId)).rejects.toThrow("no such table: usage")
  expect(await runQuotaGate(keyId)).toBeNull()
})

test("request-only quota reads counts without the dimension table", async () => {
  await repo.apiKeys.save(key({ quotaRequestsPerMonth: 1 }))
  await repo.usage.record(record({ hour: thisMonthHour(), requests: 2 }))
  db.exec("DROP TABLE usage")
  expect((await checkQuota(keyId)).reason).toBe("Monthly request quota exceeded (2/1). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1])
  expect(usageReads()[0]?.sql).not.toMatch(/\busage\b/)
})

test("token-only quota avoids price lookup and the request-count table", async () => {
  await repo.apiKeys.save(key({ quotaTokensPerMonth: 1 }))
  await repo.usage.record(record({ hour: thisMonthHour(), requests: 2, tokens: { input_image: 100 } }))
  db.exec("DROP TABLE usage_requests")
  expect((await checkQuota(keyId)).reason).toBe("Monthly token quota exceeded (100/1). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1])
  expect(usageReads()[0]?.sql).not.toContain("unit_price")
  expect(usageReads()[0]?.sql).not.toContain("usage_requests")
})

test("ordinary configured quotas use only the single aggregate and preserve request-token-cost denial order", async () => {
  await repo.apiKeys.save(key({ quotaRequestsPerMonth: 1, quotaTokensPerMonth: 100, quotaCostPerMonth: 1 }))
  await repo.usage.record(record({ hour: thisMonthHour(), requests: 2, tokens: { input: 1_000_000 }, cost: { input: 3 } }))
  const denied = await checkQuota(keyId)
  expect(denied.reason).toBe("Monthly request quota exceeded (2/1). Resets at the start of the next UTC month.")
  expect(denied.retryAfterSeconds).toBeGreaterThan(0)
  expect(usageReads().map(r => r.rows)).toEqual([1])

  await repo.apiKeys.save(key({ quotaRequestsPerMonth: 100, quotaTokensPerMonth: 100, quotaCostPerMonth: 1 }))
  reads.length = 0
  expect((await checkQuota(keyId)).reason).toBe("Monthly token quota exceeded (1000000/100). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1])

  await repo.apiKeys.save(key({ quotaRequestsPerMonth: 100, quotaTokensPerMonth: 2_000_000, quotaCostPerMonth: 1 }))
  reads.length = 0
  expect((await checkQuota(keyId)).reason).toBe("Monthly cost quota exceeded ($3.0000/$1). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1])

  await repo.apiKeys.save(key({ quotaRequestsPerMonth: 100, quotaTokensPerMonth: 2_000_000, quotaCostPerMonth: 10 }))
  reads.length = 0
  expect(await checkQuota(keyId)).toEqual({ allowed: true })
  expect(usageReads().map(r => r.rows)).toEqual([1])
})

test("an exceeded request quota does not recheck token/cost rounding boundaries", async () => {
  await repo.apiKeys.save(key({ quotaRequestsPerMonth: 1, quotaTokensPerMonth: 100, quotaCostPerMonth: 1 }))
  await repo.usage.record(record({ hour: thisMonthHour(), requests: 2, tokens: { input: 100 }, cost: { input: 10_000 } }))
  expect((await checkQuota(keyId)).reason).toBe("Monthly request quota exceeded (2/1). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1])
})

test("cost boundaries retain legacy floating-point decisions through a narrow detail recheck", async () => {
  await repo.apiKeys.save(key({ quotaCostPerMonth: 1 }))
  for (let i = 0; i < 10; i++) {
    await repo.usage.record(record({ hour: thisMonthHour(), model: `model-${i}`, requests: 1,
      tokens: { input: 1_000_000 }, cost: { input: 0.1 } }))
  }
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 13)
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 13)
  const oldCost = (await repo.usage.query({ keyId, start, end })).reduce((total, r) => total + recordCostUsd(r), 0)
  expect(oldCost).toBe(0.9999999999999999)
  reads.length = 0
  expect(await checkQuota(keyId)).toEqual({ allowed: true })
  expect(usageReads().map(r => r.rows)).toEqual([1, 10, 10])
})

test("weighted-token boundaries retain legacy floating-point decisions", async () => {
  await repo.apiKeys.save(key({ quotaTokensPerMonth: 0.6000000000000001 }))
  for (let i = 0; i < 6; i++) {
    await repo.usage.record(record({ hour: thisMonthHour(), model: `model-${i}`, requests: 1,
      tokens: { input_cache_read: 1 } }))
  }
  expect(await checkQuota(keyId)).toEqual({ allowed: true })
  expect(usageReads().map(r => r.rows)).toEqual([1, 6, 6])
})

test("exact token/cost limits remain denied after detail recheck", async () => {
  await repo.apiKeys.save(key({ quotaTokensPerMonth: 100, quotaCostPerMonth: 1 }))
  await repo.usage.record(record({ hour: thisMonthHour(), requests: 1, tokens: { input: 100 }, cost: { input: 10_000 } }))
  expect((await checkQuota(keyId)).reason).toBe("Monthly token quota exceeded (100/100). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1, 1, 1])
  await repo.apiKeys.save(key({ quotaCostPerMonth: 1 }))
  reads.length = 0
  expect((await checkQuota(keyId)).reason).toBe("Monthly cost quota exceeded ($1.0000/$1). Resets at the start of the next UTC month.")
  expect(usageReads().map(r => r.rows)).toEqual([1, 1, 1])
})
