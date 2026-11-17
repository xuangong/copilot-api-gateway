import { expect, test } from "bun:test"
import {
  DAY, HOUR, buildSeries, buildTop, checkStatuses, costOf, dropPartialHour, findSurges, freshness, latestCheck, nonZeroFlags, projectMonth, selectSurges, stageOf,
  type Surge,
} from "../src/control-plane/telemetry/analysis"
import { parseWindow } from "../src/control-plane/telemetry/protocol"
import { TelemetryError } from "../src/control-plane/telemetry/common"

const H0 = Date.UTC(2026, 10, 10) / 1000
const at = (hours: number) => H0 + hours * HOUR
const hv = (hour: number, value: number) => ({ hour, value })

// ---- month to date and projection -------------------------------------------------------------------------------

const utc = (iso: string) => Date.parse(iso) / 1000
const hoursOf = (from: string, count: number, value: number) => Array.from({ length: count }, (_, i) => hv(utc(from) + i * HOUR, value))

test("projection is month-to-date plus the last seven complete days' average times the fractional days left", () => {
  const rows = [...hoursOf("2026-11-01T00:00:00Z", 15 * 24, 1000), ...hoursOf("2026-11-16T00:00:00Z", 12, 1000)]
  const result = projectMonth(rows, utc("2026-11-01T00:00:00Z"), utc("2026-11-16T12:30:00Z"))
  expect(result.monthStart).toBe(utc("2026-11-01T00:00:00Z"))
  expect(result.mtd).toBe(372_000)
  expect(result.averageDaily).toBe(24_000)
  expect(result.projection).toBeCloseTo(372_000 + 24_000 * (14 + 11.5 / 24), 6)
})

test("only complete days starting at or after the first data hour count towards the average", () => {
  const rows = [...hoursOf("2026-11-14T08:00:00Z", 16, 1000), ...hoursOf("2026-11-15T00:00:00Z", 24, 1000), ...hoursOf("2026-11-16T00:00:00Z", 12, 1000)]
  const result = projectMonth(rows, utc("2026-11-14T08:00:00Z"), utc("2026-11-16T12:30:00Z"))
  expect(result.mtd).toBe(52_000)
  expect(result.averageDaily).toBe(24_000)
  expect(result.projection).toBeCloseTo(52_000 + 24_000 * (14 + 11.5 / 24), 6)
})

test("with no complete day yet the projection equals month-to-date, and with no data it is zero", () => {
  const today = hoursOf("2026-11-16T00:00:00Z", 12, 500)
  expect(projectMonth(today, utc("2026-11-16T00:00:00Z"), utc("2026-11-16T12:30:00Z"))).toMatchObject({ mtd: 6000, averageDaily: null, projection: 6000 })
  expect(projectMonth([], null, utc("2026-11-16T12:30:00Z"))).toMatchObject({ mtd: 0, averageDaily: null, projection: 0 })
})

test("at the start of a month the average still comes from the previous month's last days", () => {
  const rows = [...hoursOf("2026-11-24T00:00:00Z", 7 * 24, 1000), ...hoursOf("2026-12-01T00:00:00Z", 1, 1000)]
  const now = utc("2026-12-01T00:30:00Z")
  const result = projectMonth(rows, utc("2026-11-24T00:00:00Z"), now)
  expect(result.mtd).toBe(1000)
  expect(result.averageDaily).toBe(24_000)
  expect(result.projection).toBeCloseTo(1000 + 24_000 * ((Date.UTC(2027, 0, 1) / 1000 - now) / DAY), 6)
})

test("cost uses decimal gigabytes, subtracts the free allowance, and is null without a price or for non-byte metrics", () => {
  expect(costOf(150e9, "bytes", { pricePerGB: 0.08, freeGB: 100 })).toBeCloseTo(4, 9)
  expect(costOf(50e9, "bytes", { pricePerGB: 0.08, freeGB: 100 })).toBe(0)
  expect(costOf(2e9, "bytes", { pricePerGB: 0.5 })).toBe(1)
  expect(costOf(2e9, "bytes", {})).toBeNull()
  expect(costOf(5, "count", { pricePerGB: 1 })).toBeNull()
  expect(costOf(5, "ms", { pricePerGB: 1 })).toBeNull()
})

