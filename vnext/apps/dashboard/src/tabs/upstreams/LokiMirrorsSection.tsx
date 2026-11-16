import { useEffect, useState } from "react"
import { api } from "../../api/client"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { FormHeading } from "./form/Field"
import { formatLokiMirrorDocument, type LokiMirrorRow } from "./loki-mirror"

export function LokiMirrorsSection({ upstreamId }: { upstreamId: string }) {
  const t = useT()
  const base = `/api/loki/upstreams/${encodeURIComponent(upstreamId)}/mirrors`
  const [mirrors, setMirrors] = useState<LokiMirrorRow[]>([])
  const [label, setLabel] = useState("")
  const [document, setDocument] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"

  useEffect(() => {
    let live = true
    api<{ mirrors: LokiMirrorRow[] }>(base).then(result => { if (live) setMirrors(result.mirrors) })
      .catch(() => { if (live) setError(t("dash.lokiMirrorError")) })
    return () => { live = false }
  }, [base, t])

  const issue = async () => {
    setBusy(true); setError(""); setCopied(false); setDocument("")
    try {
      const result = await api<{ mirror: LokiMirrorRow; document: unknown }>(base, { method: "POST", body: { label: label.trim() } })
      setDocument(formatLokiMirrorDocument(result.document, window.location.origin))
      setMirrors(current => [...current, result.mirror])
      setLabel("")
    } catch { setError(t("dash.lokiMirrorError")) }
    finally { setBusy(false) }
  }
  const revoke = async (mirrorId: string) => {
    setBusy(true); setError("")
    try {
      const result = await api<{ mirrors: LokiMirrorRow[] }>(`${base}/${encodeURIComponent(mirrorId)}`, { method: "DELETE" })
      setMirrors(result.mirrors)
    } catch { setError(t("dash.lokiMirrorError")) }
    finally { setBusy(false) }
  }
  const time = (value: number | null) => value ? new Date(value).toLocaleString() : t("dash.lokiMirrorNever")

  return <div className="space-y-3 border-t border-border pt-3">
    <FormHeading offset={1} className="text-body font-medium text-fg">{t("dash.lokiMirrorsTitle")}</FormHeading>
    <p className="text-body text-fg-muted">{t("dash.lokiMirrorsDescription")}</p>
    {!secureOrigin ? <Notice tone="warn" role="status">{t("dash.lokiHttpsRequired")}</Notice> : null}
    <div className="flex flex-wrap items-center gap-2">
      <input type="text" value={label} maxLength={64} placeholder={t("dash.lokiMirrorLabel")} aria-label={t("dash.lokiMirrorLabel")}
        onChange={event => setLabel(event.target.value)} disabled={busy} />
      <Button variant="primary" size="sm" disabled={busy || !secureOrigin || !label.trim()} onClick={issue}>
        {t("dash.lokiMirrorIssue")}
      </Button>
    </div>
    {mirrors.length ? <ul className="space-y-1 text-xs">
      {mirrors.map(mirror => <li key={mirror.id} className="flex items-center justify-between gap-2">
        <span>{mirror.label} · {t("dash.lokiMirrorIssued", { at: time(mirror.createdAt) })} · {t("dash.lokiMirrorLastPull", { at: time(mirror.lastPulledAt) })}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(mirror.id)}>{t("dash.lokiMirrorRevoke")}</Button>
      </li>)}
    </ul> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {document ? <div className="space-y-2">
      <p className="text-xs text-fg-subtle">{t("dash.lokiMirrorSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.lokiMirrorDocument")} value={document}
        className="w-full bg-muted font-mono text-xs" rows={10} onFocus={event => event.target.select()} />
      <Button variant="secondary" size="sm" onClick={async () => {
        try { await navigator.clipboard.writeText(document); setCopied(true) }
        catch { setError(t("dash.lokiCopyError")) }
      }}>{t(copied ? "dash.lokiMirrorCopied" : "dash.lokiMirrorCopy")}</Button>
    </div> : null}
  </div>
}
