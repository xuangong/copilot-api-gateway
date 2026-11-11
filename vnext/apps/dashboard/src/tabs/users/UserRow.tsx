import { formatQuotaChip, timeAgo, type AdminUser } from "../../api/users"
import { useT } from "../../state/i18n"
import type { QuotaState } from "../../state/users"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"

interface Props {
  user: AdminUser
  busy: boolean
  isSelf: boolean
  quotas: Record<number, QuotaState>
  onAssign: () => void
  onToggle: () => void
  onDelete: () => void
}

export function UserRow({ user, busy, isSelf, quotas, onAssign, onToggle, onDelete }: Props) {
  const t = useT()
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-panel">
      <div className="flex items-center justify-between gap-3 p-3 whitespace-nowrap min-w-max">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg">{user.name}</span>
              {user.disabled ? (
                <Badge tone="danger" className="uppercase">
                  {t("dash.disabledBadge")}
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              {user.email ? <span className="text-xs text-brand-text">{user.email}</span> : null}
              {(user.githubAccounts ?? []).map((gh) => {
                const q = quotas[gh.id]
                return (
                  <span key={gh.id} className="inline-flex items-center gap-1">
                    <span className="text-xs text-fg-muted">@{gh.login}</span>
                    <span className="cursor-default tabular-nums" title={q?.error || t("dash.copilotQuotaLabel")}>
                      <Badge tone={q?.error ? "danger" : "brand"}>{formatQuotaChip(q)}</Badge>
                    </span>
                  </span>
                )
              })}
              <span className="text-xs text-fg-muted">{user.keyCount} {t("dash.ownLabel")}</span>
              {user.sharedKeyCount > 0 ? (
                <span className="text-xs text-brand-text">{user.sharedKeyCount} {t("dash.sharedShort")}</span>
              ) : null}
              <span className="text-xs text-fg-muted">{t("dash.joinedLabel")} {timeAgo(user.createdAt)}</span>
            </div>
          </div>
        </div>
        {/* Your own row offers no actions: assigning keys to yourself is meaningless,
            and disabling or deleting yourself would lock you out (the server refuses it too). */}
        {!isSelf ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onAssign} disabled={busy}>
              {t("dash.assignKeysBtn")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onToggle} disabled={busy}>
              {user.disabled ? t("dash.enableLabel") : t("dash.disableLabel")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={busy}
              className="text-danger hover:bg-danger/10 hover:text-danger"
            >
              {t("dash.deleteLabel")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
