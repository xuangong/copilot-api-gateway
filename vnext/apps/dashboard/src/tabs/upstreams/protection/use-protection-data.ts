// apps/dashboard/src/tabs/upstreams/protection/use-protection-data.ts
import { useEffect, useRef, useState } from "react"
import { getErrorSamples, getErrorSeries, getPauseHistory, type ErrorBucketRow, type ErrorSample, type ProtectionPause } from "../../../api/protection"
import { rangeWindow, type ErrorRange, type ErrorWindow } from "./error-chart"

export interface ProtectionData {
  window: ErrorWindow | null
  /** The range `window` was loaded for (the selected range may already have moved on). */
  range: ErrorRange | null
  buckets: ErrorBucketRow[]
  samples: ErrorSample[]
  history: ProtectionPause[]
  loading: boolean
  failed: boolean
}

const INITIAL: ProtectionData = { window: null, range: null, buckets: [], samples: [], history: [], loading: true, failed: false }

interface LoadKey { upstreamId: string; reloadTick: number }

/** Samples and history load on open, on another upstream and on Refresh; a range change refetches the series only. */
export const needsFullLoad = (previous: LoadKey | null, next: LoadKey): boolean =>
  previous === null || previous.upstreamId !== next.upstreamId || previous.reloadTick !== next.reloadTick

export function useProtectionData(upstreamId: string, range: ErrorRange, reloadTick: number): ProtectionData {
  const [state, setState] = useState<ProtectionData>(INITIAL)
  const loaded = useRef<LoadKey | null>(null)
  useEffect(() => {
    let cancelled = false
    const key = { upstreamId, reloadTick }
    const full = needsFullLoad(loaded.current, key)
    loaded.current = key
    const window = rangeWindow(range, Date.now())
    setState((current) => ({ ...current, loading: true, failed: false }))
    const series = getErrorSeries(upstreamId, window)
    const rest = full ? Promise.all([getErrorSamples(upstreamId), getPauseHistory(upstreamId)]) : null
    Promise.all([series, rest])
      .then(([result, extra]) => {
        if (cancelled) return
        setState((current) => ({
          window, range, buckets: result.buckets,
          samples: extra ? extra[0].samples : current.samples, history: extra ? extra[1].pauses : current.history,
          loading: false, failed: false,
        }))
      })
      .catch(() => { if (!cancelled) setState((current) => ({ ...current, loading: false, failed: true })) })
    return () => { cancelled = true }
  }, [upstreamId, range, reloadTick])
  return state
}
