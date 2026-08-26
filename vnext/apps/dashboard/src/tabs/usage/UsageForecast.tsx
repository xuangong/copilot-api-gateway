import { useMemo, useState } from "react"
import { DEFAULT_BUDGET_USD, rankForecastCandidates } from "../../state/usage-forecast"
import type { RollingStripCell } from "../../state/usage-strip"
import { useT } from "../../state/i18n"

interface Props {
  cells: RollingStripCell[]
  /** The run of days a row is pointing at, so the strip can light it up. */
  onHoverRun: (elapsed: number | null) => void
}

const money = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The three cheapest futures, given a 28-day budget.
 *
 * The user knows they are inside a 28-day window but not which day it opened
 * on, so this ranks every possible opening day by what it would leave for each
 * remaining day, and shows the three tightest. Hovering a row fades the rest of
 * the strip, leaving the run of days that reading assumes have already gone.
 */
export function UsageForecast({ cells, onHoverRun }: Props) {
  const t = useT()
  // Held as the typed string, not a number: parsing on every keystroke would
  // rewrite a half-deleted "1000" back into 100 under the cursor.
  const [budget, setBudget] = useState(String(DEFAULT_BUDGET_USD))
  const amount = Number(budget)
  const rows = useMemo(() => rankForecastCandidates(cells, amount), [cells, amount])
  if (cells.length === 0) return null

  return (
    <div className="ml-1" onMouseLeave={() => onHoverRun(null)}>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[10px] text-themed-dim uppercase tracking-widest">{t("dash.forecastTitle")}</span>
        <label htmlFor="usage-forecast-budget" className="text-[10px] text-themed-dim">
          {t("dash.forecastBudget")}
        </label>
        <input
          id="usage-forecast-budget"
          type="number"
          min="0"
          step="100"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="w-24 bg-surface-800 rounded-md px-2 py-1 text-xs text-themed border border-transparent focus:border-surface-600 outline-none"
        />
      </div>
      {/* Says what a row means. Without it the three numbers read as a forecast
          of what *will* happen rather than of what each hypothesis allows. */}
      <p className="text-[10px] text-themed-dim mb-1.5">{t("dash.forecastHint")}</p>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {rows.map((r, i) => (
          <button
            key={r.elapsed}
            type="button"
            // Focus as well as hover: the rows are the only way to drive the
            // highlight, so a keyboard has to be able to reach it too.
            onMouseEnter={() => onHoverRun(r.elapsed)}
            onFocus={() => onHoverRun(r.elapsed)}
            onBlur={() => onHoverRun(null)}
            className="text-left rounded-md bg-surface-800 border border-transparent hover:border-amber-400/60 focus:border-amber-400/60 outline-none px-2.5 py-2 transition-all"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] text-themed-dim">#{i + 1}</span>
              <span className="text-[10px] text-themed-secondary">{r.startLabel}</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span
                className={`text-base font-bold font-mono ${r.overspent ? "text-red-400" : "text-themed"}`}
              >
                {money(r.dailyUSD)}
              </span>
              <span className="text-[10px] text-themed-dim">{t("dash.forecastPerDay")}</span>
            </div>
            <div className="text-[10px] text-themed-dim mt-0.5">
              {t("dash.forecastDetail", {
                days: r.elapsed,
                spent: money(r.spentUSD),
                left: r.remainingDays,
              })}
            </div>
            {/* The floored figure alone cannot tell a window that lands exactly
                on nothing from one that is thousands past it. */}
            {r.overspent ? (
              <div className="text-[10px] text-red-400/80">
                {t("dash.forecastOver", { over: money(r.spentUSD - amount) })}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
