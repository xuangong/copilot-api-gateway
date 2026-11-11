import { useId, useState } from "react"
import { revealSharedSessionSecret, setSharedSession, type ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { Notice } from "../../ui/notice"
import { generateSharedSessionSecret, sharedSessionDraft } from "./shared-session-state"

export function SharedSessionPanel({ keyRow, canEdit, busy, onSaved }: {
  keyRow: ApiKeyDetail; canEdit: boolean; busy: boolean; onSaved: () => Promise<void>
}) {
  const t = useT()
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [secret, setSecret] = useState("")
  const [visible, setVisible] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const locked = busy || working
  const draft = sharedSessionDraft(enabled, keyRow.shared_session_configured === true, secret)
  const run = async (action: () => Promise<void>) => {
    setWorking(true); setError("")
    try { await action() } catch { setError(t("dash.sharedSessionError")) }
    finally { setWorking(false) }
  }
  const clear = () => { setSecret(""); setVisible(false); setError(""); setCopied(false) }
  return (
    <Card aria-labelledby={`${id}-title`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionHeading id={`${id}-title`}>{t("dash.sharedSessionTitle")}</SectionHeading>
        {canEdit && !editing ? <Button variant="ghost" size="sm" disabled={locked} onClick={() => {
          clear(); setEnabled(keyRow.shared_session_enabled === true); setEditing(true)
        }}>{t("dash.edit")}</Button> : null}
      </div>
      <p className="mb-4 text-xs leading-relaxed text-fg-muted">{t("dash.sharedSessionHint")}</p>
      {editing && canEdit ? <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" role="switch" checked={enabled} disabled={locked} onChange={event => setEnabled(event.target.checked)} className="accent-brand" />
          {t("dash.sharedSessionEnable")}
        </label>
        {enabled ? <div className="space-y-2">
          <label htmlFor={id} className="block text-xs font-medium text-fg-muted">{t("dash.sharedSessionSecret")}</label>
          {/* The global input rule sets font-family: inherit, so the monospace face comes from this wrapper. */}
          <div className="font-mono">
            <input id={id} type={visible ? "text" : "password"} autoComplete="off" spellCheck={false} value={secret} disabled={locked}
              placeholder={t(keyRow.shared_session_configured ? "dash.sharedSessionKeep" : "dash.sharedSessionPlaceholder")}
              onChange={event => { setSecret(event.target.value); setCopied(false) }}
              aria-invalid={draft === null} aria-describedby={`${id}-help`} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => {
              setSecret(generateSharedSessionSecret()); setVisible(true); setCopied(false)
            }}>{t("dash.sharedSessionGenerate")}</Button>
            <Button variant="ghost" size="sm" disabled={locked || (!secret && !keyRow.shared_session_configured)} onClick={() => {
              if (secret) setVisible(!visible)
              else void run(async () => { const result = await revealSharedSessionSecret(keyRow.id); setSecret(result.secret ?? ""); setVisible(true) })
            }}>{t(visible ? "dash.sharedSessionHide" : "dash.sharedSessionReveal")}</Button>
            <Button variant="ghost" size="sm" disabled={locked || !secret || draft === null} onClick={() => void run(async () => {
              await navigator.clipboard.writeText(secret.trim().toLowerCase()); setCopied(true)
            })}>{t(copied ? "dash.sharedSessionCopied" : "dash.copy")}</Button>
          </div>
          <p id={`${id}-help`} className={cn("text-xs", draft === null ? "text-danger" : "text-fg-subtle")}>
            {t(draft === null ? "dash.sharedSessionInvalid" : "dash.sharedSessionKeepHint")}
          </p>
        </div> : null}
        <p className="text-xs text-fg-subtle">{t("dash.sharedSessionHistoryHint")}</p>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={locked || draft === null} onClick={() => void run(async () => {
            if (!draft) return
            await setSharedSession(keyRow.id, draft); await onSaved(); clear(); setEditing(false)
          })}>{t(working ? "dash.savingShort" : "dash.save")}</Button>
          <Button variant="ghost" size="sm" disabled={locked} onClick={() => { clear(); setEditing(false) }}>{t("dash.cancel")}</Button>
        </div>
      </div> : <p className="text-sm text-fg">{t(keyRow.shared_session_enabled ? "dash.sharedSessionOn" : "dash.sharedSessionOff")}</p>}
      {error ? <Notice tone="danger" className="mt-3">{error}</Notice> : null}
    </Card>
  )
}
