import { comparisonGroups, formatPerformanceValue, summarizeDistribution } from "../../state/performance-data"
import { performanceLabels } from "../../state/performance-labels"
import { useT } from "../../state/i18n"

const METRICS = ["overallTps", "firstTextMs", "maxGapMs", "totalMs"] as const

export function ModelComparison({ groups }: { groups: ReturnType<typeof comparisonGroups> }) {
  const t = useT()
  const labels = performanceLabels(t)
  return <section>
    <h3 className="text-sm font-semibold text-themed">{t("dash.perf.comparison")}</h3>
    <p className="text-xs text-themed-dim mt-1 mb-3 leading-relaxed">{t("dash.perf.experience.compareHint")}</p>
    <div className="overflow-x-auto rounded-lg border border-themed" tabIndex={0} role="region" aria-label={t("dash.perf.comparison")}>
      <table className="w-full text-sm">
        <thead className="bg-surface-800 text-xs text-themed-dim"><tr>
          <th scope="col" className="px-4 py-3 text-left min-w-[180px]">{t("dash.perf.model")}</th>
          {METRICS.map(metric => <th scope="col" key={metric} className="px-4 py-3 text-right font-medium whitespace-nowrap">{labels[metric]}</th>)}
        </tr></thead>
        <tbody>{groups.map(group => <tr key={group.id} className="border-t border-themed hover:bg-surface-800/50">
          <th scope="row" className="px-4 py-3 text-left font-normal">
            <div className="text-themed font-medium text-sm break-all">{group.model}</div>
            <div className="text-xs text-themed-dim mt-1 break-all">{group.upstream ?? t("dash.perf.unknown")}</div>
            <div className="text-xs text-themed-dim mt-1">{group.sourceApi} → {group.targetApi} · {group.requests.toLocaleString()} {t("dash.perf.requests")}</div>
          </th>
          {METRICS.map(metric => {
            const stats = summarizeDistribution(group.metrics[metric])
            return <td key={metric} className="px-4 py-3 text-right tabular-nums text-sm whitespace-nowrap text-themed-secondary">
              {formatPerformanceValue(stats.mean, metric, t("dash.perf.unknown"))}
              <div className="text-xs text-themed-dim mt-1">n={stats.count.toLocaleString()}</div>
            </td>
          })}
        </tr>)}</tbody>
      </table>
    </div>
  </section>
}
