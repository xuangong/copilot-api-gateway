import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useToast } from "./toast"
import { useT } from "./i18n"
import * as api from "../api/usage"
import type { ParticipantRow, UsageRow } from "../api/usage"
import {
  buildDimensions,
  indexParticipants,
  usageAttribution,
  type KeyDimension,
} from "../tabs/usage/participants"
import {
  buildTimeBuckets,
  dayStart,
  monthStart,
  parseDateKey,
  utcHourToBucketKey,
  TRAILING_WINDOW_DAYS,
} from "./time-buckets"
import { useZoneMode, zoneOps, type TimeZoneMode } from "./timezone"
import { buildRollingStrip, computeStripRange, stripLastDay, type DailyTotal, type RollingStripCell } from "./usage-strip"
import {
  buildDistribution,
  buildIncomingModelDistribution,
  buildRoutedModelDistribution,
  filterUsageRows,
} from "./usage-model-dimensions"
import { buildUsageChartSeries, chartGrouping, type ModelKind } from "./usage-chart"

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
  /** Stable identity, distinct from the display label when names collide. */
  id: string
  label: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUSD: number
  /** Present only for incoming-model rows. */
  routedModels?: string[]
}

export interface UsageFilters {
  user: string
  key: string
  client: string
  /** Routed model. */
  model: string
  /** null is all incoming models. */
  incomingModel: string | null
}

// Compute UTC-hour bounds for the query, mirroring computeTimeRange in
// src/ui/dashboard/client.ts. Result strings are sliced to "YYYY-MM-DDTHH".
// "today", "week" and "month" are calendar windows in the zone `mode` names,
// shifted back by `periodOffset` whole periods; 28d is a trailing window ending
// now and has no period to step through, so it ignores the offset.
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
  now: Date,
  endDate: string | null | undefined,
  mode: TimeZoneMode,
): api.UsageRangeQuery {
  const ops = zoneOps(mode)
  let start: Date
  let end: Date
  if (range === "week") {
    const ref = ops.make(ops.year(now), ops.month(now), ops.day(now) + periodOffset * 7)
    const monday = ops.make(ops.year(ref), ops.month(ref), ops.day(ref) - ((ops.weekday(ref) + 6) % 7))
    start = monday
    end = ops.make(ops.year(monday), ops.month(monday), ops.day(monday) + 7)
  } else if (range === "month") {
    start = monthStart(now, periodOffset, ops)
    end = monthStart(now, periodOffset + 1, ops)
  } else {
    if (range === "today") {
      // A whole calendar day, so stepping back lands on that day rather than
      // on "midnight-to-now" of a day that has long since ended.
      start = dayStart(now, periodOffset, ops)
      end = dayStart(now, periodOffset + 1, ops)
      return { start: start.toISOString().slice(0, 13), end: end.toISOString().slice(0, 13) }
    }
    const days = TRAILING_WINDOW_DAYS[range]
    const pinned = parseDateKey(endDate, ops)
    if (pinned) {
      // Counted in calendar days, not milliseconds: a DST shift would
      // otherwise leave the window an hour short of its last day. The picked
      // day is inside the window, so the query runs to the midnight after it.
      start = ops.make(ops.year(pinned), ops.month(pinned), ops.day(pinned) - (days - 1))
      end = ops.make(ops.year(pinned), ops.month(pinned), ops.day(pinned) + 1)
    } else {
      start = dayStart(now, -(days - 1), ops)
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
  // than used to reject an otherwise usable entry. Validated on the UTC
  // calendar because the question here is only "is this a real date" — the
  // answer is the same in every zone, and UTC keeps it independent of the
  // preference in force when the entry was pushed.
  const day = typeof endDate === "string" && parseDateKey(endDate, zoneOps("utc")) ? endDate : null
  return { range: range as UsageRange, periodOffset, endDate: day }
}

export function dayOffsetFromKey(dateKey: string, now: Date, mode: TimeZoneMode): number {
  const ops = zoneOps(mode)
  const [y, m, d] = dateKey.split("-").map(Number)
  // Noon, not midnight: a DST jump moves midnight but never crosses noon, so
  // the difference still divides into whole days.
  const target = ops.make(y!, m! - 1, d!, 12)
  const today = ops.make(ops.year(now), ops.month(now), ops.day(now), 12)
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}

export function formatDayLabel(periodOffset: number, now: Date, mode: TimeZoneMode): string {
  const ops = zoneOps(mode)
  const day = dayStart(now, periodOffset, ops)
  const short = day.toLocaleDateString("en-US", { month: "short", day: "numeric", ...ops.fmt })
  if (periodOffset === 0) return `Today (${short})`
  if (periodOffset === -1) return `Yesterday (${short})`
  return day.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...ops.fmt })
}

