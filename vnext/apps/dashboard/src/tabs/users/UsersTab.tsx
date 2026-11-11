import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useUsers } from "../../state/users"
import { UserRow } from "./UserRow"
import { InviteCodesPanel } from "./InviteCodesPanel"
import { AssignKeysModal } from "./AssignKeysModal"
import type { AdminUser } from "../../api/users"
import { Button } from "../../ui/button"
import { Card } from "../../ui/card"
import { EmptyState } from "../../ui/empty-state"
import { PageHeader } from "../../ui/page-header"

export function UsersTab() {
  const { session } = useAuth()
  const store = useUsers()
  const t = useT()
  const [assignTarget, setAssignTarget] = useState<{ id: string; name: string } | null>(null)

  const currentUserId = session?.userId != null ? String(session.userId) : undefined

  return (
    <div>
      <PageHeader
        title={t("dash.users")}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={store.reloadUsers}
            disabled={store.usersLoading}
            title={t("dash.refreshLabel")}
            aria-label={t("dash.refreshLabel")}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        }
      />

      <InviteCodesPanel
        invites={store.invites}
        loading={store.invitesLoading}
        creating={store.inviteCreating}
        onCreate={store.createInvite}
        onDelete={store.deleteInvite}
      />

      {/* The page h1 already reads "Users"; the list card is named rather than given a second heading. */}
      <Card aria-label={t("dash.usersListHeader")} className="mb-4">
        {store.usersLoading && store.users.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("dash.loadingShort")}</p>
        ) : null}
        {!store.usersLoading && store.users.length === 0 ? <EmptyState title={t("dash.noUsersRegistered")} /> : null}

        {store.users.length > 0 ? (
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
        ) : null}
      </Card>

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
