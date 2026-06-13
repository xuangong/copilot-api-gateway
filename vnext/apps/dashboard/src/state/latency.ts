import { useCallback, useEffect, useMemo, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/latency"
import type { LatencyRecord } from "../api/latency"
import { buildTimeBuckets, utcHourToBucketKey } from "../components/TimeSeriesChart"

export type LatencyRange = "today" | "week" | "7d" | "30d"

export interface LatencySummary {
  avgTotal: number
  avgUpstream: number
  avgTtfb: number
  tokenMissRate: number
}

export interface LatencyByType {
  type: "Stream" | "Sync"
  requests: number
  avgTotal: number
  avgUpstream: number
  avgTtfb: number
  tokenMissRate: number
}

export interface LatencyByColo {
  colo: string
  requests: number
  avgTotal: number
  avgUpstream: number
  tokenMissRate: number
}

// Compute [start, end) ISO-13-char window (YYYY-MM-DDTHH) to match
// the legacy `computeTimeRange` helper used by the Alpine dashboard.
function computeTimeRange(range: LatencyRange, weekOffset: number): { start: string; end: string } {
  const now = new Date()
  let start: Date, end: Date
  if (range === "week") {
    const ref = new Date(now)
    ref.setDate(ref.getDate() + weekOffset * 7)
    const day = ref.getDay()
    const monday = new Date(ref)
    monday.setDate(ref.getDate() - ((day + 6) % 7))
    monday.setHours(0, 0, 0, 0)
    start = monday
    end = new Date(monday.getTime() + 7 * 86400000)
  } else {
    const todayLocal = new Date(now)
    todayLocal.setHours(0, 0, 0, 0)
    if (range === "today") start = todayLocal
    else if (range === "7d") start = new Date(todayLocal.getTime() - 6 * 86400000)
    else start = new Date(todayLocal.getTime() - 29 * 86400000)
    end = new Date(now.getTime() + 3600000)
  }
  return {
    start: start.toISOString().slice(0, 13),
    end: end.toISOString().slice(0, 13),
  }
}

export function formatWeekLabel(weekOffset: number): string {
  const now = new Date()
  const ref = new Date(now)
  ref.setDate(ref.getDate() + weekOffset * 7)
  const day = ref.getDay()
  const monday = new Date(ref)
  monday.setDate(ref.getDate() - ((day + 6) % 7))
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday.getTime() + 6 * 86400000)
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  if (weekOffset === 0) return `This week (${fmt(monday)} – ${fmt(sunday)})`
  if (weekOffset === -1) return `Last week (${fmt(monday)} – ${fmt(sunday)})`
  return `${fmt(monday)} – ${fmt(sunday)}`
}

