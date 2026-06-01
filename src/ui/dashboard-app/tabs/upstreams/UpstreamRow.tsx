import { useState } from "react"
import { ProviderAvatar } from "./KindChip"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { UpstreamRecord } from "../../api/types"
import type * as api from "../../api/upstreams"

interface Props {
  row: UpstreamRecord
  index: number
  total: number
  busy: boolean
  models?: api.UpstreamModelEntry[]
  editing?: boolean
  onToggleEnabled: () => void
  onReorder: (dir: "up" | "down") => void
  onEdit: () => void
  onRefreshModels: () => void
  onReauth: () => void
  onDelete: () => void
}

export function UpstreamRow({
  row,
  index,
  total,
  busy,
  models,
  editing,
  onToggleEnabled,
  onReorder,
  onEdit,
  onRefreshModels,
  onReauth,
  onDelete,
}: Props) {
  const u = row
  const ghUser = u.provider === "copilot" ? u.config?.user : undefined
  const avatar = ghUser
    ? ghUser.avatar_url || `https://avatars.githubusercontent.com/u/${ghUser.id}?v=4`
    : null
  const [expanded, setExpanded] = useState(false)
  const { push: toast } = useToast()
  const t = useT()
  const modelList = models ?? []
  const shown = expanded ? modelList : modelList.slice(0, 8)

  const copy = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement("textarea")
        ta.value = text
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      toast(t("dash.copiedKeyToast", { text }), "success")
    } catch (e) {
      toast(t("dash.copyFailedToast", { error: e instanceof Error ? e.message : String(e) }), "error")
    }
  }

  return (
    <div
      className={`bg-surface-900 rounded-lg p-3 sm:p-4 border transition-colors ${
        editing ? "border-accent-violet/60" : "border-surface-600"
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <ProviderAvatar provider={u.provider} avatarUrl={avatar} title={u.provider} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-themed truncate">{u.name}</div>
            <div className="text-xs text-themed-dim font-mono truncate">
              {ghUser?.login ? `@${ghUser.login}` : u.id}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap shrink-0">
          <button onClick={() => onReorder("up")} disabled={index === 0 || busy} className="btn-ghost text-xs px-2 py-1" title={t("dash.moveUp")}>↑</button>
          <button onClick={() => onReorder("down")} disabled={index === total - 1 || busy} className="btn-ghost text-xs px-2 py-1" title={t("dash.moveDown")}>↓</button>
          <label className="flex items-center gap-1 text-xs text-themed-dim cursor-pointer ml-1 select-none">
            <input type="checkbox" checked={u.enabled} onChange={onToggleEnabled} />
            <span>{u.enabled ? t("dash.onLabel") : t("dash.offLabel")}</span>
          </label>
          <button onClick={onEdit} disabled={busy} className="btn-ghost text-xs px-2 py-1">{editing ? t("dash.closeBtn") : t("dash.edit")}</button>
          <button onClick={onRefreshModels} disabled={busy} className="btn-ghost text-xs px-2 py-1" title={t("dash.refetchModelsTip")}>
            {busy ? "…" : t("dash.refetchModelsLabel")}
          </button>
          {u.provider === "copilot" ? (
            <button onClick={onReauth} className="btn-ghost text-xs px-2 py-1" title={t("dash.reauthTip")}>{t("dash.reauthBtn")}</button>
          ) : null}
          <button
            onClick={onDelete}
            disabled={busy}
            className="text-accent-red hover:text-red-300 text-xs px-2 py-1 disabled:opacity-50"
          >
            {u.provider === "copilot" ? t("dash.signOutBtn") : t("dash.delete")}
          </button>
        </div>
      </div>

      {modelList.length > 0 ? (
        <div className="mt-3 text-xs">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-themed-dim">{t("dash.modelsServedHeader", { n: modelList.length })}</div>
            {modelList.length > 8 ? (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-themed-dim hover:text-themed text-[11px] px-2 py-0.5 rounded hover:bg-surface-700"
              >
                {expanded ? t("dash.collapseBtn") : t("dash.showAll", { n: modelList.length })}
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {shown.map((m) => (
              <button
                key={m.id}
                onClick={(e) => copy(e.shiftKey ? `${u.id}/${m.id}` : m.id)}
                title={`click: copy ${m.id}\nshift-click: copy pinned ${u.id}/${m.id}`}
                className="px-2 py-0.5 bg-surface-700 hover:bg-surface-600 rounded text-themed font-mono transition-colors"
              >
                {m.id}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
