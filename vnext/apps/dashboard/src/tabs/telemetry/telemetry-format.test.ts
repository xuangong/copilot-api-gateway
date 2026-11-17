import { expect, test } from "bun:test"
import type { TelemetryBudget, TelemetrySeries, TelemetrySummary } from "../../api/telemetry"
import {
  availabilityGroups, budgetView, customWindow, defaultCustomDates, windowTotal, chartFromSeries, defaultMetric, isAvailabilityMetric, dimsLabel, formatChange, formatShare, formatValue, freshnessNotices, groupLabel, hourRange, hourShort, setDisplayZone, localDate, offsetLabel, zoneLabel,
  displayStatus, filterDimFor, filterQuery, filterText, keepFilter, formatInstant, latencyCheckMetric, maskUnpassed, rangeWindow, statusTone, visibleGroups,
} from "./telemetry-format"

setDisplayZone("UTC")

test("values render in the unit of their metric", () => {
  expect(formatValue(0, "bytes")).toBe("0 B")
  expect(formatValue(999, "bytes")).toBe("999 B")
  expect(formatValue(1500, "bytes")).toBe("1.5 KB")
  expect(formatValue(1_234_000_000, "bytes")).toBe("1.23 GB")
  expect(formatValue(2.5e12, "bytes")).toBe("2.5 TB")
  expect(formatValue(120, "ms")).toBe("120 ms")
  expect(formatValue(1500, "ms")).toBe("1.5 s")
  expect(formatValue(1_234_567, "count")).toBe("1,234,567")
  expect(formatValue(0.5, "count")).toBe("0.5")
  expect(formatValue(7, null)).toBe("7")
})

test("change and share are percentages and a missing change is a dash", () => {
  expect(formatChange(1)).toBe("+100%")
  expect(formatChange(-0.104)).toBe("-10%")
  expect(formatChange(0)).toBe("0%")
  expect(formatChange(null)).toBe("—")
  expect(formatShare(0.6)).toBe("60.0%")
})

test("group and dim labels use the configured names and fall back to the raw value", () => {
  const settings = { labels: { user: { "#1": "MacBook" } } }
  expect(groupLabel(settings, "user", "#1", "(none)")).toBe("MacBook")
  expect(groupLabel(settings, "user", "#2", "(none)")).toBe("#2")
  expect(groupLabel(settings, "domain", "a.com", "(none)")).toBe("a.com")
  expect(groupLabel(settings, "user", "", "(none)")).toBe("(none)")
  expect(dimsLabel(settings, { user: "#1", domain: "a.com" })).toBe("domain=a.com, user=MacBook")
})

test("hours are shown in UTC as a range and as a short label", () => {
  expect(hourRange("2026-11-16T13:00:00Z")).toBe("13:00–14:00")
  expect(hourRange("2026-11-16T23:00:00Z")).toBe("23:00–00:00")
  expect(hourShort("2026-11-16T13:00:00Z")).toBe("11-16 13:00")
})

const summary = (over: Partial<TelemetrySummary> = {}): TelemetrySummary => ({
  now: "2026-11-16T12:30:00.000Z", freshness: { lastPushAt: "2026-11-16T09:00:00.000Z", stale: false, staleAfterHours: 2, hoursSincePush: 3 }, budget: null,
  surges: [], flags: [], checks: [], ...over,
})
const check = (status: "passed" | "failed" | "no check" | "not monitored") => ({ metric: "probe.ok", hour: "2026-11-16T11:00:00Z", status, stage: null })

test("a stale source warns, and a latest closed hour with no check warns alongside it; the other statuses never warn", () => {
  expect(freshnessNotices(summary())).toEqual([])
  const stale = { ...summary().freshness, stale: true }
  expect(freshnessNotices(summary({ freshness: stale }))).toEqual([{ kind: "stale", hours: 3 }])
  expect(freshnessNotices(summary({ checks: [check("no check")] }))).toEqual([{ kind: "noCheck", metric: "probe.ok", hour: "2026-11-16T11:00:00Z" }])
  expect(freshnessNotices(summary({ freshness: stale, checks: [check("no check")] })).map(n => n.kind)).toEqual(["stale", "noCheck"])
  for (const status of ["passed", "failed", "not monitored"] as const) expect(freshnessNotices(summary({ checks: [check(status)] }))).toEqual([])
})

