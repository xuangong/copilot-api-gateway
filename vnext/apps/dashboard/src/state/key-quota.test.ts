import { expect, test } from "bun:test"
import type { UsageOverviewMetrics } from "../api/usage"
import { beginQuotaLoad, failQuotaLoad, finishQuotaLoad, IDLE_QUOTA, projectQuotaUsage } from "./key-quota"

const total: UsageOverviewMetrics = {
  requests: 1, cacheRead: 10, cacheCreation: 4, input: 2, output: 3,
  costUSD: 0.125, hasRecords: true, unpricedTokens: 7,
  unpricedDimensionRows: 2, observedDimensions: ["input", "output"],
}

test("projects full overview total with current limits and price metadata", () => {
  const usage = projectQuotaUsage({
    quota_requests_per_month: 2,
    quota_tokens_per_month: 24,
    quota_cost_per_month: 0.25,
  }, total)
  expect(usage).toEqual({
    reqLimit: 2, reqUsed: 1, reqPercent: 50,
    tokenLimit: 24, tokenUsed: 23, tokenPercent: 96,
    costLimit: 0.25, costUsed: 0.125, costPercent: 50,
    unpricedTokens: 7, unpricedDimensionRows: 2,
  })
  const unlimited = projectQuotaUsage({
    quota_requests_per_month: null,
    quota_tokens_per_month: 0,
    quota_cost_per_month: null,
  }, { ...total, requests: 0, cacheRead: 0, cacheCreation: 0, input: 0, output: 0, costUSD: 0, hasRecords: false })
  expect([unlimited.reqPercent, unlimited.tokenPercent, unlimited.costPercent]).toEqual([0, 0, 0])
})

test("loading, failure and retry keep only the selected key's last valid total", () => {
  const initial = beginQuotaLoad(IDLE_QUOTA, "a", 1)
  expect(initial.total).toBeNull()
  const ready = finishQuotaLoad(initial, "a", 1, total)
  expect(ready.status).toBe("ready")
  const refreshing = beginQuotaLoad(ready, "a", 2)
  expect(refreshing.total).toBe(total)
  const failed = failQuotaLoad(refreshing, "a", 2, "offline")
  expect(failed.status).toBe("error")
  expect(failed.total).toBe(total)
  const retrying = beginQuotaLoad(failed, "a", 3)
  expect(retrying.error).toBeNull()
  expect(retrying.total).toBe(total)
  expect(finishQuotaLoad(retrying, "a", 2, { ...total, requests: 999 })).toBe(retrying)
  const switched = beginQuotaLoad(retrying, "b", 4)
  expect(switched.total).toBeNull()
  expect(failQuotaLoad(switched, "a", 3, "late")).toBe(switched)
  expect(finishQuotaLoad(switched, "a", 3, total)).toBe(switched)
  const empty = finishQuotaLoad(switched, "b", 4, { ...total, requests: 0, hasRecords: false })
  expect(empty.total?.requests).toBe(0)
  expect(empty.status).toBe("ready")
  expect(IDLE_QUOTA.total).toBeNull()
})
