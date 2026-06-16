import { useMemo } from "react"
import { useLatency, type LatencyRange } from "../../state/latency"
import { TimeSeriesChart, type ChartDataset } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"
import { Select } from "../../components/Select"

export function LatencyTab() {
  const s = useLatency()
  const t = useT()
  const RANGES: ReadonlyArray<{ id: LatencyRange; label: string }> = [
    { id: "today", label: t("dash.today") },
    { id: "week", label: t("dash.weekShort") },
    { id: "7d", label: t("dash.sevenDaysShort") },
    { id: "30d", label: t("dash.thirtyDaysShort") },
  ]
  const isDark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") !== "light"
  const streamC = isDark ? "#7B90FF" : "#4E6CF5"
  const syncC = isDark ? "#50D48A" : "#2CA87A"
  const chartDatasets = useMemo<ChartDataset[]>(() => [
    { label: "Stream", data: s.chart.streamData, color: streamC },
    { label: "Sync", data: s.chart.syncData, color: syncC },
  ], [s.chart, streamC, syncC])

  return (
    <div>
      <div className="glass-card p-4 sm:p-6 animate-in">
        <div className="flex flex-col gap-4 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.latencyLabel")}</span>
              {s.loading ? (
                <span className="text-xs text-themed-dim">{t("dash.loadingShort")}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
                {RANGES.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => s.switchRange(r.id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      s.range === r.id
                        ? "bg-surface-600 text-themed"
                        : "text-themed-dim hover:text-themed-secondary"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {s.models.length > 0 ? (
                <Select
                  value={s.model}
                  onChange={(v) => s.setModel(v)}
                  className="min-w-[160px]"
                  options={[
                    { value: "", label: t("dash.allModelsLabel") },
                    ...s.models.map((m) => ({ value: m, label: m })),
                  ]}
                />
              ) : null}
            </div>
          </div>

          {s.range === "week" ? (
            <div className="flex items-center gap-3 ml-1">
              <button
                onClick={() => s.shiftWeek(-1)}
                className="p-1 rounded hover:bg-surface-600 text-themed-dim hover:text-themed transition-all"
                title={t("dash.previousWeekTitle")}
              >
                ‹
              </button>
              <span className="text-xs text-themed-secondary font-medium min-w-[180px] text-center">
                {s.weekLabel}
              </span>
              <button
                onClick={() => s.shiftWeek(1)}
                disabled={s.weekOffset >= 0}
                className={`p-1 rounded transition-all ${
                  s.weekOffset >= 0
                    ? "text-themed-dim/30 cursor-not-allowed"
                    : "hover:bg-surface-600 text-themed-dim hover:text-themed"
                }`}
                title={t("dash.nextWeekTitle")}
              >
                ›
              </button>
            </div>
          ) : null}
        </div>

        {/* TODO: chart — legacy Alpine version rendered a Chart.js line chart of
            avg total ms by Stream/Sync over time. Not ported (no chart deps). */}
        <div className="mt-2">
          <TimeSeriesChart
            labels={s.chart.labels}
            datasets={chartDatasets}
            unitLabel=" ms"
            yTickFormat={(v) => `${v} ms`}
            height={280}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 mt-2 pt-5 border-t border-white/5">
          <SummaryCell label={t("dash.avgTotalLabel")} value={`${s.summary.avgTotal} ms`} />
          <SummaryCell label={t("dash.avgUpstreamLabel")} value={`${s.summary.avgUpstream} ms`} />
        </div>
      </div>

      {s.byType.length > 0 ? (
        <div className="glass-card p-4 sm:p-6 mt-5 animate-in delay-1">
          <span className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4 block">{t("dash.byTypeLabel")}</span>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5">
                  <Th align="left">{t("dash.typeLabel")}</Th>
                  <Th>{t("dash.requestsLabel")}</Th>
                  <Th>{t("dash.avgTotalLabel")}</Th>
                  <Th className="pr-0">{t("dash.avgUpstreamLabel")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.byType.map((t) => (
                  <tr key={t.type} className="border-b border-white/[0.03]">
                    <td className="py-2.5 pr-4">
                      <code className={`text-xs font-mono ${t.type === "Stream" ? "text-accent-violet" : "text-accent-amber"}`}>
                        {t.type}
                      </code>
                    </td>
                    <NumCell>{t.requests.toLocaleString()}</NumCell>
                    <NumCell>{t.avgTotal} ms</NumCell>
                    <td className="py-2.5 pr-0 text-right text-themed-secondary font-mono text-xs">
                      {t.avgUpstream} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {s.byColo.length > 0 ? (
        <div className="glass-card p-4 sm:p-6 mt-5 animate-in delay-1">
          <span className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4 block">{t("dash.byDataCenterLabel")}</span>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5">
                  <Th align="left">{t("dash.coloLabel")}</Th>
                  <Th>{t("dash.requestsLabel")}</Th>
                  <Th>{t("dash.avgTotalLabel")}</Th>
                  <Th className="pr-0">{t("dash.avgUpstreamLabel")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.byColo.map((c) => (
                  <tr key={c.colo} className="border-b border-white/[0.03]">
                    <td className="py-2.5 pr-4">
                      <code className="text-xs font-mono text-accent-violet">{c.colo}</code>
                    </td>
                    <NumCell>{c.requests.toLocaleString()}</NumCell>
                    <NumCell>{c.avgTotal} ms</NumCell>
                    <td className="py-2.5 pr-0 text-right text-themed-secondary font-mono text-xs">
                      {c.avgUpstream} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SummaryCell({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="text-center">
      <p className="text-xs text-themed-dim mb-1">{label}</p>
      <p className={`text-lg font-bold font-mono ${valueClass ?? "text-themed"}`}>{value}</p>
    </div>
  )
}

function Th({ children, align = "right", className = "" }: { children: React.ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <th
      className={`py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest ${
        align === "left" ? "text-left" : "text-right"
      } ${className}`}
    >
      {children}
    </th>
  )
}

function NumCell({ children }: { children: React.ReactNode }) {
  return <td className="py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs">{children}</td>
}
