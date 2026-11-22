// packages/gateway/tests/quota-read-schedule.test.ts
import { expect, test } from "bun:test"
import {
  MANUAL_MIN_READ_GAP_MS, MIN_READ_GAP_MS, backoffHours, nextIntervalHours, provisionalCutoffAllowed, readAllowedAt, readDecision, readFloorMs, scheduleNextRead, type SchedState,
} from "../src/quota-balance/read-schedule"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

const H = 3_600_000
const M = 60_000
const NOW = Date.UTC(2026, 10, 10, 12)
const settings = { ...DEFAULT_GROUP_SETTINGS }
const state = (over: Partial<SchedState> = {}): SchedState => ({ lastReadAt: NOW - 3 * H, lastReadShare: 0.4, lastAttemptAt: NOW - 3 * H, nextReadAt: NOW + 3 * H, failures: 0, unlimited: false, ...over })
const decide = (s: SchedState, estimatedShare: number, extra: { manual?: boolean; settings?: Partial<typeof settings>; now?: number } = {}) =>
  readDecision({ now: extra.now ?? NOW, state: s, estimatedShare, settings: { ...settings, ...extra.settings }, manual: extra.manual })

test("the interval halves after a large error (floor 1 h) and grows back by 1.5x after small errors (cap at the setting)", () => {
  expect(nextIntervalHours(6, 6.1, 6)).toBe(3)
  expect(nextIntervalHours(6, -5.5, 6)).toBe(3)
  expect(nextIntervalHours(1.5, 9, 6)).toBe(1)
  expect(nextIntervalHours(1, 9, 6)).toBe(1)
  expect(nextIntervalHours(3, 1, 6)).toBe(4.5)
  expect(nextIntervalHours(4.5, -2.9, 6)).toBe(6)
  expect(nextIntervalHours(3, 4, 6)).toBe(3)
  expect(nextIntervalHours(3, null, 6)).toBe(3)
  expect(nextIntervalHours(8, 4, 6)).toBe(6)
})

test("failed reads back off 1 h, 2 h, 4 h, capped at the read interval", () => {
  expect([1, 2, 3, 4, 5].map(f => backoffHours(f, 6))).toEqual([1, 2, 4, 6, 6])
  expect(backoffHours(3, 2)).toBe(2)
})

test("the next read is the interval plus up to 30 minutes of jitter either way, never sooner than the floor, and no later than the first read of next month", () => {
  expect(scheduleNextRead(NOW, 6, () => 0.5)).toBe(NOW + 6 * H)
  expect(scheduleNextRead(NOW, 6, () => 0)).toBe(NOW + 6 * H - 30 * M)
  expect(scheduleNextRead(NOW, 6, () => 1)).toBe(NOW + 6 * H + 30 * M)
  expect(scheduleNextRead(NOW, 1, () => 0)).toBe(NOW + MIN_READ_GAP_MS)
  const lateNovember = Date.UTC(2026, 10, 30, 23)
  const draws = [0.5, 0.5]
  expect(scheduleNextRead(lateNovember, 6, () => draws.shift() ?? 0.5)).toBe(Date.UTC(2026, 11, 1) + 45 * M)
  const low = [0.5, 0]
  expect(scheduleNextRead(lateNovember, 6, () => low.shift() ?? 0)).toBe(Date.UTC(2026, 11, 1) + 30 * M) // the first read of a month is at least 30 minutes after the reset
  const high = [0.5, 1]
  expect(scheduleNextRead(lateNovember, 6, () => high.shift() ?? 1)).toBe(Date.UTC(2026, 11, 1) + 60 * M)
})

test("a member that was never read is read once (join); a scheduled read is due when its time has come", () => {
  expect(decide(state({ lastReadAt: null, lastReadShare: null, lastAttemptAt: null, nextReadAt: NOW }), 0)).toEqual({ read: true, reason: "join", blockedUntil: null })
  expect(decide(state(), 0.4)).toEqual({ read: false, reason: null, blockedUntil: null })
  expect(decide(state({ nextReadAt: NOW - 1 }), 0.4)).toEqual({ read: true, reason: "scheduled", blockedUntil: null })
})

