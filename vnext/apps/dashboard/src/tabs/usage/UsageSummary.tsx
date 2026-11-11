import { useRef, useState, type ReactNode } from "react"
import { Info } from "lucide-react"
import { computeWeightedTokens } from "@vibe-llm/protocols/quota"
import type { UsageSummary } from "../../state/usage"
import { WEIGHTED_FORMULA_PARTS, formatWeight } from "../../components/weighted-formula"
import { useT } from "../../state/i18n"
import { Tooltip } from "../../ui/tooltip"

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
    // what a month of traffic does: thirteen digits at text-lg needs
    // roughly twice the width an eighth of a card leaves it. Two rows of four
    // fits the widest number these cards can hold.
    //
    // The fold to two happens at md rather than sm because four across at 640px
    // is back inside the overlapping range; below that the phone gets four rows
    // of two, each with half the card to itself.
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-5 border-t border-border">
      <Cell label={t("dash.requests")} value={fmt(summary.requests)} />
      <Cell label={t("dash.totalInput")} value={fmt(totalInput)} note={t("dash.uncachedCacheNote")} />
      <Cell label={t("dash.cacheRead")} value={fmt(summary.cacheRead)} note={hitPct} valueClass="text-success" />
      <Cell label={t("dash.cacheCreation")} value={fmt(summary.cacheCreation)} />
      <Cell label={t("dash.uncachedInput")} value={fmt(summary.input)} />
      <Cell label={t("dash.output")} value={fmt(summary.output)} />
      <Cell
        label={t("dash.totalTokens")}
        value={fmt(totalTokens)}
        info={
          // Drawn on the tooltip's inverted surface (bg-fg), so the text uses
          // the background colour rather than the page's foreground tokens.
          <div className="p-1.5 text-left">
            <div className="flex items-center justify-between gap-6 pb-2 mb-2 border-b border-background/20">
              <span className="text-background/80">{t("dash.weightedTotalTokens")}</span>
              <span className="tabular-nums font-bold">{fmt(Math.round(weighted))}</span>
            </div>
            {WEIGHTED_FORMULA_PARTS.map((part) => (
              <div key={part.labelKey} className="flex items-center justify-between gap-6 leading-5">
                <span className="text-background/80">{t(part.labelKey)}</span>
                <span className="tabular-nums">{formatWeight(part.weight)}</span>
              </div>
            ))}
          </div>
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
  valueClass = "text-fg",
  info,
}: {
  label: string
  value: string
  note?: string
  valueClass?: string
  info?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Whether the tooltip was open when the press began. Radix closes an open
  // tooltip on pointerdown, before click runs, so toggling the state seen at
  // click time would reopen it and a second tap could never close it.
  const openAtPress = useRef<boolean | null>(null)
  return (
    <div className="text-center">
      <p className="text-xs text-fg-subtle mb-1 flex items-center justify-center gap-1">
        {label}
        {info ? (
          // A real button so the label has a role to sit on; the portalled
          // tooltip opens on hover and on keyboard focus alike.
          <Tooltip content={info} side="bottom" open={open} onOpenChange={setOpen}>
            <button
              type="button"
              aria-label={label}
              onPointerDown={() => {
                openAtPress.current = open
              }}
              // Radix never opens a tooltip on touch, so a tap toggles it here
              // instead; preventDefault stops Radix's own close-on-click. A
              // keyboard click has no pointerdown and toggles the current state.
              onClick={(e) => {
                e.preventDefault()
                setOpen(!(openAtPress.current ?? open))
                openAtPress.current = null
              }}
              className="inline-flex cursor-help rounded-sm text-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
            >
              <Info aria-hidden="true" className="size-3.5" />
            </button>
          </Tooltip>
        ) : null}
      </p>
      <p className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
      {note ? <p className="text-xs text-fg-subtle mt-0.5">{note}</p> : null}
    </div>
  )
}
