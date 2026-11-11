import { useCallback, useEffect, useState } from "react"
import { listRemoteHosts, listHostShares, saveHostShare, revokeHostShare, parseSessionLimit, remoteReauthenticationUrl, type RemoteHost, type HostShare } from "../../api/agent-remote"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card } from "../../ui/card"
import { EmptyState } from "../../ui/empty-state"
import { Meter, meterTone } from "../../ui/meter"
import { Notice } from "../../ui/notice"
import { PageHeader } from "../../ui/page-header"
import { useRemoteText } from "./remote-text"

const labelClass = "text-xs text-fg-muted"

export function ShareRow({ share, onSave, onRevoke, busy }: {
  share: HostShare
  onSave: (email: string, limit: number) => Promise<void>
  onRevoke: (email: string) => Promise<void>
  busy: boolean
}) {
  const t = useRemoteText()
  const [limit, setLimit] = useState(String(share.sessionLimit))
  const parsed = parseSessionLimit(limit)
  return <form className="border-t border-border pt-3 space-y-2" onSubmit={event => {
    event.preventDefault()
    if (parsed !== undefined) void onSave(share.label, parsed)
  }}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-fg break-all">{share.label}</span>
      <span className="text-xs text-fg-subtle tabular-nums">{share.used} / {share.sessionLimit}{share.revoked ? ` · ${t("dash.remote.revoked")}` : ""}</span>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className={`${labelClass} flex-1 min-w-32`}>{t("dash.remote.limit")}
        <input aria-label={`${t("dash.remote.limit")} · ${share.label}`} type="number" min="0" max="10000" step="1" value={limit} onChange={event => setLimit(event.target.value)} className="mt-1" />
      </label>
      <Button type="submit" variant="secondary" size="md" disabled={busy || parsed === undefined || (!share.revoked && parsed === share.sessionLimit)}>{share.revoked ? t("dash.remote.grant") : t("dash.remote.save")}</Button>
      {!share.revoked && <Button variant="secondary" size="md" className="text-danger" disabled={busy} onClick={() => { void onRevoke(share.label) }}>{t("dash.remote.revoke")}</Button>}
    </div>
    {parsed !== undefined && parsed < share.used && <p className="text-xs text-fg-subtle">{t("dash.remote.lowerLimit")}</p>}
  </form>
}

function HostShares({ hostId }: { hostId: string }) {
  const t = useRemoteText()
  const [shares, setShares] = useState<HostShare[] | null>(null)
  const [email, setEmail] = useState("")
  const [limit, setLimit] = useState("10")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const parsed = parseSessionLimit(limit)
  useEffect(() => {
    const controller = new AbortController()
    listHostShares(hostId, controller.signal).then(result => {
      if (!controller.signal.aborted) setShares(result.shares)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => controller.abort()
  }, [hostId])
  const mutate = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setLoginUrl(null)
    try {
      await action()
      setShares((await listHostShares(hostId)).shares)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoginUrl(remoteReauthenticationUrl(cause, window.location.origin) ?? null)
    }
    finally { setBusy(false) }
  }
  const save = (address: string, total: number) => mutate(() => saveHostShare(hostId, address, total))
  return <section className="mt-4 border-t border-border pt-4 space-y-4" aria-label={t("dash.remote.manage")}>
    <p className="text-xs text-fg-muted leading-relaxed">{t("dash.remote.quotaHint")}</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
      event.preventDefault()
      if (parsed !== undefined && email.trim()) void save(email.trim(), parsed)
    }}>
      <label className={`${labelClass} flex-1 min-w-48`}>{t("dash.remote.email")}
        <input type="email" autoComplete="off" required value={email} onChange={event => setEmail(event.target.value)} className="mt-1" placeholder="user@example.com" />
      </label>
      <label className={`${labelClass} w-36`}>{t("dash.remote.limit")}
        <input type="number" min="0" max="10000" step="1" required value={limit} onChange={event => setLimit(event.target.value)} className="mt-1" />
      </label>
      <Button type="submit" variant="primary" size="md" disabled={busy || parsed === undefined || !email.trim()}>{t("dash.remote.share")}</Button>
    </form>
    {error && <Notice tone="danger">{error}</Notice>}
    {loginUrl && <Button asChild variant="primary" size="sm"><a href={loginUrl}>{t("dash.remote.reauthenticate")}</a></Button>}
    {shares === null && !error && <p role="status" className="text-xs text-fg-subtle">{t("dash.remote.loadingShares")}</p>}
    {shares?.length === 0 && <p className="text-xs text-fg-subtle">{t("dash.remote.noShares")}</p>}
    {shares?.map(share => <ShareRow key={`${share.subject}:${share.sessionLimit}:${share.revoked}`} share={share} busy={busy} onSave={save} onRevoke={address => mutate(() => revokeHostShare(hostId, address))} />)}
  </section>
}

