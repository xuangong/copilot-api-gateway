import { useCallback, useEffect, useId, useState } from "react"
import { issueSyncDevice, listSyncDevices, revokeSyncDevice, updateSyncDevice, type SyncDevice } from "../../api/sync"
import type { UpstreamRecord } from "../../api/types"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { formatSyncDocument } from "./sync-document"
import { canSubmitDevice, initialSelection, selectableUpstreams, syncedCount, toggleSelection, type SelectableUpstream } from "./sync-devices"
import { syncDeviceErrorKey } from "./sync-errors"

/** `id: null` is a new device. */
export interface SyncDeviceForm { id: string | null; label: string; selected: string[] }

export interface SyncDevicesViewProps {
  devices: SyncDevice[]
  upstreams: SelectableUpstream[]
  form: SyncDeviceForm | null
  issued: { text: string } | null
  busy: boolean
  /** An already translated message. */
  error: string
  copied: boolean
  secureOrigin: boolean
  /** The signed-in owner is known, so the checklist is complete. */
  ownerKnown: boolean
  onNew: () => void
  onEdit: (device: SyncDevice) => void
  onLabel: (value: string) => void
  onToggle: (id: string) => void
  onSave: () => void
  onCancel: () => void
  onRevoke: (device: SyncDevice) => void
  onCopy: () => void
  onDownload: () => void
}

const UNSYNCABLE_REASON_KEYS = {
  provider: "dash.syncDeviceNotSupported", synced: "dash.syncDeviceSyncedElsewhere", wire: "dash.syncDeviceBadName",
} as const

export function SyncDevicesView(props: SyncDevicesViewProps) {
  const t = useT()
  const titleId = useId()
  const { devices, upstreams, form, issued, busy } = props
  const time = (value: string | null) => value ? new Date(value).toLocaleString() : t("dash.syncNever")
  return <Card aria-labelledby={titleId} className="mt-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SectionHeading id={titleId}>{t("dash.syncDevicesTitle")}</SectionHeading>
      <Button variant="secondary" size="sm" disabled={busy || !props.secureOrigin || !props.ownerKnown || form !== null} onClick={props.onNew}>{t("dash.syncDeviceNew")}</Button>
    </div>
    <p className="text-body text-fg-muted">{t("dash.syncDevicesDescription")}</p>
    {!props.secureOrigin ? <Notice tone="warn" role="status">{t("dash.syncDeviceHttpsRequired")}</Notice> : null}
    {devices.length ? <ul className="space-y-1 text-body">
      {devices.map(device => <li key={device.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium text-fg">{device.label}</span>
          <span className="text-fg-muted"> · {t("dash.syncDeviceCount", { n: syncedCount(device, upstreams) })} · {t("dash.syncDeviceLastSync", { at: time(device.lastSyncAt) })}</span>
        </span>
        <span className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={busy || form !== null} onClick={() => props.onEdit(device)}>{t("dash.edit")}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => props.onRevoke(device)} className="text-danger hover:text-danger">{t("dash.syncDeviceRevoke")}</Button>
        </span>
      </li>)}
    </ul> : <p className="text-body text-fg-subtle">{t("dash.syncDeviceNone")}</p>}
    {form ? <form className="space-y-3 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); props.onSave() }}>
      <input type="text" value={form.label} maxLength={64} placeholder={t("dash.syncDeviceLabel")} aria-label={t("dash.syncDeviceLabel")}
        onChange={event => props.onLabel(event.target.value)} disabled={busy} />
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium text-fg-muted">{t("dash.syncDeviceUpstreams")}</legend>
        {upstreams.length ? upstreams.map(upstream => <label key={upstream.id} className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={form.selected.includes(upstream.id)} disabled={busy || !upstream.syncable}
            onChange={() => props.onToggle(upstream.id)} />
          <span>{upstream.name}</span>
          <span className="font-mono text-xs text-fg-subtle">{upstream.provider}</span>
          {upstream.reason ? <span className="text-xs text-fg-subtle">{t(UNSYNCABLE_REASON_KEYS[upstream.reason])}</span> : null}
        </label>) : <p className="text-body text-fg-subtle">{t("dash.syncDeviceNoUpstreams")}</p>}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmitDevice(form.label, busy)}>
          {busy ? t("dash.savingShort") : t(form.id === null ? "dash.syncDeviceIssue" : "dash.save")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>{t("dash.cancel")}</Button>
      </div>
    </form> : null}
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {issued ? <div className="space-y-2">
      <p className="text-xs text-fg-subtle">{t("dash.syncDeviceSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.syncDeviceDocument")} value={issued.text}
        className="w-full bg-muted font-mono text-xs" rows={9} onFocus={event => event.target.select()} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={props.onDownload}>{t("dash.syncDeviceDownload")}</Button>
        <Button variant="secondary" size="sm" onClick={props.onCopy}>{t(props.copied ? "dash.syncDeviceCopied" : "dash.syncDeviceCopy")}</Button>
      </div>
    </div> : null}
  </Card>
}

