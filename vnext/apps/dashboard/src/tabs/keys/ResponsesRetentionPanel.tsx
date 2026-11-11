import { useId, useState } from "react"
import type { ApiKeyDetail, KeyPatchBody } from "../../api/keys"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
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
    <Card aria-labelledby={`${inputId}-title`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <SectionHeading id={`${inputId}-title`}>{t("dash.responsesRetentionTitle")}</SectionHeading>
        {canEdit && !editing ? <Button variant="ghost" size="sm" disabled={busy} onClick={beginEdit}>{t("dash.edit")}</Button> : null}
      </div>
      <p className="mb-4 text-xs leading-relaxed text-fg-muted">{t("dash.responsesRetentionHint")}</p>
      {editing && canEdit ? (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} className="accent-brand" />
            {t("dash.responsesRetentionEnable")}
          </label>
          {enabled ? (
            <div className="space-y-2">
              <label htmlFor={inputId} className="block text-xs font-medium text-fg-muted">{t("dash.responsesRetentionDays")}</label>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-28">
                  <input id={inputId} type="number" min="1" max="3650" step="1" value={days}
                    disabled={busy} onChange={(event) => setDays(event.target.value)}
                    aria-invalid={seconds === null} aria-describedby={`${inputId}-help`} />
                </div>
                {[1, 3, 7].map((value) => (
                  <Button key={value} variant={Number(days) === value ? "primary" : "secondary"} size="sm"
                    disabled={busy} aria-pressed={Number(days) === value}
                    onClick={() => setDays(String(value))}>{t("dash.responsesRetentionPreset", { n: value })}</Button>
                ))}
              </div>
              <p id={`${inputId}-help`} className={cn("text-xs", seconds === null ? "text-danger" : "text-fg-subtle")}>
                {seconds === null ? t("dash.responsesRetentionInvalid") : t("dash.responsesRetentionExpiry")}
              </p>
            </div>
          ) : <p className="text-xs text-fg-subtle">{t("dash.responsesRetentionDisabledHint")}</p>}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={busy || seconds === null} onClick={save}>
              {busy ? t("dash.savingShort") : t("dash.save")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>{t("dash.cancel")}</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg">{savedSeconds > 0
          ? t("dash.responsesRetentionSummary", { n: savedSeconds / 86400 })
          : t("dash.responsesRetentionOff")}</p>
      )}
    </Card>
  )
}
