import { useState } from "react"
import type { Calibration } from "../../../api/upstream-groups"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { Field } from "../form/Field"
import { parseCalibration, type CalibrateForm as Form, type CalibrationRefusal } from "./calibrate-form"

/** The owner's manual reading for an account whose quota can not be read, or to correct an estimate: used and entitlement (or a used share), and how long ago it was taken. */
export function CalibrateForm({ name, lastReadAt, busy, onSave, onCancel, error }: { name: string; lastReadAt: number | null; busy: boolean; onSave: (body: Calibration) => void; onCancel: () => void; error?: string }) {
  const t = useT()
  const [form, setForm] = useState<Form>({ used: "", entitlement: "", share: "", minutesAgo: "" })
  const [refusal, setRefusal] = useState<CalibrationRefusal | null>(null)
  const set = (key: keyof Form) => (event: { target: { value: string } }) => { setRefusal(null); setForm(current => ({ ...current, [key]: event.target.value })) }
  const submit = () => {
    const parsed = parseCalibration(form, Date.now(), lastReadAt)
    if (!parsed.ok) { setRefusal(parsed.reason); return }
    onSave(parsed.body)
  }
  return (
    <div role="group" aria-label={t("dash.qbCalTitleFor", { name })} className="mt-2 space-y-2 rounded-md border border-border bg-background p-3">
      <div className="text-xs font-medium text-fg">{t("dash.qbCalTitleFor", { name })}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("dash.qbCalUsed")}>{({ id }) => <input id={id} type="number" inputMode="decimal" step="any" value={form.used} onChange={set("used")} disabled={busy} />}</Field>
        <Field label={t("dash.qbCalEntitlement")}>{({ id }) => <input id={id} type="number" inputMode="decimal" step="any" value={form.entitlement} onChange={set("entitlement")} disabled={busy} />}</Field>
        <Field label={t("dash.qbCalShare")}>{({ id }) => <input id={id} type="number" inputMode="decimal" step="any" value={form.share} onChange={set("share")} disabled={busy} />}</Field>
        <Field label={t("dash.qbCalAt")}>{({ id }) => <input id={id} type="number" inputMode="numeric" step="1" min={0} max={1439} value={form.minutesAgo} onChange={set("minutesAgo")} disabled={busy} />}</Field>
      </div>
      {refusal ? <p role="alert" className="text-xs text-danger-text">{t(refusal === "range" ? "dash.qbCalErrRange" : refusal === "month" ? "dash.qbCalErrMonth" : refusal === "afterRead" ? "dash.qbCalErrAfterRead" : "dash.qbCalInvalid")}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger-text">{error}</p> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={submit}>{t("dash.qbSave")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("dash.qbCancel")}</Button>
      </div>
    </div>
  )
}
