import { getRepo } from "~/repo"

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

  return getRepo().latency.record({
    keyId,
    model,
    hour: currentHour(),
    colo,
    stream: logInfo?.stream ?? false,
    ...timings,
  })
}

/** Helper to measure elapsed time */
export function startTimer(): () => number {
  const start = Date.now()
  return () => Date.now() - start
}
