import { describe, expect, test } from "bun:test"
import { buildRollingStrip, type RollingStripCell } from "./usage-strip"
import { DEFAULT_BUDGET_USD, rankForecastCandidates } from "./usage-forecast"
import { zoneOps } from "./timezone"

const LOCAL = zoneOps("local")

const LAST = new Date(2026, 7, 12)

/**
 * A strip whose closing days carry the given costs, newest first — so
 * `costs[0]` is today, `costs[1]` yesterday. Built through the real
 * buildRollingStrip rather than by hand, so the shape the forecast reads is
 * exactly the shape the strip renders.
 */
function stripWithDayCosts(costs: number[]): RollingStripCell[] {
  const daily = new Map<string, { cost: number; tokens: number }>()
  costs.forEach((cost, i) => {
    const d = new Date(LAST.getFullYear(), LAST.getMonth(), LAST.getDate() - i)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    daily.set(k, { cost, tokens: 0 })
  })
  return buildRollingStrip(daily, LAST, LOCAL)
}

/**
 * A quiet fortnight with one $500 day three days back. Deliberately not
 * monotone: the cheapest future is neither the shortest run nor the longest,
 * so a wrong suffix sum or a wrong divisor lands somewhere else entirely.
 */
const SPIKE = stripWithDayCosts([1, 1, 500, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])

describe("the default budget", () => {
  test("is ten thousand", () => {
    expect(DEFAULT_BUDGET_USD).toBe(10000)
  })
})

describe("rankForecastCandidates", () => {
  // n(x) is the last x days added up, so a run that reaches over the spike
  // carries it and every shorter run does not.
  test("spends the last x days, not the window's", () => {
    const all = rankForecastCandidates(SPIKE, 1000, 27)
    const spent = new Map(all.map((c) => [c.elapsed, c.spentUSD]))
    expect(spent.get(1)).toBeCloseTo(1, 6)
    expect(spent.get(2)).toBeCloseTo(2, 6)
    expect(spent.get(3)).toBeCloseTo(502, 6)
    expect(spent.get(27)).toBeCloseTo(526, 6)
  })

  // The whole point of the divisor: what is left has to be spread over the days
  // that are left, not over all 28. Dividing by 28 would rank purely by how much
  // was spent, which puts the longest run first every single time.
  test("spreads what is left over the days that are left", () => {
    const top = rankForecastCandidates(SPIKE, 1000)
    expect(top.map((c) => c.elapsed)).toEqual([3, 4, 5])
    expect(top[0]!.remainingDays).toBe(25)
    expect(top[0]!.dailyUSD).toBeCloseTo(498 / 25, 6)
    expect(top[1]!.dailyUSD).toBeCloseTo(497 / 24, 6)
    expect(top[2]!.dailyUSD).toBeCloseTo(496 / 23, 6)
  })

  test("returns three, cheapest future first", () => {
    const top = rankForecastCandidates(SPIKE, 1000)
    expect(top).toHaveLength(3)
    expect(top[0]!.dailyUSD).toBeLessThan(top[1]!.dailyUSD)
    expect(top[1]!.dailyUSD).toBeLessThan(top[2]!.dailyUSD)
  })

  // The answer the panel exists to give: which day the run opened on, so the
  // user can read the scenario off a calendar.
  test("names the day the run opened", () => {
    const top = rankForecastCandidates(SPIKE, 1000)
    expect(top[0]!.startKey).toBe("2026-08-10")
    expect(top[0]!.startLabel).toBe("Aug 10")
    expect(top[1]!.startKey).toBe("2026-08-09")
  })

  // A daily budget cannot be negative, so the figure is floored — but the order
  // is taken from the unfloored value, or every blown run would tie at zero and
  // the three shown would be arbitrary.
  test("floors a blown budget at zero yet still ranks by how blown it is", () => {
    const top = rankForecastCandidates(SPIKE, 100)
    expect(top.map((c) => c.elapsed)).toEqual([27, 26, 25])
    expect(top.map((c) => c.dailyUSD)).toEqual([0, 0, 0])
    expect(top[0]!.rawDailyUSD).toBeCloseTo(-426, 6)
    expect(top[1]!.rawDailyUSD).toBeCloseTo(-425 / 2, 6)
    expect(top.every((c) => c.overspent)).toBe(true)
  })

  test("marks a run that fits as not overspent", () => {
    expect(rankForecastCandidates(SPIKE, 1000).every((c) => c.overspent)).toBe(false)
  })

  // x = 28 would leave no future to divide into, so the runs stop one short.
  test("never proposes a run with no days left", () => {
    const all = rankForecastCandidates(SPIKE, 1000, 99)
    expect(all).toHaveLength(27)
    expect(Math.max(...all.map((c) => c.elapsed))).toBe(27)
    expect(all.every((c) => Number.isFinite(c.dailyUSD))).toBe(true)
  })

  test("ranks only as many runs as there are days of history", () => {
    const short = rankForecastCandidates(SPIKE.slice(-2), 1000, 99)
    expect(short.map((c) => c.elapsed).sort()).toEqual([1, 2])
  })

  test("has nothing to rank without a strip", () => {
    expect(rankForecastCandidates([], 1000)).toEqual([])
  })

  // An empty or cleared budget box is not a budget of nothing — it is no
  // question asked, and a table of zeroes would answer it as though it were.
  test("has nothing to rank without a budget", () => {
    expect(rankForecastCandidates(SPIKE, 0)).toEqual([])
    expect(rankForecastCandidates(SPIKE, -5)).toEqual([])
    expect(rankForecastCandidates(SPIKE, Number.NaN)).toEqual([])
  })
})
