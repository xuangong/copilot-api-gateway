import { useId, useState } from "react"
import type { ApiKeyDetail, KeyPatchBody } from "../../api/keys"
import { useT } from "../../state/i18n"
import { retentionFromDraft } from "./responses-retention-state"

interface Props {
  keyRow: ApiKeyDetail
  canEdit: boolean
  busy: boolean
  onSave: (body: KeyPatchBody) => Promise<boolean>
}

export function ResponsesRetentionPanel({ keyRow, canEdit, busy, onSave }: Props) {
  const t = useT()
  const inputId = useId()
  const savedSeconds = keyRow.responses_retention_seconds ?? 0
  const [editing, setEditing] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [days, setDays] = useState("1")
  const seconds = retentionFromDraft(enabled, days)
  const beginEdit = () => {
    setEnabled(savedSeconds > 0)
    setDays(String(savedSeconds > 0 ? savedSeconds / 86400 : 1))
    setEditing(true)
  }
  const save = async () => {
    if (seconds === null) return
    if (await onSave({ responses_retention_seconds: seconds })) setEditing(false)
  }

  return (
    <section className="glass-card p-4 sm:p-6 mb-6" aria-labelledby={`${inputId}-title`}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 id={`${inputId}-title`} className="text-xs font-medium text-themed-dim uppercase tracking-widest">
          {t("dash.responsesRetentionTitle")}
        </h3>
        {canEdit && !editing ? <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={beginEdit}>{t("dash.edit")}</button> : null}
      </div>
      <p className="text-xs text-themed-secondary leading-relaxed mb-4">{t("dash.responsesRetentionHint")}</p>
      {editing && canEdit ? (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-themed">
            <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />
            {t("dash.responsesRetentionEnable")}
          </label>
          {enabled ? (
            <div className="space-y-2">
              <label htmlFor={inputId} className="block text-xs text-themed-secondary">{t("dash.responsesRetentionDays")}</label>
              <div className="flex flex-wrap items-center gap-2">
                <input id={inputId} type="number" min="1" max="3650" step="1" value={days}
                  disabled={busy} onChange={(event) => setDays(event.target.value)}
                  aria-invalid={seconds === null} aria-describedby={`${inputId}-help`}
                  className="w-24 text-sm" />
                {[1, 3, 7].map((value) => (
                  <button key={value} type="button" disabled={busy} aria-pressed={Number(days) === value}
                    className={Number(days) === value ? "btn-primary text-xs py-2 px-3" : "btn-ghost text-xs py-2 px-3"}
                    onClick={() => setDays(String(value))}>{t("dash.responsesRetentionPreset", { n: value })}</button>
                ))}
              </div>
              <p id={`${inputId}-help`} className={`text-xs ${seconds === null ? "text-accent-red" : "text-themed-dim"}`}>
                {seconds === null ? t("dash.responsesRetentionInvalid") : t("dash.responsesRetentionExpiry")}
              </p>
            </div>
          ) : <p className="text-xs text-themed-dim">{t("dash.responsesRetentionDisabledHint")}</p>}
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary text-xs py-2 px-3" disabled={busy || seconds === null} onClick={save}>
              {busy ? t("dash.savingShort") : t("dash.save")}
            </button>
            <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => setEditing(false)}>{t("dash.cancel")}</button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-themed">{savedSeconds > 0
          ? t("dash.responsesRetentionSummary", { n: savedSeconds / 86400 })
          : t("dash.responsesRetentionOff")}</p>
      )}
    </section>
  )
}
