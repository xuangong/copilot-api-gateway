import { api } from "./client"

export type TelemetryUnit = "bytes" | "count" | "ms"
export type CheckStatus = "passed" | "failed" | "no check" | "not monitored"

export interface TelemetrySettings {
  budgetMetric?: string
  monthlyLimit?: number
  pricePerGB?: number
  freeGB?: number
  surgeMetrics?: string[]
  surgeFactor?: number
  surgeMinBytes?: number
  surgeMinCount?: number
  flagNonZeroMetrics?: string[]
  checkMetrics?: string[]
  labels?: Record<string, Record<string, string>>
  staleAfterHours?: number
}

export interface TelemetrySource {
  id: string
  name: string
  createdAt: string
  lastPushAt: string | null
  settings: TelemetrySettings
}

/** Shown once, at creation or rotation. */
export interface IssuedTelemetryKey { key: string; install: string }

const base = "/api/telemetry/sources"
const path = (id: string, rest = "") => `${base}/${encodeURIComponent(id)}${rest}`

export const listTelemetrySources = () => api<{ sources: TelemetrySource[] }>(base)
export const createTelemetrySource = (name: string) => api<{ source: TelemetrySource } & IssuedTelemetryKey>(base, { method: "POST", body: { name } })
export const updateTelemetrySource = (id: string, body: { name?: string; settings?: TelemetrySettings }) =>
  api<{ source: TelemetrySource }>(path(id), { method: "PATCH", body })
export const rotateTelemetryKey = (id: string) => api<IssuedTelemetryKey>(path(id, "/rotate-key"), { method: "POST" })
export const deleteTelemetrySource = (id: string) => api<{ sources: TelemetrySource[] }>(path(id), { method: "DELETE" })

export interface TelemetryMetricInfo { metric: string; unit: TelemetryUnit; firstHour: string; lastHour: string; dims: string[] }

export interface TelemetrySeries {
  metric: string
  unit: TelemetryUnit | null
  from: string
  to: string
  hours: string[]
  total: number[]
  groups: Array<{ key: string; values: number[] }>
  /** Only for `checkMetrics`: one status and, for a failure, one stage per hour. */
  statuses?: CheckStatus[]
  stages?: Array<string | null>
}

export interface TelemetryTopRow { key: string; value: number; share: number; previous: number; change: number | null }
export interface TelemetryTop {
  metric: string
  unit: TelemetryUnit | null
  groupBy: string
  from: string
  to: string
  previousFrom: string
  previousTo: string
  total: number
  rows: TelemetryTopRow[]
  otherCurrent: number
  otherShare: number
}

export interface TelemetryBudget {
  metric: string
  unit: TelemetryUnit | null
  monthStart: string
  mtd: number
  projection: number
  averageDaily: number | null
  monthlyLimit: number | null
  mtdPercent: number | null
  projectionPercent: number | null
  overLimit: boolean | null
  cost: { mtd: number; projection: number | null } | null
}

export interface TelemetryContribution { dims: Record<string, string>; value: number }
export interface TelemetrySurge { metric: string; hour: string; value: number; baseline: number; ratio: number | null; contributors: TelemetryContribution[] }
export interface TelemetryFlag { metric: string; hour: string; total: number; breakdown: TelemetryContribution[] }
export interface TelemetryCheck { metric: string; hour: string; status: CheckStatus; stage: string | null }

export interface TelemetrySummary {
  now: string
  freshness: { lastPushAt: string | null; stale: boolean; staleAfterHours: number; hoursSincePush: number | null }
  budget: TelemetryBudget | null
  surges: TelemetrySurge[]
  flags: TelemetryFlag[]
  checks: TelemetryCheck[]
}

export const telemetryMetrics = (id: string) => api<{ metrics: TelemetryMetricInfo[] }>(path(id, "/metrics"))
export const telemetrySeries = (id: string, query: { metric: string; from: string; to: string; groupBy?: string; top?: number }) =>
  api<TelemetrySeries>(path(id, "/series"), { query })
export const telemetryTop = (id: string, query: { metric: string; from: string; to: string; groupBy: string; limit?: number }) =>
  api<TelemetryTop>(path(id, "/top"), { query })
export const telemetrySummary = (id: string) => api<TelemetrySummary>(path(id, "/summary"))
