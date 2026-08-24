import type { ReactNode } from "react"
import { computeWeightedTokens } from "@vibe-llm/protocols/quota"
import type { UsageSummary } from "../../state/usage"
import { WEIGHTED_FORMULA_PARTS, formatWeight } from "../../components/weighted-formula"
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
  const weighted = computeWeightedTokens(summary.cacheRead, summary.cacheCreation, summary.input, summary.output)
  return (
    // Four across at most, never eight. A grid cell does not clip its contents,
    // so an eighth of the card is not a budget the number respects — it just
    // overflows both ways and lands on top of its neighbours, which is exactly
    // what a month of traffic does: thirteen digits of mono at text-lg needs
    // roughly twice the width an eighth of a card leaves it. Two rows of four
    // fits the widest number these cards can hold.
    //
    // The fold to two happens at md rather than sm because four across at 640px
    // is back inside the overlapping range; below that the phone gets four rows
    // of two, each with half the card to itself.
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-5 border-t border-white/5">
      <Cell label={t("dash.requests")} value={fmt(summary.requests)} />
      <Cell label={t("dash.totalInput")} value={fmt(totalInput)} note={t("dash.uncachedCacheNote")} />
      <Cell label={t("dash.cacheRead")} value={fmt(summary.cacheRead)} note={hitPct} valueClass="text-green-400" />
      <Cell label={t("dash.cacheCreation")} value={fmt(summary.cacheCreation)} />
      <Cell label={t("dash.uncachedInput")} value={fmt(summary.input)} />
      <Cell label={t("dash.output")} value={fmt(summary.output)} />
      <Cell
        label={t("dash.totalTokens")}
        value={fmt(totalTokens)}
        info={
          <>
            <div className="flex items-center justify-between gap-6 pb-2 mb-2 border-b border-white/10">
              <span className="text-themed-secondary">{t("dash.weightedTotalTokens")}</span>
              <span className="font-mono font-bold text-themed">{fmt(Math.round(weighted))}</span>
            </div>
            {WEIGHTED_FORMULA_PARTS.map((part) => (
              <div key={part.labelKey} className="flex items-center justify-between gap-6 leading-5">
                <span className="text-themed-dim">{t(part.labelKey)}</span>
                <span className={`font-mono ${part.colorClass}`}>{formatWeight(part.weight)}</span>
              </div>
            ))}
          </>
        }
      />
      <Cell label={t("dash.cost")} value={summary.costUSD > 0 ? "$" + summary.costUSD.toFixed(4) : "—"} />
    </div>
  )
}

function Cell({
  label,
  value,
  note,
  valueClass = "text-themed",
  info,
}: {
  label: string
  value: string
  note?: string
  valueClass?: string
  info?: ReactNode
}) {
  return (
    <div className="text-center">
      <p className="text-xs text-themed-dim mb-1 flex items-center justify-center gap-1">
        {label}
        {info ? (
          // Hover/focus only, no React state: the dashboard has no popover
          // primitive and this needs no interaction beyond reveal.
          <span className="relative inline-flex group">
            <span tabIndex={0} className="cursor-help text-themed-dim hover:text-themed outline-none" aria-label={label}>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 011-1h.01a1 1 0 01.99 1.14l-.5 3.5a.5.5 0 01-.99 0l-.5-3.5A1 1 0 019 9zm1-3.25a1 1 0 110 2 1 1 0 010-2z"
                  clipRule="evenodd"
                />
              </svg>
            </span>
            <span className="absolute hidden group-hover:block group-focus-within:block z-20 left-1/2 -translate-x-1/2 top-full mt-2 w-max rounded-lg border border-white/10 bg-surface-800 shadow-xl p-3 text-[11px] text-left">
              {info}
            </span>
          </span>
        ) : null}
      </p>
      <p className={`text-lg font-bold font-mono ${valueClass}`}>{value}</p>
      {note ? <p className="text-[10px] text-themed-dim mt-0.5">{note}</p> : null}
    </div>
  )
}
