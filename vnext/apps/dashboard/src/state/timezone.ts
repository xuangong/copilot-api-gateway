import { useEffect, useState } from "react"

/**
 * Which time zone the dashboard slices days, weeks and months in.
 *
 * Usage is *stored* by UTC hour and the server resets quotas on the UTC calendar
 * month, but the charts have always bucketed in the browser's own zone. East of
 * Greenwich the two disagree for the first hours of every day and month, and
 * until now there was no way to see the UTC view — "local" was an implicit
 * choice the page could not even name.
 */
export type TimeZoneMode = "local" | "utc"

const LS_KEY = "usage.timeZone"
const EVENT = "tz-changed"

/**
 * Default "local", so nothing moves for anyone who never touches the switch.
 * Read once at module load; the setter is the only writer.
 */
let mode: TimeZoneMode = readStored()

function readStored(): TimeZoneMode {
  if (typeof localStorage === "undefined") return "local"
  try {
    return localStorage.getItem(LS_KEY) === "utc" ? "utc" : "local"
  } catch {
    return "local"
  }
}

export function getZoneMode(): TimeZoneMode {
  return mode
}

export function setZoneMode(next: TimeZoneMode): void {
  if (next === mode) return
  mode = next
  try {
    localStorage.setItem(LS_KEY, next)
  } catch {
    // A private-mode browser can refuse the write. The preference still applies
    // for this session; only its survival across a reload is lost.
  }
  window.dispatchEvent(new Event(EVENT))
}

/**
 * The current mode, re-rendering the caller when it changes.
 *
 * Same shape as useT() in ./i18n.ts and the `theme-changed` listener in
 * TimeSeriesChart: one module-level value, one window event, a tick per
 * subscriber. A context provider would be the other option, but every consumer
 * here is already a hook rather than a tree of components.
 */
export function useZoneMode(): TimeZoneMode {
  const [, setTick] = useState(0)
  useEffect(() => {
    const handler = () => setTick((n) => n + 1)
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])
  return mode
}

/**
 * Reading and constructing wall-clock fields in one zone.
 *
 * Bundled into an object rather than branching at each of the twenty-odd field
 * reads in the bucket helpers: scattered `mode === "utc" ? d.getUTCDate() :
 * d.getDate()` would bury the DST reasoning those helpers are mostly made of.
 */
export interface ZoneOps {
  year(d: Date): number
  /** 0-based, matching Date. */
  month(d: Date): number
  day(d: Date): number
  hour(d: Date): number
  /** 0 = Sunday, matching Date#getDay. */
  weekday(d: Date): number
  /** The instant at which this zone's clock reads the given wall time. */
  make(y: number, m: number, d: number, h?: number): Date
  /**
   * Spread into toLocaleDateString/toLocaleTimeString options. Empty for local —
   * omitting `timeZone` is what makes Intl use the host zone.
   */
  fmt: Intl.DateTimeFormatOptions
}

/**
 * Local uses the native getters throughout, so DST is handled by Date itself:
 * a local day really is 23 or 25 hours long twice a year, and constructing one
 * through `new Date(y, m, d)` lands on its true midnight. UTC has no DST, and
 * Date.UTC is exact.
 */
const LOCAL_OPS: ZoneOps = {
  year: (d) => d.getFullYear(),
  month: (d) => d.getMonth(),
  day: (d) => d.getDate(),
  hour: (d) => d.getHours(),
  weekday: (d) => d.getDay(),
  make: (y, m, d, h = 0) => new Date(y, m, d, h, 0, 0, 0),
  fmt: {},
}

const UTC_OPS: ZoneOps = {
  year: (d) => d.getUTCFullYear(),
  month: (d) => d.getUTCMonth(),
  day: (d) => d.getUTCDate(),
  hour: (d) => d.getUTCHours(),
  weekday: (d) => d.getUTCDay(),
  make: (y, m, d, h = 0) => new Date(Date.UTC(y, m, d, h, 0, 0, 0)),
  fmt: { timeZone: "UTC" },
}

export function zoneOps(m: TimeZoneMode): ZoneOps {
  return m === "utc" ? UTC_OPS : LOCAL_OPS
}

/** Shorthand for the ops of whatever mode is currently selected. */
export function currentOps(): ZoneOps {
  return zoneOps(mode)
}

/**
 * The browser's offset as "UTC+8" / "UTC-3:30".
 *
 * Derived from getTimezoneOffset rather than from a fixed table, so half-hour
 * and three-quarter-hour zones (UTC+5:30, UTC+5:45) come out right. Note the
 * sign flip: getTimezoneOffset reports minutes to *add* to local to reach UTC,
 * which is the opposite of how offsets are written.
 */
export function localOffsetLabel(now: Date = new Date()): string {
  const mins = -now.getTimezoneOffset()
  const sign = mins < 0 ? "-" : "+"
  const abs = Math.abs(mins)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`
}

/**
 * How the local zone is named to the user: "Asia/Shanghai, UTC+8".
 *
 * The IANA name alone does not say how far from UTC it is, and the offset alone
 * does not say which of the several zones sharing it you are in — so both.
 * Falls back to the offset when Intl cannot resolve a name.
 */
export function localZoneLabel(now: Date = new Date()): string {
  const offset = localOffsetLabel(now)
  let name = ""
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    name = ""
  }
  return name ? `${name}, ${offset}` : offset
}
