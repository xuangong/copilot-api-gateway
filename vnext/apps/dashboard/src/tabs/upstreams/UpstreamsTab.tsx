import { useEffect, useMemo, useState } from "react"
import { cn } from "../../ui/cn"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useUpstreams } from "../../state/upstreams"
import { UpstreamRow } from "./UpstreamRow"
import { UpstreamFormModal } from "./UpstreamFormModal"
import { ProxyChainModal } from "./ProxyChainModal"
import { DeviceFlowModal } from "./DeviceFlowModal"
import { VENDOR_PRESETS } from "./vendorPresets"
import { createPortableUpstreamDraft } from "./duplicate-draft"
import type { PortableUpstreamDraft } from "./duplicate-draft"
import type { UpstreamRecord } from "../../api/types"
import { moveUpstream } from "../../state/reorder-upstreams"
import { LokiPairingPanel } from "./LokiPairingPanel"
import { FormHeadingLevel } from "./form/Field"
import { useTouchReorder } from "./touch-reorder"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card } from "../../ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu"
import { EmptyState } from "../../ui/empty-state"
import { PageHeader } from "../../ui/page-header"

type CreateMode = {
  kind: "create"
  provider: "custom" | "azure" | "sdf" | "codex"
  presetId?: string
  draft?: PortableUpstreamDraft
  sourceId?: string
}

interface OwnerGroup {
  ownerId: string
  label: string
  rows: UpstreamRecord[]
  isMine: boolean
}

interface DragPreview { sourceId: string; targetId: string | null }

