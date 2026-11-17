import { useId, useState } from "react"
import { Check, Copy, Trash2 } from "lucide-react"
import type { ApiKeyDetail } from "../../api/keys"
import type { ProtectionPause } from "../../api/protection"
import { summarizeReason } from "../../components/protection-banner-model"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Td } from "../../ui/table"
import { timeAgo } from "../../state/time-ago"
import { formatUntil } from "../telemetry/telemetry-format"
import { copyToClipboard, fullDateTime, truncateKey } from "./helpers"

interface Props {
  row: ApiKeyDetail
  selected: boolean
  canManage: boolean
  busy: boolean
  onSelect: () => void
  onDelete: () => void
  onRequests?: () => void
  /** The active pause on this key, if any. */
  pause?: ProtectionPause
  /** Resumes the pause; only used when the server says the viewer may (`pause.canResume`). */
  onResume?: () => void
  /** The Resume request is in flight. */
  resuming?: boolean
}

export function KeyRow({ row, selected, canManage, busy, onSelect, onDelete, onRequests, pause, onResume, resuming = false }: Props) {
  const [copied, setCopied] = useState(false)
  const t = useT()
  const pauseNoteId = useId()

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
  const pauseReason = pause
    ? pause.upstreamName === ""
      ? summarizeReason(pause.reason, t)
      : t("dash.protKeyPausedTip", { summary: summarizeReason(pause.reason, t), upstream: pause.upstreamName })
    : ""
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
          {pause ? (
            <>
              {/* Focusable and described by hidden text, so the reason is reachable by keyboard and screen reader, not only on hover. */}
              <span className="cursor-default" tabIndex={0} aria-describedby={pauseNoteId} title={pauseReason}>
                <Badge tone="danger">{t("dash.protKeyPausedBadge", { until: formatUntil(pause.endsAt, Date.now()) })}</Badge>
              </span>
              <span id={pauseNoteId} className="sr-only">{pauseReason}</span>
            </>
          ) : null}
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
          {pause && onResume && pause.canResume ? (
            <Button variant="secondary" size="sm" disabled={resuming} onClick={(event) => { event.stopPropagation(); onResume() }}>{t("dash.protResumeKey")}</Button>
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
