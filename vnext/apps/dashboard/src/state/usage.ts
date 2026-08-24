import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/usage"
import type { ParticipantRow, UsageRow } from "../api/usage"
import {
  buildDimensions,
  indexParticipants,
  rowMatchesUser,
  usageAttribution,
  type KeyDimension,
} from "../tabs/usage/participants"
import {
  buildTimeBuckets,
  localDayStart,
  localMonthStart,
  parseLocalDateKey,
  utcHourToBucketKey,
  TRAILING_WINDOW_DAYS,
} from "../components/TimeSeriesChart"
import { buildRollingStrip, computeStripRange, stripLastDay, type DailyTotal, type RollingStripCell } from "./usage-strip"

export type UsageRange = "today" | "week" | "28d" | "month"
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
// "today", "week" and "month" are calendar windows in *local* time, shifted
// back by `periodOffset` whole periods; 28d is a trailing window ending now
// and has no period to step through, so it ignores the offset.
//
// 28d instead accepts an `endDate` ("YYYY-MM-DD"): given one it becomes a
// fixed 28-day window whose *last* day is that date, which is how the user
// picks a span that does not end today. An unparseable value falls back to
// trailing.
//
// `now` is injectable so the range maths can be tested against a fixed clock.
export function computeTimeRange(
  range: UsageRange,
  periodOffset: number,
  now: Date = new Date(),
  endDate?: string | null,
): api.UsageRangeQuery {
  let start: Date
  let end: Date
  if (range === "week") {
    const ref = new Date(now)
    ref.setDate(ref.getDate() + periodOffset * 7)
    const day = ref.getDay()
    const monday = new Date(ref)
    monday.setDate(ref.getDate() - ((day + 6) % 7))
    monday.setHours(0, 0, 0, 0)
    start = monday
    end = new Date(monday.getTime() + 7 * 86400000)
  } else if (range === "month") {
    start = localMonthStart(now, periodOffset)
    end = localMonthStart(now, periodOffset + 1)
  } else {
    if (range === "today") {
      // A whole calendar day, so stepping back lands on that day rather than
      // on "midnight-to-now" of a day that has long since ended.
      start = localDayStart(now, periodOffset)
      end = localDayStart(now, periodOffset + 1)
      return { start: start.toISOString().slice(0, 13), end: end.toISOString().slice(0, 13) }
    }
    const days = TRAILING_WINDOW_DAYS[range]
    const pinned = parseLocalDateKey(endDate)
    if (pinned) {
      // Counted in calendar days, not milliseconds: a DST shift would
      // otherwise leave the window an hour short of its last day. The picked
      // day is inside the window, so the query runs to the midnight after it.
      start = new Date(pinned.getFullYear(), pinned.getMonth(), pinned.getDate() - (days - 1), 0, 0, 0, 0)
      end = new Date(pinned.getFullYear(), pinned.getMonth(), pinned.getDate() + 1, 0, 0, 0, 0)
    } else {
      start = localDayStart(now, -(days - 1))
      end = new Date(now.getTime() + 3600000)
    }
  }
  return { start: start.toISOString().slice(0, 13), end: end.toISOString().slice(0, 13) }
}

/**
 * Turn a daily bucket key ("YYYY-MM-DD") back into the `periodOffset` that
 * selects it in the "today" range, so clicking a day in the week/month chart
 * can open that day.
 *
 * Counted in calendar days rather than elapsed milliseconds: a DST shift makes
 * a local day 23 or 25 hours long, and dividing by 86400000 would land on the
 * wrong date.
 */
/** The part of the Usage view that "View this day" moves, and back restores. */
export interface UsageView {
  range: UsageRange
  periodOffset: number
  /** Only 28d carries one; null means the trailing window ending today. */
  endDate: string | null
}

const USAGE_RANGES: readonly string[] = ["today", "week", "28d", "month"]

/**
 * Validate a `popstate` state object before acting on it. History state
 * survives reloads and other code on the page pushes its own entries, so
 * anything that is not recognisably ours is ignored rather than trusted.
 */
