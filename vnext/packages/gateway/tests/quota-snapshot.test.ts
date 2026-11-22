import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { parseQuotaSnapshot } from "../src/quota-balance/snapshot"

const dir = new URL("./fixtures/copilot-quota/", import.meta.url)
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"))

test("a normalised unit and an absolute credit unit give shares through the same rule", () => {
  expect(parseQuotaSnapshot(fixture("synthetic-normalized.json"))).toEqual({ key: "premium_interactions", unitForm: "absolute", unlimited: false, used: 750000, entitlement: 1000000, resetAt: "2026-12-01" })
  expect(parseQuotaSnapshot(fixture("synthetic-credits.json"))).toEqual({ key: "premium_interactions", unitForm: "absolute", unlimited: false, used: 900, entitlement: 1500, resetAt: "2026-12-01T00:00:00.000Z" })
})

test("an unlimited snapshot is reported as unlimited with nothing used", () => {
  expect(parseQuotaSnapshot(fixture("synthetic-unlimited.json"))).toMatchObject({ unlimited: true, used: 0, entitlement: 0 })
})

test("overage keeps used above the entitlement so the share exceeds 1", () => {
  const parsed = parseQuotaSnapshot(fixture("synthetic-overage.json"))
  expect(parsed?.used).toBe(330)
  expect(parsed!.used / parsed!.entitlement).toBeCloseTo(1.1)
})

test("the preferred snapshot key wins and a percent-only snapshot is understood", () => {
  expect(parseQuotaSnapshot({ quota_snapshots: { chat: { entitlement: 50, remaining: 10 }, premium_interactions: { entitlement: 100, remaining: 40 } } })?.key).toBe("premium_interactions")
  expect(parseQuotaSnapshot({ quota_snapshots: { ai_credits: { percent_remaining: 25 } } })).toMatchObject({ key: "ai_credits", used: 75, entitlement: 100 })
})

test("an unlimited snapshot never wins over a limited one; all-unlimited reports unlimited", () => {
  expect(parseQuotaSnapshot({ quota_snapshots: { chat: { unlimited: true, entitlement: 0, remaining: 0 }, ai_credits: { entitlement: 200, remaining: 50 } } }))
    .toMatchObject({ key: "ai_credits", unlimited: false, used: 150, entitlement: 200 })
  expect(parseQuotaSnapshot({ quota_snapshots: { completions: { unlimited: true }, chat: { entitlement: 10, remaining: 5 } } })).toMatchObject({ key: "chat", unlimited: false })
  expect(parseQuotaSnapshot({ quota_snapshots: { chat: { unlimited: true }, completions: { unlimited: true } } })).toMatchObject({ key: "chat", unlimited: true })
})

test("unusable bodies give null", () => {
  for (const body of [null, 5, {}, { quota_snapshots: {} }, { quota_snapshots: { premium_interactions: { entitlement: "x", remaining: 1 } } }, { quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0 } } }]) {
    expect(parseQuotaSnapshot(body)).toBeNull()
  }
})

test("every captured fixture parses", () => {
  for (const name of readdirSync(dir).filter(name => name.startsWith("captured-"))) {
    expect(parseQuotaSnapshot(fixture(name))).not.toBeNull()
  }
})
