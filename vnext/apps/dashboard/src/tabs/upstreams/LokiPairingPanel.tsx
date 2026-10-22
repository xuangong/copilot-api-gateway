import { useState } from "react"
import { api } from "../../api/client"
import type { UpstreamRecord } from "../../api/types"
import { useT } from "../../state/i18n"
import { formatLokiPairing } from "./loki-pairing"

interface Props { row?: UpstreamRecord; onChanged: () => void; onClose: () => void }

export function LokiPairingPanel({ row, onChanged, onClose }: Props) {
  const t = useT()
  const [name, setName] = useState(row?.name ?? "Microsoft Entra (Loki)")
  const [id, setId] = useState(row?.id)
  const [document, setDocument] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"

  const pair = async () => {
    setBusy(true); setError(""); setCopied(false); setDocument("")
    try {
      const result = await api<{ upstream: UpstreamRecord; pairing: unknown }>(id
        ? `/api/loki/upstreams/${encodeURIComponent(id)}/pair` : "/api/loki/upstreams",
      { method: "POST", body: id ? {} : { name } })
      setId(result.upstream.id)
      setDocument(formatLokiPairing(result.pairing, window.location.origin))
      onChanged()
    } catch { setError(t("dash.lokiPairError")) }
    finally { setBusy(false) }
  }
  const revoke = async () => {
    if (!id) return
    setBusy(true); setError("")
    try {
      await api(`/api/loki/upstreams/${encodeURIComponent(id)}/pair`, { method: "DELETE" })
      setDocument(""); setCopied(false); onChanged()
    } catch { setError(t("dash.lokiPairError")) }
    finally { setBusy(false) }
  }

  return <section className="rounded-xl border border-themed bg-surface-800/60 p-4 space-y-3" aria-label={t("dash.lokiPairTitle")}>
    <div className="flex items-center justify-between gap-3">
      <h4 className="text-themed font-medium">{t("dash.lokiPairTitle")}</h4>
      <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={onClose}>{t("dash.closeBtn")}</button>
    </div>
    <p className="text-sm text-themed-dim">{t("dash.lokiPairDescription")}</p>
    {!id ? <label className="block text-sm text-themed">{t("dash.lokiName")}
      <input className="input-field w-full mt-1" value={name} maxLength={120} onChange={event => setName(event.target.value)} disabled={busy} />
    </label> : <p className="text-xs text-themed-dim">{t("dash.lokiReplaceHint")}</p>}
    {!secureOrigin ? <p className="text-sm text-accent-amber" role="status">{t("dash.lokiHttpsRequired")}</p> : null}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-primary text-sm" disabled={busy || !secureOrigin || !name.trim()} onClick={pair}>
        {busy ? "…" : t(id ? "dash.lokiNewPairing" : "dash.addLoki")}
      </button>
      {id ? <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={revoke}>{t("dash.lokiRevoke")}</button> : null}
    </div>
    {error ? <p role="alert" className="text-sm text-accent-red">{error}</p> : null}
    {document ? <div className="space-y-2">
      <p className="text-xs text-themed-dim">{t("dash.lokiPairSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.lokiPairDocument")} value={document}
        className="input-field w-full font-mono text-xs" rows={9} onFocus={event => event.target.select()} />
      <button type="button" className="btn-primary text-sm" onClick={() => {
        const url = URL.createObjectURL(new Blob([document], { type: "application/json" }))
        const link = window.document.createElement("a")
        link.href = url
        link.download = "loki-pairing.json"
        window.document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }}>{t("dash.lokiDownload")}</button>
      <button type="button" className="btn-ghost text-sm" onClick={async () => {
        try { await navigator.clipboard.writeText(document); setCopied(true) }
        catch { setError(t("dash.lokiCopyError")) }
      }}>{t(copied ? "dash.lokiCopied" : "dash.lokiCopy")}</button>
    </div> : null}
  </section>
}