export function usageViewFromHistoryState(state: unknown): UsageView | null {
  if (typeof state !== "object" || state === null) return null
  const view = (state as { usageView?: unknown }).usageView
  if (typeof view !== "object" || view === null) return null
  const { range, periodOffset, endDate } = view as {
    range?: unknown
    periodOffset?: unknown
    endDate?: unknown
  }
  if (typeof range !== "string" || !USAGE_RANGES.includes(range)) return null
  // A positive offset asks for a period that has not happened; a fractional one
  // lands between days. Neither is reachable through the UI.
  if (typeof periodOffset !== "number" || !Number.isInteger(periodOffset) || periodOffset > 0) return null
  // A bad end date only costs the pinned window, so it is dropped rather
  // than used to reject an otherwise usable entry.
  const day = typeof endDate === "string" && parseLocalDateKey(endDate) ? endDate : null
  return { range: range as UsageRange, periodOffset, endDate: day }
}

export function dayOffsetFromKey(dateKey: string, now: Date = new Date()): number {
  const [y, m, d] = dateKey.split("-").map(Number)
  const target = new Date(y!, m! - 1, d!, 12, 0, 0, 0)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}

export function formatDayLabel(periodOffset: number, now: Date = new Date()): string {
  const day = localDayStart(now, periodOffset)
  if (periodOffset === 0) return `Today (${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
  if (periodOffset === -1) return `Yesterday (${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
  return day.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function formatWeekLabel(periodOffset: number, now: Date = new Date()): string {
  const ref = new Date(now)
  ref.setDate(ref.getDate() + periodOffset * 7)
  const day = ref.getDay()
  const monday = new Date(ref)
  monday.setDate(ref.getDate() - ((day + 6) % 7))
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday.getTime() + 6 * 86400000)
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const range = `${fmt(monday)} – ${fmt(sunday)}`
  if (periodOffset === 0) return `This week (${range})`
  if (periodOffset === -1) return `Last week (${range})`
  return range
}

export function formatMonthLabel(periodOffset: number, now: Date = new Date()): string {
  const first = localMonthStart(now, periodOffset)
  const name = first.toLocaleDateString("en-US", { month: "long", year: "numeric" })
  if (periodOffset === 0) return `This month (${name})`
  if (periodOffset === -1) return `Last month (${name})`
  return name
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
  keys: KeyDimension[]
  clients: string[]
  models: string[]
  users: Array<{ id: string; name: string }>
  /**
   * True when a listed key is shared. Usage is recorded per key only, so a
   * shared key's traffic counts in full for every user who can reach it —
   * the UI has to say so rather than imply a per-person split.
   */
  sharedInScope: boolean
}

const EMPTY_SUMMARY: UsageSummary = {
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  costUSD: 0,
}

/**
 * The dimension filters, applied client-side. Shared by the window rows and the
 * strip's wider history so a filtered view never shows an unfiltered trend.
 */
function applyFilters(
  rows: UsageRow[],
  filters: UsageFilters,
  participants: ReturnType<typeof indexParticipants>,
): UsageRow[] {
  let out = rows
  if (filters.key) out = out.filter((r) => r.keyId === filters.key)
  if (filters.client) out = out.filter((r) => r.client === filters.client)
  if (filters.model) out = out.filter((r) => r.model === filters.model)
  if (filters.user) out = out.filter((r) => rowMatchesUser(participants, r.keyId, filters.user))
  return out
}

/** Every token a row accounts for, cache included. */
function rowTokens(r: UsageRow): number {
  return (
    (r.inputTokens ?? 0) +
    (r.outputTokens ?? 0) +
    (r.cacheReadTokens ?? 0) +
    (r.cacheCreationTokens ?? 0)
  )
}

/**
 * The strip's fetch spans 117 days of hourly rows — about four times the main
 * query — so re-fetching it on every trip in and out of the 28d range would make
 * the strip painful to use for exactly the browsing it exists to support. Small,
 * because the span only changes when the calendar day rolls over.
 */
const STRIP_CACHE_LIMIT = 4
type StripCache = Map<string, UsageRow[]>

function cacheGet(cache: StripCache, key: string): UsageRow[] | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  // Re-insert so the least recently *used* entry is the one evicted, not the
  // least recently fetched — the user tends to revisit days they just looked at.
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cachePut(cache: StripCache, key: string, rows: UsageRow[]): void {
  cache.delete(key)
  cache.set(key, rows)
  while (cache.size > STRIP_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

export function useUsage(isAdmin: boolean) {
  const { push: toast } = useToast()
  // Switching tabs unmounts this tab, so without seeding from history a back
  // navigation would land on an entry that claims a particular day while the
  // UI silently reset to today.
  const restored = typeof window === "undefined" ? null : usageViewFromHistoryState(window.history.state)
  const [range, setRange] = useState<UsageRange>(restored?.range ?? "today")
  const [periodOffset, setPeriodOffset] = useState(restored?.periodOffset ?? 0)
  const [endDate, setEndDate] = useState<string | null>(restored?.endDate ?? null)
  const [metric, setMetric] = useState<UsageMetric>("tokens")
  const [filters, setFilters] = useState<UsageFilters>({ user: "", key: "", client: "", model: "" })
  const [data, setData] = useState<UsageRow[]>([])
  const [participantRows, setParticipantRows] = useState<ParticipantRow[]>([])
  const [stripRows, setStripRows] = useState<UsageRow[]>([])
  // Held in a ref, not state: filling it must never itself cause a render.
  const stripCache = useRef<StripCache>(new Map())
  const rangeRef = useRef(range)
  const offsetRef = useRef(periodOffset)
  const endDateRef = useRef(endDate)
  rangeRef.current = range
  offsetRef.current = periodOffset
  endDateRef.current = endDate
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const q = computeTimeRange(range, periodOffset, new Date(), endDate)
      const [rows, people] = await Promise.all([
        api.fetchTokenUsage(q),
        api.fetchUsageParticipants(),
      ])
      setData(rows)
      setParticipantRows(people)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoading(false)
    }
  }, [range, periodOffset, endDate, toast])

  useEffect(() => {
    reload()
  }, [reload])

  // The strip's own fetch. It spans 117 days — every one of the 90 squares is
  // itself a 28-day total — which is exactly why it cannot share the main query:
  // the summary cards and the distribution tables sum every row they are handed.
  //
  // Deliberately not keyed on endDate. The strip is a fixed run of days ending
  // today; picking a square moves the window drawn below it, never the strip
  // itself. Refetching per selection would both shuffle the squares under the
  // cursor and miss the cache on every click.
  useEffect(() => {
    if (range !== "28d") {
      setStripRows([])
      return
    }
    const q = computeStripRange(new Date())
    const key = `${q.start}|${q.end}`
    // Served straight from cache whenever the user comes back to the 28d range,
    // which is the common move once the strip is on screen.
    const hit = cacheGet(stripCache.current, key)
    if (hit) {
      setStripRows(hit)
      return
    }
    let cancelled = false
    api
      .fetchTokenUsage(q)
      .then((rows) => {
        cachePut(stripCache.current, key, rows)
        if (!cancelled) setStripRows(rows)
      })
      // Silent: the strip is a secondary read, and the main query has already
      // surfaced whatever is wrong with the connection.
      .catch(() => {
        if (!cancelled) setStripRows([])
      })
    return () => {
      cancelled = true
    }
  }, [range])

  const participants = useMemo(() => indexParticipants(participantRows), [participantRows])

  // Derive available filter dimensions from the full unfiltered dataset. The
  // dropdowns are independent of one another; the user list now includes
  // everyone a listed key is shared with, not just its owner.
  const dimensions: UsageDimensions = useMemo(() => {
    const clientSet = new Set<string>()
    const modelSet = new Set<string>()
    for (const r of data) {
      if (r.client) clientSet.add(r.client)
      if (r.model) modelSet.add(r.model)
    }
    const { keys, users, sharedInScope } = buildDimensions({ rows: data, participants, isAdmin })
    return { keys, users, sharedInScope, clients: [...clientSet].sort(), models: [...modelSet].sort() }
  }, [data, participants, isAdmin])

  // Apply filters before computing summary and distributions.
  const filtered = useMemo(() => applyFilters(data, filters, participants), [data, filters, participants])

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
      // Attribution, not ownership: a shared key names everyone who could have
      // used it, because usage is recorded per key and never per person.
      byUser:
        isAdmin && !filters.user
          ? buildDistribution(
              filtered,
              (r) => usageAttribution(participants, r.keyId).id,
              (r) => usageAttribution(participants, r.keyId).label,
            )
          : [],
    }
  }, [filtered, data, filters, isAdmin, participants])

  // Chart series: group by the first un-filtered dimension (user > key > client > model).
  // When the metric is tokens, also emit a separate "Cache" line (dashed) showing cache traffic.
  const chart = useMemo(() => {
    const { keys, labels, isDaily } = buildTimeBuckets(range, periodOffset, new Date(), endDate)
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
        const who = usageAttribution(participants, r.keyId)
        seriesKey = who.id
        seriesNames.set(seriesKey, who.label)
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

    return { labels, series, cacheData: cacheHasData ? cacheData : null, bucketKeys: keys, isDaily }
  }, [filtered, data, range, periodOffset, endDate, metric, filters, isAdmin, participants])

  // One square per closing day, each holding that day's trailing 28-day totals.
  // Built from its own wider fetch, filtered the same way as the window rows.
  //
  // Both dimensions are carried, and neither depends on the selected metric: the
  // square is coloured by cost and the hover reads out cost *and* tokens, so
  // toggling tokens/requests must not throw this work away.
  const strip = useMemo<RollingStripCell[]>(() => {
    if (range !== "28d" || stripRows.length === 0) return []
    const daily = new Map<string, DailyTotal>()
    for (const r of applyFilters(stripRows, filters, participants)) {
      const day = utcHourToBucketKey(r.hour, true)
      const acc = daily.get(day)
      const cost = r.cost?.totalUSD ?? 0
      const tokens = rowTokens(r)
      if (acc) {
        acc.cost += cost
        acc.tokens += tokens
      } else {
        daily.set(day, { cost, tokens })
      }
    }
    // Always ends today, matching the span that was fetched. The selection is
    // drawn as a ring on whichever square already holds that day; it does not
    // move the squares.
    return buildRollingStrip(daily, stripLastDay())
  }, [range, stripRows, filters, participants])

  const updateFilter = useCallback((patch: Partial<UsageFilters>) => {
    setFilters((cur) => ({ ...cur, ...patch }))
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({ user: "", key: "", client: "", model: "" })
  }, [])

  // The offset only means something for the calendar ranges, and a week offset
  // is not a month offset — reset whenever we leave or switch between them.
  const switchRange = useCallback((r: UsageRange) => {
    if (r !== range) setPeriodOffset(0)
    // A pinned end belongs to 28d alone; carrying it out of that range would
    // leave it set but invisible, so returning would silently re-apply it.
    if (r !== "28d") setEndDate(null)
    setRange(r)
  }, [range])

  /**
   * Pin the 28-day window to a chosen last day. `null` restores the trailing
   * window ending today.
   */
  const chooseEndDate = useCallback((day: string | null) => {
    setEndDate(day && parseLocalDateKey(day) ? day : null)
  }, [])

  // Pushes a history entry so the back button undoes the jump. Only this
  // action does — the range buttons and the ‹ › arrows are ordinary controls,
  // and turning every click of them into a history entry would make going back
  // a chore.
  const openDay = useCallback((dateKey: string) => {
    const next: UsageView = {
      range: "today",
      periodOffset: Math.min(0, dayOffsetFromKey(dateKey)),
      endDate: null,
    }
    // Stamp the entry we are leaving first, so going back has somewhere to
    // return to; the URL is unchanged, only the entry is added.
    const here: UsageView = {
      range: rangeRef.current,
      periodOffset: offsetRef.current,
      endDate: endDateRef.current,
    }
    window.history.replaceState({ ...window.history.state, usageView: here }, "", window.location.href)
    window.history.pushState({ ...window.history.state, usageView: next }, "", window.location.href)
    setRange(next.range)
    setPeriodOffset(next.periodOffset)
    setEndDate(null)
  }, [])

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const view = usageViewFromHistoryState(e.state)
      if (!view) return
      setRange(view.range)
      setPeriodOffset(view.periodOffset)
      setEndDate(view.endDate)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const shiftPeriod = useCallback((delta: number) => {
    setPeriodOffset((cur) => {
      const next = cur + delta
      return next > 0 ? 0 : next
    })
  }, [])

  return {
    range,
    periodOffset,
    endDate,
    metric,
    filters,
    data,
    loading,
    dimensions,
    summary,
    distributions,
    chart,
    strip,
    reload,
    setMetric,
    switchRange,
    chooseEndDate,
    shiftPeriod,
    updateFilter,
    clearFilters,
    openDay,
  }
}
