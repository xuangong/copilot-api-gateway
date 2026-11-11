import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react"
import { useAuth } from "../../state/auth"
import { formatDayLabel, formatMonthLabel, formatWeekLabel, useUsage, type UsageMetric, type UsageRange } from "../../state/usage"
import { UsageFiltersBar } from "./UsageFilters"
import { UsageSummaryCards } from "./UsageSummary"
import { UsageDistributionTable } from "./UsageDistributionTable"
import { RollingStrip } from "./RollingStrip"
import { UsageForecast } from "./UsageForecast"
import { UsageRefresh } from "./UsageRefresh"
import { TimeSeriesChart, paletteFor, type ChartDataset } from "../../components/TimeSeriesChart"
import { dateKey } from "../../state/time-buckets"
import { localOffsetLabel, localZoneLabel, setZoneMode, useZoneMode, zoneOps, type TimeZoneMode } from "../../state/timezone"
import { useT } from "../../state/i18n"
import { formatUsageFilterHint } from "../../state/usage-model-dimensions"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { EmptyState } from "../../ui/empty-state"
import { PageHeader } from "../../ui/page-header"
import { SegmentedControl, type SegmentedOption } from "../../ui/segmented-control"

/**
 * Whether the strip and the forecast are open. Folded away by default: they
 * answer a question about a 28-day budget, and someone who is not watching one
 * gets ninety squares and a form between them and the graph they came for.
 */
const LS_STRIP_OPEN = "usage.stripOpen"

