import { useCallback, useEffect, useMemo, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/usage"
import type { UsageRow } from "../api/usage"
import { buildTimeBuckets, utcHourToBucketKey } from "../components/TimeSeriesChart"

export type UsageRange = "today" | "week" | "7d" | "30d"
export type UsageMetric = "tokens" | "requests"

export interface UsageSummary {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUSD: number
}

export interface DistributionRow {
  label: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUSD: number
}

export interface UsageFilters {
  user: string
  key: string
  client: string
  model: string
}

// Compute UTC-hour bounds for the query, mirroring computeTimeRange in
// src/ui/dashboard/client.ts. Result strings are sliced to "YYYY-MM-DDTHH".
export function computeTimeRange(range: UsageRange, weekOffset: number): api.UsageRangeQuery {
  const now = new Date()
  let start: Date
  let end: Date
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
    if (range === "today") {
      start = todayLocal
    } else if (range === "7d") {
      start = new Date(todayLocal.getTime() - 6 * 86400000)
    } else {
      start = new Date(todayLocal.getTime() - 29 * 86400000)
    }
    end = new Date(now.getTime() + 3600000)
  }
  return { start: start.toISOString().slice(0, 13), end: end.toISOString().slice(0, 13) }
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
  const range = `${fmt(monday)} – ${fmt(sunday)}`
  if (weekOffset === 0) return `This week (${range})`
  if (weekOffset === -1) return `Last week (${range})`
  return range
}

function buildDistribution(
  rows: UsageRow[],
  keyFn: (r: UsageRow) => string,
  labelFn: (r: UsageRow, k: string) => string,
): DistributionRow[] {
  const m = new Map<string, DistributionRow>()
  for (const r of rows) {
    const k = keyFn(r)
    const req = r.requests ?? 0
    const inp = r.inputTokens ?? 0
    const out = r.outputTokens ?? 0
    const cr = r.cacheReadTokens ?? 0
    const cc = r.cacheCreationTokens ?? 0
    const cost = r.cost && typeof r.cost.totalUSD === "number" ? r.cost.totalUSD : 0
    const existing = m.get(k)
    if (existing) {
      existing.requests += req
      existing.input += inp
      existing.output += out
      existing.cacheRead += cr
      existing.cacheCreation += cc
      existing.costUSD += cost
    } else {
      m.set(k, {
        label: labelFn(r, k),
        requests: req,
        input: inp,
        output: out,
        cacheRead: cr,
        cacheCreation: cc,
        costUSD: cost,
      })
    }
  }
  return [...m.values()].sort((a, b) => {
    const totA = a.input + a.output + a.cacheRead + a.cacheCreation
    const totB = b.input + b.output + b.cacheRead + b.cacheCreation
    return totB - totA
  })
}

export interface UsageDimensions {
  keys: Array<{ id: string; name: string }>
  clients: string[]
  models: string[]
  users: Array<{ id: string; name: string }>
}

const EMPTY_SUMMARY: UsageSummary = {
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  costUSD: 0,
}

