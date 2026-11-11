import type { MetricDistribution, PerformanceMetricName } from "@vibe-llm/protocols/common"
import { ChevronRight } from "lucide-react"
import { formatPerformanceValue, summarizeDistribution } from "../../state/performance-data"
import { performanceLabels } from "../../state/performance-labels"
import { useT } from "../../state/i18n"
import { Card } from "../../ui/card"
import { TBody, Table, Td, Th } from "../../ui/table"

const METRICS: PerformanceMetricName[] = [
  "overallTps", "firstTextMs", "ttftMs", "maxGapMs", "totalMs", "upstreamMs", "upstreamTtftMs", "upstreamTps", "generationMs",
  "gapMs", "outputTokens", "reasoningTokens", "inputTokens", "cachedInputTokens",
]

export function PerformanceDiagnostics({ metrics, legacyRequests }: { metrics: Partial<Record<PerformanceMetricName, MetricDistribution>>; legacyRequests: number }) {
  const t = useT()
  const labels = performanceLabels(t)
  return <Card>
    <details className="group">
      <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        {t("dash.perf.experience.diagnostics")}
      </summary>
      <div className="mt-4 space-y-4">
        <div className="text-xs text-fg-subtle space-y-2 max-w-[75ch] leading-relaxed">
          <p>{t("dash.perf.experience.samplesNote")}</p>
          <p>{t("dash.perf.histogram")}</p><p>{t("dash.perf.rateNote")}</p>
          <p>{t("dash.perf.upstreamTtftNote")}</p>
          {legacyRequests > 0 && <p>{t("dash.perf.legacy", { count: legacyRequests.toLocaleString() })}</p>}
        </div>
        <Table label={t("dash.perf.experience.diagnostics")} className="whitespace-nowrap">
          <caption className="sr-only">{t("dash.perf.experience.diagnostics")}</caption>
          <thead><tr>
            <Th>{t("dash.perf.metric")}</Th>
            {[t("dash.perf.mean"), t("dash.perf.experience.p50"), t("dash.perf.experience.p95"), t("dash.perf.maximum"), t("dash.perf.samples")].map(label => <Th numeric key={label}>{label}</Th>)}
          </tr></thead>
          <TBody>{METRICS.map(metric => {
            const stats = summarizeDistribution(metrics[metric])
            return <tr key={metric} className="hover:bg-muted">
              <Th row>{labels[metric]}</Th>
              {[stats.mean, stats.p50, stats.p95, stats.max].map((n, index) => <Td numeric key={index} className={"text-xs " + (n === null ? "text-fg-subtle" : "text-fg-muted")}>{formatPerformanceValue(n, metric, t("dash.perf.unknown"))}</Td>)}
              <Td numeric className="text-xs text-fg-subtle">{stats.count.toLocaleString()}</Td>
            </tr>
          })}</TBody>
        </Table>
      </div>
    </details>
  </Card>
}
