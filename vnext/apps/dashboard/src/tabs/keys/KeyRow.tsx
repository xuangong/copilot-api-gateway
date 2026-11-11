import { useState } from "react"
import { Check, Copy, Trash2 } from "lucide-react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Td } from "../../ui/table"
import { copyToClipboard, fullDateTime, timeAgo, truncateKey } from "./helpers"

interface Props {
  row: ApiKeyDetail
  selected: boolean
  canManage: boolean
  busy: boolean
  onSelect: () => void
  onDelete: () => void
  onRequests?: () => void
}

export function KeyRow({ row, selected, canManage, busy, onSelect, onDelete, onRequests }: Props) {
  const [copied, setCopied] = useState(false)
  const t = useT()

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!(await copyToClipboard(row.key))) return
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
      className={cn(
        "transition-colors cursor-pointer",
        selected ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <Td>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full shrink-0 transition-colors", selected ? "bg-brand" : "bg-transparent")}
          />
          <button
            type="button"
            aria-pressed={selected}
            className="text-left font-medium text-fg cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
          >
            {row.name}
          </button>
        </div>
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          {row.owner_name ? (
            <span className="text-xs text-fg-muted">{row.owner_name}</span>
          ) : !isShared ? (
            <span className="text-xs text-fg-subtle">—</span>
          ) : null}
          {isShared ? <Badge tone="brand">{t("dash.sharedBadge")}</Badge> : null}
          {!isShared && assigneeCount > 0 ? (
            <span
              className="cursor-default"
              title={row.assignees!.map((a) => a.user_name || t("dash.unknown")).join(", ")}
            >
              <Badge tone="success">{t("dash.sharedWithCount", { n: assigneeCount })}</Badge>
            </span>
          ) : null}
        </div>
      </Td>
      <Td>
        <code className="font-mono text-xs text-fg-muted">{truncateKey(row.key)}</code>
      </Td>
      <Td className="hidden sm:table-cell">
        <span className="tabular-nums text-fg-muted cursor-default" title={fullDateTime(row.created_at)}>
          {timeAgo(row.created_at)}
        </span>
      </Td>
      <Td className="hidden sm:table-cell">
        {row.last_used_at ? (
          <span className="tabular-nums text-fg-muted cursor-default" title={fullDateTime(row.last_used_at)}>
            {timeAgo(row.last_used_at)}
          </span>
        ) : (
          <span className="text-fg-muted">{t("dash.never")}</span>
        )}
      </Td>
      <Td className="text-right">
        <div className="flex items-center justify-end gap-1">
          {onRequests ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => { event.stopPropagation(); onRequests() }}
            >
              {t("dash.requests.action")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopy}
            title={t("dash.copyKey")}
            aria-label={t("dash.copyKey")}
          >
            {copied ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
          </Button>
          {canManage && !isShared ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDelete}
              disabled={busy}
              title={t("dash.deleteKey")}
              aria-label={t("dash.deleteKey")}
              className="hover:text-danger"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </Td>
    </tr>
  )
}