export function UpstreamsTab() {
  const store = useUpstreams()
  const { session } = useAuth()
  const t = useT()
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [proxyId, setProxyId] = useState<string | null>(null)
  const [deviceFlowOpen, setDeviceFlowOpen] = useState(false)
  const [createLoki, setCreateLoki] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<DragPreview | null>(null)
  const [announcement, setAnnouncement] = useState("")

  const openCreate = (provider: "custom" | "azure" | "sdf" | "codex", presetId?: string) => {
    setEditingId(null)
    // Remount the form when the preset changes, otherwise `useMemo` on `mode`
    // keeps the previously seeded state.
    setCreateMode({ kind: "create", provider, presetId })
  }
  const openEdit = async (row: UpstreamRecord) => {
    setCreateMode(null)
    await store.ensureFlagCatalog().catch(() => null)
    setEditingId((cur) => (cur === row.id ? null : row.id))
  }

  const openDuplicate = (row: UpstreamRecord) => {
    if (row.ownerId !== myOwnerId || row.provider === "copilot") return
    const draft = createPortableUpstreamDraft(row, t("dash.duplicateName", { name: row.name }))
    setEditingId(null)
    setProxyId(null)
    setCreateMode({ kind: "create", provider: draft.provider, draft, sourceId: row.id })
  }

  const myOwnerId = session?.userId != null ? String(session.userId) : ""
  const isAdmin = !!session?.isAdmin
  const previewRows = useMemo(
    () => drag?.targetId
      ? moveUpstream(store.upstreams, drag.sourceId, drag.targetId, myOwnerId)
      : store.upstreams,
    [store.upstreams, drag, myOwnerId],
  )
  const canDropOn = (sourceId: string, target: UpstreamRecord) => {
    const source = store.upstreams.find((row) => row.id === sourceId)
    return !!source && source.id !== target.id &&
      source.ownerId === myOwnerId && target.ownerId === myOwnerId &&
      source.enabled === target.enabled
  }
  // A move gives a screen reader user no feedback of its own; say where the row landed.
  const announceMove = (row: UpstreamRecord, moved: boolean) => {
    if (!moved) return
    const at = store.positionOf(row.id, myOwnerId)
    if (at) setAnnouncement(t("dash.reorderUpstreamAnnounce", { name: row.name, n: at.position, total: at.total }))
  }

  // Touch and pen drags drive the same preview as the mouse's native drag.
  const touchDrag = useTouchReorder({
    start: (sourceId) => setDrag({ sourceId, targetId: null }),
    over: (sourceId, targetId) => {
      const target = store.upstreams.find((row) => row.id === targetId)
      if (!target || !canDropOn(sourceId, target)) return false
      setDrag((d) => (d && d.sourceId === sourceId && d.targetId !== targetId ? { ...d, targetId } : d))
      return true
    },
    drop: (sourceId, targetId) => {
      setDrag(null)
      if (!targetId) return
      const source = store.upstreams.find((row) => row.id === sourceId)
      const moved = store.reorderTo(sourceId, targetId, myOwnerId)
      if (source) announceMove(source, moved)
    },
    cancel: () => setDrag(null),
  })

  // Esc calls a drag off. A touch gesture is ended too, so a later lift cannot
  // drop it and its edge scrolling stops.
  const { abort: abortTouchDrag } = touchDrag
  useEffect(() => {
    if (!drag) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      abortTouchDrag()
      setDrag(null)
    }
    document.addEventListener("keydown", cancel)
    return () => document.removeEventListener("keydown", cancel)
  }, [drag, abortTouchDrag])

  const groups: OwnerGroup[] = useMemo(() => {
    const map = new Map<string, OwnerGroup>()
    for (const u of previewRows) {
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
  }, [previewRows, myOwnerId, t])

  return (
    <div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
      <PageHeader
        title={t("dash.managedUpstreams")}
        description={t("dash.managedUpstreamsDesc")}
        actions={
          <>
            <Button variant="primary" size="sm" onClick={() => setDeviceFlowOpen(true)}>{t("dash.addCopilot")}</Button>
            <Button variant="secondary" size="sm" onClick={() => openCreate("codex")}>{t("dash.addCodexImport")}</Button>
            <Button variant="secondary" size="sm" onClick={() => setCreateLoki(value => !value)} aria-expanded={createLoki}>{t("dash.addLoki")}</Button>
            {/* Non-modal: like the old inline menu, a click elsewhere closes it and still acts. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm">
                  {t("dash.addCustom")}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel className="text-xs font-medium text-fg-subtle">
                  {t("dash.presetMenuTitle")}
                </DropdownMenuLabel>
                {VENDOR_PRESETS.map((p) => (
                  <DropdownMenuItem key={p.id} className="text-fg" onSelect={() => openCreate("custom", p.id)}>
                    {p.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openCreate("custom")}>
                  {t("dash.addCustomBlank")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="secondary" size="sm" onClick={() => openCreate("azure")}>{t("dash.addAzure")}</Button>
            <Button variant="secondary" size="sm" onClick={() => openCreate("sdf")}>{t("dash.addSdf")}</Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={store.reload}
              disabled={store.loading}
              title={t("dash.refreshLabel")}
              aria-label={t("dash.refreshLabel")}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        {/* Create panels sit straight under the page h1, so their titles are h2. */}
        <FormHeadingLevel.Provider value={2}>
        {createLoki ? <Expand className="mb-4"><LokiPairingPanel onChanged={store.reload} onClose={() => setCreateLoki(false)} /></Expand> : null}
        {createMode ? (
          <Expand className="mb-4">
            <UpstreamFormModal
              key={createMode.sourceId ?? createMode.presetId ?? createMode.provider}
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
        </FormHeadingLevel.Provider>

        {store.loading && store.upstreams.length === 0 ? (
          <p className="text-sm text-fg-subtle">{t("dash.loadingShort")}</p>
        ) : null}

        {!store.loading && store.upstreams.length === 0 ? (
          <EmptyState title={t("dash.noManagedUpstreams")} />
        ) : null}

        {/* While a drag previews the new order the rows move, and the browser's
            scroll anchoring would scroll to hold one of them still, carrying the
            dragged row away from the pointer. Only during a drag: otherwise
            anchoring is what keeps the page steady as rows load. */}
        <div className={cn("space-y-4", drag && "[overflow-anchor:none]")}>
          {groups.map((g) => {
            const groupKey = g.ownerId || "__global__"
            const isCollapsed = !!collapsed[groupKey]
            return (
              <div key={groupKey}>
                <h2 className="text-sm font-medium text-fg">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((c) => ({ ...c, [groupKey]: !c[groupKey] }))}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left rounded-md hover:bg-muted transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {isCollapsed
                        ? <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                        : <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />}
                      <span className="truncate">{g.label}</span>
                      {g.isMine ? (
                        <Badge tone="brand">{t("dash.youBadge")}</Badge>
                      ) : (
                        <Badge>{t("dash.readOnlyBadge")}</Badge>
                      )}
                    </span>
                    <span className="text-xs font-normal text-fg-subtle tabular-nums shrink-0">
                      {t("dash.upstreamCount", { n: g.rows.length })}
                    </span>
                  </button>
                </h2>

                {!isCollapsed ? (
                  <div className="space-y-2 mt-2">
                    {g.rows.map((u, idx) => (
                      <div key={u.id}>
                        <UpstreamRow
                          row={u}
                          index={g.rows.slice(0, idx).filter((row) => row.enabled === u.enabled).length}
                          total={g.rows.filter((row) => row.enabled === u.enabled).length}
                          busy={!!store.busy[u.id]}
                          dragging={drag?.sourceId === u.id}
                          dropTarget={drag?.targetId === u.id}
                          onDragStart={(event) => {
                            if (!g.isMine) { event.preventDefault(); return }
                            event.dataTransfer.effectAllowed = "move"
                            event.dataTransfer.setData("text/plain", u.id)
                            setDrag({ sourceId: u.id, targetId: null })
                          }}
                          onDragOver={(event) => {
                            if (!drag || !canDropOn(drag.sourceId, u)) return
                            event.preventDefault()
                            event.dataTransfer.dropEffect = "move"
                            if (drag.targetId !== u.id) setDrag({ ...drag, targetId: u.id })
                          }}
                          onDrop={(event) => {
                            if (!drag || !canDropOn(drag.sourceId, u)) return
                            event.preventDefault()
                            const source = store.upstreams.find((row) => row.id === drag.sourceId)
                            const moved = store.reorderTo(drag.sourceId, u.id, myOwnerId)
                            if (source) announceMove(source, moved)
                            setDrag(null)
                          }}
                          onDragEnd={() => setDrag(null)}
                          onHandlePointerDown={g.isMine ? (event) => touchDrag.begin(event, u.id) : undefined}
                          models={store.modelsByUpstream.get(u.id)}
                          editing={editingId === u.id}
                          readOnly={!g.isMine}
                          showProxy={isAdmin}
                          proxyOpen={proxyId === u.id}
                          onToggleProxy={() => setProxyId((v) => (v === u.id ? null : u.id))}
                          onToggleEnabled={() => store.toggleEnabled(u)}
                          onReorder={(d) => announceMove(u, store.reorder(u.id, d, myOwnerId))}
                          onEdit={() => openEdit(u)}
                          onDuplicate={() => openDuplicate(u)}
                          onRefreshModels={() => store.probe(u.id)}
                          onRefreshCredential={() => store.refreshCredential(u.id)}
                          onReauth={() => setDeviceFlowOpen(true)}
                          onDelete={async () => {
                            await store.remove(u)
                          }}
                        />
                        {editingId === u.id && g.isMine ? (
                          <Expand>
                            {u.provider === "loki" ? <LokiPairingPanel key={u.id} row={u} onChanged={store.reload} onClose={() => setEditingId(null)} /> : <UpstreamFormModal
                              mode={{ kind: "edit", row: u }}
                              flagCatalog={store.flagCatalog}
                              ensureFlagCatalog={store.ensureFlagCatalog}
                              onClose={() => setEditingId(null)}
                              onSaved={() => {
                                setEditingId(null)
                                store.reload()
                              }}
                            />}
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
      </Card>

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
function Expand({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out grid-rows-[1fr]", className)}>
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}
