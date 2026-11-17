import { z } from "zod"
import {
  TELEMETRY_DIMS_RETENTION_DAYS, TELEMETRY_PLAIN_RETENTION_DAYS, TELEMETRY_UNITS, canonicalDims,
  type TelemetryPoint, type TelemetryUnit,
} from "../../repo/telemetry"
import { TelemetryError } from "./common"

export const PUSH_LIMITS = { bodyBytes: 2 * 1024 * 1024, points: 20_000, metrics: 20, hours: 168, value: 1e15 } as const
export const MAX_SOURCES_PER_OWNER = 16
export const SETTINGS_MAX_BYTES = 32 * 1024
export const MAX_WINDOW_DAYS = 90

export const METRIC_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
export const DIM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
export const SOURCE_ID_PATTERN = /^tls_[a-f0-9]{32}$/
export const PUSH_KEY_PATTERN = /^tlm_[a-f0-9]{64}$/
const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/

export const isMetricName = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 64 && METRIC_PATTERN.test(value)

/** Unix seconds of an ISO hour at the top of an hour (`2026-11-16T13:00:00Z`), or null. */
export function parseHour(value: unknown): number | null {
  if (typeof value !== "string" || !HOUR_PATTERN.test(value)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== value) return null
  return ms / 1000
}

export const formatHour = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(".000Z", "Z")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const bad = () => new TelemetryError("invalid_request", 400)

function parseDims(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw bad()
  const entries = Object.entries(value)
  if (entries.length > 3) throw bad()
  const dims: Record<string, string> = {}
  for (const [key, dim] of entries) {
    if (!DIM_KEY_PATTERN.test(key) || typeof dim !== "string" || dim.length < 1 || dim.length > 256) throw bad()
    dims[key] = dim
  }
  return dims
}

/** Validates a push body into points. Throws `TelemetryError("invalid_request", 400)` on anything out of bounds. */
export function parsePushBody(body: unknown, nowMs: number): TelemetryPoint[] {
  if (!isRecord(body) || Object.keys(body).some(key => key !== "version" && key !== "points")) throw bad()
  if (body.version !== 1 || !Array.isArray(body.points) || body.points.length > PUSH_LIMITS.points) throw bad()
  const nowSec = Math.floor(nowMs / 1000)
  const points: TelemetryPoint[] = []
  const seen = new Set<string>()
  const units = new Map<string, TelemetryUnit>()
  const hours = new Set<number>()
  for (const raw of body.points as unknown[]) {
    if (!isRecord(raw) || Object.keys(raw).some(key => !["metric", "hour", "dims", "value", "unit"].includes(key))) throw bad()
    if (!isMetricName(raw.metric)) throw bad()
    const hour = parseHour(raw.hour)
    if (hour === null) throw bad()
    const dims = parseDims(raw.dims)
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > PUSH_LIMITS.value) throw bad()
    if (typeof raw.unit !== "string" || !(TELEMETRY_UNITS as readonly string[]).includes(raw.unit)) throw bad()
    const unit = raw.unit as TelemetryUnit
    const retentionDays = Object.keys(dims).length > 0 ? TELEMETRY_DIMS_RETENTION_DAYS : TELEMETRY_PLAIN_RETENTION_DAYS
    if (hour > nowSec + 3600 || hour < nowSec - retentionDays * 86_400) throw bad()
    if (units.get(raw.metric) !== undefined && units.get(raw.metric) !== unit) throw bad()
    units.set(raw.metric, unit)
    const identity = `${raw.metric}\u0000${hour}\u0000${canonicalDims(dims)}`
    if (seen.has(identity)) throw bad()
    seen.add(identity)
    hours.add(hour)
    if (units.size > PUSH_LIMITS.metrics || hours.size > PUSH_LIMITS.hours) throw bad()
    points.push({ metric: raw.metric, hour, dims, value: raw.value, unit })
  }
  return points
}

const metricName = z.string().max(64).regex(METRIC_PATTERN)
const gb = z.number().min(0).max(1e9)
export const settingsSchema = z.object({
  budgetMetric: metricName.optional(),
  monthlyLimit: z.number().positive().max(1e15).optional(),
  pricePerGB: z.number().min(0).max(1e6).optional(),
  freeGB: gb.optional(),
  surgeMetrics: z.array(metricName).max(10).optional(),
  surgeFactor: z.number().gt(1).max(1000).optional(),
  surgeMinBytes: z.number().min(0).max(1e15).optional(),
  surgeMinCount: z.number().min(0).max(1e15).optional(),
  flagNonZeroMetrics: z.array(metricName).max(20).optional(),
  checkMetrics: z.array(metricName).max(20).optional(),
  labels: z.record(z.string().regex(DIM_KEY_PATTERN), z.record(z.string().min(1).max(256), z.string().min(1).max(64)))
    .refine(value => Object.keys(value).length <= 8).optional(),
  staleAfterHours: z.number().int().min(1).max(720).optional(),
}).strict()
export type TelemetrySettings = z.infer<typeof settingsSchema>

/** The stored settings, or `{}` when the stored object no longer validates. */
export function settingsOf(record: { settings: Record<string, unknown> }): TelemetrySettings {
  const parsed = settingsSchema.safeParse(record.settings)
  return parsed.success ? parsed.data : {}
}

export interface QueryWindow { from: number; to: number }

/** `from` inclusive, `to` exclusive, both hour-aligned ISO. Default: the last 24 hours through the current hour. At most 90 days. */
export function parseWindow(fromParam: string | undefined, toParam: string | undefined, nowSec: number): QueryWindow {
  const to = toParam === undefined ? Math.floor(nowSec / 3600) * 3600 + 3600 : parseHour(toParam)
  if (to === null) throw bad()
  const from = fromParam === undefined ? to - 24 * 3600 : parseHour(fromParam)
  if (from === null || to <= from || to - from > MAX_WINDOW_DAYS * 86_400) throw bad()
  return { from, to }
}
