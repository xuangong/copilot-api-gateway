import { CodexQuotaPanel } from "./CodexQuotaPanel"
import { useId, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react"
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react"
import { ProviderAvatar } from "./KindChip"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { UpstreamRecord } from "../../api/types"
import * as api from "../../api/upstreams"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"

type HealthTone = "success" | "warn" | "danger"

const HEALTH_TONE: Record<NonNullable<UpstreamRecord["credentialStatus"]>["health"], HealthTone> = {
  active: "success",
  access_rejected: "danger",
  session_terminated: "danger",
  refresh_failed: "danger",
  credential_expired: "warn",
}

const LOKI_TONE: Record<NonNullable<UpstreamRecord["lokiStatus"]>["assistantStatus"], HealthTone> = {
  authorized: "success",
  waiting: "warn",
  interaction_required: "warn",
  failed: "danger",
}

const TONE_TEXT: Record<HealthTone, string> = {
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
}

interface Props {
  row: UpstreamRecord
  index: number
  total: number
  busy: boolean
  models?: api.UpstreamModelEntry[]
  editing?: boolean
  readOnly?: boolean
  showProxy?: boolean
  proxyOpen?: boolean
  onToggleProxy?: () => void
  onToggleEnabled: () => void
  onReorder: (dir: "up" | "down") => void
  dragging?: boolean
  dropTarget?: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
  /** Pointer down on the drag handle: starts a touch or pen drag (the native drag is mouse-only). */
  onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void
  onEdit: () => void
  onDuplicate: () => void
  onRefreshModels: () => void
  onRefreshCredential: () => void
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
  readOnly = false,
  showProxy = false,
  proxyOpen = false,
  onToggleProxy,
  onToggleEnabled,
  onReorder,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onHandlePointerDown,
  onEdit,
  onDuplicate,
  onRefreshModels,
  onRefreshCredential,
  onReauth,
  onDelete,
}: Props) {
  const locked = readOnly
  const u = row
  const ghUser = u.provider === "copilot" ? u.config?.user : undefined
  const avatar = ghUser
    ? ghUser.avatar_url || `https://avatars.githubusercontent.com/u/${ghUser.id}?v=4`
    : null
  const [expanded, setExpanded] = useState(false)
  const nameId = useId()
  const { push: toast } = useToast()
  const t = useT()
  const modelList = models ?? []
  const shown = expanded ? modelList : modelList.slice(0, 8)
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault()
      onReorder(event.key === "ArrowUp" ? "up" : "down")
    }
  }

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

  // Set only when the server could read a past `exp` out of this upstream's
  // credential. Absence is not a clean bill of health — see the field's doc.
  const expiredAt = u.tokenExpiredAt ? new Date(u.tokenExpiredAt).toLocaleString() : null
  const credential = u.provider === "codex" ? u.credentialStatus : undefined
  const credentialHealthKey = credential ? {
    active: "dash.codexHealthActive",
    access_rejected: "dash.codexHealthAccessRejected",
    session_terminated: "dash.codexHealthSessionTerminated",
    refresh_failed: "dash.codexHealthRefreshFailed",
    credential_expired: "dash.codexHealthExpired",
  }[credential.health] : null

  const lokiTone: HealthTone | null = u.provider === "loki" && u.lokiStatus
    ? u.lokiStatus.tokenStatus === "expired" ? "danger" : LOKI_TONE[u.lokiStatus.assistantStatus]
    : null

  return (
    <div
      data-upstream-id={u.id}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "rounded-lg border bg-panel p-3 sm:p-4 transition-colors",
        dragging && "opacity-50",
        dropTarget && "ring-2 ring-brand-text",
        editing ? "border-brand-text/60" : expiredAt ? "border-danger" : "border-border",
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <ProviderAvatar provider={u.provider} avatarUrl={avatar} title={u.provider} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 id={nameId} className="text-body font-medium text-fg truncate">{u.name}</h3>
              {expiredAt ? (
                <span className="inline-flex shrink-0 cursor-default" title={t("dash.tokenExpiredTip", { at: expiredAt })}>
                  <Badge tone="danger">{t("dash.tokenExpiredBadge")}</Badge>
                </span>
              ) : null}
            </div>
            <div className="text-xs text-fg-subtle font-mono truncate">
              {ghUser?.login ? `@${ghUser.login}` : u.id}
            </div>
            {credential && credentialHealthKey ? (
              <div className="text-xs text-fg-muted mt-1">
                <span className={TONE_TEXT[HEALTH_TONE[credential.health]]}>{t(credentialHealthKey)}</span> · {t(credential.renewable ? "dash.codexRenewable" : "dash.codexAccessOnly")} · {credential.expiryKnown && credential.expiresAt !== null
                  ? t("dash.codexExpiresAt", { at: new Date(credential.expiresAt).toLocaleString() })
                  : t("dash.codexExpiryUnknown")}
              </div>
            ) : null}
            {u.provider === "loki" && u.lokiStatus ? <div className="text-xs text-fg-muted mt-1">
              <span className={lokiTone ? TONE_TEXT[lokiTone] : undefined}>
                {t(u.lokiStatus.tokenStatus === "expired" ? "dash.lokiExpired" : {
                  waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
                  interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
                }[u.lokiStatus.assistantStatus])}
              </span>
              {u.lokiStatus.expiresAt ? ` · ${t("dash.codexExpiresAt", { at: new Date(u.lokiStatus.expiresAt).toLocaleString() })}` : ""}
            </div> : null}
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            draggable={!locked}
            disabled={locked}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onPointerDown={onHandlePointerDown}
            onKeyDown={onHandleKeyDown}
            aria-label={t("dash.reorderUpstreamHandle", { name: u.name })}
            title={t("dash.reorderUpstreamHandle", { name: u.name })}
            className="cursor-grab enabled:active:cursor-grabbing touch-none"
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onReorder("up")}
            disabled={locked || index === 0}
            title={t("dash.moveUp")}
            aria-label={t("dash.moveUp")}
          >
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onReorder("down")}
            disabled={locked || index === total - 1}
            title={t("dash.moveDown")}
            aria-label={t("dash.moveDown")}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
          <label className={cn("ml-1 flex items-center gap-1 text-xs text-fg-muted select-none", locked || busy ? "cursor-not-allowed" : "cursor-pointer")}>
            <input
              type="checkbox"
              role="switch"
              checked={u.enabled}
              onChange={onToggleEnabled}
              disabled={locked || busy}
              aria-describedby={nameId}
              className="accent-brand"
            />
            <span>{u.enabled ? t("dash.onLabel") : t("dash.offLabel")}</span>
          </label>
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={locked || busy} aria-expanded={!!editing}>
            {editing ? t("dash.closeBtn") : t("dash.edit")}
          </Button>
          {u.provider === "custom" || u.provider === "azure" || u.provider === "sdf" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDuplicate}
              disabled={locked || busy}
              aria-label={`${t("dash.duplicateUpstream")} ${u.name}`}
            >
              {t("dash.duplicateUpstream")}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onRefreshModels} disabled={locked || busy} title={t("dash.refetchModelsTip")}>
            {busy ? "…" : t("dash.refetchModelsLabel")}
          </Button>
          {credential?.renewable ? (
            <Button variant="ghost" size="sm" onClick={onRefreshCredential} disabled={locked || busy}>
              {t("dash.codexRefreshCredential")}
            </Button>
          ) : null}
          {u.provider === "copilot" ? (
            <Button variant="ghost" size="sm" onClick={onReauth} disabled={locked} title={t("dash.reauthTip")}>
              {t("dash.reauthBtn")}
            </Button>
          ) : null}
          {showProxy ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleProxy}
              title={t("dash.proxyChainTitle")}
              aria-expanded={proxyOpen}
            >
              {proxyOpen ? t("dash.closeBtn") : t("dash.proxyBtn")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={locked || busy}
            className="text-danger hover:text-danger"
          >
            {u.provider === "copilot" ? t("dash.signOutBtn") : t("dash.delete")}
          </Button>
        </div>
      </div>

      {u.provider === "codex" ? <CodexQuotaPanel key={`${u.id}:${u.updatedAt}`} upstreamId={u.id} /> : null}

      <div className="mt-3 text-xs">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-fg-muted">{t("dash.modelsServedHeader", { n: modelList.length })}</div>
          <div className="flex items-center gap-1">
            {modelList.length > 8 ? (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setExpanded((v) => !v)}>
                {expanded ? t("dash.collapseBtn") : t("dash.showAll", { n: modelList.length })}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {shown.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={(e) => copy(e.shiftKey ? `${u.id}/${m.id}` : m.id)}
              title={`click: copy ${m.id}\nshift-click: copy pinned ${u.id}/${m.id}`}
              className="rounded-md border border-control bg-background px-2 py-0.5 font-mono text-xs text-fg transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
            >
              {m.id}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