export function formatWeekLabel(periodOffset: number, now: Date, mode: TimeZoneMode): string {
  const ops = zoneOps(mode)
  const ref = ops.make(ops.year(now), ops.month(now), ops.day(now) + periodOffset * 7)
  const monday = ops.make(ops.year(ref), ops.month(ref), ops.day(ref) - ((ops.weekday(ref) + 6) % 7))
  const sunday = ops.make(ops.year(monday), ops.month(monday), ops.day(monday) + 6)
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...ops.fmt })
  const range = `${fmt(monday)} – ${fmt(sunday)}`
  if (periodOffset === 0) return `This week (${range})`
  if (periodOffset === -1) return `Last week (${range})`
  return range
}

export function formatMonthLabel(periodOffset: number, now: Date, mode: TimeZoneMode): string {
  const ops = zoneOps(mode)
  const first = monthStart(now, periodOffset, ops)
  const name = first.toLocaleDateString("en-US", { month: "long", year: "numeric", ...ops.fmt })
  if (periodOffset === 0) return `This month (${name})`
  if (periodOffset === -1) return `Last month (${name})`
  return name
}

export interface UsageDimensions {
  keys: KeyDimension[]
  clients: string[]
  /** Routed models. */
  models: string[]
  incomingModels: string[]
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
  const t = useT()
  // Every window boundary below is drawn on this clock. Flipping it has to
  // refetch as well as re-bucket: the query bounds move with it.
  const mode = useZoneMode()
  // Switching tabs unmounts this tab, so without seeding from history a back
  // navigation would land on an entry that claims a particular day while the
  // UI silently reset to today.
  const restored = typeof window === "undefined" ? null : usageViewFromHistoryState(window.history.state)
  const [range, setRange] = useState<UsageRange>(restored?.range ?? "today")
  const [periodOffset, setPeriodOffset] = useState(restored?.periodOffset ?? 0)
  const [endDate, setEndDate] = useState<string | null>(restored?.endDate ?? null)
  const [metric, setMetric] = useState<UsageMetric>("tokens")
  // Shared by the trend chart and the model distribution table, so the two
  // always count a row under the same model.
  const [modelKind, setModelKind] = useState<ModelKind>("routed")
  const [filters, setFilters] = useState<UsageFilters>({ user: "", key: "", client: "", model: "", incomingModel: null })
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
  // When the numbers on screen were last known to be true. Drives the "updated
  // N ago" line, and is the clock the auto-refresh cadence is measured from.
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  // Bumped by an explicit refresh to make the strip refetch. Its own effect is
  // keyed on the range, which hasn't changed, so without this the strip would
  // sit on its cached rows while everything around it updated.
  const [refreshNonce, setRefreshNonce] = useState(0)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const q = computeTimeRange(range, periodOffset, new Date(), endDate, mode)
      const [rows, people] = await Promise.all([
        api.fetchTokenUsage(q),
        api.fetchUsageParticipants(),
      ])
      setData(rows)
      setParticipantRows(people)
      setLastUpdated(Date.now())
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoading(false)
    }
  }, [range, periodOffset, endDate, mode, toast])

  useEffect(() => {
    reload()
  }, [reload])

  /**
   * What the refresh button and the auto-refresh timer call.
   *
   * Distinct from `reload` because it also drops the strip's cached rows: a
   * control labelled "refresh" that quietly left a third of the page on
   * yesterday's numbers would be worse than no control at all. `reload` stays
   * as-is for the range and clock changes, which already refetch what they
   * need and shouldn't pay for a strip refetch on every click.
   */
  const refresh = useCallback(() => {
    stripCache.current.clear()
    setRefreshNonce((n) => n + 1)
    void reload()
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
    const q = computeStripRange(new Date(), zoneOps(mode))
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
  }, [range, mode, refreshNonce])

  const participants = useMemo(() => indexParticipants(participantRows), [participantRows])

  // Derive available filter dimensions from the full unfiltered dataset. The
  // dropdowns are independent of one another; the user list now includes
  // everyone a listed key is shared with, not just its owner.
  const dimensions: UsageDimensions = useMemo(() => {
    const clientSet = new Set<string>()
    const modelSet = new Set<string>()
    const incomingModelSet = new Set<string>()
    for (const r of data) {
      if (r.client) clientSet.add(r.client)
      if (r.model) modelSet.add(r.model)
      incomingModelSet.add(r.incomingModel)
    }
    const { keys, users, sharedInScope } = buildDimensions({ rows: data, participants, isAdmin })
    return {
      keys,
      users,
      sharedInScope,
      clients: [...clientSet].sort(),
      models: [...modelSet].sort(),
      incomingModels: [...incomingModelSet].sort(),
    }
  }, [data, participants, isAdmin])

  // Apply filters before computing summary and distributions.
  const filtered = useMemo(() => filterUsageRows(data, filters, participants), [data, filters, participants])

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
      byRoutedModel: !filters.model
        ? buildRoutedModelDistribution(filtered, t("dash.unknown"))
        : [],
      byIncomingModel: filters.incomingModel === null
        ? buildIncomingModelDistribution(filtered, t("dash.unknown"))
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
  }, [filtered, data, filters, isAdmin, participants, t])

  // One line per person until an admin picks one, then one per model (see
  // usage-chart.ts). Per-person token lines get a dashed "Cache" line for the
  // cache traffic inside them; per-model lines carry their own cache in the
  // tooltip instead, because a cache total across models adds up nothing.
  // Worked out before the memo so the per-user chart is not rebuilt when the
  // routed/incoming switch — which only concerns per-model lines — changes.
  const grouping = chartGrouping(isAdmin, filters.user)
  const chartModelKind: ModelKind = grouping === "model" ? modelKind : "routed"
  const chart = useMemo(() => {
    const ops = zoneOps(mode)
    const { keys, labels, isDaily } = buildTimeBuckets(range, periodOffset, new Date(), endDate, mode)
    const series = buildUsageChartSeries({
      rows: filtered,
      bucketKeys: keys,
      bucketOf: (r) => utcHourToBucketKey(r.hour, isDaily, ops),
      grouping,
      modelKind: chartModelKind,
      metric,
      person: (r) => usageAttribution(participants, r.keyId),
      unknownLabel: t("dash.unknown"),
    })
    const cacheData = keys.map((_, i) => series.reduce((sum, s) => sum + (s.cache[i] ?? 0), 0))
    const cacheHasData = grouping === "user" && metric === "tokens" && cacheData.some((v) => v > 0)
    return { labels, series, grouping, cacheData: cacheHasData ? cacheData : null, bucketKeys: keys, isDaily }
  }, [filtered, range, periodOffset, endDate, metric, grouping, participants, mode, chartModelKind, t])

  // One square per closing day, each holding that day's trailing 28-day totals.
  // Built from its own wider fetch, filtered the same way as the window rows.
  //
  // Both dimensions are carried, and neither depends on the selected metric: the
  // square is coloured by cost and the hover reads out cost *and* tokens, so
  // toggling tokens/requests must not throw this work away.
  const strip = useMemo<RollingStripCell[]>(() => {
    if (range !== "28d" || stripRows.length === 0) return []
    const ops = zoneOps(mode)
    const daily = new Map<string, DailyTotal>()
    for (const r of filterUsageRows(stripRows, filters, participants)) {
      const day = utcHourToBucketKey(r.hour, true, ops)
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
    return buildRollingStrip(daily, stripLastDay(new Date(), ops), ops)
  }, [range, stripRows, filters, participants, mode])

  const updateFilter = useCallback((patch: Partial<UsageFilters>) => {
    setFilters((cur) => ({ ...cur, ...patch }))
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({ user: "", key: "", client: "", model: "", incomingModel: null })
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
    // Validated on the UTC calendar for the same reason as in
    // usageViewFromHistoryState: this only asks whether the date exists.
    setEndDate(day && parseDateKey(day, zoneOps("utc")) ? day : null)
  }, [])

  // Pushes a history entry so the back button undoes the jump. Only this
  // action does — the range buttons and the ‹ › arrows are ordinary controls,
  // and turning every click of them into a history entry would make going back
  // a chore.
  const openDay = useCallback((dateKey: string) => {
    const next: UsageView = {
      range: "today",
      periodOffset: Math.min(0, dayOffsetFromKey(dateKey, new Date(), mode)),
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
  }, [mode])

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
    modelKind,
    filters,
    data,
    loading,
    lastUpdated,
    dimensions,
    summary,
    distributions,
    chart,
    strip,
    reload,
    refresh,
    setMetric,
    setModelKind,
    switchRange,
    chooseEndDate,
    shiftPeriod,
    updateFilter,
    clearFilters,
    openDay,
  }
}
