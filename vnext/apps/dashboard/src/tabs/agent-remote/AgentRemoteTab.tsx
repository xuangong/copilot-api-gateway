import { useCallback, useEffect, useState } from "react"
import { listRemoteHosts, listHostShares, saveHostShare, revokeHostShare, parseSessionLimit, type RemoteHost, type HostShare } from "../../api/agent-remote"
import { useRemoteText } from "./remote-text"

const fieldClass = "bg-surface-800 border border-surface-600 rounded-md px-3 py-2 text-sm text-themed w-full"
const buttonClass = "btn-ghost !text-xs !py-2 !px-3 disabled:opacity-40"

export function ShareRow({ share, onSave, onRevoke, busy }: {
  share: HostShare
  onSave: (email: string, limit: number) => Promise<void>
  onRevoke: (email: string) => Promise<void>
  busy: boolean
}) {
  const t = useRemoteText()
  const [limit, setLimit] = useState(String(share.sessionLimit))
  const parsed = parseSessionLimit(limit)
  return <form className="border-t border-surface-600 pt-3 space-y-2" onSubmit={event => {
    event.preventDefault()
    if (parsed !== undefined) void onSave(share.label, parsed)
  }}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-themed break-all">{share.label}</span>
      <span className="text-xs text-themed-dim tabular-nums">{share.used} / {share.sessionLimit}{share.revoked ? ` · ${t("dash.remote.revoked")}` : ""}</span>
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-themed-dim flex-1 min-w-32">{t("dash.remote.limit")}
        <input aria-label={`${t("dash.remote.limit")} · ${share.label}`} type="number" min="0" max="10000" step="1" value={limit} onChange={event => setLimit(event.target.value)} className={`${fieldClass} mt-1`} />
      </label>
      <button className={buttonClass} disabled={busy || parsed === undefined || (!share.revoked && parsed === share.sessionLimit)}>{share.revoked ? t("dash.remote.grant") : t("dash.remote.save")}</button>
      {!share.revoked && <button type="button" className={`${buttonClass} text-accent-red`} disabled={busy} onClick={() => { void onRevoke(share.label) }}>{t("dash.remote.revoke")}</button>}
    </div>
    {parsed !== undefined && parsed < share.used && <p className="text-xs text-themed-dim">{t("dash.remote.lowerLimit")}</p>}
  </form>
}

function HostShares({ hostId }: { hostId: string }) {
  const t = useRemoteText()
  const [shares, setShares] = useState<HostShare[] | null>(null)
  const [email, setEmail] = useState("")
  const [limit, setLimit] = useState("10")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    try {
      await action()
      setShares((await listHostShares(hostId)).shares)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const save = (address: string, total: number) => mutate(() => saveHostShare(hostId, address, total))
  return <section className="mt-4 border-t border-surface-600 pt-4 space-y-4" aria-label={t("dash.remote.manage")}>
    <p className="text-xs text-themed-dim leading-relaxed">{t("dash.remote.quotaHint")}</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
      event.preventDefault()
      if (parsed !== undefined && email.trim()) void save(email.trim(), parsed)
    }}>
      <label className="text-xs text-themed-dim flex-1 min-w-48">{t("dash.remote.email")}
        <input type="email" autoComplete="off" required value={email} onChange={event => setEmail(event.target.value)} className={`${fieldClass} mt-1`} placeholder="user@example.com" />
      </label>
      <label className="text-xs text-themed-dim w-36">{t("dash.remote.limit")}
        <input type="number" min="0" max="10000" step="1" required value={limit} onChange={event => setLimit(event.target.value)} className={`${fieldClass} mt-1`} />
      </label>
      <button disabled={busy || parsed === undefined || !email.trim()} className="btn-primary !text-xs !py-2 disabled:opacity-40">{t("dash.remote.share")}</button>
    </form>
    {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
    {shares === null && !error && <p role="status" className="text-xs text-themed-dim">{t("dash.remote.loadingShares")}</p>}
    {shares?.length === 0 && <p className="text-xs text-themed-dim">{t("dash.remote.noShares")}</p>}
    {shares?.map(share => <ShareRow key={`${share.subject}:${share.sessionLimit}:${share.revoked}`} share={share} busy={busy} onSave={save} onRevoke={address => mutate(() => revokeHostShare(hostId, address))} />)}
  </section>
}

export function HostCard({ host }: { host: RemoteHost }) {
  const t = useRemoteText()
  const [sharing, setSharing] = useState(false)
  const quota = host.access === "shared" ? host.sessionQuota : undefined
  return <article className="bg-surface-900 border border-surface-600 rounded-lg p-4 sm:p-5">
    <div className="flex items-start justify-between flex-wrap gap-4">
      <div className="min-w-0 space-y-2">
        <h2 className="text-base font-semibold text-themed break-words">{host.name}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-themed-dim">
          <span className={`inline-flex items-center gap-1.5 ${host.online ? "text-accent-teal" : ""}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${host.online ? "bg-accent-teal" : "bg-surface-600"}`} />{host.online ? t("dash.remote.online") : t("dash.remote.offline")}</span>
          <span>·</span><span>{host.access === "owner" ? t("dash.remote.owner") : t("dash.remote.shared")}</span>
          {host.providers.map(provider => <span key={provider.providerId} className="rounded bg-surface-800 px-2 py-0.5">{provider.displayName}</span>)}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {host.access === "owner" && <button type="button" className={buttonClass} aria-expanded={sharing} onClick={() => setSharing(value => !value)}>{sharing ? t("dash.remote.close") : t("dash.remote.manage")}</button>}
        <a href={`/agent-remote?host=${encodeURIComponent(host.id)}`} className="btn-primary !text-xs !py-2 !px-3">{t("dash.remote.open")}</a>
      </div>
    </div>
    {quota && <div className="mt-4 space-y-1">
      <div className="flex justify-between gap-3 text-xs text-themed-dim"><span>{t("dash.remote.quota")}</span><strong className="text-themed tabular-nums">{quota.used} / {quota.limit}</strong></div>
      <div className="h-1.5 bg-surface-700 rounded-full overflow-hidden" aria-hidden="true"><div className="h-full bg-accent-violet" style={{ width: `${quota.limit === 0 ? 100 : Math.min(100, quota.used / quota.limit * 100)}%` }} /></div>
      {quota.used >= quota.limit && <p className="text-xs text-themed-dim pt-1">{t("dash.remote.exhausted")}</p>}
    </div>}
    {sharing && host.access === "owner" && <HostShares hostId={host.id} />}
  </article>
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
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-lg font-semibold text-themed">{t("dash.remote.title")}</h1><p className="text-sm text-themed-dim mt-1">{t("dash.remote.hint")}</p></div>
      <div className="flex gap-2"><button disabled={loading} onClick={() => { void reload() }} className={buttonClass}>{t("dash.remote.refresh")}</button><a href="/agent-remote" className={buttonClass}>{t("dash.remote.open")}</a></div>
    </div>
    {error && <p role="alert" className="text-sm text-accent-red">{error}</p>}
    {hosts === null && loading && <p role="status" className="text-sm text-themed-dim">{t("dash.remote.loading")}</p>}
    {hosts?.length === 0 && <div className="border border-dashed border-surface-600 rounded-lg p-8 text-center text-sm text-themed-dim">{t("dash.remote.empty")}</div>}
    {hosts?.map(host => <HostCard key={host.id} host={host} />)}
  </div>
}
