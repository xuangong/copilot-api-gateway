import { useEffect, useState } from "react"
import { useAuth } from "../../state/auth"
import { useT, t as tStatic } from "../../state/i18n"
import { useClients } from "../../state/clients"
import type { RelayClient } from "../../api/clients"

function timeAgo(dateStr: string | null | undefined, now: number): string | null {
  if (!dateStr) return null
  const date = new Date(dateStr).getTime()
  const seconds = Math.floor((now - date) / 1000)
  if (seconds < 60) return tStatic("dash.justNow")
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes === 1 ? tStatic("dash.oneMinuteAgo") : tStatic("dash.minutesAgo", { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? tStatic("dash.oneHourAgo") : tStatic("dash.hoursAgo", { n: hours })
  const days = Math.floor(hours / 24)
  if (days <= 30) return days === 1 ? tStatic("dash.oneDayAgo") : tStatic("dash.daysAgo", { n: days })
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function ClientsTab() {
  const { session } = useAuth()
  const isAdmin = !!session?.isAdmin
  const { clients, loading, reload } = useClients()
  const t = useT()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="glass-card p-4 sm:p-6 animate-in">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.relayClientsLabel")}</span>
        <button onClick={reload} disabled={loading} className="btn-ghost text-xs" aria-label={t("dash.refreshLabel")}>
          <svg
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {loading && clients.length === 0 ? (
        <div className="text-center py-8 text-themed-dim text-sm">{t("dash.loadingShort")}</div>
      ) : null}
      {!loading && clients.length === 0 ? (
        <div className="text-center py-8 text-themed-dim text-sm">{t("dash.noRelayClientsConnected")}</div>
      ) : null}

      {clients.length > 0 ? (
        <div className="space-y-2">
          {clients.map((c) => (
            <ClientRow key={c.clientId} client={c} isAdmin={isAdmin} now={now} />
          ))}
        </div>
      ) : null}

      <p className="text-[11px] text-themed-dim mt-4">
        {t("dash.relayStatusLegend")}
      </p>
    </div>
  )
}

function ClientRow({ client: c, isAdmin, now }: { client: RelayClient; isAdmin: boolean; now: number }) {
  const t = useT()
  const dotClass = c.isActive
    ? "bg-accent-teal status-pulse"
    : c.isOnline
      ? "bg-accent-violet"
      : "bg-surface-600"

  return (
    <div className="flex items-center justify-between gap-3 p-4 rounded-lg bg-surface-800/50 border border-white/[0.04]">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="relative shrink-0">
          <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center">
            <svg className="w-4 h-4 text-themed-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </div>
          <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface-800 ${dotClass}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-themed truncate">
              {c.clientName || c.clientLabel || c.clientId}
            </span>
            {c.isActive ? (
              <span className="shrink-0 text-[10px] font-medium text-accent-teal uppercase tracking-widest">{t("dash.activeLabel")}</span>
            ) : c.isOnline ? (
              <span className="shrink-0 text-[10px] font-medium text-accent-violet uppercase tracking-widest">{t("dash.onlineLabel")}</span>
            ) : (
              <span className="shrink-0 text-[10px] font-medium text-themed-dim uppercase tracking-widest">{t("dash.offlineLabel")}</span>
            )}
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 mt-0.5 flex-wrap min-w-0">
            {c.keyName ? (
              <span className="text-xs text-themed-dim flex items-center gap-1 min-w-0">
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
                <span className="truncate">{c.keyName}</span>
              </span>
            ) : null}
            {isAdmin && c.ownerId ? (
              <span className="text-xs text-themed-dim truncate">
                {t("dash.ownerLabel") + (c.ownerName || c.ownerId.slice(0, 8))}
              </span>
            ) : null}
            {c.gatewayUrl ? (
              <span
                className="text-xs text-themed-dim font-mono truncate max-w-full sm:max-w-[160px]"
                title={c.gatewayUrl}
              >
                {c.gatewayUrl.replace(/https?:\/\//, "")}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0">
        <span className="text-xs text-themed-dim whitespace-nowrap" title={c.lastSeenAt}>
          {timeAgo(c.lastSeenAt, now)}
        </span>
      </div>
    </div>
  )
}
