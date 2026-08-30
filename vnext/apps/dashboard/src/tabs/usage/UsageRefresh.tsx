import { useEffect, useState } from "react"
import { Select } from "../../components/Select"
import { useT } from "../../state/i18n"
import { AUTO_REFRESH_MINUTES, loadIntervalMs, saveIntervalMs, useAutoRefresh } from "../../state/auto-refresh"

interface Props {
  /** True while a fetch is in flight; the button spins and won't re-enter. */
  loading: boolean
  lastUpdated: number | null
  onRefresh: () => void
}

/**
 * The usage tab's freshness controls: refetch now, or on a cadence.
 *
 * Sits beside the "USAGE" heading rather than with the metric and range
 * pickers on the right. Those choose *what* is shown; this one is about
 * whether what's shown is still true — the same question the loading spinner
 * it replaces was answering, in the same spot.
 *
 * The age line is not decoration. Without it an auto-refresh that has silently
 * stopped — a dead session, a tab the browser froze — looks exactly like one
 * that is working, and the whole point of the feature is trusting the numbers.
 */
export function UsageRefresh({ loading, lastUpdated, onRefresh }: Props) {
  const t = useT()
  const [intervalMs, setIntervalMs] = useState(loadIntervalMs)
  useEffect(() => {
    saveIntervalMs(intervalMs)
  }, [intervalMs])

  const age = useAutoRefresh({ intervalMs, lastUpdated, busy: loading, onRefresh })
  const auto = intervalMs > 0

  const options = AUTO_REFRESH_MINUTES.map((m) => ({
    value: String(m),
    label: m === 0 ? t("dash.usage.autoOff") : t("dash.usage.autoEvery", { n: m }),
  }))

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="tip tip-start tip-below flex items-center justify-center w-7 h-7 rounded-md bg-surface-800 border border-white/10 text-themed-dim hover:text-accent-violet hover:border-accent-violet/40 disabled:opacity-50 disabled:cursor-default transition-colors"
        data-tip={t("dash.usage.refreshTip")}
        aria-label={t("dash.usage.refreshTip")}
      >
        <svg
          className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>

      <Select
        className="w-[124px]"
        value={String(Math.round(intervalMs / 60_000))}
        options={options}
        onChange={(v) => setIntervalMs(Number(v) * 60_000)}
        buttonClassName={`w-full bg-surface-800 border rounded-md focus:outline-none flex items-center justify-between gap-2 text-left px-2.5 py-1.5 text-xs ${
          auto ? "border-accent-violet/40 text-accent-violet" : "border-white/10 text-themed-secondary"
        }`}
      />

      {age ? (
        <span className="text-[11px] text-themed-dim whitespace-nowrap">
          {t(age.key, age.n === undefined ? undefined : { n: age.n })}
        </span>
      ) : null}
    </div>
  )
}