export function useLatency() {
  const { push: toast } = useToast()
  const [range, setRange] = useState<LatencyRange>("today")
  const [weekOffset, setWeekOffset] = useState(0)
  const [model, setModel] = useState("")
  const [data, setData] = useState<LatencyRecord[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const { start, end } = computeTimeRange(range, weekOffset)
      const rows = await api.listLatency(start, end)
      setData(rows)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoading(false)
    }
  }, [range, weekOffset, toast])

  useEffect(() => {
    reload()
  }, [reload])

  const models = useMemo(() => {
    const s = new Set<string>()
    for (const r of data) if (r.model) s.add(r.model)
    return [...s].sort()
  }, [data])

  const filtered = useMemo(() => (model ? data.filter((r) => r.model === model) : data), [data, model])

  const summary = useMemo<LatencySummary>(() => {
    let totalReqs = 0, sumTotal = 0, sumUpstream = 0, sumTtfb = 0, sumMiss = 0
    for (const r of filtered) {
      totalReqs += r.requests
      sumTotal += r.totalMs
      sumUpstream += r.upstreamMs
      sumTtfb += r.ttfbMs
      sumMiss += r.tokenMiss
    }
    return {
      avgTotal: totalReqs > 0 ? Math.round(sumTotal / totalReqs) : 0,
      avgUpstream: totalReqs > 0 ? Math.round(sumUpstream / totalReqs) : 0,
      avgTtfb: totalReqs > 0 ? Math.round(sumTtfb / totalReqs) : 0,
      tokenMissRate: totalReqs > 0 ? Math.round((sumMiss / totalReqs) * 100) : 0,
    }
  }, [filtered])

  const byType = useMemo<LatencyByType[]>(() => {
    const m = new Map<string, { requests: number; totalMs: number; upstreamMs: number; ttfbMs: number; tokenMiss: number }>()
    for (const r of filtered) {
      const key = r.stream ? "Stream" : "Sync"
      const cur = m.get(key) ?? { requests: 0, totalMs: 0, upstreamMs: 0, ttfbMs: 0, tokenMiss: 0 }
      cur.requests += r.requests
      cur.totalMs += r.totalMs
      cur.upstreamMs += r.upstreamMs
      cur.ttfbMs += r.ttfbMs
      cur.tokenMiss += r.tokenMiss
      m.set(key, cur)
    }
    return [...m.entries()]
      .map(([type, v]) => ({
        type: type as "Stream" | "Sync",
        requests: v.requests,
        avgTotal: v.requests > 0 ? Math.round(v.totalMs / v.requests) : 0,
        avgUpstream: v.requests > 0 ? Math.round(v.upstreamMs / v.requests) : 0,
        avgTtfb: v.requests > 0 ? Math.round(v.ttfbMs / v.requests) : 0,
        tokenMissRate: v.requests > 0 ? Math.round((v.tokenMiss / v.requests) * 100) : 0,
      }))
      .sort((a, b) => b.requests - a.requests)
  }, [filtered])

  const byColo = useMemo<LatencyByColo[]>(() => {
    const m = new Map<string, { requests: number; totalMs: number; upstreamMs: number; tokenMiss: number }>()
    for (const r of filtered) {
      const cur = m.get(r.colo) ?? { requests: 0, totalMs: 0, upstreamMs: 0, tokenMiss: 0 }
      cur.requests += r.requests
      cur.totalMs += r.totalMs
      cur.upstreamMs += r.upstreamMs
      cur.tokenMiss += r.tokenMiss
      m.set(r.colo, cur)
    }
    return [...m.entries()]
      .map(([colo, v]) => ({
        colo,
        requests: v.requests,
        avgTotal: v.requests > 0 ? Math.round(v.totalMs / v.requests) : 0,
        avgUpstream: v.requests > 0 ? Math.round(v.upstreamMs / v.requests) : 0,
        tokenMissRate: v.requests > 0 ? Math.round((v.tokenMiss / v.requests) * 100) : 0,
      }))
      .sort((a, b) => b.requests - a.requests)
  }, [filtered])

  // Time-series buckets for the chart (Stream vs Sync avg total ms).
  const chart = useMemo(() => {
    const { keys, labels, isDaily } = buildTimeBuckets(range, weekOffset)
    const aggStream = new Map<string, number>()
    const aggSync = new Map<string, number>()
    const reqsStream = new Map<string, number>()
    const reqsSync = new Map<string, number>()
    for (const k of keys) {
      aggStream.set(k, 0); aggSync.set(k, 0)
      reqsStream.set(k, 0); reqsSync.set(k, 0)
    }
    for (const r of filtered) {
      const bucket = utcHourToBucketKey(r.hour, isDaily)
      if (!aggStream.has(bucket)) continue
      if (r.stream) {
        reqsStream.set(bucket, (reqsStream.get(bucket) ?? 0) + r.requests)
        aggStream.set(bucket, (aggStream.get(bucket) ?? 0) + r.totalMs)
      } else {
        reqsSync.set(bucket, (reqsSync.get(bucket) ?? 0) + r.requests)
        aggSync.set(bucket, (aggSync.get(bucket) ?? 0) + r.totalMs)
      }
    }
    const avg = (sum: number, reqs: number) => reqs > 0 ? Math.round(sum / reqs) : 0
    return {
      labels,
      streamData: keys.map((k) => avg(aggStream.get(k) ?? 0, reqsStream.get(k) ?? 0)),
      syncData: keys.map((k) => avg(aggSync.get(k) ?? 0, reqsSync.get(k) ?? 0)),
    }
  }, [filtered, range, weekOffset])

  const switchRange = (r: LatencyRange) => {
    setRange(r)
    if (r !== "week") setWeekOffset(0)
  }
  const shiftWeek = (delta: number) => {
    setWeekOffset((w) => {
      const next = w + delta
      return next > 0 ? 0 : next
    })
  }

  return {
    range,
    weekOffset,
    model,
    models,
    loading,
    summary,
    byType,
    byColo,
    chart,
    reload,
    switchRange,
    shiftWeek,
    setModel,
    weekLabel: formatWeekLabel(weekOffset),
  }
}
