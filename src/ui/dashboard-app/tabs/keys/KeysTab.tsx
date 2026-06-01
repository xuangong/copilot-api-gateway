import { useState } from "react"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useKeys } from "../../state/keys"
import { JustCreatedKeyModal } from "./JustCreatedKeyModal"
import { KeyDetailPanel } from "./KeyDetailPanel"
import { KeyRow } from "./KeyRow"

export function KeysTab() {
  const { session } = useAuth()
  const store = useKeys()
  const t = useT()
  const [newKeyName, setNewKeyName] = useState("")

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
      <div className="glass-card p-4 sm:p-6 mb-8 animate-in">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="text-themed font-medium">{t("dash.apiKeys")}</h3>
            <p className="text-xs text-themed-dim mt-1">
              {t("dash.apiKeysDesc")}
            </p>
          </div>
          {canCreate ? (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <input
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
                className="flex-1 sm:flex-none sm:w-40 mt-1 text-sm min-w-0"
              />
              <button
                type="button"
                onClick={submitCreate}
                disabled={!newKeyName.trim() || store.creating}
                className="btn-primary text-xs py-1.5 px-3 whitespace-nowrap"
              >
                {store.creating ? t("dash.creatingShort") : t("dash.createBtn")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          {store.keys.length === 0 && !store.loading ? (
            <p className="text-sm text-themed-dim py-4 text-center">{t("dash.noApiKeys")}</p>
          ) : null}
          {store.loading && store.keys.length === 0 ? (
            <div className="space-y-3 py-2">
              <div className="h-10 bg-surface-600 rounded animate-pulse" />
              <div className="h-10 bg-surface-600 rounded animate-pulse" />
            </div>
          ) : null}
          {store.keys.length > 0 ? (
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left py-2 pr-4 pl-7 text-xs font-medium text-themed-dim uppercase tracking-widest">
                    {t("dash.name")}
                  </th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">
                    {t("dash.owner")}
                  </th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest">
                    {t("dash.key")}
                  </th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest hidden sm:table-cell">
                    {t("dash.created")}
                  </th>
                  <th className="text-left py-2 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest hidden sm:table-cell">
                    {t("dash.lastUsedShort")}
                  </th>
                  {canCreate ? (
                    <th className="text-right py-2 pr-2 text-xs font-medium text-themed-dim uppercase tracking-widest">
                      {t("dash.actions")}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
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
                  />
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>

      {store.selectedKey ? (
        <KeyDetailPanel
          keyRow={store.selectedKey}
          allKeys={store.keys}
          isAdmin={isAdmin}
          isUser={isUser}
          busy={!!store.busy[store.selectedKey.id]}
          quotaUsage={store.quotaUsage}
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
        <JustCreatedKeyModal data={store.justCreated} onClose={() => store.setJustCreated(null)} />
      ) : null}
    </div>
  )
}
