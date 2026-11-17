// apps/dashboard/src/tabs/upstreams/protection/error-chart.test.ts
import { afterEach, expect, test } from "bun:test"
import type { ErrorBucketRow } from "../../../api/protection"
import { setDisplayZone } from "../../telemetry/telemetry-format"
import { ERROR_RANGES, classColors, errorChartModel, fillBuckets, rangeWindow } from "./error-chart"

afterEach(() => setDisplayZone(null))
const row = (t: number, over: Partial<ErrorBucketRow> = {}): ErrorBucketRow =>
  ({ t, requests: 0, rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0, ...over })

test("ranges: 1 h by minute, 24 h / 7 d / 30 d by hour, aligned to the end of the current bucket", () => {
  const now = Date.UTC(2026, 10, 17, 12, 34, 56)
  const hour = rangeWindow("24h", now)
  expect(hour).toEqual({ from: Date.UTC(2026, 10, 16, 13) / 1000, to: Date.UTC(2026, 10, 17, 13) / 1000, bucket: "hour" })
  const minute = rangeWindow("1h", now)
  expect(minute).toEqual({ from: Date.UTC(2026, 10, 17, 11, 35) / 1000, to: Date.UTC(2026, 10, 17, 12, 35) / 1000, bucket: "minute" })
  expect(ERROR_RANGES["30d"].seconds / 3600).toBe(720)
  expect(rangeWindow("7d", now).to - rangeWindow("7d", now).from).toBe(7 * 86_400)
})

test("sparse server rows are zero-filled to one row per bucket", () => {
  const filled = fillBuckets([row(7200, { requests: 5, rate_limited: 2 })], 3600, 14_400, 3600)
  expect(filled.map(r => [r.t, r.requests, r.rate_limited])).toEqual([[3600, 0, 0], [7200, 5, 2], [10_800, 0, 0]])
  expect(fillBuckets([], 0, 120, 60).map(r => r.t)).toEqual([0, 60])
  expect(fillBuckets([row(99_999)], 0, 120, 60).every(r => r.requests === 0)).toBe(true) // rows outside the window are ignored
})

test("the model stacks only the classes that occurred, risky ones first, with requests as the line", () => {
  setDisplayZone("UTC")
  const from = Date.UTC(2026, 10, 17, 10) / 1000
  const model = errorChartModel([row(from, { requests: 10, auth: 1, rate_limited: 4 }), row(from + 3600, { requests: 3, upstream: 1 })],
    { from, to: from + 3 * 3600, bucket: "hour" }, key => `label:${key}`)
  expect(model.labels).toEqual(["11-17 10:00", "11-17 11:00", "11-17 12:00"])
  expect(model.bars.map(b => [b.key, b.label, b.data])).toEqual([
    ["rate_limited", "label:rate_limited", [4, 0, 0]], ["auth", "label:auth", [1, 0, 0]], ["upstream", "label:upstream", [0, 1, 0]]])
  expect(model.requests).toEqual([10, 3, 0])
  expect(model.hasData).toBe(true)
  const empty = errorChartModel([], { from, to: from + 3600, bucket: "hour" }, key => key)
  expect(empty).toMatchObject({ bars: [], requests: [0], hasData: false })
})

test("minute buckets are labelled with the local clock", () => {
  setDisplayZone("Asia/Shanghai")
  const from = Date.UTC(2026, 10, 17, 10, 0) / 1000
  expect(errorChartModel([], { from, to: from + 120, bucket: "minute" }, k => k).labels).toEqual(["18:00", "18:01"])
})

test("each class has its own colour per theme, and the risky classes are warm (red channel above blue)", () => {
  for (const dark of [false, true]) {
    const colors = classColors(dark)
    const values = Object.values(colors)
    expect(new Set(values).size).toBe(values.length)
    for (const key of ["rate_limited", "rejected", "auth"] as const) {
      const hex = colors[key].replace("#", "")
      expect(parseInt(hex.slice(0, 2), 16), `${key} red`).toBeGreaterThan(parseInt(hex.slice(4, 6), 16))
    }
  }
})

test("the light-theme neutral for `other` is dark enough to see on a light surface", () => {
  const hex = classColors(false).other.replace("#", "")
  const lum = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const L = 0.2126 * lum[0]! + 0.7152 * lum[1]! + 0.0722 * lum[2]!
  expect(1.05 / (L + 0.05)).toBeGreaterThan(3)
})

test("chartTotals sums requests and every error class shown", async () => {
  const { chartTotals } = await import("./error-chart")
  expect(chartTotals({ labels: ["a", "b"], bars: [{ key: "rate_limited", label: "x", data: [1, 2] }, { key: "network", label: "y", data: [0, 4] }], requests: [10, 20], hasData: true })).toEqual({ requests: 30, errors: 7 })
})
