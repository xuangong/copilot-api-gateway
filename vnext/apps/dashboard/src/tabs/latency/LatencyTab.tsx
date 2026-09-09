import { performanceLabels } from "../../state/performance-labels"
import type { PerformanceMetricsGroup } from "@vibe-llm/protocols/common"
import { usePerformance } from "../../state/performance"
import type { PerformanceFilters } from "../../state/performance-data"
import type { LatencyRange } from "../../state/latency"
import { useT } from "../../state/i18n"
import { Select } from "../../components/Select"
import { ExperienceSummary } from "./ExperienceSummary"
import { ModelComparison } from "./ModelComparison"
import { PerformanceDiagnostics } from "./PerformanceDiagnostics"

const EXTRA_FILTERS = ["keyId", "incomingModel", "upstream", "sourceApi", "targetApi", "runtimeLocation", "inputBucket", "cacheStatus", "reasoningEffort"] as const

export function LatencyTab() {
  const s = usePerformance()
  const t = useT()
  const labels = performanceLabels(t)
  const ranges: Array<[LatencyRange, string]> = [["today", "dash.today"], ["week", "dash.weekShort"], ["7d", "dash.sevenDaysShort"], ["30d", "dash.thirtyDaysShort"]]
  const dynamicOptions = (field: keyof PerformanceMetricsGroup) => {
    const values = [...new Set(s.data.groups.flatMap(group => typeof group[field] === "string" ? [String(group[field])] : []))].sort()
    return values.map(v => ({
      value: v,
      label: field === "keyId" ? s.data.groups.find(group => group.keyId === v)?.keyName ?? v
        : (v === "unknown" || v === "hit" || v === "miss") ? labels[v] : v,
    }))
  }
  function filter(field: keyof PerformanceFilters, options: Array<{ value: string; label: string }>) {
    return <div key={field} className={"flex flex-col gap-1.5 min-w-0 " + (field === "model" ? "col-span-2 sm:col-span-1" : "")}>
      <span id={"performance-filter-" + field} className="text-xs text-themed-dim">{labels[field]}</span>
      <Select ariaLabel={labels[field]} value={s.filters[field] ?? ""} onChange={v => s.setFilter(field, v)}
        className="w-full min-w-0" options={[{ value: "", label: t("dash.perf.all") }, ...options]} />
    </div>
  }
  const extraCount = EXTRA_FILTERS.filter(field => s.filters[field]).length
  const selectedCount = s.filtered.reduce((sum, group) => sum + group.requests, 0)
  return <div className="space-y-5" aria-busy={s.loading}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-lg font-semibold text-themed">{t("dash.perf.experience.title")}</h2><p className="text-xs text-themed-dim mt-1 leading-relaxed max-w-[65ch]">{t("dash.perf.experience.scope")}</p></div>
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
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
      {filter("model", dynamicOptions("model"))}
      {filter("mode", (["stream", "sync"] as const).map(v => ({ value: v, label: labels[v] })))}
      {filter("outcome", (["success", "error", "cancelled"] as const).map(v => ({ value: v, label: labels[v] })))}
    </div>
    <details className="border-b border-themed pb-4">
      <summary className="text-sm text-themed-secondary cursor-pointer">{t("dash.perf.filters")}{extraCount > 0 && <span className="ml-2 tabular-nums">({extraCount})</span>}</summary>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">{EXTRA_FILTERS.map(field => filter(field, dynamicOptions(field)))}</div>
    </details>
    {s.error && <div role="alert" className="rounded-lg bg-accent-red/10 text-accent-red p-3 text-sm">{s.error}</div>}
    {s.loading ? <div role="status" className="h-36 rounded-xl bg-surface-800 p-5 text-themed-dim text-sm">{t("dash.loadingShort")}</div> : <>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-themed-dim">
        <span className="text-themed-secondary">{selectedCount.toLocaleString()} {t("dash.perf.requests")}</span>
        <span>{t("dash.perf.experience.averages")}</span>
      </div>
      {selectedCount === 0 ? !s.error && <p className="text-sm text-themed-dim py-6">{t("dash.perf.empty")}</p> : <>
        <ExperienceSummary metrics={s.metrics} requests={selectedCount} />
        {s.comparisons.length > 0 && <ModelComparison groups={s.comparisons} />}
      </>}
      <PerformanceDiagnostics metrics={s.metrics} legacyRequests={s.data.legacyRequests} />
    </>}
  </div>
}