test("check statuses have their own tones: passed green, failed red, no check a warning, not monitored neutral", () => {
  expect([statusTone("passed"), statusTone("failed"), statusTone("no check"), statusTone("not monitored")]).toEqual(["success", "danger", "warn", "neutral"])
})

const budget = (over: Partial<TelemetryBudget> = {}): TelemetryBudget => ({
  metric: "nic.tx_bytes", unit: "bytes", monthStart: "2026-11-01T00:00:00Z", mtd: 372e9, projection: 719.5e9, averageDaily: 24e9, monthlyLimit: 500e9,
  mtdPercent: 74.4, projectionPercent: 143.9, overLimit: true, cost: null, ...over,
})

test("the budget bar is red when the projection exceeds the limit and otherwise follows the usage thresholds", () => {
  expect(budgetView(budget())).toEqual({ percent: 74.4, tone: "danger", over: true })
  expect(budgetView(budget({ overLimit: false, mtdPercent: 40, projectionPercent: 80 }))).toEqual({ percent: 40, tone: "brand", over: false })
  expect(budgetView(budget({ overLimit: false, mtdPercent: 80 })).tone).toBe("warn")
  expect(budgetView(budget({ overLimit: false, mtdPercent: 95 })).tone).toBe("danger")
  expect(budgetView(budget({ monthlyLimit: null, mtdPercent: null, projectionPercent: null, overLimit: null }))).toEqual({ percent: null, tone: "brand", over: false })
})

test("range windows end after the current hour and span 24 hours, 7 days or 30 days", () => {
  const now = Date.parse("2026-11-16T12:34:56Z")
  expect(rangeWindow("24h", now)).toEqual({ from: "2026-11-15T13:00:00Z", to: "2026-11-16T13:00:00Z" })
  expect(rangeWindow("7d", now).from).toBe("2026-11-09T13:00:00Z")
  expect(rangeWindow("30d", now).from).toBe("2026-10-17T13:00:00Z")
})

test("the first metric to show is the budget metric, else a non-check metric, else any", () => {
  const info = (metric: string) => ({ metric, unit: "count" as const, firstHour: "", lastHour: "", dims: [] })
  const metrics = [info("probe.ok"), info("nic.tx_bytes"), info("proxy.sent_bytes")]
  expect(defaultMetric(metrics, { budgetMetric: "proxy.sent_bytes" })).toBe("proxy.sent_bytes")
  expect(defaultMetric(metrics, { checkMetrics: ["probe.ok"] })).toBe("nic.tx_bytes")
  expect(defaultMetric([info("probe.ok")], { checkMetrics: ["probe.ok"] })).toBe("probe.ok")
  expect(defaultMetric([], {})).toBe("")
})

const series = (over: Partial<TelemetrySeries> = {}): TelemetrySeries => ({
  metric: "m", unit: "bytes", from: "2026-11-16T10:00:00Z", to: "2026-11-16T13:00:00Z", hours: ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z"],
  total: [3, 9, 2], groups: [], ...over,
})
const palette = ["#111111", "#222222", "#333333"]

test("a chart has one line per group plus a dashed total, labelled by the configured names, with surge hours highlighted on the total", () => {
  const chart = chartFromSeries({
    series: series({ groups: [{ key: "#1", values: [1, 5, 1] }, { key: "(other)", values: [2, 4, 1] }] }),
    settings: { labels: { user: { "#1": "MacBook" } } }, groupBy: "user", palette, totalLabel: "Total", otherLabel: "Other", noneLabel: "(none)",
    surgeHours: new Set(["2026-11-16T11:00:00Z"]),
  })
  expect(chart.labels).toEqual(["11-16 10:00", "11-16 11:00", "11-16 12:00"])
  expect(chart.datasets.map(d => [d.label, d.color, d.dashed ?? false, d.fill])).toEqual([
    ["MacBook", "#111111", false, false], ["Other", "#8a8a8a", false, false], ["Total", "#6b7280", true, false],
  ])
  expect(chart.datasets[2]!.highlight).toEqual([false, true, false])
  expect(chart.datasets[0]!.highlight).toBeUndefined()
})

test("without groups the total is the only, solid, filled line", () => {
  const chart = chartFromSeries({ series: series(), settings: {}, groupBy: "", palette, totalLabel: "Total", otherLabel: "Other", noneLabel: "(none)", surgeHours: new Set() })
  expect(chart.datasets).toEqual([{ label: "Total", data: [3, 9, 2], color: "#111111", fill: true }])
})