export function HostCard({ host }: { host: RemoteHost }) {
  const t = useRemoteText()
  const [sharing, setSharing] = useState(false)
  const quota = host.access === "shared" ? host.sessionQuota : undefined
  const percent = quota ? (quota.limit === 0 ? 100 : Math.min(100, quota.used / quota.limit * 100)) : 0
  return <Card className="sm:p-5">
    <div className="flex items-start justify-between flex-wrap gap-4">
      <div className="min-w-0 space-y-2">
        <h2 className="text-base font-semibold text-fg wrap-break-word">{host.name}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          <Badge tone={host.online ? "success" : "neutral"} className="gap-1.5"><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${host.online ? "bg-success" : "bg-fg-subtle"}`} />{host.online ? t("dash.remote.online") : t("dash.remote.offline")}</Badge>
          <span aria-hidden="true">·</span><span>{host.access === "owner" ? t("dash.remote.owner") : t("dash.remote.shared")}</span>
          {host.providers.map(provider => <Badge key={provider.providerId}>{provider.displayName}</Badge>)}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {host.access === "owner" && <Button variant="secondary" size="sm" aria-expanded={sharing} onClick={() => setSharing(value => !value)}>{sharing ? t("dash.remote.close") : t("dash.remote.manage")}</Button>}
        <Button asChild variant="primary" size="sm"><a href={`/agent-remote?host=${encodeURIComponent(host.id)}`} aria-label={t("dash.remote.openHostAria", { name: host.name })}>{t("dash.remote.open")}</a></Button>
      </div>
    </div>
    {quota && <div className="mt-4 space-y-1">
      <div className="flex justify-between gap-3 text-xs text-fg-subtle"><span>{t("dash.remote.quota")}</span><strong className="text-fg tabular-nums">{quota.used} / {quota.limit}</strong></div>
      <Meter percent={percent} tone={meterTone(percent)} />
      {quota.used >= quota.limit && <p className="text-xs text-fg-subtle pt-1">{t("dash.remote.exhausted")}</p>}
    </div>}
    {sharing && host.access === "owner" && <HostShares hostId={host.id} />}
  </Card>
}

export function AgentRemoteTab() {
  const t = useRemoteText()
  const [hosts, setHosts] = useState<RemoteHost[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const result = await listRemoteHosts(signal)
      if (!signal?.aborted) setHosts(result.hosts)
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    return () => controller.abort()
  }, [reload])
  return <div>
    <PageHeader
      title={t("dash.remote.title")}
      description={t("dash.remote.hint")}
      actions={<>
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => { void reload() }}>{t("dash.remote.refresh")}</Button>
        <Button asChild variant="secondary" size="sm"><a href="/agent-remote">{t("dash.remote.open")}</a></Button>
      </>}
    />
    <div className="space-y-4">
      {error && <Notice tone="danger">{error}</Notice>}
      {hosts === null && loading && <p role="status" className="text-sm text-fg-subtle">{t("dash.remote.loading")}</p>}
      {hosts?.length === 0 && <EmptyState title={t("dash.remote.empty")} />}
      {hosts?.map(host => <HostCard key={host.id} host={host} />)}
    </div>
  </div>
}
