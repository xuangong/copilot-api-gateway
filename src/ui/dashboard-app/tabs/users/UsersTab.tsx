import { useState } from "react"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useUsers } from "../../state/users"
import { UserRow } from "./UserRow"
import { InviteCodesPanel } from "./InviteCodesPanel"
import { AssignKeysModal } from "./AssignKeysModal"
import type { AdminUser } from "../../api/users"

export function UsersTab() {
  const { session } = useAuth()
  const store = useUsers()
  const t = useT()
  const [assignTarget, setAssignTarget] = useState<{ id: string; name: string } | null>(null)

  const currentUserId = session?.userId != null ? String(session.userId) : undefined

  return (
    <div>
      <InviteCodesPanel
        invites={store.invites}
        loading={store.invitesLoading}
        creating={store.inviteCreating}
        onCreate={store.createInvite}
        onDelete={store.deleteInvite}
      />

      <div className="glass-card p-4 sm:p-6 mb-8 animate-in">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h3 className="text-themed font-medium">{t("dash.usersListHeader")}</h3>
          <button onClick={store.reloadUsers} disabled={store.usersLoading} className="btn-ghost text-sm">
            ↻
          </button>
        </div>

        {store.usersLoading && store.users.length === 0 ? (
          <p className="text-sm text-themed-dim">{t("dash.loadingShort")}</p>
        ) : null}
        {!store.usersLoading && store.users.length === 0 ? (
          <p className="text-sm text-themed-dim italic">{t("dash.noUsersRegistered")}</p>
        ) : null}

        <div className="space-y-2">
          {store.users.map((u: AdminUser) => (
            <UserRow
              key={u.id}
              user={u}
              busy={!!store.busy[u.id]}
              quotas={store.quotas}
              isSelf={currentUserId != null && currentUserId === u.id}
              onAssign={() => setAssignTarget({ id: u.id, name: u.name })}
              onToggle={() => store.toggleUser(u)}
              onDelete={() => store.deleteUser(u)}
            />
          ))}
        </div>
      </div>

      {assignTarget ? (
        <AssignKeysModal
          userId={assignTarget.id}
          userName={assignTarget.name}
          onClose={() => {
            setAssignTarget(null)
            store.reloadUsers()
          }}
        />
      ) : null}
    </div>
  )
}
