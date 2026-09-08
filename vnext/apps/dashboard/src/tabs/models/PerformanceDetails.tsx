import { performanceLabels } from "../../state/performance-labels"
import type { PerformanceMetricName } from "@vibe-llm/protocols/common"
import { formatPerformanceValue, summarizeDistribution } from "../../state/performance-data"
import { useT } from "../../state/i18n"
import type { BrowserPerformanceSnapshot } from "./browser-performance"

const DETAILS: PerformanceMetricName[] = ["firstTextMs", "generationMs", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "maxGapMs"]

export function PerformanceDetails({ snapshot }: { snapshot: BrowserPerformanceSnapshot }) {
  const t = useT()
  const labels = performanceLabels(t)
  const format = (n: number | undefined | null, metric: PerformanceMetricName) => formatPerformanceValue(n ?? null, metric, t("dash.perf.unknown"))
  const gaps = summarizeDistribution(snapshot.gaps)
  return <details className="mt-3 rounded-lg border border-themed px-3 py-2 text-xs text-themed-secondary">
    <summary className="cursor-pointer leading-relaxed" aria-label={t("dash.perf.details")}>
      <span className="font-medium">{t("dash.perf.browser")}</span>
      <span className="ml-2 text-themed-dim">{labels[snapshot.outcome]}</span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 mt-1 font-mono text-[11px]">
        <span>TTFT {format(snapshot.metrics.ttftMs, "ttftMs")}</span>
        <span>{t("dash.perf.overallTps")} {format(snapshot.metrics.overallTps, "overallTps")}</span>
        <span>{t("dash.perf.totalMs")} {format(snapshot.metrics.totalMs, "totalMs")}</span>
      </span>
    </summary>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mt-3 pt-3 border-t border-themed">
      {DETAILS.map(metric => <div key={metric} className="flex items-baseline justify-between gap-3">
        <dt className="text-themed-dim">{labels[metric]}</dt><dd className="font-mono whitespace-nowrap">{format(snapshot.metrics[metric], metric)}</dd>
      </div>)}
      <div className="flex items-baseline justify-between gap-3"><dt className="text-themed-dim">{t("dash.perf.gapMs")} P50 / P95</dt><dd className="font-mono whitespace-nowrap">{format(gaps.p50, "gapMs")} / {format(gaps.p95, "gapMs")} · n={gaps.count}</dd></div>
    </dl>
    <p className="mt-3 text-themed-dim leading-relaxed">{t("dash.perf.browserNote")}</p>
    <p className="mt-1 text-themed-dim leading-relaxed">{t("dash.perf.histogram")}</p>
  </details>
}