export function UsageTab() {
  const { session } = useAuth()
  const isAdmin = !!session?.isAdmin
  const usage = useUsage(isAdmin)
  const t = useT()
  const mode = useZoneMode()
  const ops = zoneOps(mode)
  // Read once per render rather than at module load: a laptop that crosses a
  // zone boundary between sessions would otherwise keep naming the old one.
  const zoneLabel = localZoneLabel()
  const today = dateKey(new Date(), ops)
  const [stripOpen, setStripOpen] = useState(() => localStorage.getItem(LS_STRIP_OPEN) === "1")
  useEffect(() => {
    localStorage.setItem(LS_STRIP_OPEN, stripOpen ? "1" : "0")
  }, [stripOpen])
  // Lives here rather than inside the forecast because the two components it
  // joins are siblings: the row is hovered in one and the days light up in the
  // other.
  const [forecastRun, setForecastRun] = useState<number | null>(null)
  const RANGE_OPTIONS: Array<SegmentedOption<UsageRange>> = [
    { value: "today", label: t("dash.day") },
    { value: "week", label: t("dash.week") },
    { value: "month", label: t("dash.month") },
    { value: "28d", label: t("dash.twentyEightDays") },
  ]
  const METRIC_OPTIONS: Array<SegmentedOption<UsageMetric>> = [
    { value: "tokens", label: t("dash.metricTokens") },
    { value: "requests", label: t("dash.metricRequests") },
  ]
  const MODEL_KIND_OPTIONS: Array<SegmentedOption<"routed" | "incoming">> = [
    { value: "routed", label: t("dash.routedModel") },
    { value: "incoming", label: t("dash.incomingModel") },
  ]
  // The local option names the zone it means. "Local" on its own is the thing
  // this switch exists to remove: a boundary the page will not say out loud.
  const TZ_OPTIONS: Array<SegmentedOption<TimeZoneMode>> = [
    { value: "local", label: t("dash.tzLocal", { zone: localOffsetLabel() }) },
    { value: "utc", label: t("dash.tzUtc") },
  ]
  const isDark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") !== "light"
  const palette = paletteFor(isDark ? "dark" : "light")
  const chartDatasets = useMemo<ChartDataset[]>(() => {
    // Per-model lines are ordered by usage, which shifts between refreshes and
    // between tokens and requests; colouring by that rank would swap two
    // models' colours under the reader. Colour by name instead.
    const colorSlot = usage.chart.grouping === "model"
      ? new Map([...usage.chart.series].map((s) => s.id).sort().map((id, i) => [id, i] as const))
      : null
    const series: ChartDataset[] = usage.chart.series.map((s, i) => ({
      label: s.label,
      data: s.data,
      color: palette[(colorSlot?.get(s.id) ?? i) % palette.length] ?? "#888888",
      costData: s.cost,
      // Per-model lines cross one another, and filled areas would bury the
      // lower ones; each line names its own cache in the tooltip instead.
      ...(usage.chart.grouping === "model" ? { fill: false, hidden: s.hidden, cacheData: s.cache } : {}),
    }))
    if (usage.chart.cacheData) {
      series.push({
        label: "Cache",
        data: usage.chart.cacheData,
        color: "#a78bfa",
        dashed: true,
        fill: false,
        // No costData: cache tokens are already billed inside the series above,
        // so pricing them again would double-count the bucket.
      })
    }
    return series
  }, [usage.chart, palette])
  const unitLabel = usage.metric === "requests" ? " req" : " tokens"
  const periodNoun = usage.range === "today" ? "day" : usage.range === "week" ? "week" : "month"
  // Only the daily-bucket ranges have a day to open; "today" is already one,
  // and its buckets are hours.
  const bucketKeys = usage.chart.bucketKeys
  // A week/month chart runs to the end of the period, so its later buckets can
  // be days that have not happened yet — and an empty past day is just as
  // pointless to open.
  const bucketHasData = (i: number) => chartDatasets.some((d) => (d.data[i] ?? 0) > 0)
  // Read off the chart's own labels rather than recomputing the window, so the
  // caption can never name a span the graph is not drawing.
  const chartLabels = usage.chart.labels
  const windowLabel =
    chartLabels.length > 0 ? `${chartLabels[0]} – ${chartLabels[chartLabels.length - 1]}` : ""
  const dayLink = usage.chart.isDaily
    ? {
        labelFor: (i: number) => (bucketKeys[i] && bucketHasData(i) ? t("dash.viewThisDay") : null),
        onSelect: (i: number) => {
          const key = bucketKeys[i]
          if (key && bucketHasData(i)) usage.openDay(key)
        },
      }
    : undefined

  return (
    <div>
      <PageHeader
        title={t("dash.usage")}
        actions={
          <UsageRefresh
            loading={usage.loading}
            lastUpdated={usage.lastUpdated}
            onRefresh={usage.refresh}
          />
        }
      />

      <div className="flex flex-col gap-4 mb-5">
        <div className="flex items-center gap-2 flex-wrap">
          <SegmentedControl
            ariaLabel={t("dash.usage.metricLabel")}
            options={METRIC_OPTIONS}
            value={usage.metric}
            onChange={(v) => usage.setMetric(v)}
          />
          <SegmentedControl
            ariaLabel={t("dash.usage.rangeLabel")}
            options={RANGE_OPTIONS}
            value={usage.range}
            onChange={(v) => usage.switchRange(v)}
          />
          <SegmentedControl
            ariaLabel={t("dash.usage.timeZoneLabel")}
            options={TZ_OPTIONS}
            value={mode}
            onChange={(v) => setZoneMode(v)}
          />
        </div>

        {/* 28d is a trailing window — no period to step. */}
        {usage.range === "today" || usage.range === "week" || usage.range === "month" ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => usage.shiftPeriod(-1)}
              title={`Previous ${periodNoun}`}
              aria-label={`Previous ${periodNoun}`}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span className="text-[13px] text-fg-muted font-medium tabular-nums min-w-[180px] text-center">
              {usage.range === "today"
                ? formatDayLabel(usage.periodOffset, new Date(), mode)
                : usage.range === "week"
                  ? formatWeekLabel(usage.periodOffset, new Date(), mode)
                  : formatMonthLabel(usage.periodOffset, new Date(), mode)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => usage.shiftPeriod(1)}
              disabled={usage.periodOffset >= 0}
              title={`Next ${periodNoun}`}
              aria-label={`Next ${periodNoun}`}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        ) : null}

        {/* 28d has no arrows because its window is not one of a series of
            periods — the user names its last day instead. */}
        {usage.range === "28d" ? (
          <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
            <div className="flex items-center gap-2">
              <label htmlFor="usage-end-date" className="text-xs font-medium text-fg-muted">
                {t("dash.endDate")}
              </label>
              <input
                id="usage-end-date"
                type="date"
                // Falls back to today rather than to blank. A null endDate means
                // "the window that ends now", which is a day the user can name —
                // so leaving the field empty hides an answer the page already
                // knows, and makes the Latest button look like it cleared the
                // window rather than moved it. Same fallback the strip's
                // selection ring uses, so the two always agree.
                value={usage.endDate ?? today}
                // A window closing in the future could only ever be part empty.
                max={today}
                onChange={(e) => usage.chooseEndDate(e.target.value || null)}
              />
            </div>
            <span className="text-[13px] text-fg-muted font-medium tabular-nums">{windowLabel}</span>
            <div className="flex items-center gap-1">
              {usage.endDate ? (
                <Button variant="ghost" size="sm" onClick={() => usage.chooseEndDate(null)}>
                  {t("dash.latestWindow")}
                </Button>
              ) : null}
              {/* Sits with the other 28d controls rather than over the strip
                  itself: when it is folded there is no strip to sit over. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Dropped on the way down so a run left lit by the pointer
                  // cannot come back with the strip when it reopens.
                  if (stripOpen) setForecastRun(null)
                  setStripOpen((v) => !v)
                }}
                aria-expanded={stripOpen}
                className={stripOpen ? "bg-muted text-fg" : undefined}
              >
                {t("dash.rollingSection")}
                {stripOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </Button>
            </div>
          </div>
        ) : null}

        {usage.range === "28d" && stripOpen ? (
          <RollingStrip
            cells={usage.strip}
            selectedKey={usage.endDate ?? today}
            highlightTail={forecastRun}
            isDark={isDark}
            onPick={(day) => usage.chooseEndDate(day)}
          />
        ) : null}

        {usage.range === "28d" && stripOpen ? (
          <UsageForecast cells={usage.strip} onHoverRun={setForecastRun} />
        ) : null}

        <UsageFiltersBar
          isAdmin={isAdmin}
          filters={usage.filters}
          dimensions={usage.dimensions}
          onChange={usage.updateFilter}
          onClear={usage.clearFilters}
        />

        <FilterHint
          isAdmin={isAdmin}
          usersAvailable={usage.dimensions.users.length > 0}
          filters={usage.filters}
          visible={usage.data.length > 0}
          keyName={usage.dimensions.keys.find((k) => k.id === usage.filters.key)?.name}
          userName={usage.dimensions.users.find((u) => u.id === usage.filters.user)?.name}
        />
      </div>

      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-fg-subtle">
            {usage.chart.grouping === "user"
              ? t("dash.chartLinesByUser")
              : t(usage.modelKind === "routed" ? "dash.chartLinesByRoutedModel" : "dash.chartLinesByIncomingModel")}
          </p>
          {usage.chart.grouping === "model" ? (
            <SegmentedControl
              size="sm"
              options={MODEL_KIND_OPTIONS}
              value={usage.modelKind}
              onChange={usage.setModelKind}
              ariaLabel={t("dash.modelDistributionToggle")}
            />
          ) : null}
        </div>

        <div className="mt-2">
          <TimeSeriesChart
            labels={usage.chart.labels}
            datasets={chartDatasets}
            unitLabel={unitLabel}
            height={320}
            totalCostLabel={t("dash.tooltipTotalCost")}
            sortTooltip={usage.chart.grouping === "model"}
            formatCache={(n) => t("dash.tooltipCacheShare", { n: n.toLocaleString() })}
            {...(dayLink ? { pointLink: dayLink } : {})}
          />
        </div>

        <p className="text-xs text-fg-subtle">
          {mode === "utc"
            ? t("dash.allTimestampsUtc")
            : t("dash.allTimestampsLocalNamed", { zone: zoneLabel })}
        </p>
        <UsageSummaryCards summary={usage.summary} />
      </Card>

      <div className="flex items-center justify-between gap-3 flex-wrap mt-6">
        <SectionHeading>{t("dash.modelDistribution")}</SectionHeading>
        <SegmentedControl
          size="sm"
          options={MODEL_KIND_OPTIONS}
          value={usage.modelKind}
          onChange={usage.setModelKind}
          ariaLabel={t("dash.modelDistributionToggle")}
        />
      </div>
      <UsageDistributionTable
        title={usage.modelKind === "routed" ? t("dash.byRoutedModel") : t("dash.byIncomingModel")}
        rows={usage.modelKind === "routed" ? usage.distributions.byRoutedModel : usage.distributions.byIncomingModel}
        showRoutedModels={usage.modelKind === "incoming"}
      />
      {isAdmin ? <UsageDistributionTable title={t("dash.byUser")} rows={usage.distributions.byUser} /> : null}
      <UsageDistributionTable title={t("dash.byKey")} rows={usage.distributions.byKey} />
      <UsageDistributionTable title={t("dash.byClient")} rows={usage.distributions.byClient} />

      {!usage.loading && usage.data.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={t("dash.noUsageInRange")} />
        </div>
      ) : null}
    </div>
  )
}

function FilterHint({
  isAdmin,
  usersAvailable,
  filters,
  visible,
  keyName,
  userName,
}: {
  isAdmin: boolean
  usersAvailable: boolean
  filters: { user: string; key: string; client: string; model: string; incomingModel: string | null }
  visible: boolean
  keyName?: string
  userName?: string
}) {
  const t = useT()
  if (!visible) return null
  const selected: string[] = []
  const remaining: string[] = []
  if (isAdmin && usersAvailable) {
    if (filters.user) selected.push(t("dash.filterUser", { value: userName ?? filters.user.slice(0, 8) }))
    else remaining.push(t("dash.user"))
  }
  if (filters.key) selected.push(t("dash.filterKey", { value: keyName ?? filters.key.slice(0, 8) }))
  else remaining.push(t("dash.key"))
  if (filters.client) selected.push(t("dash.filterClient", { value: filters.client }))
  else remaining.push(t("dash.client"))
  if (filters.model) selected.push(t("dash.filterRoutedModel", { value: filters.model }))
  else remaining.push(t("dash.routedModel"))
  if (filters.incomingModel !== null) {
    selected.push(t("dash.filterIncomingModel", { value: filters.incomingModel || t("dash.unknown") }))
  } else {
    remaining.push(t("dash.incomingModel"))
  }
  return <p className="text-xs text-fg-subtle">{formatUsageFilterHint({ selected, remaining }, t)}</p>
}
