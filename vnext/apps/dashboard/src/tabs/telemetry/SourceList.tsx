import { useCallback, useEffect, useId, useState } from "react"
import { createTelemetrySource, deleteTelemetrySource, listTelemetrySources, rotateTelemetryKey, type IssuedTelemetryKey, type TelemetrySource } from "../../api/telemetry"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { telemetryErrorKey } from "./telemetry-errors"
import { formatInstant } from "./telemetry-format"
import { canCreateSource, sourceBadge, startPolling } from "./telemetry-sources"

export interface IssuedKeyView extends IssuedTelemetryKey { sourceName: string }
export type CopyTarget = "install" | "key"

export function IssuedKeyPanel({ issued, copied, onCopy, onDismiss }: { issued: IssuedKeyView; copied: CopyTarget | null; onCopy: (what: CopyTarget) => void; onDismiss: () => void }) {
  const t = useT()
  return <div className="space-y-2 rounded-md border border-border bg-panel p-3">
    <p className="text-body font-medium text-fg">{issued.sourceName}</p>
    <p className="text-xs text-fg-subtle">{t("dash.tlmKeyHint")}</p>
    <label className="block text-xs font-medium text-fg-muted">{t("dash.tlmInstallCommand")}
      <textarea readOnly spellCheck={false} value={issued.install} rows={4} className="mt-1 w-full bg-muted font-mono text-xs" onFocus={event => event.target.select()} />
    </label>
    <label className="block text-xs font-medium text-fg-muted">{t("dash.tlmKeyLabel")}
      <input readOnly spellCheck={false} value={issued.key} className="mt-1 w-full bg-muted font-mono text-xs" onFocus={event => event.target.select()} />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => onCopy("install")}>{t(copied === "install" ? "dash.tlmCopied" : "dash.tlmCopyCommand")}</Button>
      <Button variant="secondary" size="sm" onClick={() => onCopy("key")}>{t(copied === "key" ? "dash.tlmCopied" : "dash.tlmCopyKey")}</Button>
      <Button variant="ghost" size="sm" onClick={onDismiss}>{t("dash.tlmDismiss")}</Button>
    </div>
  </div>
}

export interface SourceListViewProps {
  sources: TelemetrySource[]
  nowMs: number
  newName: string
  issued: IssuedKeyView | null
  busy: boolean
  /** An already translated message. */
  error: string
  copied: CopyTarget | null
  secureOrigin: boolean
  onName: (value: string) => void
  onCreate: () => void
  onRotate: (source: TelemetrySource) => void
  onDelete: (source: TelemetrySource) => void
  onCopy: (what: CopyTarget) => void
  onDismissIssued: () => void
  /** Opens the source's page; the button is shown only when this is given. */
  onOpen?: (source: TelemetrySource) => void
}

const BADGES = { never: { tone: "neutral", key: "dash.tlmNeverPushed" }, fresh: { tone: "success", key: "dash.tlmFresh" }, stale: { tone: "warn", key: "dash.tlmStale" } } as const