test("groups whose total is zero are hidden from the chart, keeping a real group that is zero in some hours", () => {
  const chart = chartFromSeries({
    series: series({ groups: [{ key: "", values: [0, 0, 0] }, { key: "tls", values: [0, 2, 0] }, { key: "(other)", values: [0, 0, 0] }] }),
    settings: {}, groupBy: "stage", palette, totalLabel: "Total", otherLabel: "Other", noneLabel: "(none)", surgeHours: new Set(),
  })
  expect(chart.datasets.map(d => d.label)).toEqual(["tls", "Total"])
  expect(visibleGroups([{ key: "a", values: [0] }, { key: "b", values: [1] }]).map(g => g.key)).toEqual(["b"])
  const none = chartFromSeries({ series: series({ groups: [{ key: "", values: [0, 0, 0] }] }), settings: {}, groupBy: "stage", palette, totalLabel: "Total", otherLabel: "Other", noneLabel: "(none)", surgeHours: new Set() })
  expect(none.datasets.map(d => d.label)).toEqual(["Total"])
})

test("a latency metric pairs with its check metric, and only passed hours keep their latency", () => {
  expect(latencyCheckMetric("probe.latency_ms", ["probe.ok"])).toBe("probe.ok")
  expect(latencyCheckMetric("probe.latency_ms", [])).toBeNull()
  expect(latencyCheckMetric("nic.tx_bytes", ["probe.ok"])).toBeNull()
  const latency = series({ unit: "ms", total: [120, 300, 80], groups: [{ key: "", values: [120, 300, 80] }] })
  const masked = maskUnpassed(latency, { hours: latency.hours, statuses: ["passed", "failed", "no check"] })
  expect(masked.total.map(v => Number.isNaN(v))).toEqual([false, true, true])
  expect(masked.total[0]).toBe(120)
  expect(masked.groups[0]!.values.map(v => Number.isNaN(v))).toEqual([false, true, true])
  const notMonitored = maskUnpassed(latency, { hours: latency.hours, statuses: ["not monitored", "passed", "passed"] })
  expect(notMonitored.total.map(v => Number.isNaN(v))).toEqual([true, false, false])
  expect(latency.total).toEqual([120, 300, 80])
})

test("the open current hour is pending unless a check already ran in it, and closed hours keep their status", () => {
  const now = Date.parse("2026-11-16T12:30:00Z")
  expect(displayStatus("no check", "2026-11-16T12:00:00Z", now)).toBe("pending")
  expect(displayStatus("no check", "2026-11-16T11:00:00Z", now)).toBe("no check")
  expect(displayStatus("passed", "2026-11-16T12:00:00Z", now)).toBe("passed")
  expect(displayStatus("failed", "2026-11-16T12:00:00Z", now)).toBe("failed")
  expect(displayStatus("not monitored", "2026-11-16T12:00:00Z", now)).toBe("not monitored")
  expect(statusTone("pending")).toBe("neutral")
})

test("only closed hours can raise the no-check warning", () => {
  const open = { ...summary(), checks: [{ ...check("no check"), hour: "2026-11-16T12:00:00Z" }] }
  expect(freshnessNotices(open)).toEqual([])
})

test("the open hour is never judged by the latency mask: a gap unless its check passed", () => {
  const latency = series({ unit: "ms", total: [120, 300, 80], groups: [] })
  const masked = maskUnpassed(latency, { hours: latency.hours, statuses: ["passed", "passed", "no check"] })
  expect(masked.total.map(v => Number.isNaN(v))).toEqual([false, false, true])
})

test("instants are shown as zone text", () => {
  expect(formatInstant("2026-11-16T09:05:00.000Z")).toBe("2026-11-16 09:05")
})

