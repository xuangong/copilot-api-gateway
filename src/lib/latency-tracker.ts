import { getRepo } from "~/repo"
import type { PerformanceSourceApi, PerformanceTargetApi } from "~/repo/types"

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

export interface LatencyTimings {
  totalMs: number
  upstreamMs: number
  ttfbMs: number
  tokenMiss: boolean
}

// Extended info for local logging
export interface LatencyLogInfo extends LatencyTimings {
  inputTokens?: number
  outputTokens?: number
  stream?: boolean
  userAgent?: string
  // Performance-table dimensions. Optional for backwards compat; when present
  // we additionally write into `performance_summary` + `performance_latency_buckets`.
  sourceApi?: PerformanceSourceApi
  targetApi?: PerformanceTargetApi
  isError?: boolean
  upstream?: string | null
}

// Optional callback for local logging (set by local.ts)
let logCallback: ((requestId: string, model: string, info: LatencyLogInfo) => void) | null = null

export function setLatencyLogCallback(cb: typeof logCallback) {
  logCallback = cb
}

export function recordLatency(
  keyId: string,
  model: string,
  colo: string,
  timings: LatencyTimings,
  requestId?: string,
  logInfo?: Partial<LatencyLogInfo>,
): Promise<void> {
  // Call log callback if set (local mode)
  if (logCallback && requestId) {
    logCallback(requestId, model, { ...timings, ...logInfo })
  }

  const repo = getRepo()
  const latencyP = repo.latency.record({
    keyId,
    model,
    hour: currentHour(),
    colo,
    stream: logInfo?.stream ?? false,
    ...timings,
  })

  // Fan out to performance telemetry when caller passed source/target metadata.
  // `request_total` counts every call; `upstream_success` counts only non-errors.
  const sourceApi = logInfo?.sourceApi
  const targetApi = logInfo?.targetApi
  if (sourceApi && targetApi) {
    const hour = currentHour()
    const stream = logInfo?.stream ?? false
    const isError = logInfo?.isError ?? false
    const durationMs = timings.totalMs
    const base = { hour, keyId, model, upstream: logInfo?.upstream ?? null, sourceApi, targetApi, stream, runtimeLocation: colo }
    const perfTotal = repo.performance.record({
      ...base,
      metricScope: "request_total",
      durationMs,
      isError,
    })
    const perfSuccess = isError
      ? Promise.resolve()
      : repo.performance.record({
        ...base,
        metricScope: "upstream_success",
        durationMs: timings.upstreamMs,
        isError: false,
      })
    return Promise.all([latencyP, perfTotal, perfSuccess]).then(() => undefined)
  }

  return latencyP
}

/** Helper to measure elapsed time */
export function startTimer(): () => number {
  const start = Date.now()
  return () => Date.now() - start
}
