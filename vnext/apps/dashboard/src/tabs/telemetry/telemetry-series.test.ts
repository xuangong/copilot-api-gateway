import { expect, test } from "bun:test"
import type { TelemetrySeries } from "../../api/telemetry"
import { loadAvailability, loadSeries } from "./telemetry-series"

const hours = ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z"]
const make = (metric: string, over: Partial<TelemetrySeries> = {}): TelemetrySeries => ({ metric, unit: "ms", from: hours[0]!, to: "2026-11-16T12:00:00Z", hours, total: [100, 200], groups: [], ...over })
const span = { from: hours[0]!, to: "2026-11-16T12:00:00Z" }

test("a plain metric is fetched once and returned as is", async () => {
  const calls: string[] = []
  const result = await loadSeries(async (_id, query) => { calls.push(query.metric); return make(query.metric) }, "s", { metric: "nic.tx_bytes", ...span, groupBy: "", checkMetrics: ["probe.ok"] })
  expect(calls).toEqual(["nic.tx_bytes"])
  expect(result.total).toEqual([100, 200])
})

test("a latency metric is fetched with its check metric and only passed hours keep a value", async () => {
  const calls: Array<{ metric: string; groupBy?: string }> = []
  const result = await loadSeries(async (_id, query) => {
    calls.push({ metric: query.metric, groupBy: query.groupBy })
    return query.metric === "probe.ok" ? make("probe.ok", { statuses: ["passed", "failed"] }) : make(query.metric)
  }, "s", { metric: "probe.latency_ms", ...span, groupBy: "stage", checkMetrics: ["probe.ok"] })
  expect(calls).toEqual([{ metric: "probe.latency_ms", groupBy: "stage" }, { metric: "probe.ok", groupBy: undefined }])
  expect(result.total[0]).toBe(100)
  expect(Number.isNaN(result.total[1])).toBe(true)
})

test("a latency metric without a configured check is returned unmasked", async () => {
  const calls: string[] = []
  const result = await loadSeries(async (_id, query) => { calls.push(query.metric); return make(query.metric) }, "s", { metric: "probe.latency_ms", ...span, groupBy: "", checkMetrics: [] })
  expect(calls).toEqual(["probe.latency_ms"])
  expect(result.total).toEqual([100, 200])
})

test("availability fetches each check and its latency, keeping latency only in passed hours", async () => {
  const calls: string[] = []
  const result = await loadAvailability(async (_id, query) => {
    calls.push(query.metric)
    return query.metric === "probe.ok" ? make("probe.ok", { unit: "count", statuses: ["failed", "passed"] }) : make(query.metric)
  }, "s", [{ check: "probe.ok", latency: "probe.latency_ms" }], span)
  expect(calls.sort()).toEqual(["probe.latency_ms", "probe.ok"])
  expect(result[0]!.checkSeries.statuses).toEqual(["failed", "passed"])
  expect(Number.isNaN(result[0]!.latency!.total[0])).toBe(true)
  expect(result[0]!.latency!.total[1]).toBe(200)
  const plain = await loadAvailability(async (_id, query) => make(query.metric, { statuses: ["passed", "passed"] }), "s", [{ check: "probe.ok", latency: null }], span)
  expect(plain[0]!.latency).toBeNull()
})

test("the filter is passed to the series fetch, and not to the check metric", async () => {
  const calls: Array<{ metric: string; filter?: string }> = []
  await loadSeries(async (_id, query) => { calls.push({ metric: query.metric, filter: query.filter }); return make(query.metric, { statuses: ["passed", "passed"] }) },
    "s", { metric: "probe.latency_ms", ...span, groupBy: "", filter: "user:#1", checkMetrics: ["probe.ok"] })
  expect(calls).toEqual([{ metric: "probe.latency_ms", filter: "user:#1" }, { metric: "probe.ok", filter: undefined }])
})
