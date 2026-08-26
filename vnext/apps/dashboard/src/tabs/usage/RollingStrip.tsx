import { useRef, useState } from "react"
import { COST_ANCHOR_WINDOW, costShadeLevel, dayFillRatio, type RollingStripCell } from "../../state/usage-strip"
import { useT } from "../../state/i18n"

interface Props {
  cells: RollingStripCell[]
  /** The day the window currently closes on, so the strip can mark it. */
  selectedKey: string | null
  /**
   * How many squares at the end of the strip to pick out — the run of days a
   * forecast row is hovering. Null or zero leaves the strip alone.
   */
  highlightTail?: number | null
  isDark: boolean
  onPick: (endKey: string) => void
}

/**
 * GitHub's contribution-graph ramp, borrowed wholesale. Five steps rather than a
 * continuous gradient because the eye reads a handful of distinct shades far
 * better than a smooth one, and these particular five are already tuned to stay
 * apart on both backgrounds.
 */
const SHADES_DARK = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"]
const SHADES_LIGHT = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"]

const money = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Where the tooltip should sit, measured against the wrapper on hover. */
interface Hover {
  index: number
  cx: number
  top: number
}

/**
 * A row of squares, one per closing day, each holding the *rolling* 28-day
 * totals that end on it — not that day's own usage. Shaded by cost on an
 * absolute scale so a colour keeps its meaning when the filters change; hovering
 * a square floats its cost and tokens above it, and clicking closes the window
 * on that day.
 */
export function RollingStrip({ cells, selectedKey, highlightTail, isDark, onPick }: Props) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  if (cells.length === 0) return null
  const shades = isDark ? SHADES_DARK : SHADES_LIGHT
  const shown = hover ? cells[hover.index] : null
  // The fill is measured against the busiest day *on screen*, so it has to be
  // taken from the cells themselves rather than from a constant.
  const peakDay = cells.reduce((m, c) => (c.dayCostUSD > m ? c.dayCostUSD : m), 0)
  // A ring on the run would be lost among ninety squares that already carry
  // rings; fading everything else is what makes a stretch of days readable at
  // this size. The run always ends on today, so a count is enough to place it.
  const tail = highlightTail && highlightTail > 0 ? highlightTail : 0
  const litFrom = cells.length - tail

  // Measured rather than derived from the index: the squares are flex-sized, so
  // their width depends on the card and a computed offset would drift.
  const track = (index: number) => (e: { currentTarget: HTMLElement }) => {
    const wrap = wrapRef.current
    if (!wrap) return
    const r = e.currentTarget.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    // Kept clear of the edges so the first and last squares do not push their
    // tooltip off the card.
    const cx = Math.min(Math.max(r.left - w.left + r.width / 2, 70), Math.max(w.width - 70, 70))
    setHover({ index, cx, top: r.top - w.top })
  }

  return (
    <div ref={wrapRef} className="ml-1 relative">
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <span className="text-[10px] text-themed-dim uppercase tracking-widest">{t("dash.rollingTotal")}</span>
        {/* Says out loud what a square means; without it the strip reads as a
            daily activity graph, which is a different number entirely. */}
        <span className="text-[10px] text-themed-dim">{t("dash.rollingTotalHint")}</span>
      </div>
      {/* Wraps rather than shrinks, and never goes wider than forty-five. Ninety
          squares in one row sounds like the best reading of the trend, but at
          any real card width it leaves each square around a dozen pixels — too
          small to judge a fill height against its neighbour, which is the whole
          point. Two rows of forty-five is the widest that still reads, so the
          fold runs 45 / 30 / 15. Every count divides ninety exactly, so the rows
          are always whole and none is left half-empty. aspect-square keeps them
          square at whatever width the column works out to. */}
      <div
        className="grid gap-[2px] w-full grid-cols-[repeat(15,minmax(0,1fr))] sm:grid-cols-[repeat(30,minmax(0,1fr))] lg:grid-cols-[repeat(45,minmax(0,1fr))]"
        onMouseLeave={() => setHover(null)}
      >
        {cells.map((c, i) => {
          // Two readings on one square: the outline is the 28-day total on an
          // absolute scale, the fill is the closing day against the busiest day
          // here. Drawn as a hard-stopped gradient rather than a nested element
          // so a square stays a single node — there are ninety of them.
          const shade = shades[costShadeLevel(c.costUSD)]!
          const pct = Math.round(dayFillRatio(c.dayCostUSD, peakDay) * 100)
          const lit = tail > 0 && i >= litFrom
          return (
            <button
              key={c.endKey}
              type="button"
              aria-label={`${c.label}: ${money(c.costUSD)} over 28 days, ${money(c.dayCostUSD)} that day, ${c.tokens.toLocaleString()} tokens`}
              onMouseEnter={track(i)}
              onFocus={track(i)}
              onBlur={() => setHover(null)}
              onClick={() => onPick(c.endKey)}
              style={{
                borderColor: shade,
                // Left transparent above the fill so the card reads through,
                // which keeps the outline legible against its own interior.
                backgroundImage: pct > 0 ? `linear-gradient(to top, ${shade} ${pct}%, transparent ${pct}%)` : "none",
              }}
              className={`aspect-square rounded-[2px] border transition-all ${
                tail > 0 && !lit ? "opacity-20 " : ""
              }${
                lit
                  ? "ring-1 ring-amber-400"
                  : c.endKey === selectedKey
                    ? "ring-1 ring-white/70"
                    : "hover:ring-1 hover:ring-white/40"
              }`}
            />
          )
        })}
      </div>
      {/* Floated over the square itself, and pointer-events-none so it can never
          steal the hover from the square it is describing. The background is a
          solid token, not a translucent one: the surface colours are bare
          var(--...) with no <alpha-value> placeholder, so bg-surface-900/95 and
          friends emit a declaration the browser drops — leaving it see-through. */}
      {shown ? (
        <div
          style={{ left: hover!.cx, top: hover!.top - 6 }}
          className="absolute -translate-x-1/2 -translate-y-full z-20 pointer-events-none whitespace-nowrap rounded-md bg-surface-700 border border-surface-500 px-2 py-1 shadow-lg"
        >
          <div className="text-[10px] text-themed-dim">{shown.label}</div>
          <div className="text-[11px] text-themed font-medium">{money(shown.costUSD)}</div>
          <div className="text-[10px] text-themed-secondary">{shown.tokens.toLocaleString()} tokens</div>
          {/* The fill has no legend of its own — the square only shows a height,
              so the number behind it has to be readable somewhere. */}
          <div className="text-[10px] text-themed-dim mt-0.5 pt-0.5 border-t border-surface-500">
            {`${t("dash.rollingThatDay")} ${money(shown.dayCostUSD)} · ${shown.dayTokens.toLocaleString()} tokens`}
          </div>
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1 mt-1 text-[10px] text-themed-dim">
        {/* The legend is what makes the scale absolute rather than decorative:
            it names the spend the darkest square stands for. */}
        <span>{t("dash.rollingLess")}</span>
        {shades.map((s, i) => (
          <span key={i} style={{ backgroundColor: s }} className="h-2.5 w-2.5 rounded-[2px] inline-block" />
        ))}
        <span>{`${t("dash.rollingMore")} ≥ $${COST_ANCHOR_WINDOW.toLocaleString()}/${t("dash.rollingPerDay")}`}</span>
      </div>
    </div>
  )
}
