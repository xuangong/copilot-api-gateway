import { useState } from "react"
import { useT } from "../../../state/i18n"
import type { GroupSettings } from "../../../api/upstream-groups"
import { Button } from "../../../ui/button"
import { SegmentedControl } from "../../../ui/segmented-control"
import { Field } from "../form/Field"
import { NUMERIC_FIELDS, defaultText, displayRange, isDirty, parseForm, resetToDefaults, setFieldValue, toForm, type FieldErrorKind, type FieldErrors, type GroupForm, type NumericField } from "./group-form"

interface FieldsProps {
  form: GroupForm
  errors: FieldErrors
  dirty: boolean
  saving: boolean
  disabled: boolean
  onPolicy: (policy: GroupForm["policy"]) => void
  onValue: (field: NumericField, value: string) => void
  onReset: () => void
  onSave: () => void
}

/** The presentational form: one input per setting with its default and range (shares in percent), the exhausted-policy switch, Save and Defaults. */
export function GroupFields({ form, errors, dirty, saving, disabled, onPolicy, onValue, onReset, onSave }: FieldsProps) {
  const t = useT()
  const errorText = (field: NumericField, kind: FieldErrorKind): string => {
    const [min, max] = displayRange(field)
    return kind === "number" ? t("dash.qbErrNumber") : kind === "integer" ? t("dash.qbErrInteger") : kind === "order" ? t("dash.qbErrOrder") : kind === "confirmOrder" ? t("dash.qbErrConfirmOrder") : t("dash.qbErrRange", { min, max })
  }
  const blocked = disabled || saving || !dirty || Object.keys(errors).length > 0
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t("dash.qbSet.exhaustedPolicy")}</div>
        <SegmentedControl
          options={[{ value: "stop", label: t("dash.qbPolicyStop") }, { value: "overage", label: t("dash.qbPolicyOverage") }]}
          value={form.policy} onChange={onPolicy} ariaLabel={t("dash.qbSet.exhaustedPolicy")} size="sm" disabled={disabled || saving} />
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.qbSetHelp.exhaustedPolicy")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NUMERIC_FIELDS.map(field => {
          const [min, max] = displayRange(field)
          const kind = errors[field]
          return (
            <Field key={field} label={t(`dash.qbSet.${field}`)} hint={<>{t(`dash.qbSetHelp.${field}`)} {t("dash.qbFieldRange", { value: defaultText(field), min, max })}</>} error={kind ? errorText(field, kind) : undefined}>
              {({ id, describedBy }) => (
                <input id={id} type="number" inputMode="decimal" step="any" value={form.values[field]} disabled={disabled || saving}
                  aria-describedby={describedBy} aria-invalid={kind ? true : undefined} onChange={event => onValue(field, event.target.value)} />
              )}
            </Field>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={blocked} onClick={onSave}>{t("dash.qbSave")}</Button>
        <Button variant="ghost" size="sm" disabled={disabled || saving} onClick={onReset}>{t("dash.qbSettingsDefaults")}</Button>
      </div>
    </div>
  )
}

interface Props { saved: GroupSettings; saving: boolean; disabled?: boolean; onSave: (settings: GroupSettings) => void }

export function GroupSettingsForm({ saved, saving, disabled = false, onSave }: Props) {
  const [form, setForm] = useState(() => toForm(saved))
  const parsed = parseForm(form)
  return (
    <GroupFields form={form} errors={parsed.ok ? {} : parsed.errors} dirty={isDirty(form, saved)} saving={saving} disabled={disabled}
      onPolicy={policy => setForm(current => ({ ...current, policy }))}
      onValue={(field, value) => setForm(current => setFieldValue(current, field, value))}
      onReset={() => setForm(current => resetToDefaults(current))}
      onSave={() => { if (parsed.ok) onSave(parsed.settings) }} />
  )
}
