// apps/dashboard/src/tabs/upstreams/protection/error-chart.ts
import { ERROR_CLASS_KEYS, type ErrorBucketRow, type ErrorClassKey } from "../../../api/protection"
import { formatClockMs, hourShort } from "../../telemetry/telemetry-format"

export type ErrorRange = "1h" | "24h" | "7d" | "30d"
export type ErrorBucketSize = "minute" | "hour"
export const ERROR_RANGES: Record<ErrorRange, { seconds: number; bucket: ErrorBucketSize }> = {
  "1h": { seconds: 3600, bucket: "minute" },
  "24h": { seconds: 86_400, bucket: "hour" },
  "7d": { seconds: 604_800, bucket: "hour" },
  "30d": { seconds: 2_592_000, bucket: "hour" },
}
const bucketSeconds = (bucket: ErrorBucketSize): number => (bucket === "minute" ? 60 : 3600)

export interface ErrorWindow { from: number; to: number; bucket: ErrorBucketSize }

/** Unix seconds, ending at the end of the current bucket so the open bucket is included. */
export function rangeWindow(range: ErrorRange, nowMs: number): ErrorWindow {
  const { seconds, bucket } = ERROR_RANGES[range]
  const step = bucketSeconds(bucket)
  const to = (Math.floor(nowMs / 1000 / step) + 1) * step
  return { from: to - seconds, to, bucket }
}

/** One row per bucket in `[from, to)`; the server only returns buckets that have requests. */
export function fillBuckets(rows: readonly ErrorBucketRow[], from: number, to: number, step: number): ErrorBucketRow[] {
  const byTime = new Map(rows.map((row) => [row.t, row]))
  const out: ErrorBucketRow[] = []
  for (let t = from; t < to; t += step) {
    out.push(byTime.get(t) ?? { t, requests: 0, rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 })
  }
  return out
}

/** Risky classes are warm (amber, rose, red); the others are warm-neutral or grey; the requests line is the brand blue. */
export function classColors(dark: boolean): Record<ErrorClassKey | "requests", string> {
  return dark
    ? { rate_limited: "#F0B050", rejected: "#F07898", auth: "#F2705F", upstream: "#C19A78", network: "#A3A8B0", other: "#CFC8BB", requests: "#7B90FF" }
    : { rate_limited: "#D88A2E", rejected: "#C85878", auth: "#B83A2B", upstream: "#8A6A4F", network: "#7A7F87", other: "#8F897C", requests: "#4E6CF5" }
}

export interface ErrorChartModel {
  labels: string[]
  /** Only classes that occurred, in the order risky first. */
  bars: Array<{ key: ErrorClassKey; label: string; data: number[] }>
  requests: number[]
  hasData: boolean
}

export function errorChartModel(rows: readonly ErrorBucketRow[], window: ErrorWindow, classLabel: (key: ErrorClassKey) => string): ErrorChartModel {
  const filled = fillBuckets(rows, window.from, window.to, bucketSeconds(window.bucket))
  const labels = filled.map((row) => (window.bucket === "minute" ? formatClockMs(row.t * 1000) : hourShort(new Date(row.t * 1000).toISOString())))
  const bars = ERROR_CLASS_KEYS
    .map((key) => ({ key, label: classLabel(key), data: filled.map((row) => row[key]) }))
    .filter((bar) => bar.data.some((value) => value > 0))
  const requests = filled.map((row) => row.requests)
  return { labels, bars, requests, hasData: requests.some((value) => value > 0) }
}

/** Totals over the window, for the chart's text alternative: every request, and every non-ok response shown. */
export function chartTotals(model: ErrorChartModel): { requests: number; errors: number } {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
  return { requests: sum(model.requests), errors: model.bars.reduce((total, bar) => total + sum(bar.data), 0) }
}
