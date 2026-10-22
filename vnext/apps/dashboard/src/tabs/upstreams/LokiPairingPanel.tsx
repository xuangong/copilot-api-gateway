import { useId, useState } from "react"
import { api, ApiError } from "../../api/client"
import type { UpstreamRecord } from "../../api/types"
import { useT } from "../../state/i18n"
import { formatLokiPairing } from "./loki-pairing"

interface Props { row?: UpstreamRecord; onChanged: () => void; onClose: () => void }
const DEFAULT_ENDPOINT = "https://loki.delve.office.com/api/v1/llmapi"

function endpointError(error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object" || !("error" in error.body)) return false
  const detail = error.body.error
  return !!detail && typeof detail === "object" && "code" in detail && detail.code === "invalid_endpoint"
}

export function LokiPairingPanel({ row, onChanged, onClose }: Props) {
  const t = useT()
  const [name, setName] = useState(row?.name ?? "Microsoft Entra (Loki)")
  const [baseUrl, setBaseUrl] = useState(typeof row?.config.baseUrl === "string" ? row.config.baseUrl : DEFAULT_ENDPOINT)
  const [savedBaseUrl, setSavedBaseUrl] = useState(baseUrl)
  const [saved, setSaved] = useState(false)
  const endpointHintId = useId()
  const [id, setId] = useState(row?.id)
  const [document, setDocument] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"

  const save = async () => {
    if (!id) return
    setBusy(true); setError(""); setSaved(false)
    try {
      const result = await api<{ upstream: UpstreamRecord }>(`/api/loki/upstreams/${encodeURIComponent(id)}`,
        { method: "PATCH", body: { baseUrl: baseUrl.trim() } })
      const next = typeof result.upstream.config.baseUrl === "string" ? result.upstream.config.baseUrl : DEFAULT_ENDPOINT
      setBaseUrl(next); setSavedBaseUrl(next); setSaved(true)
      onChanged()
    } catch (error) { setError(t(endpointError(error) ? "dash.lokiEndpointInvalid" : "dash.lokiSettingsError")) }
    finally { setBusy(false) }
  }

  const pair = async () => {
    setBusy(true); setError(""); setCopied(false); setDocument(""); setSaved(false)
    try {
      const result = await api<{ upstream: UpstreamRecord; pairing: unknown }>(id
        ? `/api/loki/upstreams/${encodeURIComponent(id)}/pair` : "/api/loki/upstreams",
      { method: "POST", body: id ? {} : { name, baseUrl: baseUrl.trim() } })
      if (!id) {
        const next = typeof result.upstream.config.baseUrl === "string" ? result.upstream.config.baseUrl : DEFAULT_ENDPOINT
        setBaseUrl(next); setSavedBaseUrl(next)
      }
      setId(result.upstream.id)
      setDocument(formatLokiPairing(result.pairing, window.location.origin))
      onChanged()
    } catch (error) { setError(t(endpointError(error) ? "dash.lokiEndpointInvalid" : "dash.lokiPairError")) }
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

  return <section className="rounded-xl border border-themed bg-surface-800/60 p-4 space-y-3" aria-label={t("dash.lokiSettingsTitle")}>
    <div className="flex items-center justify-between gap-3">
      <h4 className="text-themed font-medium">{t("dash.lokiSettingsTitle")}</h4>
      <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={onClose}>{t("dash.closeBtn")}</button>
    </div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void (id ? save() : pair()) }}>
      {!id ? <label className="block text-sm text-themed">{t("dash.lokiName")}
        <input className="input-field w-full mt-1" value={name} maxLength={120} required onChange={event => setName(event.target.value)} disabled={busy} />
      </label> : null}
      <label className="block text-sm text-themed">{t("dash.endpointLabel")}
        <input type="url" className="input-field w-full mt-1" value={baseUrl} placeholder={DEFAULT_ENDPOINT}
          maxLength={2048} autoComplete="off" spellCheck={false} aria-describedby={endpointHintId}
          onChange={event => { setBaseUrl(event.target.value); setSaved(false); setError("") }} disabled={busy} />
      </label>
      <p id={endpointHintId} className="text-xs text-themed-dim">{t("dash.lokiEndpointHint")}</p>
      <button type="submit" className="btn-primary text-sm"
        disabled={busy || (id ? baseUrl === savedBaseUrl : !secureOrigin || !name.trim())}>
        {busy ? t("dash.savingShort") : t(id ? "dash.save" : "dash.addLoki")}
      </button>
      {saved ? <p role="status" className="text-xs text-themed-dim">{t("dash.lokiSettingsSaved")}</p> : null}
    </form>
    {id ? <h5 className="text-sm text-themed font-medium pt-3 border-t border-themed">{t("dash.lokiPairTitle")}</h5> : null}
    <p className="text-sm text-themed-dim">{t("dash.lokiPairDescription")}</p>
    {id ? <p className="text-xs text-themed-dim">{t("dash.lokiReplaceHint")}</p> : null}
    {!secureOrigin ? <p className="text-sm text-accent-amber" role="status">{t("dash.lokiHttpsRequired")}</p> : null}
    {id ? <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-primary text-sm" disabled={busy || !secureOrigin || !name.trim()} onClick={pair}>
        {busy ? "…" : t("dash.lokiNewPairing")}
      </button>
      {id ? <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={revoke}>{t("dash.lokiRevoke")}</button> : null}
    </div> : null}
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
