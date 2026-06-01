import { useMemo } from "react"
import { useAuth } from "../../state/auth"
import { formatWeekLabel, useUsage, type UsageMetric, type UsageRange } from "../../state/usage"
import { UsageFiltersBar } from "./UsageFilters"
import { UsageSummaryCards } from "./UsageSummary"
import { UsageDistributionTable } from "./UsageDistributionTable"
import { TimeSeriesChart, paletteFor, type ChartDataset } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"

export function UsageTab() {
  const { session } = useAuth()
  const isAdmin = !!session?.isAdmin
  const usage = useUsage(isAdmin)
  const t = useT()
  const RANGE_OPTIONS: Array<{ id: UsageRange; label: string }> = [
    { id: "today", label: t("dash.today") },
    { id: "week", label: t("dash.week") },
    { id: "7d", label: t("dash.sevenDays") },
    { id: "30d", label: t("dash.thirtyDays") },
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

  return (
    <div>
      <div className="glass-card p-4 sm:p-6 animate-in">
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

          {usage.range === "week" ? (
            <div className="flex items-center gap-3 ml-1">
              <button
                onClick={() => usage.shiftWeek(-1)}
                className="p-1 rounded hover:bg-surface-600 text-themed-dim hover:text-themed transition-all"
                title="Previous week"
              >
                ‹
              </button>
              <span className="text-xs text-themed-secondary font-medium min-w-[180px] text-center">
                {formatWeekLabel(usage.weekOffset)}
              </span>
              <button
                onClick={() => usage.shiftWeek(1)}
                disabled={usage.weekOffset >= 0}
                className={`p-1 rounded transition-all ${
                  usage.weekOffset >= 0
                    ? "text-themed-dim/30 cursor-not-allowed"
                    : "hover:bg-surface-600 text-themed-dim hover:text-themed"
                }`}
                title="Next week"
              >
                ›
              </button>
            </div>
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

        {/* TODO: chart — legacy renders a Chart.js line series of usage.metric
            over time, optionally grouped by the first un-filtered dimension
            (user > key > client > model). Not migrated to avoid adding
            chart dependencies; numeric summary + per-dimension tables below
            already convey the data. */}
        <div className="mt-2">
          <TimeSeriesChart
            labels={usage.chart.labels}
            datasets={chartDatasets}
            unitLabel={unitLabel}
            height={320}
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
