import type { UsageSummary } from "../../state/usage"
import { useT } from "../../state/i18n"

interface Props {
  summary: UsageSummary
}

function fmt(n: number): string {
  return n.toLocaleString()
}

export function UsageSummaryCards({ summary }: Props) {
  const t = useT()
  const totalInput = summary.input + summary.cacheRead + summary.cacheCreation
  const totalTokens = totalInput + summary.output
  const hitPct = totalInput > 0 ? ((summary.cacheRead / totalInput) * 100).toFixed(1) + "% " + t("dash.cacheHitSuffix") : ""
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4 mt-6 pt-5 border-t border-white/5">
      <Cell label={t("dash.requests")} value={fmt(summary.requests)} />
      <Cell label={t("dash.totalInput")} value={fmt(totalInput)} note={t("dash.uncachedCacheNote")} />
      <Cell label={t("dash.cacheRead")} value={fmt(summary.cacheRead)} note={hitPct} valueClass="text-green-400" />
      <Cell label={t("dash.cacheCreation")} value={fmt(summary.cacheCreation)} />
      <Cell label={t("dash.uncachedInput")} value={fmt(summary.input)} />
      <Cell label={t("dash.output")} value={fmt(summary.output)} />
      <Cell label={t("dash.totalTokens")} value={fmt(totalTokens)} />
      <Cell label={t("dash.cost")} value={summary.costUSD > 0 ? "$" + summary.costUSD.toFixed(4) : "—"} />
    </div>
  )
}

function Cell({
  label,
  value,
  note,
  valueClass = "text-themed",
}: {
  label: string
  value: string
  note?: string
  valueClass?: string
}) {
  return (
    <div className="text-center">
      <p className="text-xs text-themed-dim mb-1">{label}</p>
      <p className={`text-lg font-bold font-mono ${valueClass}`}>{value}</p>
      {note ? <p className="text-[10px] text-themed-dim mt-0.5">{note}</p> : null}
    </div>
  )
}