export function useUsage(isAdmin: boolean) {
  const { push: toast } = useToast()
  const [range, setRange] = useState<UsageRange>("today")
  const [weekOffset, setWeekOffset] = useState(0)
  const [metric, setMetric] = useState<UsageMetric>("tokens")
  const [filters, setFilters] = useState<UsageFilters>({ user: "", key: "", client: "", model: "" })
  const [data, setData] = useState<UsageRow[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const q = computeTimeRange(range, weekOffset)
      const rows = await api.fetchTokenUsage(q)
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

  // Derive available filter dimensions from the full unfiltered dataset.
  const dimensions: UsageDimensions = useMemo(() => {
    const keyNameMap = new Map<string, string>()
    const keySet = new Set<string>()
    const clientSet = new Set<string>()
    const modelSet = new Set<string>()
    const userMap = new Map<string, string>()
    for (const r of data) {
      keyNameMap.set(r.keyId, r.keyName ?? r.keyId.slice(0, 8))
      keySet.add(r.keyId)
      if (r.client) clientSet.add(r.client)
      if (r.model) modelSet.add(r.model)
      if (r.ownerId) userMap.set(r.ownerId, r.ownerName || r.ownerId.slice(0, 8))
    }
    return {
      keys: [...keySet]
        .map((id) => ({ id, name: keyNameMap.get(id) ?? id.slice(0, 8) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      clients: [...clientSet].sort(),
      models: [...modelSet].sort(),
      users: isAdmin
        ? [...userMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    }
  }, [data, isAdmin])

  // Apply filters before computing summary and distributions.
  const filtered = useMemo(() => {
    let rows = data
    if (filters.key) rows = rows.filter((r) => r.keyId === filters.key)
    if (filters.client) rows = rows.filter((r) => r.client === filters.client)
    if (filters.model) rows = rows.filter((r) => r.model === filters.model)
    if (filters.user) rows = rows.filter((r) => r.ownerId === filters.user)
    return rows
  }, [data, filters])

  const summary: UsageSummary = useMemo(() => {
    const s = { ...EMPTY_SUMMARY }
    for (const r of filtered) {
      s.requests += r.requests ?? 0
      s.input += r.inputTokens ?? 0
      s.output += r.outputTokens ?? 0
      s.cacheRead += r.cacheReadTokens ?? 0
      s.cacheCreation += r.cacheCreationTokens ?? 0
      if (r.cost && typeof r.cost.totalUSD === "number") s.costUSD += r.cost.totalUSD
    }
    return s
  }, [filtered])

  // Distribution rows are only shown along dimensions the user hasn't filtered
  // to a single value (matches legacy behavior in client.ts:1751–1767).
  const distributions = useMemo(() => {
    const keyNameMap = new Map<string, string>()
    for (const r of data) keyNameMap.set(r.keyId, r.keyName ?? r.keyId.slice(0, 8))
    return {
      byModel: !filters.model
        ? buildDistribution(filtered, (r) => r.model || "unknown", (_r, k) => k)
        : [],
      byKey: !filters.key
        ? buildDistribution(filtered, (r) => r.keyId, (r) => keyNameMap.get(r.keyId) ?? r.keyId.slice(0, 8))
        : [],
      byClient: !filters.client
        ? buildDistribution(filtered, (r) => r.client || "unknown", (_r, k) => k)
        : [],
      byUser:
        isAdmin && !filters.user
          ? buildDistribution(
              filtered,
              (r) => r.ownerId || "_admin",
              (r, k) => r.ownerName || (k === "_admin" ? "Admin" : k.slice(0, 8)),
            )
          : [],
    }
  }, [filtered, data, filters, isAdmin])

  // Chart series: group by the first un-filtered dimension (user > key > client > model).
  // When the metric is tokens, also emit a separate "Cache" line (dashed) showing cache traffic.
  const chart = useMemo(() => {
    const { keys, labels, isDaily } = buildTimeBuckets(range, weekOffset)
    const keyNameMap = new Map<string, string>()
    for (const r of data) keyNameMap.set(r.keyId, r.keyName ?? r.keyId.slice(0, 8))

    const allDims: Array<"user" | "key" | "client" | "model"> = []
    if (isAdmin && !filters.user) allDims.push("user")
    if (!filters.key) allDims.push("key")
    if (!filters.client) allDims.push("client")
    if (!filters.model) allDims.push("model")
    const groupBy = allDims[0] ?? "total"

    const seriesNames = new Map<string, string>()
    const agg = new Map<string, Map<string, number>>()
    const cacheAgg = new Map<string, number>()
    for (const k of keys) { agg.set(k, new Map()); cacheAgg.set(k, 0) }

    for (const r of filtered) {
      const bucket = utcHourToBucketKey(r.hour, isDaily)
      if (!agg.has(bucket)) continue
      let seriesKey: string
      if (groupBy === "user") {
        seriesKey = r.ownerId || "_admin"
        seriesNames.set(seriesKey, r.ownerName || (seriesKey === "_admin" ? "Admin" : seriesKey.slice(0, 8)))
      } else if (groupBy === "key") {
        seriesKey = r.keyId
        seriesNames.set(r.keyId, keyNameMap.get(r.keyId) ?? r.keyId.slice(0, 8))
      } else if (groupBy === "client") {
        seriesKey = r.client || "unknown"
        seriesNames.set(seriesKey, seriesKey)
      } else if (groupBy === "model") {
        seriesKey = r.model || "unknown"
        seriesNames.set(seriesKey, seriesKey)
      } else {
        seriesKey = "total"
        seriesNames.set("total", "Total")
      }
      const m = agg.get(bucket)!
      const cache = (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0)
      const value = metric === "requests" ? (r.requests ?? 0) : (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + cache
      m.set(seriesKey, (m.get(seriesKey) ?? 0) + value)
      if (metric === "tokens") cacheAgg.set(bucket, (cacheAgg.get(bucket) ?? 0) + cache)
    }

    const seriesList = [...seriesNames.keys()]
    const series = seriesList.map((sk) => ({
      label: seriesNames.get(sk) ?? sk,
      data: keys.map((k) => agg.get(k)?.get(sk) ?? 0),
    }))
    const cacheData = keys.map((k) => cacheAgg.get(k) ?? 0)
    const cacheHasData = metric === "tokens" && cacheData.some((v) => v > 0)

    return { labels, series, cacheData: cacheHasData ? cacheData : null }
  }, [filtered, data, range, weekOffset, metric, filters, isAdmin])

  const updateFilter = useCallback((patch: Partial<UsageFilters>) => {
    setFilters((cur) => ({ ...cur, ...patch }))
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({ user: "", key: "", client: "", model: "" })
  }, [])

  const switchRange = useCallback((r: UsageRange) => {
    setRange(r)
    if (r !== "week") setWeekOffset(0)
  }, [])

  const shiftWeek = useCallback((delta: number) => {
    setWeekOffset((cur) => {
      const next = cur + delta
      return next > 0 ? 0 : next
    })
  }, [])

  return {
    range,
    weekOffset,
    metric,
    filters,
    data,
    loading,
    dimensions,
    summary,
    distributions,
    chart,
    reload,
    setMetric,
    switchRange,
    shiftWeek,
    updateFilter,
    clearFilters,
  }
}
