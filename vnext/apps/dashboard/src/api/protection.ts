// apps/dashboard/src/api/protection.ts
import { api } from "./client"

export const ERROR_CLASS_KEYS = ["rate_limited", "rejected", "auth", "upstream", "network", "other"] as const
export type ErrorClassKey = (typeof ERROR_CLASS_KEYS)[number]
export type ProtectionMode = "off" | "notify" | "pause"

export interface ProtectionSettings {
  mode: ProtectionMode
  windowMinutes: number
  minRiskyErrors: number
  minFailureRatio: number
  authBurst: number
  keyShare: number
  cooldownMinutes: number
  maxCooldownMinutes: number
}

export interface PauseReason {
  windowMinutes: number
  requests: number
  risky: number
  counts: Record<ErrorClassKey, number>
  failureRatio: number
  topKeys: Array<{ keyId: string; risky: number }>
  trigger: "ratio" | "authBurst"
  keyShare: number | null
  upstreamName?: string
  targetName?: string
}

/** One row of `/api/protection/active` and of the pause history (times are unix ms). */
export interface ProtectionPause {
  id: string
  targetKind: "upstream" | "key"
  targetId: string
  targetName: string
  /** Blank when the viewer does not own the upstream. */
  upstreamId: string
  /** Blank when the viewer does not own the upstream. */
  upstreamName: string
  mode: "pause" | "notify"
  reason: PauseReason
  startedAt: number
  endsAt: number
  resolvedAt: number | null
  endedBy: "auto" | "owner" | null
  /** The viewer may resume it (key pauses: the key's owner; upstream pauses: the upstream's owner; admins both). */
  canResume: boolean
}

export interface ErrorBucketRow extends Record<ErrorClassKey, number> { t: number; requests: number }
export interface ErrorSeries { upstreamId: string; from: number; to: number; bucket: "minute" | "hour"; buckets: ErrorBucketRow[] }
export interface ErrorSample { upstreamId: string; status: number; at: number; keyId: string; model: string; code: string; message: string }

export const getActivePauses = () => api<{ pauses: ProtectionPause[] }>("/api/protection/active")
export const resumePause = (id: string) => api<{ ok: true }>(`/api/protection/pauses/${encodeURIComponent(id)}/resume`, { method: "POST" })
const upstream = (id: string, rest: string) => `/api/upstreams/${encodeURIComponent(id)}/${rest}`
export const getErrorSeries = (id: string, query: { from: number; to: number; bucket: "minute" | "hour"; keyId?: string }) =>
  api<ErrorSeries>(upstream(id, "errors"), { query })
export const getErrorSamples = (id: string) => api<{ samples: ErrorSample[] }>(upstream(id, "error-samples"))
export const getPauseHistory = (id: string, limit = 20) => api<{ pauses: ProtectionPause[] }>(upstream(id, "pauses"), { query: { limit } })
