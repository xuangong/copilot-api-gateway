import { useEffect, useState } from "react"
import { getCodexQuota } from "../../api/upstreams"
import { useT } from "../../state/i18n"
import { CodexQuotaReader, type QuotaReadState } from "./codex-quota-read"

export function CodexQuotaPanel({ upstreamId }: { upstreamId: string }) {
  // Keying the child by identity prevents even a single render of another
  // account's data before its effect cleanup runs.
  return <QuotaPanel key={upstreamId} upstreamId={upstreamId} />
}

function QuotaPanel({ upstreamId }: { upstreamId: string }) {
  const t = useT()
  const [reader] = useState(() => new CodexQuotaReader())
  const [state, setState] = useState<QuotaReadState>({ status: "loading" })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    void reader.read(upstreamId, getCodexQuota, setState)
    return () => reader.cancel()
  }, [reader, upstreamId, revision])
  const unknown = t("dash.codexQuotaUnknown")
  const percent = (value: number | undefined) => value === undefined ? unknown : `${value}%`
  const date = (value: string | number) => new Date(value).toLocaleString()
  return (
    <section data-testid="codex-quota-panel" data-upstream-id={upstreamId} className="mt-3 border-t border-themed pt-3 text-xs space-y-2" aria-label={t("dash.codexQuotaTitle")}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium text-themed">{t("dash.codexQuotaTitle")}</h4>
        <button type="button" data-testid="codex-quota-reload" className="btn-ghost text-xs" disabled={state.status === "loading"}
          onClick={() => setRevision(value => value + 1)}>{t("dash.codexQuotaReload")}</button>
      </div>
      <p className="text-themed-dim">{t("dash.codexQuotaHint")}</p>
      <div data-testid="codex-quota-status" aria-live="polite">
        {state.status === "loading" ? <p>{t("dash.loadingShort")}</p> : null}
        {state.status === "error" ? <p role="alert" className="text-accent-red">{t("dash.codexQuotaFailed")}</p> : null}
        {state.status === "ready" && state.result.quota === null ? <p>{t("dash.codexQuotaMissing")}</p> : null}
      </div>
      {state.status === "ready" && state.result.quota ? Object.entries(state.result.quota).map(([key, observation]) => (
        <div key={key} data-testid="codex-quota-bucket" data-active-limit={key} data-freshness={observation.freshness} className="rounded border border-themed p-2 space-y-1">
          <div className="font-medium text-themed">{key} · {t(observation.freshness === "stale" ? "dash.codexQuotaStale" : "dash.codexQuotaFresh")}</div>
          <div>{t("dash.codexQuotaPrimary")}: {percent(observation.data.primary_used_percent)} · {t("dash.codexQuotaSecondary")}: {percent(observation.data.secondary_used_percent)}</div>
          <div>{t("dash.codexQuotaCredits")}: {observation.data.credits_balance ?? unknown}</div>
          <div className="text-themed-dim">{t("dash.codexQuotaObserved", { at: date(observation.observedAt) })}</div>
          <div className="text-themed-dim">{t("dash.codexQuotaReceived", { at: date(observation.fetchedAt), until: date(observation.freshUntil) })}</div>
          {observation.data.primary_reset_after_at ? <div>{t("dash.codexQuotaPrimaryReset", { at: date(observation.data.primary_reset_after_at) })}</div> : null}
          {observation.data.secondary_reset_after_at ? <div>{t("dash.codexQuotaSecondaryReset", { at: date(observation.data.secondary_reset_after_at) })}</div> : null}
        </div>
      )) : null}
    </section>
  )
}