test("the floor is one hour from the last attempt, ten minutes for a manual read, and a failed attempt counts", () => {
  const recent = state({ lastAttemptAt: NOW - 30 * M, nextReadAt: NOW - 1 })
  expect(decide(recent, 0.4)).toEqual({ read: false, reason: "scheduled", blockedUntil: NOW + 30 * M })
  expect(decide(state({ lastAttemptAt: NOW - 15 * M }), 0.4, { manual: true })).toEqual({ read: true, reason: "manual", blockedUntil: null })
  expect(decide(state({ lastAttemptAt: NOW - 5 * M }), 0.4, { manual: true })).toEqual({ read: false, reason: "manual", blockedUntil: NOW + 5 * M })
  expect(readAllowedAt(state({ lastAttemptAt: NOW, failures: 2 }), settings, false)).toBe(NOW + 2 * H)
  expect(readAllowedAt(state({ lastAttemptAt: NOW, failures: 2 }), settings, true)).toBe(NOW + MANUAL_MIN_READ_GAP_MS)
  expect(readAllowedAt(state({ lastAttemptAt: null }), settings, false)).toBe(0)
})

test("early triggers: drift, confirm, soft line and hard line fire when the estimate crosses them and the last read had not", () => {
  expect(decide(state({ lastReadShare: 0.40 }), 0.51).reason).toBe("drift")
  expect(decide(state({ lastReadShare: 0.40 }), 0.49).reason).toBeNull()
  const wide = { softShare: 0.95, hardShare: 0.98 }
  expect(decide(state({ lastReadShare: 0.85 }), 0.92, { settings: wide }).reason).toBe("confirm")
  expect(decide(state({ lastReadShare: 0.85 }), 0.96, { settings: wide }).reason).toBe("soft")
  expect(decide(state({ lastReadShare: 0.85 }), 0.99, { settings: wide }).reason).toBe("hard")
  // A real read already at or above the line makes a confirming read pointless.
  expect(decide(state({ lastReadShare: 0.96 }), 0.97).reason).toBeNull()
  expect(decide(state({ lastReadShare: 0.92 }), 0.96).reason).toBe("hard")
})

test("the first read after the monthly reset is due 30 to 60 minutes after 00:00 UTC, from a state whose last read is from the previous month", () => {
  const s = state({ lastReadAt: Date.UTC(2026, 10, 30, 22), lastReadShare: 0.9, lastAttemptAt: Date.UTC(2026, 10, 30, 22), nextReadAt: Date.UTC(2026, 11, 1, 0, 45) })
  expect(decide(s, 0.05, { now: Date.UTC(2026, 11, 1, 0, 50) }).reason).toBe("monthly")
  expect(decide(s, 0.05, { now: Date.UTC(2026, 11, 1, 0, 40) }).reason).toBeNull()
  // A stored time before the reset (or inside the first 30 minutes) is held back until 00:30.
  const early = state({ lastReadAt: Date.UTC(2026, 10, 30, 22), lastReadShare: 0.9, lastAttemptAt: Date.UTC(2026, 10, 30, 22), nextReadAt: Date.UTC(2026, 10, 30, 23) })
  expect(decide(early, 0.05, { now: Date.UTC(2026, 11, 1, 0, 5) }).reason).toBeNull()
  expect(decide(early, 0.05, { now: Date.UTC(2026, 11, 1, 0, 31) }).reason).toBe("monthly")
})

test("an unlimited member has no early triggers", () => {
  expect(decide(state({ unlimited: true, lastReadShare: 0 }), 0.99).reason).toBeNull()
  expect(decide(state({ unlimited: true, nextReadAt: NOW - 1 }), 0).reason).toBe("scheduled")
})

