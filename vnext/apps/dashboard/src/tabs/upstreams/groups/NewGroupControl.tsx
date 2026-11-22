import { useState } from "react"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { Field } from "../form/Field"

export function NewGroupControl({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => Promise<boolean> }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  if (!open) return <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{t("dash.qbNewGroup")}</Button>
  const close = () => { setName(""); setOpen(false) }
  const submit = async () => { if (name.trim() !== "" && await onCreate(name.trim())) close() }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t("dash.qbGroupName")}>
        {({ id }) => <input id={id} type="text" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submit(); if (event.key === "Escape") close() }} maxLength={80} disabled={busy} autoFocus />}
      </Field>
      <Button variant="primary" size="sm" disabled={busy || name.trim() === ""} onClick={() => void submit()}>{t("dash.qbCreate")}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={close}>{t("dash.qbCancel")}</Button>
    </div>
  )
}
