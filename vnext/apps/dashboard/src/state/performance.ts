import { useEffect, useMemo, useState } from "react"
import type { PerformanceMetricsResponse } from "@vibe-llm/protocols/common"
import { listPerformanceMetrics } from "../api/performance"
import { computeTimeRange, formatWeekLabel, type LatencyRange } from "./latency"
import { useZoneMode } from "./timezone"
import { aggregateMetrics, comparisonGroups, filterPerformanceGroups, type PerformanceFilters } from "./performance-data"

const EMPTY: PerformanceMetricsResponse = { version: 2, groups: [], legacyRequests: 0 }

export function usePerformance() {
  const zone = useZoneMode()
  const [range, setRange] = useState<LatencyRange>("today")
  const [weekOffset, setWeekOffset] = useState(0)
  const [data, setData] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [filters, setFilters] = useState<PerformanceFilters>({ outcome: "success", mode: "stream" })
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setData(EMPTY)
    const { start, end } = computeTimeRange(range, weekOffset, zone)
    listPerformanceMetrics(start, end)
      .then(result => { if (active) setData(result) })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [range, weekOffset, zone, reload])
  const filtered = useMemo(() => filterPerformanceGroups(data.groups, filters), [data, filters])
  const metrics = useMemo(() => aggregateMetrics(filtered), [filtered])
  const comparisons = useMemo(() => comparisonGroups(filtered), [filtered])
  const outcomeCounts = useMemo(() => {
    const counts = { success: 0, error: 0, cancelled: 0 }
    for (const group of filterPerformanceGroups(data.groups, { ...filters, outcome: "" })) counts[group.outcome] += group.requests
    return counts
  }, [data, filters])
  return {
    data, loading, error, filtered, metrics, comparisons, outcomeCounts, range, weekOffset, filters,
    weekLabel: formatWeekLabel(weekOffset, zone),
    setFilter: (field: keyof PerformanceFilters, value: string) => setFilters(current => ({ ...current, [field]: value })),
    switchRange: (next: LatencyRange) => { setRange(next); setWeekOffset(0) },
    shiftWeek: (delta: number) => setWeekOffset(current => Math.min(0, current + delta)),
    refresh: () => setReload(current => current + 1),
  }
}