// ---- surges ------------------------------------------------------------------------------------------------------

const flat = (hours: number, value: number) => Array.from({ length: hours }, (_, i) => hv(at(i), value))
const surgeInput = (hourly: ReturnType<typeof flat>, over: Partial<Parameters<typeof findSurges>[0]> = {}): Parameters<typeof findSurges>[0] => ({
  metric: "nic.tx_bytes", unit: "bytes", hourly, firstHour: at(0), nowHour: at(239), settings: { surgeMinBytes: 0 }, ...over,
})

test("an hour at or above factor times the 168 hour baseline is a surge, with the boundary inclusive", () => {
  const withSpike = (value: number) => [...flat(239, 100), hv(at(239), value)]
  expect(findSurges(surgeInput(withSpike(300)))).toEqual([{ metric: "nic.tx_bytes", hour: at(239), value: 300, baseline: 100, ratio: 3 }])
  expect(findSurges(surgeInput(withSpike(299)))).toEqual([])
  expect(findSurges(surgeInput(withSpike(900), { settings: { surgeMinBytes: 0, surgeFactor: 10 } }))).toEqual([])
  expect(findSurges(surgeInput(withSpike(1000), { settings: { surgeMinBytes: 0, surgeFactor: 10 } }))).toHaveLength(1)
})

test("the minimum is per unit, inclusive, and defaults to 2 GiB for bytes and 1000 for counts", () => {
  const spike = (value: number) => [hv(at(0), 0), hv(at(100), value)]
  const count = (value: number) => findSurges(surgeInput(spike(value), { unit: "count", settings: {}, nowHour: at(110) }))
  expect(count(1000)).toHaveLength(1)
  expect(count(999)).toEqual([])
  const bytes = (value: number, settings = {}) => findSurges(surgeInput(spike(value), { settings, nowHour: at(110) }))
  expect(bytes(2 * 1024 ** 3, {})).toHaveLength(1)
  expect(bytes(2 * 1024 ** 3 - 1, {})).toEqual([])
  expect(bytes(5, { surgeMinBytes: 5 })).toHaveLength(1)
  expect(bytes(4, { surgeMinBytes: 5 })).toEqual([])
  expect(findSurges(surgeInput(spike(5000), { unit: "count", settings: { surgeMinCount: 6000 }, nowHour: at(110) }))).toEqual([])
})

test("an hour is judged only with at least 24 hours of history before it; hours without data count as zero", () => {
  const data = (spikeAt: number) => [hv(at(0), 0), hv(at(spikeAt), 1000)]
  expect(findSurges(surgeInput(data(23), { unit: "count", settings: {}, nowHour: at(30) }))).toEqual([])
  const judged = findSurges(surgeInput(data(24), { unit: "count", settings: {}, nowHour: at(30) }))
  expect(judged).toEqual([{ metric: "nic.tx_bytes", hour: at(24), value: 1000, baseline: 0, ratio: null }])
  expect(findSurges(surgeInput([], { firstHour: null }))).toEqual([])
})

test("only the last 168 hours are reported, newest first, and ms metrics are never checked", () => {
  const base = [hv(at(0), 0), hv(at(30), 1000), hv(at(200), 1000), hv(at(239), 1000)]
  const found = findSurges(surgeInput(base, { unit: "count", settings: {}, nowHour: at(239) }))
  expect(found.map(s => s.hour)).toEqual([at(239), at(200)])
  expect(findSurges(surgeInput(base, { unit: "ms", settings: {}, nowHour: at(239) }))).toEqual([])
})

test("the baseline covers exactly the 168 preceding hours: the 168th hour back counts, the 169th does not", () => {
  const input = (rows: ReturnType<typeof flat>) => surgeInput(rows, { unit: "count", settings: { surgeMinCount: 0 }, nowHour: at(169) })
  expect(findSurges(input([hv(at(1), 1680), hv(at(169), 30)]))).toEqual([{ metric: "nic.tx_bytes", hour: at(169), value: 30, baseline: 10, ratio: 3 }])
  expect(findSurges(input([hv(at(0), 1680), hv(at(169), 30)]))).toEqual([{ metric: "nic.tx_bytes", hour: at(169), value: 30, baseline: 0, ratio: null }])
})

