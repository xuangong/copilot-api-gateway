import { useState } from "react"
import type { UpstreamRecord } from "../../../api/types"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { Select } from "../../../ui/select"

/** Moves one of the owner's ungrouped Copilot upstreams into the group. */
export function AddMemberControl({ candidates, busy, onAdd }: { candidates: readonly UpstreamRecord[]; busy: boolean; onAdd: (upstream: UpstreamRecord) => void }) {
  const t = useT()
  const [picked, setPicked] = useState("")
  if (candidates.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select ariaLabel={t("dash.qbAddMember")} placeholder={t("dash.qbAddMemberPick")} value={picked} onChange={setPicked} disabled={busy} size="sm"
        options={candidates.map(u => ({ value: u.id, label: u.config?.user?.login ? `@${u.config.user.login}` : u.name }))} />
      <Button variant="secondary" size="sm" disabled={busy || picked === ""} onClick={() => { const row = candidates.find(u => u.id === picked); if (row) { onAdd(row); setPicked("") } }}>{t("dash.qbAddMember")}</Button>
    </div>
  )
}
