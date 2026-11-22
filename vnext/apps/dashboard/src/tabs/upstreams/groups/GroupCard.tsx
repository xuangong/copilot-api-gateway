import { useId, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { ChevronDown, ChevronUp, GripVertical, Layers } from "lucide-react"
import type { GroupStatus } from "../../../api/upstream-groups"
import type { GroupItem } from "../../../state/group-items"
import { useT } from "../../../state/i18n"
import { Badge } from "../../../ui/badge"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"

interface Props {
  item: GroupItem
  status?: GroupStatus
  /** Position among the items it can be reordered with. */
  index: number
  total: number
  dragging: boolean
  dropTarget: boolean
  readOnly: boolean
  busy: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void
  onReorder: (direction: "up" | "down") => void
  onToggleEnabled: () => void
  onRename: () => void
  onDelete: () => void
  onToggleSettings: () => void
  settingsOpen: boolean
  children?: ReactNode
  /** Below the members: the add-member control, the settings panel. */
  footer?: ReactNode
}

const STATE_KEYS = { normal: "dash.qbStateNormal", stopped: "dash.qbStateStopped", unknown: "dash.qbStateUnknown", overage: "dash.qbStateOverage" } as const
const ATTENTION_KEYS = { large_error: "dash.qbAttLargeError", read_failing: "dash.qbAttReadFailing", entitlement_changed: "dash.qbAttEntitlement" } as const

/** A group is one card in the upstream list: dragged and reordered as a unit, its members inside without an order of their own. */
export function GroupCard({
  item, status, index, total, dragging, dropTarget, readOnly, busy, onDragStart, onDragOver, onDrop, onDragEnd, onHandlePointerDown, onReorder,
  onToggleEnabled, onRename, onDelete, onToggleSettings, settingsOpen, children, footer,
}: Props) {
  const t = useT()
  const nameId = useId()
  const { group, members } = item
  const state = status?.state ?? "normal"
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); onReorder(event.key === "ArrowUp" ? "up" : "down") }
  }
  const nameOf = (upstreamId: string) => status?.members.find(m => m.upstreamId === upstreamId)?.name ?? upstreamId
  return (
    <section
      data-group-id={group.id} aria-labelledby={nameId} tabIndex={-1} onDragOver={onDragOver} onDrop={onDrop}
      className={cn("rounded-lg border border-brand-text/40 bg-panel p-3 sm:p-4 transition-colors", dragging && "opacity-50", dropTarget && "ring-2 ring-brand-text")}
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="size-4 shrink-0 text-brand-text" aria-hidden="true" />
          <h3 id={nameId} className="truncate text-body font-medium text-fg">{group.name}</h3>
          <Badge tone="brand">{t("dash.qbGroup")}</Badge>
          <span className="shrink-0 text-xs text-fg-subtle">{t("dash.qbMembers", { n: members.length })}</span>
          {!group.enabled ? <Badge>{t("dash.qbGroupOff")}</Badge> : null}
          {state === "stopped" ? <Badge tone="danger">{t("dash.qbStateStopped")}</Badge> : state === "overage" ? <Badge tone="warn">{t("dash.qbStateOverage")}</Badge> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button variant="ghost" size="icon-sm" draggable={!readOnly} disabled={readOnly} onDragStart={onDragStart} onDragEnd={onDragEnd} onPointerDown={onHandlePointerDown} onKeyDown={onHandleKeyDown}
            aria-label={t("dash.qbReorderGroupHandle", { name: group.name })} title={t("dash.qbReorderGroupHandle", { name: group.name })} className="cursor-grab enabled:active:cursor-grabbing touch-none">
            <GripVertical aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onReorder("up")} disabled={readOnly || index === 0} title={t("dash.moveUp")} aria-label={t("dash.moveUp")}><ChevronUp aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onReorder("down")} disabled={readOnly || index === total - 1} title={t("dash.moveDown")} aria-label={t("dash.moveDown")}><ChevronDown aria-hidden="true" /></Button>
          <label className={cn("ml-1 flex select-none items-center gap-1 text-xs text-fg-muted", readOnly || busy ? "cursor-not-allowed" : "cursor-pointer")}>
            <input type="checkbox" role="switch" checked={group.enabled} onChange={onToggleEnabled} disabled={readOnly || busy} aria-describedby={nameId} className="accent-brand" />
            <span>{group.enabled ? t("dash.onLabel") : t("dash.offLabel")}</span>
          </label>
          {!readOnly ? (
            <>
              <Button variant="ghost" size="sm" onClick={onToggleSettings} aria-expanded={settingsOpen} disabled={busy}>{settingsOpen ? t("dash.closeBtn") : t("dash.qbSettings")}</Button>
              <Button variant="ghost" size="sm" onClick={onRename} disabled={busy}>{t("dash.qbRename")}</Button>
              <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} className="text-danger hover:text-danger">{t("dash.qbDeleteGroup")}</Button>
            </>
          ) : null}
        </div>
      </header>
      {(state === "normal" || state === "unknown") && group.enabled ? <p className="mt-1 text-xs text-fg-subtle">{t(STATE_KEYS[state])}</p> : null}
      {status && status.attention.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-warn-text">
          {status.attention.map(a => <li key={`${a.upstreamId}:${a.kind}`}>{t(ATTENTION_KEYS[a.kind], { name: nameOf(a.upstreamId) })}</li>)}
        </ul>
      ) : null}
      <div className="mt-3 space-y-2">
        {members.length === 0 ? <p className="text-xs text-fg-muted">{t("dash.qbNoMembers")}</p> : children}
      </div>
      {footer}
    </section>
  )
}
