import { useId } from "react"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { agentSourceInvalid } from "./telemetry-sources"
import { AgentSourceField } from "./SourceList"
import type { LimitState, SettingsForm, TextField } from "./telemetry-settings-form"

export const SETTINGS_FIELDS: Array<{ key: TextField; labelKey: string; area?: boolean }> = [
  { key: "budgetMetric", labelKey: "dash.tlmSetBudgetMetric" },
  { key: "monthlyLimit", labelKey: "dash.tlmSetMonthlyLimit" },
  { key: "pricePerGB", labelKey: "dash.tlmSetPricePerGB" },
  { key: "freeGB", labelKey: "dash.tlmSetFreeGB" },
  { key: "surgeMetrics", labelKey: "dash.tlmSetSurgeMetrics" },
  { key: "surgeFactor", labelKey: "dash.tlmSetSurgeFactor" },
  { key: "surgeMinGB", labelKey: "dash.tlmSetSurgeMinGB" },
  { key: "surgeMinCount", labelKey: "dash.tlmSetSurgeMinCount" },
  { key: "flagNonZeroMetrics", labelKey: "dash.tlmSetFlagMetrics" },
  { key: "checkMetrics", labelKey: "dash.tlmSetCheckMetrics" },
  { key: "staleAfterHours", labelKey: "dash.tlmSetStaleAfter" },
  { key: "labels", labelKey: "dash.tlmSetLabels", area: true },
]

const LIMIT_HINTS = { loading: "dash.tlmLimitLoading", raw: "dash.tlmLimitRaw", mismatch: "dash.tlmLimitMismatch" } as const

export interface SettingsPanelProps {
  form: SettingsForm
  name: string
  busy: boolean
  /** An already translated message. */
  error: string
  saved: boolean
  invalidField: TextField | null
  /** Whether the monthly limit can be edited and saved: it needs the budget metric's unit first. */
  limitState: LimitState
  onField: (field: TextField, value: string) => void
  onName: (value: string) => void
  onSave: () => void
  onRename: () => void
  /** Optional agent source name for the rotated key's install command (a website source on the VM). */
  agentSource: string
  onAgentSource: (value: string) => void
  onRotate: () => void
  onDelete: () => void
}

export function SettingsPanel(props: SettingsPanelProps) {
  const t = useT()
  const titleId = useId()
  const { form, busy } = props
  return <Card aria-labelledby={titleId} className="space-y-4">
    <SectionHeading id={titleId}>{t("dash.tlmSettings")}</SectionHeading>
    <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); props.onRename() }}>
      <input type="text" value={props.name} maxLength={64} aria-label={t("dash.tlmName")} disabled={busy} onChange={event => props.onName(event.target.value)} />
      <Button type="submit" variant="secondary" size="sm" disabled={busy || props.name.trim() === ""}>{t("dash.tlmRename")}</Button>
    </form>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); props.onSave() }}>
      <div className="grid gap-3 sm:grid-cols-2">
        {SETTINGS_FIELDS.map(field => <label key={field.key} className={`block text-xs font-medium text-fg-muted ${field.area ? "sm:col-span-2" : ""}`}>
          {t(field.labelKey)}
          {field.area
            ? <textarea value={form[field.key]} rows={4} spellCheck={false} disabled={busy} aria-invalid={props.invalidField === field.key ? "true" : undefined}
              className="mt-1 w-full font-mono text-xs" onChange={event => props.onField(field.key, event.target.value)} />
            : <input type="text" value={form[field.key]} disabled={busy || (field.key === "monthlyLimit" && props.limitState === "loading")} aria-invalid={props.invalidField === field.key ? "true" : undefined}
              className="mt-1 w-full" onChange={event => props.onField(field.key, event.target.value)} />}
        </label>)}
      </div>
      <p className="text-xs text-fg-subtle">{t("dash.tlmSetLabelsHint")}</p>
      {props.limitState === "ready" ? null : <p className="text-xs text-fg-subtle">{t(LIMIT_HINTS[props.limitState])}</p>}
      <AgentSourceField value={props.agentSource} onChange={props.onAgentSource} disabled={busy} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy || props.limitState === "loading" || props.limitState === "mismatch"}>{busy ? t("dash.savingShort") : t("dash.save")}</Button>
        <Button variant="secondary" size="sm" disabled={busy || agentSourceInvalid(props.agentSource)} onClick={props.onRotate}>{t("dash.tlmRotate")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onDelete} className="text-danger hover:text-danger">{t("dash.delete")}</Button>
      </div>
    </form>
    {props.saved ? <Notice tone="success" role="status">{t("dash.tlmSettingsSaved")}</Notice> : null}
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
  </Card>
}
