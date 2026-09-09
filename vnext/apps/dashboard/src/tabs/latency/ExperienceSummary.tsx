import type { MetricDistribution, PerformanceMetricName } from "@vibe-llm/protocols/common"
import { formatPerformanceValue, summarizeDistribution } from "../../state/performance-data"
import { performanceLabels } from "../../state/performance-labels"
import { useT } from "../../state/i18n"

type Metrics = Partial<Record<PerformanceMetricName, MetricDistribution>>

export function ExperienceSummary({ metrics, requests }: { metrics: Metrics; requests: number }) {
  const t = useT()
  const labels = performanceLabels(t)
  const rows = [
    { metric: "overallTps", title: "dash.perf.overallTps", hint: "dash.perf.experience.efficiencyHint", secondary: "totalMs" },
    { metric: "firstTextMs", title: "dash.perf.experience.wait", hint: "dash.perf.experience.waitHint", secondary: "ttftMs" },
    { metric: "maxGapMs", title: "dash.perf.experience.pauses", hint: "dash.perf.experience.pausesHint" },
  ] as const
  return <section aria-label={t("dash.perf.experience.overview")} className="border-y border-themed">
    {rows.map((row, index) => {
      const stats = summarizeDistribution(metrics[row.metric])
      const secondary = "secondary" in row ? row.secondary : undefined
      const other = secondary ? summarizeDistribution(metrics[secondary]) : undefined
      return <div key={row.metric} className={"grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 gap-y-2 py-4 " + (index ? "border-t border-themed" : "")}>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-themed">{t(row.title)}</h3>
          <p className="text-xs text-themed-secondary mt-1.5 leading-relaxed max-w-[65ch]">{t(row.hint)}</p>
        </div>
        <div className="text-right self-start">
          <div className={"text-xl sm:text-2xl font-semibold tabular-nums tracking-tight " + (stats.mean === null ? "text-themed-dim" : "text-themed")}>{formatPerformanceValue(stats.mean, row.metric, t("dash.perf.unknown"))}</div>
          <div className="text-xs text-themed-dim mt-1">{t("dash.perf.experience.coverage", { count: stats.count.toLocaleString(), total: requests.toLocaleString() })}</div>
        </div>
        {secondary && other && <p className="col-span-2 text-xs text-themed-dim">
          {labels[secondary]} {formatPerformanceValue(other.mean, secondary, t("dash.perf.unknown"))}
          <span className="ml-2">n={other.count.toLocaleString()}</span>
        </p>}
      </div>
    })}
  </section>
}
