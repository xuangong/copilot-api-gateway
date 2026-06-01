import { formatQuotaChip, timeAgo, type AdminUser } from "../../api/users"
import { useT } from "../../state/i18n"
import type { QuotaState } from "../../state/users"

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
    <div className="overflow-x-auto rounded-lg bg-surface-800/50 border border-white/[0.04] [scrollbar-width:thin]">
      <div className="flex items-center justify-between gap-3 p-4 whitespace-nowrap min-w-max">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-themed">{user.name}</span>
              {user.disabled ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent-red/10 text-accent-red uppercase">{t("dash.disabledBadge")}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              {user.email ? <span className="text-xs text-accent-violet">{user.email}</span> : null}
              {(user.githubAccounts ?? []).map((gh) => {
                const q = quotas[gh.id]
                return (
                  <span key={gh.id} className="inline-flex items-center gap-1">
                    <span className="text-xs text-themed-dim">@{gh.login}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        q?.error ? "bg-accent-red/10 text-accent-red" : "bg-accent-violet/10 text-accent-violet"
                      }`}
                      title={q?.error || t("dash.copilotQuotaLabel")}
                    >
                      {formatQuotaChip(q)}
                    </span>
                  </span>
                )
              })}
              <span className="text-xs text-themed-dim">{user.keyCount} {t("dash.ownLabel")}</span>
              {user.sharedKeyCount > 0 ? (
                <span className="text-xs text-accent-violet">{user.sharedKeyCount} {t("dash.sharedShort")}</span>
              ) : null}
              <span className="text-xs text-themed-dim">{t("dash.joinedLabel")} {timeAgo(user.createdAt)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isSelf ? (
            <button onClick={onAssign} disabled={busy} className="btn-ghost text-xs">
              {t("dash.assignKeysBtn")}
            </button>
          ) : null}
          <button onClick={onToggle} disabled={busy} className="btn-ghost text-xs">
            {user.disabled ? t("dash.enableLabel") : t("dash.disableLabel")}
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="btn-ghost text-xs text-accent-red hover:bg-accent-red/10"
          >
            {t("dash.deleteLabel")}
          </button>
        </div>
      </div>
    </div>
  )
}
