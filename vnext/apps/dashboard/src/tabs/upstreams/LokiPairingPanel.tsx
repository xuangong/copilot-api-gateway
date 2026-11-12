import { useId, useState } from "react"
import { api, ApiError } from "../../api/client"
import type { UpstreamRecord } from "../../api/types"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { Field, FormHeading } from "./form/Field"
import { formatLokiPairing } from "./loki-pairing"
import { formatLokiModelNames, parseLokiModelNames } from "./loki-static-models"

interface Props { row?: UpstreamRecord; onChanged: () => void; onClose: () => void }
const DEFAULT_ENDPOINT = "https://loki.delve.office.com/api/v1/llmapi"

function settingsError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object" || !("error" in error.body)) return undefined
  const detail = error.body.error
  return detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string" ? detail.code : undefined
}

export function LokiPairingPanel({ row, onChanged, onClose }: Props) {
  const t = useT()
  const [name, setName] = useState(row?.name ?? "Microsoft Entra (Loki)")
  const [baseUrl, setBaseUrl] = useState(typeof row?.config.baseUrl === "string" ? row.config.baseUrl : DEFAULT_ENDPOINT)
  const [savedBaseUrl, setSavedBaseUrl] = useState(baseUrl)
  const [modelsText, setModelsText] = useState(() => formatLokiModelNames(row?.config.staticModels))
  const [savedModelsText, setSavedModelsText] = useState(modelsText)
  const [saved, setSaved] = useState(false)
  const titleId = useId()
  const [id, setId] = useState(row?.id)
  const [document, setDocument] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"
  const errorMessage = (error: unknown, pairing = false) => t(settingsError(error) === "invalid_endpoint"
    ? "dash.lokiEndpointInvalid" : settingsError(error) === "invalid_static_models"
      ? "dash.lokiStaticModelsInvalid" : pairing ? "dash.lokiPairError" : "dash.lokiSettingsError")

  const save = async () => {
    if (!id) return
    setBusy(true); setError(""); setSaved(false)
    try {
      const result = await api<{ upstream: UpstreamRecord }>(`/api/loki/upstreams/${encodeURIComponent(id)}`,
        { method: "PATCH", body: { baseUrl: baseUrl.trim(), staticModels: parseLokiModelNames(modelsText) } })
      const next = typeof result.upstream.config.baseUrl === "string" ? result.upstream.config.baseUrl : DEFAULT_ENDPOINT
      const nextModels = formatLokiModelNames(result.upstream.config.staticModels)
      setModelsText(nextModels); setSavedModelsText(nextModels)
      setBaseUrl(next); setSavedBaseUrl(next); setSaved(true)
      onChanged()
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  const pair = async () => {
    setBusy(true); setError(""); setCopied(false); setDocument(""); setSaved(false)
    try {
      const result = await api<{ upstream: UpstreamRecord; pairing: unknown }>(id
        ? `/api/loki/upstreams/${encodeURIComponent(id)}/pair` : "/api/loki/upstreams",
      { method: "POST", body: id ? {} : { name, baseUrl: baseUrl.trim(), staticModels: parseLokiModelNames(modelsText) } })
      if (!id) {
        const next = typeof result.upstream.config.baseUrl === "string" ? result.upstream.config.baseUrl : DEFAULT_ENDPOINT
        setBaseUrl(next); setSavedBaseUrl(next)
        const nextModels = formatLokiModelNames(result.upstream.config.staticModels)
        setModelsText(nextModels); setSavedModelsText(nextModels)
      }
      setId(result.upstream.id)
      setDocument(formatLokiPairing(result.pairing, window.location.origin))
      onChanged()
    } catch (error) { setError(errorMessage(error, true)) }
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

  return <section className="space-y-3 rounded-lg border border-border bg-panel p-4" aria-labelledby={titleId}>
    <div className="flex items-center justify-between gap-3">
      <FormHeading id={titleId} className="text-body font-medium text-fg">{t("dash.lokiSettingsTitle")}</FormHeading>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t("dash.closeBtn")}</Button>
    </div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void (id ? save() : pair()) }}>
      {!id ? <Field label={t("dash.lokiName")}>
        {({ id: inputId }) => (
          <input id={inputId} type="text" value={name} maxLength={120} required onChange={event => setName(event.target.value)} disabled={busy} />
        )}
      </Field> : null}
      <Field label={t("dash.endpointLabel")} hint={t("dash.lokiEndpointHint")}>
        {({ id: inputId, describedBy }) => (
          <div className="font-mono">
            <input id={inputId} type="url" value={baseUrl} placeholder={DEFAULT_ENDPOINT}
              maxLength={2048} autoComplete="off" spellCheck={false} aria-describedby={describedBy}
              onChange={event => { setBaseUrl(event.target.value); setSaved(false); setError("") }} disabled={busy} />
          </div>
        )}
      </Field>
      <Field label={t("dash.lokiStaticModels")} hint={t("dash.lokiStaticModelsHint")}>
        {({ id: inputId, describedBy }) => (
          <textarea id={inputId} value={modelsText} rows={6} maxLength={60_000} spellCheck={false}
            className="w-full font-mono text-xs" aria-describedby={describedBy}
            placeholder={"claude-opus-5.5\nclaude-sonnet-5.5\ngpt-6-luna"}
            onChange={event => { setModelsText(event.target.value); setSaved(false); setError("") }} disabled={busy} />
        )}
      </Field>
      <Button type="submit" variant="primary" size="sm"
        disabled={busy || (id ? baseUrl === savedBaseUrl && modelsText === savedModelsText : !secureOrigin || !name.trim())}>
        {busy ? t("dash.savingShort") : t(id ? "dash.save" : "dash.addLoki")}
      </Button>
      {saved ? <p role="status" className="text-xs text-fg-subtle">{t("dash.lokiSettingsSaved")}</p> : null}
    </form>
    {id ? <FormHeading offset={1} className="border-t border-border pt-3 text-body font-medium text-fg">{t("dash.lokiPairTitle")}</FormHeading> : null}
    <p className="text-body text-fg-muted">{t("dash.lokiPairDescription")}</p>
    {id ? <p className="text-xs text-fg-subtle">{t("dash.lokiReplaceHint")}</p> : null}
    {!secureOrigin ? <Notice tone="warn" role="status">{t("dash.lokiHttpsRequired")}</Notice> : null}
    {id ? <div className="flex flex-wrap gap-2">
      <Button variant="primary" size="sm" disabled={busy || !secureOrigin || !name.trim()} onClick={pair}>
        {busy ? "…" : t("dash.lokiNewPairing")}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={revoke}>{t("dash.lokiRevoke")}</Button>
    </div> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {document ? <div className="space-y-2">
      <p className="text-xs text-fg-subtle">{t("dash.lokiPairSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.lokiPairDocument")} value={document}
        className="w-full bg-muted font-mono text-xs" rows={9} onFocus={event => event.target.select()} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => {
          const url = URL.createObjectURL(new Blob([document], { type: "application/json" }))
          const link = window.document.createElement("a")
          link.href = url
          link.download = "loki-pairing.json"
          window.document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}>{t("dash.lokiDownload")}</Button>
        <Button variant="secondary" size="sm" onClick={async () => {
          try { await navigator.clipboard.writeText(document); setCopied(true) }
          catch { setError(t("dash.lokiCopyError")) }
        }}>{t(copied ? "dash.lokiCopied" : "dash.lokiCopy")}</Button>
      </div>
    </div> : null}
  </section>
}
