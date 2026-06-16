import { useMemo, useState } from "react"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useUpstreams } from "../../state/upstreams"
import { UpstreamRow } from "./UpstreamRow"
import { UpstreamFormModal } from "./UpstreamFormModal"
import { DeviceFlowModal } from "./DeviceFlowModal"
import type { UpstreamRecord } from "../../api/types"

type CreateMode = { kind: "create"; provider: "custom" | "azure" | "sdf" }

interface OwnerGroup {
  ownerId: string
  label: string
  rows: UpstreamRecord[]
  isMine: boolean
}

export function UpstreamsTab() {
  const store = useUpstreams()
  const { session } = useAuth()
  const t = useT()
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deviceFlowOpen, setDeviceFlowOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const openCreate = (provider: "custom" | "azure" | "sdf") => {
    setEditingId(null)
    setCreateMode({ kind: "create", provider })
  }
  const openEdit = async (row: UpstreamRecord) => {
    setCreateMode(null)
    await store.ensureFlagCatalog().catch(() => null)
    setEditingId((cur) => (cur === row.id ? null : row.id))
  }

  const myOwnerId = session?.userId != null ? String(session.userId) : ""

  const groups: OwnerGroup[] = useMemo(() => {
    const map = new Map<string, OwnerGroup>()
    for (const u of store.upstreams) {
      const key = u.ownerId || ""
      let g = map.get(key)
      if (!g) {
        g = { ownerId: key, label: "", rows: [], isMine: key === myOwnerId }
        map.set(key, g)
      }
      g.rows.push(u)
    }
    for (const g of map.values()) {
      const copilot = g.rows.find((r) => r.provider === "copilot" && r.config?.user?.login)
      const login = copilot?.config?.user?.login
      g.label = login
        ? `@${login}`
        : g.ownerId
          ? `#${g.ownerId.slice(0, 8)}`
          : t("dash.globalOwner")
    }
    // Own group first, then alphabetical
    return [...map.values()].sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1
      return a.label.localeCompare(b.label)
    })
  }, [store.upstreams, myOwnerId, t])

  return (
    <div>
      <div className="glass-card p-4 sm:p-6 mb-8 animate-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h3 className="text-themed font-medium">{t("dash.managedUpstreams")}</h3>
            <p className="text-xs text-themed-dim mt-1">
              {t("dash.managedUpstreamsDesc")}
            </p>
          </div>
          <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
            <button onClick={() => setDeviceFlowOpen(true)} className="btn-primary text-sm">{t("dash.addCopilot")}</button>
            <button onClick={() => openCreate("custom")} className="btn-ghost text-sm">{t("dash.addCustom")}</button>
            <button onClick={() => openCreate("azure")} className="btn-ghost text-sm">{t("dash.addAzure")}</button>
            <button onClick={() => openCreate("sdf")} className="btn-ghost text-sm">{t("dash.addSdf")}</button>
            <button onClick={store.reload} disabled={store.loading} className="btn-ghost text-sm" title="Refresh">↻</button>
          </div>
        </div>

        {createMode ? (
          <Expand>
            <UpstreamFormModal
              mode={createMode}
              flagCatalog={store.flagCatalog}
              ensureFlagCatalog={store.ensureFlagCatalog}
              onClose={() => setCreateMode(null)}
              onSaved={() => {
                setCreateMode(null)
                store.reload()
              }}
            />
          </Expand>
        ) : null}

        {store.loading && store.upstreams.length === 0 ? (
          <p className="text-sm text-themed-dim">{t("dash.loadingShort")}</p>
        ) : null}

        {!store.loading && store.upstreams.length === 0 ? (
          <p className="text-sm text-themed-dim italic">{t("dash.noManagedUpstreams")}</p>
        ) : null}

        <div className="space-y-4">
          {groups.map((g) => {
            const groupKey = g.ownerId || "__global__"
            const isCollapsed = !!collapsed[groupKey]
            return (
              <div key={groupKey}>
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [groupKey]: !c[groupKey] }))}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left rounded hover:bg-surface-700/40 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-themed-dim">{isCollapsed ? "▶" : "▼"}</span>
                    <span className="text-sm font-medium text-themed truncate">{g.label}</span>
                    {g.isMine ? (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-violet/20 text-accent-violet">
                        {t("dash.youBadge")}
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-700 text-themed-dim">
                        {t("dash.readOnlyBadge")}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-themed-dim shrink-0">
                    {t("dash.upstreamCount", { n: g.rows.length })}
                  </span>
                </button>

                {!isCollapsed ? (
                  <div className="space-y-2 mt-2">
                    {g.rows.map((u, idx) => (
                      <div key={u.id}>
                        <UpstreamRow
                          row={u}
                          index={idx}
                          total={g.rows.length}
                          busy={!!store.busy[u.id]}
                          models={store.modelsByUpstream.get(u.id)}
                          editing={editingId === u.id}
                          readOnly={!g.isMine}
                          onToggleEnabled={() => store.toggleEnabled(u)}
                          onReorder={(d) => store.reorder(u.id, d)}
                          onEdit={() => openEdit(u)}
                          onRefreshModels={() => store.probe(u.id)}
                          onReauth={() => setDeviceFlowOpen(true)}
                          onDelete={async () => {
                            await store.remove(u)
                          }}
                        />
                        <Expand open={editingId === u.id && g.isMine}>
                          <UpstreamFormModal
                            mode={{ kind: "edit", row: u }}
                            flagCatalog={store.flagCatalog}
                            ensureFlagCatalog={store.ensureFlagCatalog}
                            onClose={() => setEditingId(null)}
                            onSaved={() => {
                              setEditingId(null)
                              store.reload()
                            }}
                          />
                        </Expand>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {deviceFlowOpen ? (
        <DeviceFlowModal
          onClose={() => setDeviceFlowOpen(false)}
          onComplete={() => {
            setDeviceFlowOpen(false)
            store.reload()
          }}
        />
      ) : null}
    </div>
  )
}

// Expand: simple grid-rows animation. Uses [grid-template-rows:0fr] → 1fr
// trick so the panel can animate to its natural height.
function Expand({ open = true, children }: { open?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out ${
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      }`}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}
