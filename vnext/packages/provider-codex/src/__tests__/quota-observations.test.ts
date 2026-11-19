import { expect, test } from "bun:test"
import { readCodexQuotaObservations } from "../quota"

const receipt = Date.parse("2026-01-01T00:00:00.000Z")
const day = 86_400_000
const snapshot = (extra: Record<string, unknown> = {}) => ({ observed_at: "2025-12-31T23:59:00.000Z", ...extra })
const state = (quotaSnapshot: unknown) => ({ accounts: [{ chatgptAccountId: "account", quotaSnapshot }] })

test("fixed freshness preserves old observations and expires exactly at the receipt horizon", () => {
  const raw = state({ standard: { fetchedAt: receipt, data: snapshot({ primary_used_percent: 0 }) } })
  const fresh = readCodexQuotaObservations(raw, "account", receipt + day - 1)?.standard
  const stale = readCodexQuotaObservations(raw, "account", receipt + 3 * day)?.standard
  expect(fresh).toMatchObject({ fetchedAt: receipt, freshUntil: receipt + day, freshness: "fresh", observedAt: "2025-12-31T23:59:00.000Z" })
  expect(stale).toMatchObject({ freshUntil: receipt + day, freshness: "stale", data: { primary_used_percent: 0 } })
  expect(readCodexQuotaObservations(raw, "account", receipt + day)?.standard?.freshness).toBe("stale")
})

test("known reset horizons extend freshness from receipt rather than from read time", () => {
  const raw = state({ weekly: { fetchedAt: receipt, data: snapshot({ secondary_reset_after_at: "2026-01-08T00:00:00.000Z" }) } })
  expect(readCodexQuotaObservations(raw, "account", receipt + 6 * day)?.weekly?.freshUntil).toBe(receipt + 7 * day)
  expect(readCodexQuotaObservations(raw, "account", receipt + 8 * day)?.weekly?.freshness).toBe("stale")
})

test("malformed buckets stay unknown and valid neighbors survive without credential fields", () => {
  for (const raw of [null, {}, state(null), state({}), state({ bad: { fetchedAt: -1, data: snapshot() } })]) {
    expect(readCodexQuotaObservations(raw, "account", receipt)).toBeNull()
  }
  expect(readCodexQuotaObservations(state({ good: { fetchedAt: receipt, data: snapshot() } }), "other")).toBeNull()
  const buckets = JSON.parse('{"__proto__":{"data":{}},"constructor":{}}') as Record<string, unknown>
  Object.assign(buckets, {
    date: { fetchedAt: receipt, data: snapshot({ observed_at: "2026-02-30T00:00:00Z" }) },
    invalid: { fetchedAt: Infinity, data: snapshot() },
    wrong: { fetchedAt: "123", data: snapshot() },
    good: { fetchedAt: receipt, data: snapshot({ primary_used_percent: 0, secondary_used_percent: "0", credits_balance: null,
      primary_window_minutes: -3, secondary_window_minutes: NaN, primary_reset_after_at: "secret", credits_has_credits: false,
      accessToken: "SECRET", refresh_token: "SECRET" }) },
  })
  const result = readCodexQuotaObservations(state(buckets), "account", receipt)
  expect(Object.keys(result ?? {})).toEqual(["good"])
  expect(result?.good?.data).toEqual({ observed_at: "2025-12-31T23:59:00.000Z", primary_used_percent: 0, credits_has_credits: false })
  expect(JSON.stringify(result)).not.toContain("SECRET")
})

// Adapted from reference copilot-gateway c27a76122 (#570): legacy snapshots
// stamped ratelimited_until from the furthest window; reads re-derive it from
// exhausted windows only, without touching other fields.
test("stored legacy ratelimited_until is re-projected from exhausted windows", () => {
  const legacy = {
    primary_used_percent: 100, primary_reset_after_at: "2026-01-01T05:00:00.000Z",
    secondary_used_percent: 40, secondary_reset_after_at: "2026-01-08T00:00:00.000Z",
    ratelimited_until: "2026-01-08T00:00:00.000Z",
  }
  const raw = state({
    primary: { fetchedAt: receipt, data: snapshot(legacy) },
    secondary: { fetchedAt: receipt, data: snapshot({ ...legacy, primary_used_percent: 40, secondary_used_percent: 100 }) },
    none: { fetchedAt: receipt, data: snapshot({ ...legacy, primary_used_percent: 40 }) },
    noreset: { fetchedAt: receipt, data: snapshot({ primary_used_percent: 100, ratelimited_until: "2026-01-08T00:00:00.000Z" }) },
  })
  const out = readCodexQuotaObservations(raw, "account", receipt)
  expect(out?.primary?.data.ratelimited_until).toBe("2026-01-01T05:00:00.000Z")
  expect(out?.primary?.data.secondary_used_percent).toBe(40)
  expect(out?.secondary?.data.ratelimited_until).toBe("2026-01-08T00:00:00.000Z")
  expect(out?.none?.data.ratelimited_until).toBeUndefined()
  expect(out?.noreset?.data.ratelimited_until).toBeUndefined()
})
