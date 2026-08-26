import { useEffect, useMemo, useState } from "react"
import { useAuth } from "../../state/auth"
import { formatDayLabel, formatMonthLabel, formatWeekLabel, useUsage, type UsageMetric, type UsageRange } from "../../state/usage"
import { UsageFiltersBar } from "./UsageFilters"
import { UsageSummaryCards } from "./UsageSummary"
import { UsageDistributionTable } from "./UsageDistributionTable"
import { RollingStrip } from "./RollingStrip"
import { UsageForecast } from "./UsageForecast"
import { TimeSeriesChart, localDateKey, paletteFor, type ChartDataset } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"

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
  const [stripOpen, setStripOpen] = useState(() => localStorage.getItem(LS_STRIP_OPEN) === "1")
  useEffect(() => {
    localStorage.setItem(LS_STRIP_OPEN, stripOpen ? "1" : "0")
  }, [stripOpen])
  // Lives here rather than inside the forecast because the two components it
  // joins are siblings: the row is hovered in one and the days light up in the
  // other.
  const [forecastRun, setForecastRun] = useState<number | null>(null)
  const RANGE_OPTIONS: Array<{ id: UsageRange; label: string }> = [
    { id: "today", label: t("dash.day") },
    { id: "week", label: t("dash.week") },
    { id: "month", label: t("dash.month") },
    { id: "28d", label: t("dash.twentyEightDays") },
  ]
  const METRIC_OPTIONS: Array<{ id: UsageMetric; label: string }> = [
    { id: "tokens", label: t("dash.metricTokens") },
    { id: "requests", label: t("dash.metricRequests") },
  ]
  const isDark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") !== "light"
  const palette = paletteFor(isDark ? "dark" : "light")
  const chartDatasets = useMemo<ChartDataset[]>(() => {
    const series: ChartDataset[] = usage.chart.series.map((s, i) => ({
      label: s.label,
      data: s.data,
      color: palette[i % palette.length] ?? "#888888",
    }))
    if (usage.chart.cacheData) {
      series.push({
        label: "Cache",
        data: usage.chart.cacheData,
        color: "#a78bfa",
        dashed: true,
        fill: false,
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
      {/* z-10: the cards below build their own stacking contexts (backdrop-filter),
          so without this the summary's hover popup paints underneath them. */}
      <div className="glass-card p-4 sm:p-6 animate-in relative z-10">
        <div className="flex flex-col gap-4 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.usage")}</span>
              {usage.loading ? <Spinner /> : null}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <SegmentedGroup
                options={METRIC_OPTIONS}
                value={usage.metric}
                onChange={(v) => usage.setMetric(v)}
              />
              <SegmentedGroup
                options={RANGE_OPTIONS}
                value={usage.range}
                onChange={(v) => usage.switchRange(v)}
              />
            </div>
          </div>

          {/* 28d is a trailing window — no period to step. */}
          {usage.range === "today" || usage.range === "week" || usage.range === "month" ? (
            <div className="flex items-center gap-3 ml-1">
              <button
                onClick={() => usage.shiftPeriod(-1)}
                className="p-1 rounded hover:bg-surface-600 text-themed-dim hover:text-themed transition-all"
                title={`Previous ${periodNoun}`}
              >
                ‹
              </button>
              <span className="text-xs text-themed-secondary font-medium min-w-[180px] text-center">
                {usage.range === "today"
                  ? formatDayLabel(usage.periodOffset)
                  : usage.range === "week"
                    ? formatWeekLabel(usage.periodOffset)
                    : formatMonthLabel(usage.periodOffset)}
              </span>
              <button
                onClick={() => usage.shiftPeriod(1)}
                disabled={usage.periodOffset >= 0}
                className={`p-1 rounded transition-all ${
                  usage.periodOffset >= 0
                    ? "text-themed-dim/30 cursor-not-allowed"
                    : "hover:bg-surface-600 text-themed-dim hover:text-themed"
                }`}
                title={`Next ${periodNoun}`}
              >
                ›
              </button>
            </div>
          ) : null}

          {/* 28d has no arrows because its window is not one of a series of
              periods — the user names its last day instead. */}
          {usage.range === "28d" ? (
            <div className="flex items-center gap-2 ml-1 flex-wrap">
              <label htmlFor="usage-end-date" className="text-xs text-themed-dim">
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
                value={usage.endDate ?? localDateKey(new Date())}
                // A window closing in the future could only ever be part empty.
                max={localDateKey(new Date())}
                onChange={(e) => usage.chooseEndDate(e.target.value || null)}
                className="bg-surface-800 rounded-md px-2 py-1 text-xs text-themed border border-transparent focus:border-surface-600 outline-none"
              />
              <span className="text-xs text-themed-secondary font-medium">{windowLabel}</span>
              {usage.endDate ? (
                <button
                  onClick={() => usage.chooseEndDate(null)}
                  className="text-xs text-themed-dim hover:text-themed underline underline-offset-2"
                >
                  {t("dash.latestWindow")}
                </button>
              ) : null}
              {/* Sits with the other 28d controls rather than over the strip
                  itself: when it is folded there is no strip to sit over. */}
              <button
                onClick={() => {
                  // Dropped on the way down so a run left lit by the pointer
                  // cannot come back with the strip when it reopens.
                  if (stripOpen) setForecastRun(null)
                  setStripOpen((v) => !v)
                }}
                aria-expanded={stripOpen}
                className={`px-2 py-1 rounded-md text-xs font-medium transition-all ${
                  stripOpen ? "bg-surface-600 text-themed" : "bg-surface-800 text-themed-dim hover:text-themed-secondary"
                }`}
              >
                {t("dash.rollingSection")} {stripOpen ? "▴" : "▾"}
              </button>
            </div>
          ) : null}

          {usage.range === "28d" && stripOpen ? (
            <RollingStrip
              cells={usage.strip}
              selectedKey={usage.endDate ?? localDateKey(new Date())}
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

        <div className="mt-2">
          <TimeSeriesChart
            labels={usage.chart.labels}
            datasets={chartDatasets}
            unitLabel={unitLabel}
            height={320}
            {...(dayLink ? { pointLink: dayLink } : {})}
          />
        </div>

        <p className="text-[10px] text-themed-dim">{t("dash.allTimestampsLocal")}</p>
        <UsageSummaryCards summary={usage.summary} />
      </div>

      <UsageDistributionTable title={t("dash.byModel")} rows={usage.distributions.byModel} />
      {isAdmin ? <UsageDistributionTable title={t("dash.byUser")} rows={usage.distributions.byUser} /> : null}
      <UsageDistributionTable title={t("dash.byKey")} rows={usage.distributions.byKey} />
      <UsageDistributionTable title={t("dash.byClient")} rows={usage.distributions.byClient} />

      {!usage.loading && usage.data.length === 0 ? (
        <p className="text-sm text-themed-dim italic mt-6">{t("dash.noUsageInRange")}</p>
      ) : null}
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5 text-themed-dim" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75" />
    </svg>
  )
}

interface SegmentedGroupProps<T extends string> {
  options: ReadonlyArray<{ id: T; label: string }>
  value: T
  onChange: (v: T) => void
}

function SegmentedGroup<T extends string>({ options, value, onChange }: SegmentedGroupProps<T>) {
  return (
    <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            value === o.id
              ? "bg-surface-600 text-themed"
              : "text-themed-dim hover:text-themed-secondary"
          }`}
        >
          {o.label}
        </button>
      ))}
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
  filters: { user: string; key: string; client: string; model: string }
  visible: boolean
  keyName?: string
  userName?: string
}) {
  if (!visible) return null
  const selected: string[] = []
  const all: string[] = []
  if (isAdmin && usersAvailable) {
    if (filters.user) selected.push("User: " + (userName ?? filters.user.slice(0, 8)))
    else all.push("User")
  }
  if (filters.key) selected.push("Key: " + (keyName ?? filters.key.slice(0, 8)))
  else all.push("Key")
  if (filters.client) selected.push("Client: " + filters.client)
  else all.push("Client")
  if (filters.model) selected.push("Model: " + filters.model)
  else all.push("Model")

  let msg: string
  if (selected.length === 0) {
    msg = "Showing overall usage. Select a filter to see distribution by the remaining dimensions."
  } else if (all.length === 0) {
    msg = "Filtered by " + selected.join(", ") + "."
  } else {
    msg = "Filtered by " + selected.join(", ") + ". Showing distribution by " + all.join(" & ") + "."
  }
  return <p className="text-[11px] text-themed-dim">{msg}</p>
}
