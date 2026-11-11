import { useEffect, useState } from "react"
import { useAuth } from "../../state/auth"
import { useT, t as tStatic } from "../../state/i18n"
import { useClients } from "../../state/clients"
import type { RelayClient } from "../../api/clients"
import { KeyRound, Monitor, RefreshCw } from "lucide-react"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { EmptyState } from "../../ui/empty-state"
import { PageHeader } from "../../ui/page-header"

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
    <div>
      <PageHeader
        title={t("dash.relays")}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={reload}
            disabled={loading}
            title={t("dash.refreshLabel")}
            aria-label={t("dash.refreshLabel")}
          >
            <RefreshCw className={cn(loading && "animate-spin")} aria-hidden="true" />
          </Button>
        }
      />

      <Card>
        <SectionHeading className="mb-3">{t("dash.relayClientsLabel")}</SectionHeading>

        {loading && clients.length === 0 ? (
          <p className="py-8 text-center text-sm text-fg-muted">{t("dash.loadingShort")}</p>
        ) : null}
        {!loading && clients.length === 0 ? <EmptyState title={t("dash.noRelayClientsConnected")} /> : null}

        {clients.length > 0 ? (
          <div className="space-y-2">
            {clients.map((c) => (
              <ClientRow key={c.clientId} client={c} isAdmin={isAdmin} now={now} />
            ))}
          </div>
        ) : null}

        <p className="mt-4 text-xs text-fg-subtle">
          {t("dash.relayStatusLegend")}
        </p>
      </Card>
    </div>
  )
}

function ClientRow({ client: c, isAdmin, now }: { client: RelayClient; isAdmin: boolean; now: number }) {
  const t = useT()
  const dotClass = c.isOnline ? "bg-success animate-pulse" : "bg-fg-subtle"

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel p-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="relative shrink-0">
          <div className="flex size-8 items-center justify-center rounded-md bg-muted">
            <Monitor className="size-4 text-fg-muted" aria-hidden="true" />
          </div>
          <div className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-panel ${dotClass}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">
              {c.clientName || c.clientLabel || c.clientId}
            </span>
            {c.isOnline ? (
              <span className="shrink-0 text-xs font-medium tracking-wide text-success uppercase">{t("dash.onlineLabel")}</span>
            ) : (
              <span className="shrink-0 text-xs font-medium tracking-wide text-fg-subtle uppercase">{t("dash.offlineLabel")}</span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {c.keyName ? (
              <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                <KeyRound className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{c.keyName}</span>
              </span>
            ) : null}
            {isAdmin && c.ownerId ? (
              <span className="truncate text-xs text-fg-muted">
                {t("dash.ownerLabel") + (c.ownerName || c.ownerId.slice(0, 8))}
              </span>
            ) : null}
            {c.gatewayUrl ? (
              <span
                className="max-w-full truncate font-mono text-xs text-fg-muted sm:max-w-40"
                title={c.gatewayUrl}
              >
                {c.gatewayUrl.replace(/https?:\/\//, "")}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <span className="whitespace-nowrap text-xs text-fg-muted" title={c.lastSeenAt}>
          {timeAgo(c.lastSeenAt, now)}
        </span>
      </div>
    </div>
  )
}