test("selectSurges keeps the newest 20 across metrics", () => {
  const all: Surge[] = Array.from({ length: 25 }, (_, i) => ({ metric: i % 2 ? "b" : "a", hour: at(i), value: 1, baseline: 0, ratio: null }))
  const picked = selectSurges(all)
  expect(picked).toHaveLength(20)
  expect(picked[0]!.hour).toBe(at(24))
  expect(picked[19]!.hour).toBe(at(5))
})

// ---- non-zero flags ----------------------------------------------------------------------------------------------

test("non-zero flags group by metric and hour, total over dims, and order the breakdown by value", () => {
  const flags = nonZeroFlags([
    { metric: "probe.fail", hour: at(5), dims: { stage: "tls" }, value: 1 },
    { metric: "probe.fail", hour: at(5), dims: { stage: "tcp" }, value: 3 },
    { metric: "probe.fail", hour: at(2), dims: {}, value: 2 },
    { metric: "probe.fail", hour: at(9), dims: { stage: "http" }, value: 0 },
  ])
  expect(flags).toEqual([
    { metric: "probe.fail", hour: at(5), total: 4, breakdown: [{ dims: { stage: "tcp" }, value: 3 }, { dims: { stage: "tls" }, value: 1 }] },
    { metric: "probe.fail", hour: at(2), total: 2, breakdown: [] },
  ])
})

test("non-zero flags cover at most 50 distinct hours, newest first", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ metric: "m", hour: at(i), dims: {}, value: 1 }))
  const flags = nonZeroFlags(rows)
  expect(flags).toHaveLength(50)
  expect(flags[0]!.hour).toBe(at(59))
  expect(flags[49]!.hour).toBe(at(10))
})

// ---- point-in-time checks ----------------------------------------------------------------------------------------

test("check statuses distinguish passed, failed, no check and not monitored", () => {
  const hours = [3, 4, 5, 6, 7, 8].map(at)
  const values = [hv(at(5), 1), hv(at(7), 0)]
  expect(checkStatuses(hours, values, at(5))).toEqual(["not monitored", "not monitored", "passed", "no check", "failed", "no check"])
  expect(checkStatuses(hours, [], null)).toEqual(hours.map(() => "not monitored"))
})

test("the latest closed hour is judged, and a failure names its stage from the matching .fail flag", () => {
  const flags = nonZeroFlags([{ metric: "probe.fail", hour: at(7), dims: { stage: "tls" }, value: 1 }])
  const values = [hv(at(5), 1), hv(at(7), 0)]
  expect(latestCheck("probe.ok", at(8) + 1800, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(7), status: "failed", stage: "tls" })
  expect(latestCheck("probe.ok", at(6) + 60, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(5), status: "passed", stage: null })
  expect(latestCheck("probe.ok", at(9) + 600, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(8), status: "no check", stage: null })
  expect(latestCheck("probe.ok", at(4) + 600, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(3), status: "not monitored", stage: null })
  expect(stageOf(flags, "probe.ok", at(7))).toBe("tls")
  expect(stageOf(flags, "probe.ok", at(6))).toBeNull()
  expect(stageOf(flags, "other.metric", at(7))).toBeNull()
})

test("the probe of the run hour is pushed at about :05, so at 14:03 the latest closed hour (13:00) is passed, not no check", () => {
  const values = [hv(at(10), 1), hv(at(13), 1)]
  expect(latestCheck("probe.ok", at(14) + 180, values, at(10), [])).toEqual({ metric: "probe.ok", hour: at(13), status: "passed", stage: null })
})

test("a row limit that was hit drops the oldest, possibly partial, hour", () => {
  const rows = [{ metric: "m", hour: at(5), dims: { a: "1" }, value: 1 }, { metric: "m", hour: at(5), dims: { a: "2" }, value: 1 }, { metric: "m", hour: at(4), dims: { a: "1" }, value: 1 }]
  expect(dropPartialHour(rows, 4)).toBe(rows)
  expect(dropPartialHour(rows, 3)).toEqual(rows.slice(0, 2))
  expect(dropPartialHour([], 0)).toEqual([])
})

// ---- freshness ---------------------------------------------------------------------------------------------------

