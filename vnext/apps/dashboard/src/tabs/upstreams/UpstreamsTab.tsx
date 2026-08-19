import { useEffect, useMemo, useState } from "react"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useUpstreams } from "../../state/upstreams"
import { UpstreamRow } from "./UpstreamRow"
import { UpstreamFormModal } from "./UpstreamFormModal"
import { ProxyChainModal } from "./ProxyChainModal"
import { DeviceFlowModal } from "./DeviceFlowModal"
import { VENDOR_PRESETS } from "./vendorPresets"
import type { UpstreamRecord } from "../../api/types"

type CreateMode = { kind: "create"; provider: "custom" | "azure" | "sdf"; presetId?: string }

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
  const [proxyId, setProxyId] = useState<string | null>(null)
  const [deviceFlowOpen, setDeviceFlowOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)

  // A menu that only closes by picking something strands the user on mobile,
  // where the toggle can scroll out of reach.
  useEffect(() => {
    if (!presetMenuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresetMenuOpen(false)
    }
    const onPointer = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (!el?.closest("[data-preset-menu]")) setPresetMenuOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onPointer)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onPointer)
    }
  }, [presetMenuOpen])

  const openCreate = (provider: "custom" | "azure" | "sdf", presetId?: string) => {
    setEditingId(null)
    setPresetMenuOpen(false)
    // Remount the form when the preset changes, otherwise `useMemo` on `mode`
    // keeps the previously seeded state.
    setCreateMode({ kind: "create", provider, presetId })
  }
  const openEdit = async (row: UpstreamRecord) => {
    setCreateMode(null)
    await store.ensureFlagCatalog().catch(() => null)
    setEditingId((cur) => (cur === row.id ? null : row.id))
  }

  const myOwnerId = session?.userId != null ? String(session.userId) : ""
  const isAdmin = !!session?.isAdmin

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
          {/* The negative margin lets the strip scroll edge-to-edge inside the
              card's p-4 padding instead of clipping mid-button. */}
          <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:shrink-0">
            <button onClick={() => setDeviceFlowOpen(true)} className="btn-primary text-sm">{t("dash.addCopilot")}</button>
            <button
              onClick={() => setPresetMenuOpen((v) => !v)}
              className="btn-ghost text-sm"
              data-preset-menu
              aria-haspopup="menu"
              aria-controls="preset-menu"
              aria-expanded={presetMenuOpen}
            >
              {t("dash.addCustom")} ▾
            </button>
            <button onClick={() => openCreate("azure")} className="btn-ghost text-sm">{t("dash.addAzure")}</button>
            <button onClick={() => openCreate("sdf")} className="btn-ghost text-sm">{t("dash.addSdf")}</button>
            <button onClick={store.reload} disabled={store.loading} className="btn-ghost text-sm" title="Refresh">↻</button>
          </div>
        </div>

        {/* Rendered outside the button strip: that strip scrolls horizontally on
            mobile, which would clip an absolutely-positioned menu. */}
        {presetMenuOpen ? (
          <div
            role="menu"
            id="preset-menu"
            data-preset-menu
            className="rounded-lg py-1 mb-4"
            style={{ background: "var(--surface-800)", border: "1px solid var(--border-color)" }}
          >
            <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-themed-dim">
              {t("dash.presetMenuTitle")}
            </div>
            {VENDOR_PRESETS.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                onClick={() => openCreate("custom", p.id)}
                className="block w-full text-left px-3 py-1.5 text-sm text-themed hover:bg-surface-700/60"
              >
                {p.label}
              </button>
            ))}
            <div className="my-1 border-t border-themed" />
            <button
              role="menuitem"
              onClick={() => openCreate("custom")}
              className="block w-full text-left px-3 py-1.5 text-sm text-themed-dim hover:bg-surface-700/60"
            >
              {t("dash.addCustomBlank")}
            </button>
          </div>
        ) : null}

        {createMode ? (
          <Expand>
            <UpstreamFormModal
              key={createMode.presetId ?? createMode.provider}
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
                          showProxy={isAdmin}
                          proxyOpen={proxyId === u.id}
                          onToggleProxy={() => setProxyId((v) => (v === u.id ? null : u.id))}
                          onToggleEnabled={() => store.toggleEnabled(u)}
                          onReorder={(d) => store.reorder(u.id, d)}
                          onEdit={() => openEdit(u)}
                          onRefreshModels={() => store.probe(u.id)}
                          onReauth={() => setDeviceFlowOpen(true)}
                          onDelete={async () => {
                            await store.remove(u)
                          }}
                        />
                        {editingId === u.id && g.isMine ? (
                          <Expand>
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
                        ) : null}
                        {proxyId === u.id ? (
                          <Expand>
                            <ProxyChainModal
                              upstreamId={u.id}
                              initialChain={u.proxyFallbackList ?? []}
                              onSaved={() => {
                                setProxyId(null)
                                store.reload()
                              }}
                              onClose={() => setProxyId(null)}
                            />
                          </Expand>
                        ) : null}
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
// trick so the panel can animate to its natural height. Mounted only while
// open — keeping it mounted-but-collapsed made every row run the form's
// catalog fetch on every render of the list.
function Expand({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid transition-[grid-template-rows] duration-200 ease-out grid-rows-[1fr]">
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}