test("under any mix of triggers a read is never allowed inside the floors", () => {
  let seed = 12345
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  for (let i = 0; i < 2000; i++) {
    const s = state({
      lastReadAt: rnd() < 0.1 ? null : NOW - rnd() * 30 * H, lastReadShare: rnd(), lastAttemptAt: rnd() < 0.1 ? null : NOW - rnd() * 3 * H,
      nextReadAt: NOW + (rnd() - 0.5) * 12 * H, failures: Math.floor(rnd() * 5), unlimited: rnd() < 0.1,
    })
    const manual = rnd() < 0.3
    const d = decide(s, rnd() * 1.2, { manual })
    if (d.read) expect(NOW).toBeGreaterThanOrEqual(readAllowedAt(s, settings, manual))
    if (!d.read && d.reason !== null) expect(d.blockedUntil).toBe(readAllowedAt(s, settings, manual))
  }
})

test("the monthly cap never schedules a read earlier than the floor", () => {
  const lateNovember = Date.UTC(2026, 10, 30, 23, 40)
  for (const draw of [0, 0.5, 1]) expect(scheduleNextRead(lateNovember, 1, () => draw)).toBeGreaterThanOrEqual(lateNovember + MIN_READ_GAP_MS)
})

test("with the fallback k the hard line triggers a read but never a provisional cut-off; with a learned k the estimate may cut", () => {
  const wide = { softShare: 0.95, hardShare: 0.98 }
  expect(decide(state({ lastReadShare: 0.85 }), 0.99, { settings: wide }).reason).toBe("hard")
  const at = (kLearned: boolean, estimatedShare: number, unlimited = false) => provisionalCutoffAllowed({ kLearned, estimatedShare, unlimited, settings: { hardShare: 0.98 } })
  expect(at(false, 0.99)).toBe(false)
  expect(at(true, 0.99)).toBe(true)
  expect(at(true, 0.97)).toBe(false)
  expect(at(true, 0.99, true)).toBe(false)
})

test("a member joined (or a read taken) in the first 30 minutes of a month is not used as the month base: join and the month's first read wait for 00:30 UTC", () => {
  const first = Date.UTC(2026, 11, 1)
  const fresh = state({ lastReadAt: null, lastReadShare: null, lastAttemptAt: null, nextReadAt: first })
  expect(decide(fresh, 0, { now: first + 10 * M }).reason).toBeNull()
  expect(decide(fresh, 0, { now: first + 31 * M }).reason).toBe("join")
  // A read from inside the window (page open, manual) does not count as this month's base: the first read after 00:30 replaces it.
  const early = state({ lastReadAt: first + 10 * M, lastReadShare: 0.9, lastAttemptAt: first + 10 * M, nextReadAt: first + 6 * H })
  expect(decide(early, 0.05, { now: first + 20 * M }).reason).toBeNull()
  expect(decide(early, 0.05, { now: first + 31 * M })).toEqual({ read: false, reason: "monthly", blockedUntil: first + 70 * M }) // the one hour floor from the 00:10 attempt still applies
  expect(decide(early, 0.05, { now: first + 71 * M })).toEqual({ read: true, reason: "monthly", blockedUntil: null })
  expect(decide(state({ lastReadAt: first + 31 * M, lastAttemptAt: first + 31 * M, nextReadAt: first + 6 * H }), 0.4, { now: first + 2 * H }).reason).toBeNull() // a later read is a normal base
})

test("the floor of an attempt is one function: manual 10 minutes, one hour, or the failure back-off", () => {
  expect(readFloorMs(state(), settings, true)).toBe(MANUAL_MIN_READ_GAP_MS)
  expect(readFloorMs(state(), settings, false)).toBe(MIN_READ_GAP_MS)
  expect(readFloorMs(state({ failures: 3 }), settings, false)).toBe(4 * H)
})
