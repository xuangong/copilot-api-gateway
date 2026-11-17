// apps/dashboard/src/tabs/upstreams/protection/ProtectionSettingsForm.tsx
import { useEffect, useRef, useState } from "react"
import type { ProtectionMode, ProtectionSettings } from "../../../api/protection"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { SegmentedControl, type SegmentedOption } from "../../../ui/segmented-control"
import { Field } from "../form/Field"
import {
  NUMERIC_FIELDS, PROTECTION_DEFAULTS, PROTECTION_LIMITS, isDirty, parseForm, reconcileForm, resetToDefaults, toForm,
  type FieldErrorKind, type FieldErrors, type NumericField, type ProtectionForm,
} from "./protection-form"

type Translate = (key: string, vars?: Record<string, string | number>) => string

const fieldTexts = (t: Translate): Record<NumericField, { label: string; help: string }> => ({
  windowMinutes: { label: t("dash.protWindowMinutes"), help: t("dash.protWindowMinutesHelp") },
  minRiskyErrors: { label: t("dash.protMinRiskyErrors"), help: t("dash.protMinRiskyErrorsHelp") },
  minFailureRatio: { label: t("dash.protMinFailureRatio"), help: t("dash.protMinFailureRatioHelp") },
  authBurst: { label: t("dash.protAuthBurst"), help: t("dash.protAuthBurstHelp") },
  keyShare: { label: t("dash.protKeyShare"), help: t("dash.protKeyShareHelp") },
  cooldownMinutes: { label: t("dash.protCooldownMinutes"), help: t("dash.protCooldownMinutesHelp") },
  maxCooldownMinutes: { label: t("dash.protMaxCooldownMinutes"), help: t("dash.protMaxCooldownMinutesHelp") },
})

function errorText(t: Translate, field: NumericField, kind: FieldErrorKind): string {
  const [min, max] = PROTECTION_LIMITS[field]
  if (kind === "number") return t("dash.protErrNumber")
  if (kind === "integer") return t("dash.protErrInteger")
  if (kind === "order") return t("dash.protErrOrder")
  return t("dash.protErrRange", { min, max })
}

interface FieldsProps {
  form: ProtectionForm
  errors: FieldErrors
  dirty: boolean
  saving: boolean
  disabled: boolean
  onMode: (mode: ProtectionMode) => void
  onValue: (field: NumericField, value: string) => void
  onReset: () => void
  onSave: () => void
}

/** The presentational form: mode selector, one input per threshold with its default and range, Save and Reset. */
export function ProtectionFields({ form, errors, dirty, saving, disabled, onMode, onValue, onReset, onSave }: FieldsProps) {
  const t = useT()
  const texts = fieldTexts(t)
  const modes: Array<SegmentedOption<ProtectionMode>> = [
    { value: "off", label: t("dash.protModeOff") }, { value: "notify", label: t("dash.protModeNotify") }, { value: "pause", label: t("dash.protModePause") },
  ]
  const blocked = disabled || saving || !dirty || Object.keys(errors).length > 0
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t("dash.protMode")}</div>
        <SegmentedControl options={modes} value={form.mode} onChange={onMode} ariaLabel={t("dash.protMode")} size="sm" disabled={disabled || saving} />
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.protModeHint")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NUMERIC_FIELDS.map((field) => {
          const [min, max] = PROTECTION_LIMITS[field]
          const kind = errors[field]
          return (
            <Field key={field} label={texts[field].label}
              hint={<>{texts[field].help} {t("dash.protFieldRange", { value: PROTECTION_DEFAULTS[field], min, max })}</>}
              error={kind ? errorText(t, field, kind) : undefined}>
              {({ id, describedBy }) => (
                <input id={id} type="number" inputMode="decimal" step="any" value={form.values[field]} disabled={disabled || saving}
                  aria-describedby={describedBy} aria-invalid={kind ? true : undefined} onChange={(event) => onValue(field, event.target.value)} />
              )}
            </Field>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={blocked} onClick={onSave}>{t("dash.protSave")}</Button>
        <Button variant="ghost" size="sm" disabled={disabled || saving} onClick={onReset}>{t("dash.protReset")}</Button>
      </div>
    </div>
  )
}

interface Props {
  saved: ProtectionSettings
  saving: boolean
  disabled?: boolean
  onSave: (settings: ProtectionSettings) => void
  /** Errors the server reported for fields; cleared through `onEdit` as soon as the user changes anything. */
  serverErrors?: FieldErrors
  onEdit?: () => void
}

export function ProtectionSettingsForm({ saved, saving, disabled = false, onSave, serverErrors = {}, onEdit }: Props) {
  const [form, setForm] = useState(() => toForm(saved))
  const base = useRef(saved)
  // A reload hands over a new object each time: only a changed value matters, and unsaved edits are kept.
  useEffect(() => {
    if (base.current === saved) return
    const previous = base.current
    base.current = saved
    setForm((current) => reconcileForm(current, previous, saved))
  }, [saved])
  const parsed = parseForm(form)
  return (
    <ProtectionFields form={form} errors={{ ...serverErrors, ...(parsed.ok ? {} : parsed.errors) }} dirty={isDirty(form, saved)} saving={saving} disabled={disabled}
      onMode={(mode) => { onEdit?.(); setForm((current) => ({ ...current, mode })) }}
      onValue={(field, value) => { onEdit?.(); setForm((current) => ({ ...current, values: { ...current.values, [field]: value } })) }}
      onReset={() => { onEdit?.(); setForm((current) => resetToDefaults(current)) }}
      onSave={() => { if (parsed.ok) onSave(parsed.settings) }} />
  )
}
