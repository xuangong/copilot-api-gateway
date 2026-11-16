import { useCallback, useEffect, useId, useRef, useState } from "react"
import { connectSyncSource, disconnectSyncSource, getSyncSource, replaceSyncSource, type SyncSourceView as SourceRecord } from "../../api/sync"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { Field } from "./form/Field"
import { parseSyncDocumentText } from "./sync-document"
import { syncLastErrorKey, syncSourceErrorKey } from "./sync-errors"
import { PollGate, shouldPoll, sourceChanged, sourceHealth } from "./sync-source"

export interface SyncSourceViewProps {
  available: boolean
  loaded: boolean
  source: SourceRecord | null
  text: string
  replacing: boolean
  busy: boolean
  /** Already translated. */
  error: string
  /** Already translated. */
  notice: string
  onText: (value: string) => void
  onConnect: () => void
  onToggleReplace: () => void
  onReplace: () => void
  onDisconnect: () => void
}

export function SyncSourceView(props: SyncSourceViewProps) {
  const t = useT()
  const titleId = useId()
  if (!props.available || !props.loaded) return null
  const { source, busy } = props
  const time = (value: string | null) => value ? new Date(value).toLocaleString() : t("dash.syncNever")
  const health = source ? sourceHealth(source) : "ok"
  const documentField = <Field label={t("dash.syncSourceDocument")} hint={t("dash.syncSourcePasteHint")}>
    {({ id, describedBy }) => <textarea id={id} value={props.text} rows={8} spellCheck={false} className="w-full font-mono text-xs"
      aria-describedby={describedBy} placeholder={'{ "kind": "gateway-sync", … }'} disabled={busy} onChange={event => props.onText(event.target.value)} />}
  </Field>
  return <Card aria-labelledby={titleId} className="mt-4 space-y-3">
    <SectionHeading id={titleId}>{t("dash.syncSourceTitle")}</SectionHeading>
    <p className="text-body text-fg-muted">{t("dash.syncSourceDescription")}</p>
    {source ? <>
      <p className="text-body text-fg">{t("dash.syncSourceFrom", { origin: source.origin })}</p>
      <p className="text-xs text-fg-subtle">
        {t("dash.syncSourceCount", { n: source.upstreamCount })} · {t("dash.syncSourceLastSuccess", { at: time(source.lastSuccessAt) })} · {t("dash.syncSourceLastAttempt", { at: time(source.lastAttemptAt) })}
      </p>
      {health === "revoked" ? <Notice tone="danger">{t("dash.syncSourceRevokedNotice")}</Notice> : null}
      {health === "failing" ? <Notice tone="warn" role="status">
        {t("dash.syncSourceFailingNotice", { error: t(syncLastErrorKey(source.lastError) ?? "dash.syncErrorUnknown") })}</Notice> : null}
      {health === "skipped" ? <Notice tone="warn" role="status">
        {t("dash.syncSourceSkippedNotice", { error: t(syncLastErrorKey(source.lastError) ?? "dash.syncErrorUnknown") })}</Notice> : null}
      {props.replacing || health === "revoked" ? <div className="space-y-2">
        {documentField}
        <Button variant="primary" size="sm" disabled={busy || !props.text.trim()} onClick={props.onReplace}>{t("dash.syncSourceConnect")}</Button>
      </div> : null}
      <div className="flex flex-wrap gap-2">
        {health !== "revoked" ? <Button variant="secondary" size="sm" disabled={busy} aria-expanded={props.replacing} onClick={props.onToggleReplace}>
          {props.replacing ? t("dash.closeBtn") : t("dash.syncSourceReplace")}</Button> : null}
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onDisconnect} className="text-danger hover:text-danger">{t("dash.syncSourceDisconnect")}</Button>
      </div>
    </> : <div className="space-y-2">
      {documentField}
      <Button variant="primary" size="sm" disabled={busy || !props.text.trim()} onClick={props.onConnect}>{t("dash.syncSourceConnect")}</Button>
    </div>}
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {props.notice ? <p role="status" className="text-xs text-fg-subtle">{props.notice}</p> : null}
  </Card>
}

export function SyncSourceSection({ onChanged }: { onChanged: () => void }) {
  const t = useT()
  const confirm = useConfirm()
  const [state, setState] = useState<{ available: boolean; source: SourceRecord | null } | null>(null)
  const [text, setText] = useState("")
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const gate = useRef(new PollGate())
  // The last source this component showed; undefined until the first load.
  const shown = useRef<SourceRecord | null | undefined>(undefined)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const show = (next: { available: boolean; source: SourceRecord | null }) => { shown.current = next.source; setState(next) }

  const load = useCallback(() => {
    const ticket = gate.current.ticket()
    return getSyncSource().then(result => {
      if (!gate.current.isFresh(ticket)) return
      const previous = shown.current
      shown.current = result.source
      setState(result)
      // A background sync or a revocation changed the rows; refresh the upstream list.
      if (previous !== undefined && sourceChanged(previous, result.source)) onChangedRef.current()
    }).catch(() => { /* Keep what is shown (or stay hidden before the first load); the next poll retries. */ })
  }, [])
  const polling = shouldPoll(state)
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!polling) return
    // The status changes by itself every minute (last sync, errors, revocation).
    const timer = window.setInterval(() => { void load() }, 30_000)
    return () => window.clearInterval(timer)
  }, [polling, load])

  const submit = async (replace: boolean) => {
    const document = parseSyncDocumentText(text)
    if (!document) { setError(t("dash.syncSourceDocumentInvalid")); setNotice(""); return }
    setBusy(true); setError(""); setNotice("")
    gate.current.bump()
    try {
      const result = await (replace ? replaceSyncSource : connectSyncSource)(document)
      gate.current.bump()
      show({ available: true, source: result.source })
      setText(""); setReplacing(false)
      setNotice(t(replace ? "dash.syncSourceReplaced" : "dash.syncSourceConnected"))
      onChanged()
    } catch (error) { setError(t(syncSourceErrorKey(error))) }
    finally { gate.current.bump(); setBusy(false) }
  }
  const disconnect = async () => {
    const origin = state?.source?.origin ?? ""
    const sure = await confirm({ title: t("dash.syncSourceDisconnectConfirmTitle", { origin }), description: t("dash.syncSourceDisconnectConfirmHint"),
      confirmLabel: t("dash.syncSourceDisconnect"), danger: true })
    if (!sure) return
    setBusy(true); setError(""); setNotice("")
    gate.current.bump()
    let failed = false
    try { await disconnectSyncSource(); gate.current.bump(); show({ available: true, source: null }); setReplacing(false); onChanged() }
    catch (error) { failed = true; setError(t(syncSourceErrorKey(error))) }
    finally { gate.current.bump(); setBusy(false) }
    if (failed) void load()
  }

  return <SyncSourceView available={state?.available ?? false} loaded={state !== null} source={state?.source ?? null} text={text} replacing={replacing}
    busy={busy} error={error} notice={notice} onText={value => { setText(value); setError("") }} onConnect={() => void submit(false)}
    onToggleReplace={() => { setReplacing(value => !value); setText(""); setError("") }} onReplace={() => void submit(true)} onDisconnect={() => void disconnect()} />
}