test("availability metrics are the check metrics and their namespace, and the traffic default skips them", () => {
  const info = (metric: string) => ({ metric, unit: "count" as const, firstHour: "", lastHour: "", dims: [] })
  const checks = ["probe.ok"]
  expect(["probe.ok", "probe.fail", "probe.latency_ms"].every(metric => isAvailabilityMetric(metric, checks))).toBe(true)
  expect(["proxy.sent_bytes", "nic.tx_bytes", "prober.x"].some(metric => isAvailabilityMetric(metric, checks))).toBe(false)
  expect(isAvailabilityMetric("probe.fail", [])).toBe(false)
  expect(isAvailabilityMetric("ok", ["ok"])).toBe(true)
  expect(isAvailabilityMetric("ok_rate", ["ok"])).toBe(false)
  expect(defaultMetric([info("probe.fail"), info("probe.latency_ms"), info("probe.ok"), info("proxy.connections")], { checkMetrics: checks })).toBe("proxy.connections")
  expect(availabilityGroups([info("probe.ok"), info("probe.latency_ms")], checks)).toEqual([{ check: "probe.ok", latency: "probe.latency_ms" }])
  expect(availabilityGroups([info("probe.ok")], checks)).toEqual([{ check: "probe.ok", latency: null }])
  expect(availabilityGroups([info("proxy.connections")], checks)).toEqual([])
})

test("a custom period is whole days in the display zone, both included, ends at the current hour and is at most 90 days", () => {
  const now = Date.parse("2026-11-17T05:30:00Z")
  expect(defaultCustomDates(now)).toEqual({ start: "2026-11-01", end: "2026-11-17" })
  expect(customWindow("2026-11-01", "2026-11-10", now)).toEqual({ from: "2026-11-01T00:00:00Z", to: "2026-11-11T00:00:00Z" })
  expect(customWindow("2026-11-10", "2026-11-17", now)).toEqual({ from: "2026-11-10T00:00:00Z", to: "2026-11-17T06:00:00Z" })
  expect(customWindow("2026-11-17", "2026-11-17", now)).toEqual({ from: "2026-11-17T00:00:00Z", to: "2026-11-17T06:00:00Z" })
  expect(customWindow("2026-11-10", "2026-11-09", now)).toEqual({ error: "order" })
  expect(customWindow("2026-11-18", "2026-11-20", now)).toEqual({ error: "order" })
  expect(customWindow("", "2026-11-09", now)).toEqual({ error: "invalid" })
  expect(customWindow("2026-08-20", "2026-11-17", now)).toEqual({ from: "2026-08-20T00:00:00Z", to: "2026-11-17T06:00:00Z" })
  expect(customWindow("2026-08-19", "2026-11-17", now)).toEqual({ error: "too_long" })
})

test("the window total sums the hours, skips gaps and is not given for milliseconds", () => {
  const series = (unit: "bytes" | "ms", total: number[]) => ({ metric: "m", unit, from: "", to: "", hours: [], total, groups: [] })
  expect(windowTotal(series("bytes", [1, 2, Number.NaN, 3]))).toBe(6)
  expect(windowTotal(series("ms", [1, 2]))).toBeNull()
})

test("the filter dim prefers user, is never the split dim and needs two dims", () => {
  expect(filterDimFor(["domain", "user"], "")).toBe("user")
  expect(filterDimFor(["domain", "user"], "domain")).toBe("user")
  expect(filterDimFor(["domain", "user"], "user")).toBe("domain")
  expect(filterDimFor(["domain", "stage"], "")).toBe("domain")
  expect(filterDimFor(["user"], "")).toBeNull()
  expect(filterDimFor([], "")).toBeNull()
})

test("the filter is shown with the owner's name, sent as key:value, and kept only while its dim and value are offered", () => {
  const settings = { labels: { user: { "#1": "MacBook" } } }
  expect(filterText(settings, { key: "user", value: "#1" })).toBe("user #1 (MacBook)")
  expect(filterText(settings, { key: "user", value: "#2" })).toBe("user #2")
  expect(filterQuery({ key: "user", value: "#1" })).toBe("user:#1")
  expect(filterQuery(null)).toBeUndefined()
  const filter = { key: "user", value: "#1" }
  expect(keepFilter(filter, "user", null)).toBe(filter)
  expect(keepFilter(filter, "user", { key: "user", values: ["#1", "#2"] })).toBe(filter)
  expect(keepFilter(filter, "user", { key: "user", values: ["#2"] })).toBeNull()
  expect(keepFilter(filter, "domain", null)).toBeNull()
  expect(keepFilter(filter, null, null)).toBeNull()
  expect(keepFilter(null, "user", null)).toBeNull()
})

const inZone = (zone: string, run: () => void) => { setDisplayZone(zone); try { run() } finally { setDisplayZone("UTC") } }

