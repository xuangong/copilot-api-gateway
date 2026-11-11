import { comparisonGroups, formatPerformanceValue, summarizeDistribution } from "../../state/performance-data"
import { performanceLabels } from "../../state/performance-labels"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { TBody, Table, Td, Th } from "../../ui/table"

const METRICS = ["overallTps", "firstTextMs", "maxGapMs", "totalMs"] as const

export function ModelComparison({ groups }: { groups: ReturnType<typeof comparisonGroups> }) {
  const t = useT()
  const labels = performanceLabels(t)
  return <Card>
    <SectionHeading>{t("dash.perf.comparison")}</SectionHeading>
    <p className="text-xs text-fg-subtle mt-1 mb-3 leading-relaxed">{t("dash.perf.experience.compareHint")}</p>
    <Table label={t("dash.perf.comparison")}>
      <thead><tr>
        <Th className="min-w-[180px]">{t("dash.perf.model")}</Th>
        {METRICS.map(metric => <Th numeric key={metric} className="whitespace-nowrap">{labels[metric]}</Th>)}
      </tr></thead>
      <TBody>{groups.map(group => <tr key={group.id} className="hover:bg-muted">
        <Th row className="align-top">
          <div className="text-fg font-medium text-sm break-all">{group.model}</div>
          <div className="text-xs text-fg-subtle mt-1 break-all">{group.upstream ?? t("dash.perf.unknown")}</div>
          <div className="text-xs text-fg-subtle mt-1 tabular-nums">{group.sourceApi} → {group.targetApi} · {group.requests.toLocaleString()} {t("dash.perf.requests")}</div>
        </Th>
        {METRICS.map(metric => {
          const stats = summarizeDistribution(group.metrics[metric])
          return <Td numeric key={metric} className="align-top whitespace-nowrap text-fg-muted">
            {formatPerformanceValue(stats.mean, metric, t("dash.perf.unknown"))}
            <div className="text-xs text-fg-subtle mt-1">n={stats.count.toLocaleString()}</div>
          </Td>
        })}
      </tr>)}</TBody>
    </Table>
  </Card>
}
