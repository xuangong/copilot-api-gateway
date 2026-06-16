/**
 * Latency tracker: conditionally fans out to `performance_summary` +
 * `performance_latency_buckets` when the caller supplies BOTH `sourceApi`
 * and `targetApi` (and they map to valid perf enums).
 *
 * The legacy `latency` aggregate table is no longer written — the dashboard
 * `/api/latency` view derives from `performance_summary` (see
 * control-plane/performance/routes.ts::summaryToLatencyRecords). The table
 * and `LatencyRepo` are kept temporarily for schema stability but receive
 * no new rows.
 *
 * Source-api enums use dash form in the perf tables ('chat-completions') but
 * the dispatcher's SourceApi type from errors/repackage.ts uses underscore
 * form ('chat_completions'). This module is the single translation point.
 */
import { getRepo } from '../repo/index.ts'
import type { PerformanceSourceApi, PerformanceTargetApi } from '../repo/types.ts'

export interface LatencyTimings {
  totalMs: number
  upstreamMs: number
  ttfbMs: number
  tokenMiss: boolean
}

export type SourceApiInput =
  | 'messages'
  | 'chat_completions'
  | 'responses'
  | 'gemini'
  | 'embeddings'

export type TargetApiInput =
  | 'messages'
  | 'chat_completions'
  | 'responses'
  | 'embeddings'

export interface LatencyLogInfo {
  stream?: boolean
  sourceApi?: SourceApiInput
  targetApi?: TargetApiInput
  isError?: boolean
  upstream?: string | null
  inputTokens?: number
  outputTokens?: number
  userAgent?: string
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

function toPerfSourceApi(s: SourceApiInput): PerformanceSourceApi {
  return s === 'chat_completions' ? 'chat-completions' : s
}

function toPerfTargetApi(t: TargetApiInput): PerformanceTargetApi {
  return t === 'chat_completions' ? 'chat-completions' : t
}

export function startTimer(): () => number {
  const start = Date.now()
  return () => Date.now() - start
}

export async function recordLatency(
  keyId: string,
  model: string,
  colo: string,
  timings: LatencyTimings,
  requestId?: string,
  logInfo?: LatencyLogInfo,
): Promise<void> {
  const sourceApi = logInfo?.sourceApi
  const targetApi = logInfo?.targetApi
  if (!sourceApi || !targetApi) return

  const repo = getRepo()
  const hour = currentHour()
  const stream = logInfo?.stream ?? false
  const isError = logInfo?.isError ?? false
  const base = {
    hour, keyId, model,
    upstream: logInfo?.upstream ?? null,
    sourceApi: toPerfSourceApi(sourceApi),
    targetApi: toPerfTargetApi(targetApi),
    stream,
    runtimeLocation: colo,
  }
  const perfTotal = repo.performance.record({
    ...base,
    metricScope: 'request_total',
    durationMs: timings.totalMs,
    isError,
  })
  const perfSuccess = isError
    ? Promise.resolve()
    : repo.performance.record({
      ...base,
      metricScope: 'upstream_success',
      durationMs: timings.upstreamMs,
      isError: false,
    })

  await Promise.all([perfTotal, perfSuccess])
}