export function SyncDevicesSection({ upstreams, myOwnerId }: { upstreams: UpstreamRecord[]; myOwnerId: string }) {
  const t = useT()
  const confirm = useConfirm()
  const [devices, setDevices] = useState<SyncDevice[]>([])
  const [form, setForm] = useState<SyncDeviceForm | null>(null)
  const [issued, setIssued] = useState<{ text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"
  const selectable = selectableUpstreams(upstreams, myOwnerId)

  const reload = useCallback(() => listSyncDevices().then(result => setDevices(result.devices))
    .catch(() => setError(t("dash.syncDeviceLoadError"))), [t])
  useEffect(() => { void reload() }, [reload])

  const fail = (error: unknown) => setError(t(syncDeviceErrorKey(error)))
  const save = async () => {
    if (!form) return
    setBusy(true); setError(""); setCopied(false)
    try {
      if (form.id === null) {
        const result = await issueSyncDevice({ label: form.label.trim(), upstreamIds: form.selected })
        setDevices(list => [...list, result.device])
        try { setIssued({ text: formatSyncDocument(result.document, window.location.origin) }) }
        catch { setError(t("dash.syncDeviceOriginMismatch")) }
      } else {
        const result = await updateSyncDevice(form.id, { label: form.label.trim(), upstreamIds: form.selected })
        setDevices(list => list.map(device => device.id === result.device.id ? result.device : device))
      }
      setForm(null)
    } catch (error) { fail(error) }
    finally { setBusy(false) }
  }
  const revoke = async (device: SyncDevice) => {
    const sure = await confirm({ title: t("dash.syncDeviceRevokeConfirmTitle", { name: device.label }),
      description: t("dash.syncDeviceRevokeConfirmHint"), confirmLabel: t("dash.syncDeviceRevoke"), danger: true })
    if (!sure) return
    setBusy(true); setError("")
    try { setDevices((await revokeSyncDevice(device.id)).devices); setIssued(null) }
    catch (error) { fail(error) }
    finally { setBusy(false) }
  }

  return <SyncDevicesView devices={devices} upstreams={selectable} form={form} issued={issued} busy={busy} error={error} copied={copied}
    secureOrigin={secureOrigin} ownerKnown={myOwnerId !== ""}
    onNew={() => { setIssued(null); setError(""); setForm({ id: null, label: "", selected: [] }) }}
    onEdit={device => { setIssued(null); setError(""); setForm({ id: device.id, label: device.label, selected: initialSelection(device, selectable) }) }}
    onLabel={label => setForm(current => current && { ...current, label })}
    onToggle={id => setForm(current => current && { ...current, selected: toggleSelection(current.selected, id) })}
    onSave={() => void save()} onCancel={() => { setForm(null); setError("") }} onRevoke={device => void revoke(device)}
    onCopy={async () => {
      if (!issued) return
      try { await navigator.clipboard.writeText(issued.text); setCopied(true) }
      catch { setError(t("dash.syncDeviceCopyError")) }
    }}
    onDownload={() => {
      if (!issued) return
      const url = URL.createObjectURL(new Blob([issued.text], { type: "application/json" }))
      const link = window.document.createElement("a")
      link.href = url
      link.download = "gateway-sync.json"
      window.document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }} />
}
