// packages/gateway/tests/protection-detect.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_PROTECTION_SETTINGS, emptyCounts, type ClassCounts, type KeyWindowCounts, type PauseRecord, type ProtectionSettings, type WindowSummary } from "../src/repo/protection"
import { assess, cooldownMinutes, covered } from "../src/protection/detect"

const settings = (over: Partial<ProtectionSettings> = {}): ProtectionSettings => ({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", ...over })
const key = (keyId: string, over: Partial<ClassCounts> = {}): KeyWindowCounts => ({ keyId, ...emptyCounts(), ...over })
const windowOf = (...keys: KeyWindowCounts[]): WindowSummary => {
  const totals = emptyCounts()
  for (const k of keys) for (const field of Object.keys(totals) as Array<keyof ClassCounts>) totals[field] += k[field]
  return { totals, byKey: keys }
}
const row = (over: Partial<PauseRecord>): PauseRecord => ({
  id: "pp_" + "0".repeat(32), targetKind: "upstream", targetId: "up_test_d", upstreamId: "up_test_d", mode: "pause",
  reason: {} as never, startedAt: 0, endsAt: 1, resolvedAt: null, resolvedBy: null, ...over,
})

test("the ratio rule needs both the risky count and the failure ratio, each inclusive at its boundary", () => {
  expect(assess("u", settings(), windowOf(key("a", { requests: 19, rate_limited: 19 })))).toBeNull() // 19 < 20
  expect(assess("u", settings(), windowOf(key("a", { requests: 20, rate_limited: 20 })))?.trigger).toBe("ratio")
  expect(assess("u", settings(), windowOf(key("a", { requests: 40, rate_limited: 20 })))?.trigger).toBe("ratio") // ratio == 0.5
  expect(assess("u", settings(), windowOf(key("a", { requests: 41, rate_limited: 20 })))).toBeNull() // 0.488 < 0.5
  expect(assess("u", settings({ minRiskyErrors: 1, minFailureRatio: 0 }), windowOf(key("a", { requests: 100, rejected: 1 })))?.trigger).toBe("ratio")
  expect(assess("u", settings(), windowOf())).toBeNull()
})

test("only rate-limit, rejected and auth responses are risky", () => {
  expect(assess("u", settings(), windowOf(key("a", { requests: 100, upstream: 50, network: 30, other: 20 })))).toBeNull()
  expect(assess("u", settings(), windowOf(key("a", { requests: 20, rate_limited: 7, rejected: 7, auth: 6 })))?.reason.risky).toBe(20)
})

test("the auth burst fires on auth errors alone, is inclusive, and 0 disables it", () => {
  const w = (auth: number) => windowOf(key("a", { requests: 1000, auth }))
  expect(assess("u", settings(), w(4))).toBeNull()
  const burst = assess("u", settings(), w(5))
  expect(burst?.trigger).toBe("authBurst")
  expect(assess("u", settings({ authBurst: 0 }), windowOf(key("a", { requests: 100_000, auth: 500 })))).toBeNull() // risky 500 but ratio 0.005
  expect(assess("u", settings({ authBurst: 3 }), w(3))?.trigger).toBe("authBurst")
  // When both rules fire the ratio rule is reported.
  expect(assess("u", settings(), windowOf(key("a", { requests: 30, auth: 30 })))?.trigger).toBe("ratio")
})

test("a key causing at least keyShare of the risky errors takes the whole key; otherwise the upstream", () => {
  const split = (a: number, b: number) => assess("up_x", settings(), windowOf(key("key_a", { requests: a, rate_limited: a }), key("key_b", { requests: b, rate_limited: b })))
  const at = split(16, 4) // 16/20 = 0.8
  expect(at?.target).toEqual({ kind: "key", id: "key_a" })
  expect(at?.attributedKey).toBe("key_a")
  expect(at?.reason.keyShare).toBe(0.8)
  const below = split(15, 5) // 0.75
  expect(below?.target).toEqual({ kind: "upstream", id: "up_x" })
  expect(below?.attributedKey).toBeNull()
  expect(below?.reason.keyShare).toBeNull()
  expect(assess("up_x", settings({ keyShare: 0.5 }), windowOf(key("key_a", { requests: 10, rate_limited: 10 }), key("key_b", { requests: 10, rate_limited: 10 })))?.target)
    .toEqual({ kind: "key", id: "key_a" }) // tie broken by key id
})

test("requests without an API key are never attributed to a key", () => {
  const a = assess("up_x", settings(), windowOf(key("", { requests: 25, rate_limited: 25 })))
  expect(a?.target).toEqual({ kind: "upstream", id: "up_x" })
})

test("the reason carries window, counts per class, ratio and the top five keys", () => {
  const keys = ["k1", "k2", "k3", "k4", "k5", "k6"].map((id, i) => key(id, { requests: 10 + i, rate_limited: 10 - i }))
  const a = assess("up_x", settings({ keyShare: 1 }), windowOf(...keys))!
  expect(a.reason).toMatchObject({ windowMinutes: 5, requests: 75, risky: 45, failureRatio: 45 / 75, trigger: "ratio", keyShare: null })
  expect(a.reason.counts).toEqual({ rate_limited: 45, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 })
  expect(a.reason.topKeys).toEqual([{ keyId: "k1", risky: 10 }, { keyId: "k2", risky: 9 }, { keyId: "k3", risky: 8 }, { keyId: "k4", risky: 7 }, { keyId: "k5", risky: 6 }])
})

test("an active row for the upstream, or for the attributed key, covers the evaluation; ended or foreign rows do not", () => {
  expect(covered([row({})], "up_test_d", null, "pause")).toBe(true)
  expect(covered([row({ mode: "notify" })], "up_test_d", null, "notify")).toBe(true)
  expect(covered([row({ mode: "notify" })], "up_test_d", null, "pause")).toBe(false) // a warning does not stop a pause
  expect(covered([row({ mode: "pause" })], "up_test_d", null, "notify")).toBe(true)
  expect(covered([row({ targetKind: "key", targetId: "key_a", upstreamId: "up_other" })], "up_test_d", "key_a", "pause")).toBe(true) // key rows cover across upstreams
  expect(covered([row({ targetKind: "key", targetId: "key_a" })], "up_test_d", "key_a", "pause")).toBe(true)
  expect(covered([row({ targetKind: "key", targetId: "key_a" })], "up_test_d", "key_b", "pause")).toBe(false)
  expect(covered([row({ targetKind: "key", targetId: "key_a" })], "up_test_d", null, "pause")).toBe(false)
  expect(covered([row({ targetId: "up_other", upstreamId: "up_other" })], "up_test_d", null, "pause")).toBe(false)
  expect(covered([], "up_test_d", "key_a", "pause")).toBe(false)
})

test("the cooldown doubles per earlier pause and is capped", () => {
  const s = settings({ cooldownMinutes: 30, maxCooldownMinutes: 360 })
  expect([0, 1, 2, 3, 4, 5, 50].map(n => cooldownMinutes(s, n))).toEqual([30, 60, 120, 240, 360, 360, 360])
  expect(cooldownMinutes(settings({ cooldownMinutes: 100, maxCooldownMinutes: 100 }), 3)).toBe(100)
})

test("key attribution needs traffic from at least two distinct keys; a single key means the upstream", () => {
  const single = assess("up_x", settings(), windowOf(key("key_a", { requests: 100, rate_limited: 100 })))
  expect(single?.target).toEqual({ kind: "upstream", id: "up_x" })
  expect(single?.attributedKey).toBeNull()
  // Keyless traffic does not count as a second key.
  const keyless = assess("up_x", settings(), windowOf(key("key_a", { requests: 100, rate_limited: 100 }), key("", { requests: 5 })))
  expect(keyless?.target.kind).toBe("upstream")
  const two = assess("up_x", settings(), windowOf(key("key_a", { requests: 100, rate_limited: 100 }), key("key_b", { requests: 3 })))
  expect(two?.target).toEqual({ kind: "key", id: "key_a" })
})
