import { useId, useState } from "react"
import { revealSharedSessionSecret, setSharedSession, type ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
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
    <section className="glass-card p-4 sm:p-6 mb-6" aria-labelledby={`${id}-title`}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 id={`${id}-title`} className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.sharedSessionTitle")}</h3>
        {canEdit && !editing ? <button type="button" className="btn-ghost text-xs" disabled={locked} onClick={() => {
          clear(); setEnabled(keyRow.shared_session_enabled === true); setEditing(true)
        }}>{t("dash.edit")}</button> : null}
      </div>
      <p className="text-xs text-themed-secondary leading-relaxed mb-4">{t("dash.sharedSessionHint")}</p>
      {editing && canEdit ? <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-themed">
          <input type="checkbox" role="switch" checked={enabled} disabled={locked} onChange={event => setEnabled(event.target.checked)} />
          {t("dash.sharedSessionEnable")}
        </label>
        {enabled ? <div className="space-y-2">
          <label htmlFor={id} className="block text-xs text-themed-secondary">{t("dash.sharedSessionSecret")}</label>
          <input id={id} type={visible ? "text" : "password"} autoComplete="off" spellCheck={false} value={secret} disabled={locked}
            placeholder={t(keyRow.shared_session_configured ? "dash.sharedSessionKeep" : "dash.sharedSessionPlaceholder")}
            onChange={event => { setSecret(event.target.value); setCopied(false) }}
            aria-invalid={draft === null} aria-describedby={`${id}-help`} className="w-full text-sm font-mono" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost text-xs" disabled={locked} onClick={() => {
              setSecret(generateSharedSessionSecret()); setVisible(true); setCopied(false)
            }}>{t("dash.sharedSessionGenerate")}</button>
            <button type="button" className="btn-ghost text-xs" disabled={locked || (!secret && !keyRow.shared_session_configured)} onClick={() => {
              if (secret) setVisible(!visible)
              else void run(async () => { const result = await revealSharedSessionSecret(keyRow.id); setSecret(result.secret ?? ""); setVisible(true) })
            }}>{t(visible ? "dash.sharedSessionHide" : "dash.sharedSessionReveal")}</button>
            <button type="button" className="btn-ghost text-xs" disabled={locked || !secret || draft === null} onClick={() => void run(async () => {
              await navigator.clipboard.writeText(secret.trim().toLowerCase()); setCopied(true)
            })}>{t(copied ? "dash.sharedSessionCopied" : "dash.copy")}</button>
          </div>
          <p id={`${id}-help`} className={`text-xs ${draft === null ? "text-accent-red" : "text-themed-dim"}`}>
            {t(draft === null ? "dash.sharedSessionInvalid" : "dash.sharedSessionKeepHint")}
          </p>
        </div> : null}
        <p className="text-xs text-themed-dim">{t("dash.sharedSessionHistoryHint")}</p>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary text-xs py-2 px-3" disabled={locked || draft === null} onClick={() => void run(async () => {
            if (!draft) return
            await setSharedSession(keyRow.id, draft); await onSaved(); clear(); setEditing(false)
          })}>{t(working ? "dash.savingShort" : "dash.save")}</button>
          <button type="button" className="btn-ghost text-xs" disabled={locked} onClick={() => { clear(); setEditing(false) }}>{t("dash.cancel")}</button>
        </div>
      </div> : <p className="text-sm text-themed">{t(keyRow.shared_session_enabled ? "dash.sharedSessionOn" : "dash.sharedSessionOff")}</p>}
      {error ? <p role="alert" className="text-xs text-accent-red mt-3">{error}</p> : null}
    </section>
  )
}
