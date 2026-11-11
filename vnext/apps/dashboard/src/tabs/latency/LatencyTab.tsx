import { ChevronLeft, ChevronRight } from "lucide-react"
import { performanceLabels } from "../../state/performance-labels"
import type { PerformanceMetricsGroup } from "@vibe-llm/protocols/common"
import { usePerformance } from "../../state/performance"
import { completePerformanceOptions } from "../../state/performance-data"
import type { PerformanceFilters } from "../../state/performance-data"
import type { LatencyRange } from "../../state/latency"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { EmptyState } from "../../ui/empty-state"
import { MultiSelect } from "../../ui/multi-select"
import { Notice } from "../../ui/notice"
import { PageHeader } from "../../ui/page-header"
import { SegmentedControl } from "../../ui/segmented-control"
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
    const options = values.map(v => ({
      value: v,
      label: field === "keyId" ? s.data.groups.find(group => group.keyId === v)?.keyName ?? s.keyNames[v] ?? v
        : (v === "unknown" || v === "hit" || v === "miss") ? labels[v] : v,
    }))
    const rememberedLabels = field === "keyId" ? s.keyNames : { unknown: labels.unknown, hit: labels.hit, miss: labels.miss }
    return completePerformanceOptions(options, s.filters[field as keyof PerformanceFilters] ?? [], rememberedLabels)
  }
  function filter(field: keyof PerformanceFilters, options: Array<{ value: string; label: string }>) {
    const labelId = "performance-filter-" + field
    return <div key={field} className={"flex flex-col gap-1.5 min-w-0 " + (field === "model" ? "col-span-2 sm:col-span-1" : "")}>
      <span id={labelId} className="text-xs font-medium text-fg-muted">{labels[field]}</span>
      <MultiSelect labelledBy={labelId} value={s.filters[field] ?? []} onChange={values => s.setFilter(field, values)}
        allLabel={t("dash.perf.all")} clearLabel={t("dash.perf.clear")} className="w-full min-w-0" options={options} />
    </div>
  }
  const extraCount = EXTRA_FILTERS.filter(field => (s.filters[field]?.length ?? 0) > 0).length
  const selectedCount = s.filtered.reduce((sum, group) => sum + group.requests, 0)
  return <div className="space-y-5" aria-busy={s.loading}>
    <PageHeader title={t("dash.perf.experience.title")} description={t("dash.perf.experience.scope")} actions={<>
      <SegmentedControl ariaLabel={t("dash.perf.range")} value={s.range} onChange={s.switchRange}
        options={ranges.map(([range, label]) => ({ value: range, label: t(label) }))} />
      <Button variant="secondary" size="sm" onClick={s.refresh} disabled={s.loading}>{t("dash.perf.refresh")}</Button>
    </>} />
    {s.range === "week" && <div className="flex items-center gap-1 text-sm text-fg-muted">
      <Button variant="ghost" size="icon" onClick={() => s.shiftWeek(-1)} aria-label={t("dash.previousWeekTitle")}><ChevronLeft aria-hidden="true" /></Button>
      <span className="px-1 tabular-nums">{s.weekLabel}</span>
      <Button variant="ghost" size="icon" onClick={() => s.shiftWeek(1)} disabled={s.weekOffset >= 0} aria-label={t("dash.nextWeekTitle")}><ChevronRight aria-hidden="true" /></Button>
    </div>}
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
      {filter("model", dynamicOptions("model"))}
      {filter("mode", (["stream", "sync"] as const).map(v => ({ value: v, label: labels[v] })))}
      {filter("outcome", (["success", "error", "cancelled"] as const).map(v => ({ value: v, label: labels[v] })))}
    </div>
    <details className="group border-b border-border pb-4">
      <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        {t("dash.perf.filters")}{extraCount > 0 && <span className="tabular-nums">({extraCount})</span>}
      </summary>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">{EXTRA_FILTERS.map(field => filter(field, dynamicOptions(field)))}</div>
    </details>
    {s.error && <Notice tone="danger">{s.error}</Notice>}
    {s.loading ? <div role="status" className="h-36 rounded-lg border border-border bg-panel p-5 text-sm text-fg-subtle">{t("dash.loadingShort")}</div> : <>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-fg-subtle">
        <span className="text-fg-muted tabular-nums">{selectedCount.toLocaleString()} {t("dash.perf.requests")}</span>
        <span>{t("dash.perf.experience.averages")}</span>
      </div>
      {selectedCount === 0 ? !s.error && <EmptyState title={t("dash.perf.empty")} /> : <>
        <ExperienceSummary metrics={s.metrics} requests={selectedCount} />
        {s.comparisons.length > 0 && <ModelComparison groups={s.comparisons} />}
      </>}
      <PerformanceDiagnostics metrics={s.metrics} legacyRequests={s.data.legacyRequests} />
    </>}
  </div>
}
