import type { MetricDistribution, PerformanceMetricName } from "@vibe-llm/protocols/common"
import { formatPerformanceValue, summarizeDistribution } from "../../state/performance-data"
import { performanceLabels } from "../../state/performance-labels"
import { useT } from "../../state/i18n"

const METRICS: PerformanceMetricName[] = [
  "overallTps", "firstTextMs", "ttftMs", "maxGapMs", "totalMs", "upstreamMs", "upstreamTps", "generationMs",
  "gapMs", "outputTokens", "reasoningTokens", "inputTokens", "cachedInputTokens",
]

export function PerformanceDiagnostics({ metrics, legacyRequests }: { metrics: Partial<Record<PerformanceMetricName, MetricDistribution>>; legacyRequests: number }) {
  const t = useT()
  const labels = performanceLabels(t)
  return <details className="border-t border-themed pt-4">
    <summary className="text-sm text-themed-secondary cursor-pointer w-fit focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">{t("dash.perf.experience.diagnostics")}</summary>
    <div className="mt-4 space-y-4">
      <div className="text-xs text-themed-dim space-y-2 max-w-[75ch] leading-relaxed">
        <p>{t("dash.perf.experience.samplesNote")}</p>
        <p>{t("dash.perf.histogram")}</p><p>{t("dash.perf.rateNote")}</p>
        {legacyRequests > 0 && <p>{t("dash.perf.legacy", { count: legacyRequests.toLocaleString() })}</p>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-themed" tabIndex={0} role="region" aria-label={t("dash.perf.experience.diagnostics")}>
        <table className="w-full text-sm whitespace-nowrap">
          <caption className="sr-only">{t("dash.perf.experience.diagnostics")}</caption>
          <thead className="bg-surface-800 text-xs text-themed-dim"><tr>
            <th scope="col" className="px-4 py-3 text-left">{t("dash.perf.metric")}</th>
            {[t("dash.perf.mean"), t("dash.perf.experience.p50"), t("dash.perf.experience.p95"), t("dash.perf.maximum"), t("dash.perf.samples")].map(label => <th scope="col" key={label} className="px-4 py-3 text-right font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{METRICS.map(metric => {
            const stats = summarizeDistribution(metrics[metric])
            return <tr key={metric} className="border-t border-themed hover:bg-surface-800/50">
              <th scope="row" className="px-4 py-3 text-left font-normal text-themed">{labels[metric]}</th>
              {[stats.mean, stats.p50, stats.p95, stats.max].map((n, index) => <td key={index} className={"px-4 py-3 text-right tabular-nums text-xs " + (n === null ? "text-themed-dim" : "text-themed-secondary")}>{formatPerformanceValue(n, metric, t("dash.perf.unknown"))}</td>)}
              <td className="px-4 py-3 text-right tabular-nums text-xs text-themed-dim">{stats.count.toLocaleString()}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </div>
  </details>
}
