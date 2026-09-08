import { performanceLabels } from "../../state/performance-labels"
import type { PerformanceMetricName, PerformanceMetricsGroup } from "@vibe-llm/protocols/common"
import { usePerformance } from "../../state/performance"
import { formatPerformanceValue, summarizeDistribution, type PerformanceFilters } from "../../state/performance-data"
import type { LatencyRange } from "../../state/latency"
import { useT } from "../../state/i18n"
import { Select } from "../../components/Select"

const METRICS: PerformanceMetricName[] = [
  "ttftMs", "firstTextMs", "upstreamTps", "overallTps", "totalMs", "upstreamMs", "generationMs",
  "gapMs", "maxGapMs", "outputTokens", "reasoningTokens", "inputTokens", "cachedInputTokens",
]
const EXTRA_FILTERS = ["keyId", "incomingModel", "upstream", "sourceApi", "targetApi", "runtimeLocation", "inputBucket", "cacheStatus", "reasoningEffort"] as const


export function LatencyTab() {
  const s = usePerformance()
  const t = useT()
  const labels = performanceLabels(t)
  const ranges: Array<[LatencyRange, string]> = [["today", "dash.today"], ["week", "dash.weekShort"], ["7d", "dash.sevenDaysShort"], ["30d", "dash.thirtyDaysShort"]]
  const value = (n: number | null, metric: PerformanceMetricName) => formatPerformanceValue(n, metric, t("dash.perf.unknown"))
  const dynamicOptions = (field: keyof PerformanceMetricsGroup) => {
    const values = [...new Set(s.data.groups.flatMap(group => typeof group[field] === "string" ? [String(group[field])] : []))].sort()
    return values.map(v => ({
      value: v,
      label: field === "keyId" ? s.data.groups.find(group => group.keyId === v)?.keyName ?? v
        : (v === "unknown" || v === "hit" || v === "miss") ? labels[v] : v,
    }))
  }
  function filter(field: keyof PerformanceFilters, options: Array<{ value: string; label: string }>) {
    return <div key={field} className="flex flex-col gap-1.5 min-w-0">
      <span id={"performance-filter-" + field} className="text-xs text-themed-dim">{labels[field]}</span>
      <Select ariaLabel={labels[field]} value={s.filters[field] ?? ""} onChange={v => s.setFilter(field, v)}
        className="w-full min-w-0" options={[{ value: "", label: t("dash.perf.all") }, ...options]} />
    </div>
  }
  const selectedCount = s.filtered.reduce((sum, group) => sum + group.requests, 0)
  return <div className="space-y-6" aria-busy={s.loading}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-lg font-semibold text-themed">{t("dash.perf.title")}</h2><p className="text-xs text-themed-dim mt-1">{t("dash.perf.gateway")}</p></div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex bg-surface-800 rounded-lg p-0.5">
          {ranges.map(([range, label]) => <button key={range} type="button" aria-pressed={s.range === range} onClick={() => s.switchRange(range)}
            className={"px-3 py-1.5 rounded-md text-xs " + (s.range === range ? "bg-surface-600 text-themed" : "text-themed-dim")}>{t(label)}</button>)}
        </div>
        <button type="button" onClick={s.refresh} disabled={s.loading} className="text-xs px-3 py-2 rounded-lg bg-surface-700 text-themed disabled:opacity-50">{t("dash.perf.refresh")}</button>
      </div>
    </div>
    {s.range === "week" && <div className="flex items-center gap-3 text-sm text-themed-secondary">
      <button type="button" onClick={() => s.shiftWeek(-1)} aria-label={t("dash.previousWeekTitle")} className="p-2 rounded hover:bg-surface-700">‹</button>
      <span>{s.weekLabel}</span>
      <button type="button" onClick={() => s.shiftWeek(1)} disabled={s.weekOffset >= 0} aria-label={t("dash.nextWeekTitle")} className="p-2 rounded hover:bg-surface-700 disabled:opacity-30">›</button>
    </div>}
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
      {filter("model", dynamicOptions("model"))}
      {filter("mode", (["stream", "sync"] as const).map(v => ({ value: v, label: labels[v] })))}
      {filter("outcome", (["success", "error", "cancelled"] as const).map(v => ({ value: v, label: labels[v] })))}
    </div>
    <details className="rounded-xl border border-themed p-4">
      <summary className="text-sm text-themed-secondary cursor-pointer">{t("dash.perf.filters")}</summary>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">{EXTRA_FILTERS.map(field => filter(field, dynamicOptions(field)))}</div>
    </details>
    {s.error && <div role="alert" className="rounded-lg bg-accent-red/10 text-accent-red p-3 text-sm">{s.error}</div>}
    {s.loading ? <div role="status" className="h-36 rounded-xl bg-surface-800 p-5 text-themed-dim text-sm">{t("dash.loadingShort")}</div> : <>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-themed-secondary">
        <span className="font-medium text-themed">{selectedCount.toLocaleString()} {t("dash.perf.requests")}</span>
        {(["success", "error", "cancelled"] as const).map(outcome => <span key={outcome}>{labels[outcome]}: {s.outcomeCounts[outcome].toLocaleString()}</span>)}
      </div>
      {s.data.legacyRequests > 0 && <p className="text-xs text-themed-dim">{t("dash.perf.legacy", { count: s.data.legacyRequests.toLocaleString() })}</p>}
      {selectedCount === 0 && !s.error && <p className="text-sm text-themed-dim py-3">{t("dash.perf.empty")}</p>}
      <div className="overflow-x-auto rounded-xl border border-themed">
        <table className="w-full text-sm whitespace-nowrap">
          <caption className="sr-only">{t("dash.perf.title")}, {t("dash.perf.gateway")}</caption>
          <thead className="bg-surface-800 text-xs text-themed-dim"><tr>
            <th scope="col" className="px-4 py-3 text-left">{t("dash.perf.metric")}</th>
            {[t("dash.perf.mean"), "P50", "P95", t("dash.perf.maximum"), t("dash.perf.samples")].map(label => <th scope="col" key={label} className="px-4 py-3 text-right font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{METRICS.map(metric => {
            const stats = summarizeDistribution(s.metrics[metric])
            return <tr key={metric} className="border-t border-themed hover:bg-surface-800/50">
              <th scope="row" className="px-4 py-3 text-left font-normal text-themed">{labels[metric]}</th>
              {[stats.mean, stats.p50, stats.p95, stats.max].map((n, index) => <td key={index} className={"px-4 py-3 text-right font-mono text-xs " + (n === null ? "text-themed-dim" : "text-themed-secondary")}>{value(n, metric)}</td>)}
              <td className="px-4 py-3 text-right font-mono text-xs text-themed-dim">{stats.count.toLocaleString()}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
      <div className="space-y-2 max-w-[75ch] text-xs leading-relaxed text-themed-dim"><p>{t("dash.perf.histogram")}</p><p>{t("dash.perf.rateNote")}</p></div>
      {s.comparisons.length > 0 && <section>
        <h3 className="text-sm font-medium text-themed mb-3">{t("dash.perf.comparison")}</h3>
        <div className="overflow-x-auto rounded-xl border border-themed"><table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-surface-800 text-xs text-themed-dim"><tr>
            <th scope="col" className="px-4 py-3 text-left">{t("dash.perf.model")} / {t("dash.perf.upstream")}</th>
            <th scope="col" className="px-4 py-3 text-right">{t("dash.perf.requests")}</th>
            <th scope="col" className="px-4 py-3 text-right">TTFT P50 / P95</th>
            <th scope="col" className="px-4 py-3 text-right">{t("dash.perf.upstreamTps")}</th>
          </tr></thead><tbody>{s.comparisons.map(group => {
            const ttft = summarizeDistribution(group.metrics.ttftMs)
            const speed = summarizeDistribution(group.metrics.upstreamTps)
            return <tr key={group.id} className="border-t border-themed">
              <th scope="row" className="px-4 py-3 text-left font-normal"><span className="text-themed font-mono text-xs">{group.model}</span><div className="text-xs text-themed-dim mt-1">{group.upstream ?? t("dash.perf.unknown")} · {group.sourceApi} → {group.targetApi}</div></th>
              <td className="px-4 py-3 text-right text-themed-secondary font-mono text-xs">{group.requests.toLocaleString()}</td>
              <td className="px-4 py-3 text-right text-themed-secondary font-mono text-xs">{value(ttft.p50, "ttftMs")} / {value(ttft.p95, "ttftMs")}<div className="text-themed-dim mt-1">n={ttft.count}</div></td>
              <td className="px-4 py-3 text-right text-themed-secondary font-mono text-xs">{value(speed.mean, "upstreamTps")}<div className="text-themed-dim mt-1">n={speed.count}</div></td>
            </tr>
          })}</tbody>
        </table></div>
      </section>}
    </>}
  </div>
}
