import { useRef, useState } from "react"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useKeys } from "../../state/keys"
import { JustCreatedKeyModal } from "./JustCreatedKeyModal"
import { KeyDetailPanel } from "./KeyDetailPanel"
import { KeyRow } from "./KeyRow"
import { RequestsPanel } from "../requests/RequestsPanel"
import { Button } from "../../ui/button"
import { Card } from "../../ui/card"
import { EmptyState } from "../../ui/empty-state"
import { PageHeader } from "../../ui/page-header"
import { Table, TBody, Th } from "../../ui/table"

export function KeysTab() {
  const { session } = useAuth()
  const store = useKeys()
  const t = useT()
  const [newKeyName, setNewKeyName] = useState("")
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [requestsKeyId, setRequestsKeyId] = useState<string | null>(null)

  const isAdmin = session?.isAdmin === true
  const isUser = session?.isUser === true
  const canCreate = isAdmin || isUser

  const submitCreate = async () => {
    const trimmed = newKeyName.trim()
    if (!trimmed) return
    const created = await store.createKey(trimmed)
    if (created) setNewKeyName("")
  }

  return (
    <div>
      <PageHeader
        title={t("dash.apiKeys")}
        description={t("dash.apiKeysDesc")}
        actions={
          canCreate ? (
            <>
              <div className="w-44 sm:w-56">
                <input
                  ref={nameInputRef}
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      submitCreate()
                    }
                  }}
                  placeholder={t("dash.keyNamePlaceholder")}
                  aria-label={t("dash.keyNamePlaceholder")}
                  className="text-sm min-w-0"
                />
              </div>
              <Button
                variant="primary"
                onClick={submitCreate}
                disabled={!newKeyName.trim() || store.creating}
              >
                {store.creating ? t("dash.creatingShort") : t("dash.createBtn")}
              </Button>
            </>
          ) : null
        }
      />

      <Card className="mb-4">
        {store.keys.length === 0 && !store.loading ? <EmptyState title={t("dash.noApiKeys")} /> : null}
        {store.loading && store.keys.length === 0 ? (
          <div className="space-y-3 py-2">
            <div className="h-10 bg-muted rounded-sm animate-pulse" />
            <div className="h-10 bg-muted rounded-sm animate-pulse" />
          </div>
        ) : null}
        {store.keys.length > 0 ? (
          <Table label={t("dash.apiKeys")} className="whitespace-nowrap">
            <thead>
              <tr>
                <Th className="pl-6.5">{t("dash.name")}</Th>
                <Th>{t("dash.owner")}</Th>
                <Th>{t("dash.key")}</Th>
                <Th className="hidden sm:table-cell">{t("dash.created")}</Th>
                <Th className="hidden sm:table-cell">{t("dash.lastUsedShort")}</Th>
                <Th numeric>{t("dash.actions")}</Th>
              </tr>
            </thead>
            <TBody>
              {store.keys.map((k) => (
                <KeyRow
                  key={k.id}
                  row={k}
                  selected={store.selectedKeyId === k.id}
                  canManage={canCreate}
                  busy={!!store.busy[k.id]}
                  onSelect={() =>
                    store.setSelectedKeyId(store.selectedKeyId === k.id ? null : k.id)
                  }
                  onDelete={() => store.deleteKey(k.id, k.name)}
                  onRequests={isAdmin || (isUser && k.is_owner && k.owner_id != null && String(session?.userId) === k.owner_id)
                    ? () => setRequestsKeyId(k.id) : undefined}
                />
              ))}
            </TBody>
          </Table>
        ) : null}
      </Card>

      {requestsKeyId && store.keys.find((key) => key.id === requestsKeyId) ? (
        <RequestsPanel
          key={requestsKeyId}
          keyId={requestsKeyId}
          keyName={store.keys.find((key) => key.id === requestsKeyId)?.name ?? requestsKeyId}
          onClose={() => setRequestsKeyId(null)}
        />
      ) : null}

      {store.selectedKey ? (
        <KeyDetailPanel
          keyRow={store.selectedKey}
          allKeys={store.keys}
          isAdmin={isAdmin}
          isUser={isUser}
          busy={!!store.busy[store.selectedKey.id]}
          quotaUsage={store.quotaUsage}
          quotaLoad={store.quotaLoad}
          onSettingsSaved={store.reload}
          onQuotaRetry={store.retryQuota}
          wsUsage={store.wsUsage}
          wsUsageRange={store.wsUsageRange}
          onWsUsageRangeChange={store.setWsUsageRange}
          onPatch={(body) => store.patchKey(store.selectedKey!.id, body)}
          onCopyWebSearchFrom={(sourceId) =>
            store.copyWebSearchFrom(store.selectedKey!.id, sourceId)
          }
          onAssign={(email) => store.assignKey(store.selectedKey!.id, email)}
          onUnassign={(userId) => store.unassignKey(store.selectedKey!.id, userId)}
        />
      ) : null}

      {store.justCreated ? (
        <JustCreatedKeyModal data={store.justCreated} onClose={() => store.setJustCreated(null)} returnFocusTo={nameInputRef} />
      ) : null}
    </div>
  )
}
