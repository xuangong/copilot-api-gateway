import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { useT } from "../../state/i18n"
import { AUTO_REFRESH_MINUTES, loadIntervalMs, saveIntervalMs, useAutoRefresh } from "../../state/auto-refresh"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Select } from "../../ui/select"
import { Tooltip } from "../../ui/tooltip"

interface Props {
  /** True while a fetch is in flight; the button spins and won't re-enter. */
  loading: boolean
  lastUpdated: number | null
  onRefresh: () => void
}

/**
 * The usage tab's freshness controls: refetch now, or on a cadence.
 *
 * Sits in the page header's actions rather than with the metric and range
 * pickers in the toolbar. Those choose *what* is shown; this one is about
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
      {/* The span is the trigger: a disabled button fires no pointer events
          (and Button adds pointer-events-none), so the tip would never open
          while a fetch is running. */}
      <Tooltip content={t("dash.usage.refreshTip")} side="bottom">
        <span className="inline-flex" tabIndex={-1}>
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t("dash.usage.refreshTip")}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden="true" />
          </Button>
        </span>
      </Tooltip>

      <Select
        size="sm"
        className={cn("w-[124px]", auto && "border-brand-text text-brand-text")}
        value={String(Math.round(intervalMs / 60_000))}
        options={options}
        onChange={(v) => setIntervalMs(Number(v) * 60_000)}
        ariaLabel={t("dash.usage.autoRefreshLabel")}
      />

      {age ? (
        <span className="text-xs text-fg-subtle whitespace-nowrap">
          {t(age.key, age.n === undefined ? undefined : { n: age.n })}
        </span>
      ) : null}
    </div>
  )
}
