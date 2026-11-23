import type { TelemetrySource } from "../../api/telemetry"

export const MAX_TELEMETRY_SOURCES = 16
const DEFAULT_STALE_AFTER_HOURS = 2

export type SourceBadge = "never" | "fresh" | "stale"

/** Stale is strictly more than the threshold (default 2 hours); a source that never pushed has no age. */
export function sourceBadge(source: Pick<TelemetrySource, "lastPushAt" | "settings">, nowMs: number): SourceBadge {
  if (source.lastPushAt === null) return "never"
  const limit = (source.settings.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS) * 3_600_000
  return nowMs - Date.parse(source.lastPushAt) > limit ? "stale" : "fresh"
}

/** The optional agent source name: empty, or a lower-case name as the installer's TELEMETRY_SOURCE and the gateway require. */
export const agentSourceInvalid = (value: string): boolean => value.trim() !== "" && !/^(?!trojan-vm$)[a-z][a-z0-9-]{0,31}$/.test(value.trim())

/** The agent source stored for a source, to pre-fill the field. */
export const initialAgentSource = (settings: Pick<TelemetrySource["settings"], "agentSource">): string => settings.agentSource ?? ""

export const canCreateSource = (name: string, busy: boolean, agentSource = ""): boolean =>
  !busy && name.trim().length > 0 && name.trim().length <= 64 && !agentSourceInvalid(agentSource)

export const POLL_MS = 5 * 60_000

export interface PollingTimers { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: never) => void }
export interface PollingVisibility {
  hidden: () => boolean
  /** Calls `listener` whenever the page is shown or hidden; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

const defaultTimers: PollingTimers = { setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: id => globalThis.clearInterval(id) }
const defaultVisibility = (): PollingVisibility => ({
  hidden: () => typeof document !== "undefined" && document.hidden,
  subscribe: listener => {
    if (typeof document === "undefined") return () => {}
    document.addEventListener("visibilitychange", listener)
    return () => document.removeEventListener("visibilitychange", listener)
  },
})

/**
 * Runs `refresh` every `intervalMs` (default five minutes) while the page is visible; the returned function stops it (call it on unmount).
 * A tick that falls while the page is hidden is skipped (no request), and the page refreshes once when it becomes visible again.
 */
export function startPolling(refresh: () => void, timers: PollingTimers = defaultTimers, visibility: PollingVisibility = defaultVisibility(), intervalMs: number = POLL_MS): () => void {
  let missed = false
  const id = timers.setInterval(() => {
    if (visibility.hidden()) { missed = true; return }
    missed = false
    refresh()
  }, intervalMs)
  const unsubscribe = visibility.subscribe(() => {
    if (visibility.hidden() || !missed) return
    missed = false
    refresh()
  })
  return () => { unsubscribe(); timers.clearInterval(id as never) }
}
