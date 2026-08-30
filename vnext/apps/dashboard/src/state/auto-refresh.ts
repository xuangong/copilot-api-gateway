/**
 * Keeping the usage tab's numbers current.
 *
 * The tab fetches once when it mounts and then never again, so a dashboard
 * left open on a wall display drifts further from the truth by the hour with
 * nothing on screen admitting it. Two things fix that: a button that refetches
 * on demand, and an optional timer that does it on a chosen cadence.
 *
 * The timing rules live here rather than inside the component so they can be
 * tested directly — a poll that fires twice, or never, is exactly the kind of
 * bug that hides behind a `setInterval` in a render function.
 */

import { useEffect, useRef, useState } from "react"

/**
 * Cadences offered in the picker, in minutes. `0` means the timer is off and
 * the button is the only way to refetch.
 *
 * Nothing faster than a minute is offered: every tick is a D1 aggregate over
 * the whole window, and usage rows are written as requests finish, so a
 * sub-minute cadence would spend real query time to redraw the same chart.
 */
export const AUTO_REFRESH_MINUTES = [0, 1, 5, 15, 30] as const

export const MANUAL_ONLY = 0

const LS_KEY = "usage.autoRefreshMin"

/**
 * The stored cadence, in milliseconds.
 *
 * An unrecognised value falls back to manual rather than to some default
 * cadence: a stale or hand-edited key must never silently start a poll the
 * user didn't ask for.
 */
export function parseIntervalMs(raw: string | null): number {
  const minutes = Number(raw)
  if (!Number.isFinite(minutes)) return MANUAL_ONLY
  return (AUTO_REFRESH_MINUTES as readonly number[]).includes(minutes) ? minutes * 60_000 : MANUAL_ONLY
}

export function loadIntervalMs(): number {
  if (typeof localStorage === "undefined") return MANUAL_ONLY
  return parseIntervalMs(localStorage.getItem(LS_KEY))
}

export function saveIntervalMs(ms: number): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(LS_KEY, String(Math.round(ms / 60_000)))
}

/**
 * Whether a poll is owed.
 *
 * Measured from the last *successful* fetch, not from when the timer was
 * armed, so changing the range — which refetches on its own — resets the
 * clock instead of stacking another fetch on top a moment later.
 */
export function isDue(lastUpdated: number | null, now: number, intervalMs: number): boolean {
  if (intervalMs <= 0) return false
  if (lastUpdated === null) return false
  return now - lastUpdated >= intervalMs
}

/** How the "updated N ago" line reads, as an i18n key plus its one variable. */
export interface Age {
  key: string
  n?: number
}

/**
 * Age of the data on screen.
 *
 * Deliberately coarse. A second-by-second counter next to a chart that only
 * moves every few minutes is motion for its own sake, and it would force a
 * re-render of the whole tab once a second to keep it honest.
 */
export function formatAge(elapsedMs: number): Age {
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return { key: "dash.usage.agoNow" }
  if (minutes < 60) return { key: "dash.usage.agoMinutes", n: minutes }
  return { key: "dash.usage.agoHours", n: Math.floor(minutes / 60) }
}

/** Identity of a rendered age, used to re-render only when the words change. */
function ageId(age: Age): string {
  return `${age.key}:${age.n ?? ""}`
}

/** How often the heartbeat wakes to check both the clock and the poll. */
const HEARTBEAT_MS = 10_000

interface Options {
  /** Chosen cadence; `0` disables the timer. */
  intervalMs: number
  /** Timestamp of the last successful fetch, or null before the first one. */
  lastUpdated: number | null
  /** True while a fetch is in flight. */
  busy: boolean
  onRefresh: () => void
}

/**
 * Drives both the poll and the "updated N ago" label off one timer.
 *
 * Returns the age to render, or null before any data has arrived.
 *
 * Three behaviours worth naming, because each is a decision rather than a
 * detail:
 *
 * - **A hidden tab does not poll.** A dashboard behind twenty other tabs would
 *   otherwise query all day for nobody. On becoming visible again it checks
 *   immediately, so returning to the tab shows current numbers rather than
 *   whatever was last drawn plus a wait.
 * - **A fetch in flight suppresses the next tick.** On a slow window a poll
 *   could otherwise start before the previous one landed and the two would
 *   race to set the same state.
 * - **The label re-renders only when its words change** — roughly once a
 *   minute, not once a heartbeat — so an idle tab isn't repainting its charts
 *   every ten seconds.
 */
export function useAutoRefresh({ intervalMs, lastUpdated, busy, onRefresh }: Options): Age | null {
  const [age, setAge] = useState<Age | null>(null)

  // Read through refs so the heartbeat is armed once and survives every
  // change of cadence or of in-flight state; re-arming it on each would let a
  // rapid sequence of changes postpone a due poll indefinitely.
  const state = useRef({ intervalMs, lastUpdated, busy, onRefresh })
  state.current = { intervalMs, lastUpdated, busy, onRefresh }

  useEffect(() => {
    let shown: string | null = null

    const beat = () => {
      const { intervalMs: every, lastUpdated: last, busy: fetching, onRefresh: refresh } = state.current
      if (last === null) {
        if (shown !== null) {
          shown = null
          setAge(null)
        }
        return
      }
      const now = Date.now()
      const next = formatAge(now - last)
      const id = ageId(next)
      if (id !== shown) {
        shown = id
        setAge(next)
      }
      if (!fetching && !document.hidden && isDue(last, now, every)) refresh()
    }

    beat()
    const timer = setInterval(beat, HEARTBEAT_MS)
    document.addEventListener("visibilitychange", beat)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", beat)
    }
  }, [])

  // A fetch that just landed makes the label stale ("3 minutes ago" over data
  // from a second ago) until the next heartbeat, so settle it straight away.
  useEffect(() => {
    setAge(lastUpdated === null ? null : formatAge(Date.now() - lastUpdated))
  }, [lastUpdated])

  return age
}
