import { Hono } from "hono"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { UserId } from "../../repo/branded-ids"
import type { TelemetryDimFilter, TelemetrySourceRecord } from "../../repo/telemetry"
import type { FullAuthCtx } from "../../shared/credential-auth"
import {
  DAY, HOUR, MAX_SURGE_METRICS, SURGE_BASELINE_HOURS, SURGE_WINDOW_HOURS, buildSeries, buildTop, checkStatuses, costOf, dropPartialHour, failMetricOf, findSurges,
  floorDay, floorHour, freshness, latestCheck, monthStart, nonZeroFlags, projectMonth, selectSurges, stageOf, type Surge,
} from "./analysis"
import { TelemetryError, telemetryClock, telemetryFailure, telemetryJson } from "./common"
import { DIM_KEY_PATTERN, formatHour, isMetricName, parseWindow, settingsOf } from "./protocol"
import { ownedSource } from "./sources"

export const telemetryQueriesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const bad = () => new TelemetryError("invalid_request", 400)
type Query = (name: string) => string | undefined

function metricParam(query: Query): string {
  const metric = query("metric")
  if (!isMetricName(metric)) throw bad()
  return metric
}

function groupByParam(query: Query): string | undefined {
  const value = query("groupBy")
  if (value === undefined || value === "") return undefined
  if (!DIM_KEY_PATTERN.test(value)) throw bad()
  return value
}

/** `filter=<dimKey>:<value>`, split at the first colon; the dim must differ from `groupBy`. */
function filterParam(query: Query, groupBy: string | undefined): TelemetryDimFilter | undefined {
  const raw = query("filter")
  if (raw === undefined || raw === "") return undefined
  const colon = raw.indexOf(":")
  if (colon < 0) throw bad()
  const key = raw.slice(0, colon)
  const value = raw.slice(colon + 1)
  if (!DIM_KEY_PATTERN.test(key) || value.length < 1 || value.length > 256 || key === groupBy) throw bad()
  return { key, value }
}

function intParam(query: Query, name: string, fallback: number, min: number, max: number): number {
  const raw = query(name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw bad()
  const value = Number(raw)
  if (value < min || value > max) throw bad()
  return value
}

const sourceOf = (ownerId: unknown, id: string) => ownedSource(ownerId as UserId, id)

telemetryQueriesRouter.get("/sources/:id/metrics", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    const since = floorHour(Math.floor(telemetryClock.now() / 1000)) - 30 * DAY
    const metrics = await getRepo().telemetry.listMetrics(source.id, since)
    return telemetryJson({ metrics: metrics.map(m => ({ metric: m.metric, unit: m.unit, firstHour: formatHour(m.firstHour), lastHour: formatHour(m.lastHour), dims: m.dimKeys })) })
  } catch (error) { return telemetryFailure(error) }
})

telemetryQueriesRouter.get("/sources/:id/series", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    const query: Query = name => c.req.query(name)
    const nowSec = Math.floor(telemetryClock.now() / 1000)
    const window = parseWindow(query("from"), query("to"), nowSec)
    const metric = metricParam(query)
    const groupBy = groupByParam(query)
    const filter = filterParam(query, groupBy)
    const top = intParam(query, "top", 10, 1, 20)
    const repo = getRepo().telemetry
    const settings = settingsOf(source)

    // The hourly rollup has no dims, so a filtered total sums the matching point rows instead.
    const totals = filter === undefined ? await repo.hourlyTotals(source.id, [metric], window.from, window.to)
      : await repo.filteredHourlyTotals(source.id, metric, filter, window.from, window.to)
    let groups: Awaited<ReturnType<typeof repo.groupHours>> = []
    if (groupBy !== undefined) {
      const ranked = await repo.rankGroups(source.id, metric, groupBy, window.from, window.to, top, filter)
      groups = await repo.groupHours(source.id, metric, groupBy, window.from, window.to, ranked.map(group => group.key), filter)
    }
    const built = buildSeries(window, totals, groups)
    const body: Record<string, unknown> = {
      metric, unit: totals[0]?.unit ?? null, from: formatHour(window.from), to: formatHour(window.to),
      hours: built.hours.map(formatHour), total: built.total, groups: built.groups,
    }
    if (filter !== undefined) body.filter = filter
    if ((settings.checkMetrics ?? []).includes(metric)) {
      const statuses = checkStatuses(built.hours, totals, await repo.firstHour(source.id, metric))
      const failMetric = failMetricOf(metric)
      const rows = failMetric !== null && (settings.flagNonZeroMetrics ?? []).includes(failMetric)
        ? dropPartialHour(await repo.nonZeroRows(source.id, [failMetric], window.from, window.to, FLAG_ROW_LIMIT), FLAG_ROW_LIMIT) : []
      const flags = nonZeroFlags(rows, 2200)
      body.statuses = statuses
      body.stages = built.hours.map((hour, index) => statuses[index] === "failed" ? stageOf(flags, metric, hour) : null)
    }
    return telemetryJson(body)
  } catch (error) { return telemetryFailure(error) }
})