test("labels shift to the display zone", () => {
  inZone("Asia/Shanghai", () => {
    expect(hourShort("2026-11-16T16:00:00Z")).toBe("11-17 00:00")
    expect(hourRange("2026-11-16T15:00:00Z")).toBe("23:00–00:00")
    expect(formatInstant("2026-11-16T21:05:00.000Z")).toBe("2026-11-17 05:05")
    expect(zoneLabel(Date.parse("2026-11-16T00:00:00Z"))).toBe("Asia/Shanghai, UTC+8")
    const series = { hours: ["2026-11-16T16:00:00Z"], total: [1], groups: [], unit: "count" } as unknown as TelemetrySeries
    expect(chartFromSeries({ series, palette: ["#000"], surgeHours: new Set(), totalLabel: "Total", groupBy: "", settings: {} } as never).labels).toEqual(["11-17 00:00"])
  })
  inZone("Asia/Kolkata", () => {
    expect(hourShort("2026-11-16T16:00:00Z")).toBe("11-16 21:30")
    expect(hourRange("2026-11-16T16:00:00Z")).toBe("21:30–22:30")
    expect(offsetLabel(0)).toBe("UTC+5:30")
  })
})

test("a custom period in Asia/Shanghai starts and ends at local midnight", () => {
  inZone("Asia/Shanghai", () => {
    const now = Date.parse("2026-11-17T06:20:00Z") // 14:20 local on the 17th
    expect(localDate(now)).toBe("2026-11-17")
    expect(localDate(Date.parse("2026-11-16T17:00:00Z"))).toBe("2026-11-17")
    expect(defaultCustomDates(now)).toEqual({ start: "2026-11-01", end: "2026-11-17" })
    expect(customWindow("2026-11-01", "2026-11-10", now)).toEqual({ from: "2026-10-31T16:00:00Z", to: "2026-11-10T16:00:00Z" })
    expect(customWindow("2026-11-17", "2026-11-17", now)).toEqual({ from: "2026-11-16T16:00:00Z", to: "2026-11-17T07:00:00Z" })
    expect(customWindow("2026-11-18", "2026-11-18", now)).toEqual({ error: "order" })
  })
})

test("a custom period is DST-safe in America/New_York across 2026-11-01", () => {
  inZone("America/New_York", () => {
    const now = Date.parse("2026-11-17T12:00:00Z")
    // Oct 31 is still EDT (UTC-4); Nov 2 is EST (UTC-5); Nov 1 is 25 hours long.
    expect(customWindow("2026-10-31", "2026-10-31", now)).toEqual({ from: "2026-10-31T04:00:00Z", to: "2026-11-01T04:00:00Z" })
    expect(customWindow("2026-11-01", "2026-11-01", now)).toEqual({ from: "2026-11-01T04:00:00Z", to: "2026-11-02T05:00:00Z" })
    expect(customWindow("2026-10-31", "2026-11-02", now)).toEqual({ from: "2026-10-31T04:00:00Z", to: "2026-11-03T05:00:00Z" })
    expect(hourShort("2026-11-01T05:00:00Z")).toBe("11-01 01:00") // 05:00Z is 01:00 EST, after the clocks went back
    expect(hourShort("2026-11-01T06:00:00Z")).toBe("11-01 01:00")
    expect(hourShort("2026-11-01T04:00:00Z")).toBe("11-01 00:00")
    expect(localDate(Date.parse("2026-11-02T04:30:00Z"))).toBe("2026-11-01")
  })
})

test("a custom period floors from and ceils to whole UTC hours in Asia/Kolkata", () => {
  inZone("Asia/Kolkata", () => {
    const now = Date.parse("2026-11-20T00:00:00Z")
    // Local midnight of Nov 1 is 2026-10-31T18:30Z: floored to 18:00Z. Local midnight after Nov 1 is 2026-11-01T18:30Z: ceiled to 19:00Z.
    expect(customWindow("2026-11-01", "2026-11-01", now)).toEqual({ from: "2026-10-31T18:00:00Z", to: "2026-11-01T19:00:00Z" })
  })
})

test("the 90-day limit counts local calendar days", () => {
  inZone("America/New_York", () => {
    const now = Date.parse("2026-11-17T12:00:00Z")
    expect("error" in customWindow("2026-08-20", "2026-11-17", now)).toBe(false)
    expect(customWindow("2026-08-19", "2026-11-17", now)).toEqual({ error: "too_long" })
  })
})