test("freshness is stale only strictly after the threshold and never for a source that has not pushed yet", () => {
  const now = Date.parse("2026-11-16T12:00:00Z")
  expect(freshness(null, now)).toEqual({ lastPushAt: null, stale: false, staleAfterHours: 2, hoursSincePush: null })
  expect(freshness("2026-11-16T10:00:00.000Z", now).stale).toBe(false)
  expect(freshness("2026-11-16T09:59:59.999Z", now)).toMatchObject({ stale: true, hoursSincePush: 2 })
  expect(freshness("2026-11-16T09:59:59.999Z", now, 3).stale).toBe(false)
  expect(freshness("2026-11-16T11:30:00.000Z", now)).toMatchObject({ stale: false, hoursSincePush: 0 })
})

// ---- series and top ----------------------------------------------------------------------------------------------

test("a series is dense and the remainder after the listed groups becomes one (other) group", () => {
  const built = buildSeries({ from: at(0), to: at(4) }, [hv(at(0), 10), hv(at(1), 20), hv(at(3), 7)], [
    { key: "a", points: [hv(at(0), 6), hv(at(1), 15)] },
    { key: "b", points: [hv(at(0), 2)] },
  ])
  expect(built.hours).toEqual([at(0), at(1), at(2), at(3)])
  expect(built.total).toEqual([10, 20, 0, 7])
  expect(built.groups).toEqual([
    { key: "a", values: [6, 15, 0, 0] }, { key: "b", values: [2, 0, 0, 0] }, { key: "(other)", values: [2, 5, 0, 7] },
  ])
})

test("with no remainder there is no (other) group, and without groups only the total is returned", () => {
  const exact = buildSeries({ from: at(0), to: at(2) }, [hv(at(0), 3)], [{ key: "a", points: [hv(at(0), 3)] }])
  expect(exact.groups.map(g => g.key)).toEqual(["a"])
  expect(buildSeries({ from: at(0), to: at(2) }, [hv(at(1), 4)], [])).toEqual({ hours: [at(0), at(1)], total: [0, 4], groups: [] })
})

test("the top table shares against all groups, compares with the previous period and reports the remainder", () => {
  const top = buildTop(100, [{ key: "a", value: 60 }, { key: "b", value: 30 }], [{ key: "a", value: 30 }])
  expect(top).toEqual({
    total: 100, otherCurrent: 10, otherShare: 0.1,
    rows: [{ key: "a", value: 60, share: 0.6, previous: 30, change: 1 }, { key: "b", value: 30, share: 0.3, previous: 0, change: null }],
  })
  expect(buildTop(0, [], [])).toEqual({ total: 0, rows: [], otherCurrent: 0, otherShare: 0 })
  expect(buildTop(10, [{ key: "a", value: 10 }], [{ key: "a", value: 20 }]).rows[0]!.change).toBe(-0.5)
})

// ---- query windows -----------------------------------------------------------------------------------------------

test("query windows default to the last 24 hours through the current hour and reject misaligned, inverted or oversized ranges", () => {
  const now = utc("2026-11-16T12:34:56Z")
  expect(parseWindow(undefined, undefined, now)).toEqual({ from: utc("2026-11-15T13:00:00Z"), to: utc("2026-11-16T13:00:00Z") })
  expect(parseWindow("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", now)).toEqual({ from: utc("2026-11-10T00:00:00Z"), to: utc("2026-11-11T00:00:00Z") })
  expect(parseWindow("2026-11-10T00:00:00Z", undefined, now).to).toBe(utc("2026-11-16T13:00:00Z"))
  expect(parseWindow(undefined, "2026-11-11T00:00:00Z", now).from).toBe(utc("2026-11-10T00:00:00Z"))
  expect(parseWindow("2026-08-18T13:00:00Z", "2026-11-16T13:00:00Z", now).to).toBe(utc("2026-11-16T13:00:00Z"))
  for (const [from, to] of [["2026-11-10T00:30:00Z", undefined], ["2026-11-10", undefined], ["2026-11-11T00:00:00Z", "2026-11-10T00:00:00Z"],
    ["2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z"], ["2026-08-17T13:00:00Z", "2026-11-16T13:00:00Z"]] as const) {
    expect(() => parseWindow(from, to, now)).toThrow(TelemetryError)
  }
})
