import { useState } from "react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import { copyToClipboard, fullDateTime, timeAgo, truncateKey } from "./helpers"

interface Props {
  row: ApiKeyDetail
  selected: boolean
  canManage: boolean
  busy: boolean
  onSelect: () => void
  onDelete: () => void
}

export function KeyRow({ row, selected, canManage, busy, onSelect, onDelete }: Props) {
  const [copied, setCopied] = useState(false)
  const t = useT()

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await copyToClipboard(row.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete()
  }

  const isShared = row.is_owner === false
  const assigneeCount = row.assignees?.length ?? 0

  return (
    <tr
      onClick={onSelect}
      className={`border-b border-white/[0.03] transition-colors cursor-pointer ${
        selected ? "bg-accent-violet/5 hover:bg-accent-violet/10" : "hover:bg-white/[0.02]"
      }`}
    >
      <td className="py-3 pr-4 pl-2">
        <div className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
              selected ? "bg-accent-violet" : "bg-transparent"
            }`}
          />
          <span className="text-themed font-medium">{row.name}</span>
        </div>
      </td>
      <td className="py-3 pr-4">
        {row.owner_name ? (
          <span className="text-xs text-themed-secondary">{row.owner_name}</span>
        ) : !isShared ? (
          <span className="text-xs text-themed-dim">—</span>
        ) : null}
        {isShared ? (
          <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-accent-violet/10 text-accent-violet">
            {t("dash.sharedBadge")}
          </span>
        ) : null}
        {!isShared && assigneeCount > 0 ? (
          <span
            className="ml-1 text-[10px] text-themed-dim cursor-default"
            title={row.assignees!.map((a) => a.user_name || t("dash.unknown")).join(", ")}
          >
            <span className="px-1.5 py-0.5 rounded bg-accent-teal/10 text-accent-teal">
              {t("dash.sharedWithCount", { n: assigneeCount })}
            </span>
          </span>
        ) : null}
      </td>
      <td className="py-3 pr-4">
        <code className="text-xs font-mono text-themed-dim bg-surface-800 rounded px-2 py-1">
          {truncateKey(row.key)}
        </code>
      </td>
      <td className="py-3 pr-4 hidden sm:table-cell">
        <span className="text-themed-dim text-xs cursor-default" title={fullDateTime(row.created_at)}>
          {timeAgo(row.created_at)}
        </span>
      </td>
      <td className="py-3 pr-4 hidden sm:table-cell">
        {row.last_used_at ? (
          <span className="text-themed-dim text-xs cursor-default" title={fullDateTime(row.last_used_at)}>
            {timeAgo(row.last_used_at)}
          </span>
        ) : (
          <span className="text-themed-dim text-xs">{t("dash.never")}</span>
        )}
      </td>
      <td className="py-3 pr-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={handleCopy}
            title={t("dash.copyKey")}
            className="text-themed-dim hover:text-accent-violet transition-colors p-1"
          >
            {copied ? (
              <svg
                className="w-4 h-4 text-accent-teal"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          {canManage && !isShared ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              title={t("dash.deleteKey")}
              className="text-themed-dim hover:text-accent-red transition-colors p-1 disabled:opacity-40"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  )
}
