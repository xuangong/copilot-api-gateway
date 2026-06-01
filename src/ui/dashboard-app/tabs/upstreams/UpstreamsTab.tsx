import { useState } from "react"
import { useT } from "../../state/i18n"
import { useUpstreams } from "../../state/upstreams"
import { UpstreamRow } from "./UpstreamRow"
import { UpstreamFormModal } from "./UpstreamFormModal"
import { DeviceFlowModal } from "./DeviceFlowModal"
import type { UpstreamRecord } from "../../api/types"

type CreateMode = { kind: "create"; provider: "custom" | "azure" }

export function UpstreamsTab() {
  const store = useUpstreams()
  const t = useT()
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deviceFlowOpen, setDeviceFlowOpen] = useState(false)

  const openCreate = (provider: "custom" | "azure") => {
    setEditingId(null)
    setCreateMode({ kind: "create", provider })
  }
  const openEdit = async (row: UpstreamRecord) => {
    setCreateMode(null)
    await store.ensureFlagCatalog().catch(() => null)
    setEditingId((cur) => (cur === row.id ? null : row.id))
  }

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
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setDeviceFlowOpen(true)} className="btn-primary text-sm">{t("dash.addCopilot")}</button>
            <button onClick={() => openCreate("custom")} className="btn-ghost text-sm">{t("dash.addCustom")}</button>
            <button onClick={() => openCreate("azure")} className="btn-ghost text-sm">{t("dash.addAzure")}</button>
            <button onClick={store.reload} disabled={store.loading} className="btn-ghost text-sm">↻</button>
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

        <div className="space-y-2">
          {store.upstreams.map((u, idx) => (
            <div key={u.id}>
              <UpstreamRow
                row={u}
                index={idx}
                total={store.upstreams.length}
                busy={!!store.busy[u.id]}
                models={store.modelsByUpstream.get(u.id)}
                editing={editingId === u.id}
                onToggleEnabled={() => store.toggleEnabled(u)}
                onReorder={(d) => store.reorder(u.id, d)}
                onEdit={() => openEdit(u)}
                onRefreshModels={() => store.probe(u.id)}
                onReauth={() => setDeviceFlowOpen(true)}
                onDelete={async () => {
                  await store.remove(u)
                }}
              />
              <Expand open={editingId === u.id}>
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