export function SourceListView(props: SourceListViewProps) {
  const t = useT()
  const titleId = useId()
  const { sources, busy } = props
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmSources")}</SectionHeading>
    <p className="text-body text-fg-muted">{t("dash.tlmDescription")}</p>
    {!props.secureOrigin ? <Notice tone="warn" role="status">{t("dash.tlmHttpsRequired")}</Notice> : null}
    {sources.length ? <ul className="space-y-1 text-body">
      {sources.map(source => {
        const badge = BADGES[sourceBadge(source, props.nowMs)]
        return <li key={source.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{source.name}</span>
            <Badge tone={badge.tone}>{t(badge.key)}</Badge>
            {source.lastPushAt ? <span className="text-fg-muted">{t("dash.tlmLastPush", { at: formatInstant(source.lastPushAt) })}</span> : null}
          </span>
          <span className="flex gap-1">
            {props.onOpen ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => props.onOpen?.(source)}>{t("dash.tlmOpen")}</Button> : null}
            <Button variant="ghost" size="sm" disabled={busy || !props.secureOrigin} onClick={() => props.onRotate(source)}>{t("dash.tlmRotate")}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => props.onDelete(source)} className="text-danger hover:text-danger">{t("dash.delete")}</Button>
          </span>
        </li>
      })}
    </ul> : <p className="text-body text-fg-subtle">{t("dash.tlmNone")}</p>}
    <form className="flex flex-wrap items-center gap-2 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); props.onCreate() }}>
      <input type="text" value={props.newName} maxLength={64} placeholder={t("dash.tlmName")} aria-label={t("dash.tlmName")} disabled={busy}
        onChange={event => props.onName(event.target.value)} />
      <Button type="submit" variant="primary" size="sm" disabled={!props.secureOrigin || !canCreateSource(props.newName, busy)}>{t("dash.tlmCreate")}</Button>
    </form>
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {props.issued ? <IssuedKeyPanel issued={props.issued} copied={props.copied} onCopy={props.onCopy} onDismiss={props.onDismissIssued} /> : null}
  </Card>
}

export function SourceListSection({ onOpen, onSourcesChanged }: { onOpen?: (source: TelemetrySource) => void; onSourcesChanged?: (sources: TelemetrySource[]) => void }) {
  const t = useT()
  const confirm = useConfirm()
  const [sources, setSources] = useState<TelemetrySource[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [newName, setNewName] = useState("")
  const [issued, setIssued] = useState<IssuedKeyView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const secureOrigin = window.location.protocol === "https:"

  const apply = useCallback((next: TelemetrySource[]) => { setSources(next); setNowMs(Date.now()); onSourcesChanged?.(next) }, [onSourcesChanged])
  const reload = useCallback(() => listTelemetrySources().then(result => apply(result.sources)).catch(() => setError(t("dash.tlmLoadError"))), [apply, t])
  useEffect(() => { void reload() }, [reload])
  // Freshness badges are refreshed every five minutes while the page is open.
  useEffect(() => {
    let live = true
    const stop = startPolling(() => { listTelemetrySources().then(result => { if (live) apply(result.sources) }).catch(() => {}) })
    return () => { live = false; stop() }
  }, [apply])

  const create = async () => {
    setBusy(true); setError(""); setCopied(null)
    try {
      const result = await createTelemetrySource(newName.trim())
      apply([...sources, result.source])
      setIssued({ sourceName: result.source.name, key: result.key, install: result.install })
      setNewName("")
    } catch (failure) { setError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const rotate = async (source: TelemetrySource) => {
    const sure = await confirm({ title: t("dash.tlmRotateConfirmTitle", { name: source.name }), description: t("dash.tlmRotateConfirmHint"), confirmLabel: t("dash.tlmRotate"), danger: true })
    if (!sure) return
    setBusy(true); setError(""); setCopied(null)
    try {
      const result = await rotateTelemetryKey(source.id)
      setIssued({ sourceName: source.name, key: result.key, install: result.install })
    } catch (failure) { setError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const remove = async (source: TelemetrySource) => {
    const sure = await confirm({ title: t("dash.tlmDeleteConfirmTitle", { name: source.name }), description: t("dash.tlmDeleteConfirmHint"), confirmLabel: t("dash.delete"), danger: true })
    if (!sure) return
    setBusy(true); setError("")
    try { apply((await deleteTelemetrySource(source.id)).sources); setIssued(null) }
    catch (failure) { setError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }

  return <SourceListView sources={sources} nowMs={nowMs} newName={newName} issued={issued} busy={busy} error={error} copied={copied} secureOrigin={secureOrigin}
    onName={setNewName} onCreate={() => void create()} onRotate={source => void rotate(source)} onDelete={source => void remove(source)} onOpen={onOpen}
    onCopy={async what => {
      if (!issued) return
      try { await navigator.clipboard.writeText(what === "install" ? issued.install : issued.key); setCopied(what) }
      catch { setError(t("dash.tlmCopyError")) }
    }}
    onDismissIssued={() => { setIssued(null); setCopied(null) }} />
}