telemetryQueriesRouter.get("/sources/:id/top", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    const query: Query = name => c.req.query(name)
    const window = parseWindow(query("from"), query("to"), Math.floor(telemetryClock.now() / 1000))
    const metric = metricParam(query)
    const groupBy = groupByParam(query)
    if (groupBy === undefined) throw bad()
    const filter = filterParam(query, groupBy)
    const limit = intParam(query, "limit", 20, 1, 100)
    const repo = getRepo().telemetry
    const length = window.to - window.from
    const current = await repo.topGroups(source.id, metric, groupBy, window.from, window.to, limit, filter)
    const previous = await repo.groupTotals(source.id, metric, groupBy, window.from - length, window.from, current.groups.map(group => group.key), filter)
    const first = (await repo.firstHours(source.id, [metric])).get(metric)
    const comparable = first !== undefined && first <= window.from - length
    const top = buildTop(current.total, current.groups, previous, comparable)
    return telemetryJson({
      metric, unit: current.unit, groupBy, ...(filter === undefined ? {} : { filter }), from: formatHour(window.from), to: formatHour(window.to),
      previousFrom: formatHour(window.from - length), previousTo: formatHour(window.from), comparable,
      total: top.total, rows: top.rows, otherCurrent: top.otherCurrent, otherShare: top.otherShare,
    })
  } catch (error) { return telemetryFailure(error) }
})

const FLAG_ROW_LIMIT = 5000

async function summarize(source: TelemetrySourceRecord, nowMs: number) {
  const repo = getRepo().telemetry
  const settings = settingsOf(source)
  const nowSec = Math.floor(nowMs / 1000)
  const nowHour = floorHour(nowSec)
  const windowStart = nowHour - (SURGE_WINDOW_HOURS - 1) * HOUR
  const windowEnd = nowHour + HOUR

  const flagMetrics = settings.flagNonZeroMetrics ?? []
  const flags = nonZeroFlags(dropPartialHour(await repo.nonZeroRows(source.id, flagMetrics, windowStart, windowEnd, FLAG_ROW_LIMIT), FLAG_ROW_LIMIT))

  const checkMetrics = settings.checkMetrics ?? []
  const checks = checkMetrics.length === 0 ? [] : await (async () => {
    const [values, firsts] = await Promise.all([
      repo.hourlyTotals(source.id, checkMetrics, nowHour - HOUR, nowHour),
      repo.firstHours(source.id, checkMetrics),
    ])
    return checkMetrics.map(metric => {
      const check = latestCheck(metric, nowSec, values.filter(row => row.metric === metric), firsts.get(metric) ?? null, flags)
      return { metric, hour: formatHour(check.hour), status: check.status, stage: check.stage }
    })
  })()

  let budget: Record<string, unknown> | null = null
  if (settings.budgetMetric !== undefined) {
    const metric = settings.budgetMetric
    const from = Math.min(monthStart(nowSec), floorDay(nowSec) - 7 * DAY)
    const [rows, first] = await Promise.all([repo.hourlyTotals(source.id, [metric], from, windowEnd), repo.firstHour(source.id, metric)])
    const projection = projectMonth(rows, first, nowSec)
    const unit = rows[0]?.unit ?? null
    const limit = settings.monthlyLimit ?? null
    const mtdCost = unit === null ? null : costOf(projection.mtd, unit, settings)
    budget = {
      metric, unit, monthStart: formatHour(projection.monthStart), mtd: projection.mtd, projection: projection.projection, averageDaily: projection.averageDaily,
      monthlyLimit: limit, mtdPercent: limit === null ? null : projection.mtd / limit * 100,
      projectionPercent: limit === null ? null : projection.projection / limit * 100, overLimit: limit === null ? null : projection.projection > limit,
      cost: mtdCost === null || unit === null ? null : { mtd: mtdCost, projection: costOf(projection.projection, unit, settings) },
    }
  }

  // `ms` metrics are never judged, so they are filtered out before the cap and cannot crowd out other metrics.
  const known = (await repo.listMetrics(source.id, floorHour(nowSec) - 30 * DAY, false)).filter(info => info.unit !== "ms").map(info => info.metric)
  const wanted = settings.surgeMetrics === undefined ? known : known.filter(metric => settings.surgeMetrics?.includes(metric))
  const surgeMetrics = [...wanted].sort().slice(0, MAX_SURGE_METRICS)
  const found: Surge[] = []
  if (surgeMetrics.length > 0) {
    const [hourly, firsts] = await Promise.all([
      repo.hourlyTotals(source.id, surgeMetrics, windowStart - SURGE_BASELINE_HOURS * HOUR, windowEnd),
      repo.firstHours(source.id, surgeMetrics),
    ])
    surgeMetrics.forEach(metric => {
      const rows = hourly.filter(row => row.metric === metric)
      const unit = rows[0]?.unit
      if (unit !== undefined) found.push(...findSurges({ metric, unit, hourly: rows, firstHour: firsts.get(metric) ?? null, nowHour, settings }))
    })
  }
  const selected = selectSurges(found)
  const contributors = await repo.hoursContributors(source.id, selected.map(surge => [surge.metric, surge.hour] as const), 5)

  return {
    now: new Date(nowMs).toISOString(),
    freshness: freshness(source.lastPushAt, nowMs, settings.staleAfterHours),
    budget,
    surges: selected.map(surge => ({ ...surge, hour: formatHour(surge.hour), contributors: contributors.filter(row => row.metric === surge.metric && row.hour === surge.hour).map(row => ({ dims: row.dims, value: row.value })) })),
    flags: flags.map(flag => ({ ...flag, hour: formatHour(flag.hour) })),
    checks,
  }
}

telemetryQueriesRouter.get("/sources/:id/summary", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    return telemetryJson(await summarize(source, telemetryClock.now()))
  } catch (error) { return telemetryFailure(error) }
})
