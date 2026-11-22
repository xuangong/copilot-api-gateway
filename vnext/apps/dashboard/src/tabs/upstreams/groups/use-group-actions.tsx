import { useState, type ReactNode } from "react"
import type { UpstreamRecord } from "../../../api/types"
import * as groups from "../../../api/upstream-groups"
import type { GroupItem } from "../../../state/group-items"
import { useConfirm } from "../../../state/confirm"
import { useT } from "../../../state/i18n"
import { useToast } from "../../../state/toast"
import { Button } from "../../../ui/button"
import { Field } from "../form/Field"
import { AddMemberControl } from "./AddMemberControl"
import { CalibrateForm } from "./CalibrateForm"
import { GroupSettingsForm } from "./GroupSettingsForm"
import { groupErrorText } from "../../../state/group-errors"
import { memberCandidates, refreshNotice } from "./group-actions"

interface Args { upstreams: readonly UpstreamRecord[]; reload: () => Promise<void>; refreshStatuses: () => Promise<void> }

/** Everything the group cards do: create, rename, enable, delete, settings, add and remove members, Refresh and Calibrate. Every change reloads the lists. */
export function useGroupActions({ upstreams, reload, refreshStatuses }: Args) {
  const t = useT()
  const { push: toast } = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  /** Members whose Refresh or Calibrate is in flight: only that row is disabled, and a second click cannot start a second read. */
  const [busyMembers, setBusyMembers] = useState<ReadonlySet<string>>(new Set())
  const withMember = async (upstreamId: string, work: () => Promise<void>) => {
    if (busyMembers.has(upstreamId)) return
    setBusyMembers(current => new Set(current).add(upstreamId))
    try { await work() } finally { setBusyMembers(current => { const next = new Set(current); next.delete(upstreamId); return next }) }
  }
  const errorText = (error: unknown): string => groupErrorText(error, t, Date.now())
  const [settingsOpenId, setSettingsOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [calibratingId, setCalibratingId] = useState<string | null>(null)
  const [calError, setCalError] = useState<string | undefined>()

  const run = async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true)
    try { await work(); if (done) toast(done, "success"); await reload(); await refreshStatuses(); return true }
    catch (error) {
      toast(errorText(error), "error")
      // The lists may have changed under us (deleted group, moved upstream): show the truth.
      await Promise.allSettled([reload(), refreshStatuses()])
      return false
    } finally { setBusy(false) }
  }

  const refreshMember = (upstreamId: string) => withMember(upstreamId, async () => {
    try {
      const result = await groups.refreshQuota(upstreamId)
      const notice = refreshNotice(result, t, Date.now())
      toast(notice.text, notice.tone)
    } catch (error) { toast(errorText(error), "error") }
    await refreshStatuses()
  })

  return {
    busy,
    isMemberBusy: (upstreamId: string) => busyMembers.has(upstreamId),
    settingsOpenId,
    createGroup: (name: string) => run(() => groups.createGroup({ name })),
    toggleEnabled: (group: groups.UpstreamGroup) => run(() => groups.patchGroup(group.id, { enabled: !group.enabled })),
    rename: (group: groups.UpstreamGroup) => setRenamingId(current => current === group.id ? null : group.id),
    remove: async (group: groups.UpstreamGroup) => {
      const sure = await confirm({ title: t("dash.qbConfirmDelete", { name: group.name }), description: t("dash.qbConfirmDeleteHint"), confirmLabel: t("dash.delete"), danger: true })
      if (sure) await run(() => groups.deleteGroup(group.id))
    },
    toggleSettings: (id: string) => setSettingsOpenId(current => current === id ? null : id),
    refreshMember,
    calibrate: (upstreamId: string) => { setCalError(undefined); setCalibratingId(current => current === upstreamId ? null : upstreamId) },
    removeMember: (upstream: UpstreamRecord) => run(() => groups.setUpstreamGroup(upstream.id, null)),
    /** The calibration form of a member, to render directly under its quota row (null unless that member is being calibrated). */
    calibrationFor: (upstreamId: string, name: string, lastReadAt: number | null): ReactNode => calibratingId !== upstreamId ? null : (
      <CalibrateForm name={name} lastReadAt={lastReadAt} busy={busy || busyMembers.has(upstreamId)} error={calError} onCancel={() => setCalibratingId(null)}
        onSave={body => withMember(upstreamId, async () => {
          try { await groups.calibrateQuota(upstreamId, body); toast(t("dash.qbCalSaved"), "success"); setCalibratingId(null); await refreshStatuses() }
          catch (error) { setCalError(errorText(error)) }
        })} />
    ),
    /** The content below a group's members: rename, settings and the add-member control. */
    footer: (item: GroupItem): ReactNode => (
      <>
        {renamingId === item.group.id ? <RenameInline name={item.group.name} busy={busy} onSave={async name => { if (await run(() => groups.patchGroup(item.group.id, { name }))) setRenamingId(null) }} onCancel={() => setRenamingId(null)} /> : null}
        {settingsOpenId === item.group.id ? (
          <div className="mt-3 rounded-md border border-border bg-background p-3">
            <div className="mb-2 text-xs font-medium text-fg">{t("dash.qbSettings")}</div>
            <GroupSettingsForm saved={item.group.settings} saving={busy} onSave={async settings => { await run(() => groups.patchGroup(item.group.id, { settings }), t("dash.qbSettingsSaved")) }} />
          </div>
        ) : null}
        <AddMemberControl candidates={memberCandidates(upstreams, item.group)} busy={busy}
          onAdd={async upstream => { if (await run(() => groups.setUpstreamGroup(upstream.id, item.group.id))) void groups.refreshQuota(upstream.id).then(refreshStatuses).catch(() => {}) }} />
      </>
    ),
  }
}

function RenameInline({ name, busy, onSave, onCancel }: { name: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const t = useT()
  const [value, setValue] = useState(name)
  const submit = () => { if (value.trim() !== "") onSave(value.trim()) }
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <Field label={t("dash.qbGroupName")}>
        {({ id }) => <input id={id} type="text" value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === "Enter") submit(); if (event.key === "Escape") onCancel() }} maxLength={80} disabled={busy} autoFocus />}
      </Field>
      <Button variant="primary" size="sm" disabled={busy || value.trim() === ""} onClick={submit}>{t("dash.qbSave")}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("dash.qbCancel")}</Button>
    </div>
  )
}
