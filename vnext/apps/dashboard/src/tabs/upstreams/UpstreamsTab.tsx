import { useEffect, useMemo, useState } from "react"
import { cn } from "../../ui/cn"
import { useAuth } from "../../state/auth"
import { useT } from "../../state/i18n"
import { useUpstreams } from "../../state/upstreams"
import { useProtection } from "../../state/protection"
import { UpstreamRow } from "./UpstreamRow"
import { UpstreamFormModal } from "./UpstreamFormModal"
import { ProxyChainModal } from "./ProxyChainModal"
import { ProtectionSection } from "./protection/ProtectionSection"
import { planFocus } from "./protection/focus"
import { DeviceFlowModal } from "./DeviceFlowModal"
import { VENDOR_PRESETS } from "./vendorPresets"
import { createPortableUpstreamDraft } from "./duplicate-draft"
import type { PortableUpstreamDraft } from "./duplicate-draft"
import type { UpstreamRecord } from "../../api/types"
import { moveUpstream } from "../../state/reorder-upstreams"
import { ownerSections, type OrderItem } from "../../state/group-items"
import { GroupCard } from "./groups/GroupCard"
import { MemberQuotaRow } from "./groups/MemberQuotaRow"
import { useGroupStatuses } from "./groups/use-group-status"
import { useGroupActions } from "./groups/use-group-actions"
import { NewGroupControl } from "./groups/NewGroupControl"
import { LokiPairingPanel } from "./LokiPairingPanel"
import { SyncDevicesSection } from "./SyncDevicesSection"
import { SyncSourceSection } from "./SyncSourceSection"
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

interface DragPreview { sourceId: string; targetId: string | null }

export function UpstreamsTab() {
  const store = useUpstreams()
  const { statuses, nowMs, refresh: refreshStatuses } = useGroupStatuses()
  const { session } = useAuth()
  const t = useT()
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [proxyId, setProxyId] = useState<string | null>(null)
  const protection = useProtection()
  const { focusUpstreamId, clearFocus, focusGroupId, clearGroupFocus } = protection
  const [protectionId, setProtectionId] = useState<string | null>(null)
  const [scrollToId, setScrollToId] = useState<string | null>(null)
  const [scrollToGroupId, setScrollToGroupId] = useState<string | null>(null)
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
  const previewItems = useMemo(
    () => drag?.targetId
      ? moveUpstream(store.items, drag.sourceId, drag.targetId, myOwnerId)
      : store.items,
    [store.items, drag, myOwnerId],
  )
  const canDropOn = (sourceId: string, target: OrderItem) => {
    const source = store.items.find((item) => item.id === sourceId)
    return !!source && source.id !== target.id &&
      source.ownerId === myOwnerId && target.ownerId === myOwnerId &&
      source.enabled === target.enabled
  }
  // A move gives a screen reader user no feedback of its own; say where the item landed.
  const announceMove = (item: OrderItem, moved: boolean) => {
    if (!moved) return
    const at = store.positionOf(item.id, myOwnerId)
    const name = item.kind === "group" ? item.group.name : item.upstream.name
    if (at) setAnnouncement(t("dash.reorderUpstreamAnnounce", { name, n: at.position, total: at.total }))
  }

  // Touch and pen drags drive the same preview as the mouse's native drag.
  const touchDrag = useTouchReorder({
    start: (sourceId) => setDrag({ sourceId, targetId: null }),
    over: (sourceId, targetId) => {
      const target = store.items.find((item) => item.id === targetId)
      if (!target || !canDropOn(sourceId, target)) return false
      setDrag((d) => (d && d.sourceId === sourceId && d.targetId !== targetId ? { ...d, targetId } : d))
      return true
    },
    drop: (sourceId, targetId) => {
      setDrag(null)
      if (!targetId) return
      const source = store.items.find((item) => item.id === sourceId)
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

  // The banner's "Open" asks for one upstream's Protection section: expand its group, open it, scroll to it.
  const upstreamRows = store.upstreams
  useEffect(() => {
    if (focusUpstreamId === null) return
    // The list may still be loading; keep the request until it arrives.
    if (upstreamRows.length === 0 && store.loading) return
    const plan = planFocus(upstreamRows, focusUpstreamId, { isAdmin, myOwnerId })
    clearFocus()
    if (!plan) return
    setCollapsed((current) => (current[plan.groupKey] ? { ...current, [plan.groupKey]: false } : current))
    setProtectionId(plan.id)
    setScrollToId(plan.id)
  }, [focusUpstreamId, clearFocus, upstreamRows, store.loading, isAdmin, myOwnerId])
  // The banner's "Open group": expand the owner's section and bring the group card into view.
  useEffect(() => {
    if (focusGroupId === null) return
    if (store.items.length === 0 && store.loading) return
    const item = store.items.find((candidate) => candidate.id === focusGroupId)
    clearGroupFocus()
    if (!item) return
    setCollapsed((current) => (current[item.ownerId || "__global__"] ? { ...current, [item.ownerId || "__global__"]: false } : current))
    setScrollToGroupId(item.id)
  }, [focusGroupId, clearGroupFocus, store.items, store.loading])
  useEffect(() => {
    if (scrollToGroupId === null) return
    const card = document.querySelector<HTMLElement>(`[data-group-id="${scrollToGroupId}"]`)
    if (!card) return // not mounted yet; runs again when it is
    card.scrollIntoView({ block: "start", behavior: "auto" })
    card.focus({ preventScroll: true })
    setScrollToGroupId(null)
  }, [scrollToGroupId, collapsed, store.items])
  useEffect(() => {
    if (scrollToId === null) return
    const section = document.getElementById(`protection-${scrollToId}`)
    if (!section) return // not mounted yet; runs again when it is
    section.scrollIntoView({ block: "start", behavior: "auto" })
    section.focus({ preventScroll: true })
    setScrollToId(null)
  }, [scrollToId, protectionId, collapsed])

  const groups = useMemo(() => ownerSections(previewItems, myOwnerId, t("dash.globalOwner")), [previewItems, myOwnerId, t])

  const groupActions = useGroupActions({ upstreams: store.upstreams, reload: store.reload, refreshStatuses })

  const itemOf = (u: UpstreamRecord): OrderItem => ({ kind: "upstream", id: u.id, ownerId: u.ownerId ?? "", enabled: u.enabled, sortOrder: u.sortOrder, upstream: u })
  /** One upstream row with its edit, proxy and protection panels: an ungrouped upstream, or a group member (`orderable: false`: no drag handle or move buttons). */
  const renderUpstream = (
    u: UpstreamRecord,
    { g, position, total, orderable, dragHandlers }: { g: { isMine: boolean }; position: number; total: number; orderable: boolean; dragHandlers: Record<string, unknown> | null },
  ) => (
    <div key={u.id}>
      <UpstreamRow
        row={u}
        index={position}
        total={total}
        orderable={orderable}
        busy={!!store.busy[u.id]}
        dragging={drag?.sourceId === u.id}
        dropTarget={drag?.targetId === u.id}
        {...(dragHandlers ?? {})}
        models={store.modelsByUpstream.get(u.id)}
        editing={editingId === u.id}
        readOnly={!g.isMine}
        showProxy={isAdmin}
        proxyOpen={proxyId === u.id}
        onToggleProxy={() => setProxyId((v) => (v === u.id ? null : u.id))}
        showProtection={g.isMine || isAdmin}
        protectionOpen={protectionId === u.id}
        onToggleProtection={() => setProtectionId((v) => (v === u.id ? null : u.id))}
        pause={protection.pauses.find((p) => p.targetKind === "upstream" && p.targetId === u.id)}
        onToggleEnabled={() => store.toggleEnabled(u)}
        onReorder={(d) => announceMove(itemOf(u), store.reorder(u.id, d, myOwnerId))}
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
          {u.provider === "loki" ? <LokiPairingPanel key={u.id} row={u} onChanged={() => { void store.reload() }} onClose={() => setEditingId(null)} /> : <UpstreamFormModal
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
      {protectionId === u.id && (g.isMine || isAdmin) ? (
        <Expand>
          <ProtectionSection upstream={u} onSaved={() => { void store.reload() }} />
        </Expand>
      ) : null}
    </div>
  )

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
            <NewGroupControl busy={groupActions.busy} onCreate={groupActions.createGroup} />
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
                      {t("dash.upstreamCount", { n: g.items.reduce((n, item) => n + (item.kind === "group" ? item.members.length : 1), 0) })}
                    </span>
                  </button>
                </h2>

                {!isCollapsed ? (
                  <div className="space-y-2 mt-2">
                    {g.items.map((item, idx) => {
                      const peers = g.items.filter((other) => other.enabled === item.enabled)
                      const position = g.items.slice(0, idx).filter((other) => other.enabled === item.enabled).length
                      const dragHandlers = {
                        onDragStart: (event: React.DragEvent<HTMLButtonElement>) => {
                          if (!g.isMine) { event.preventDefault(); return }
                          event.dataTransfer.effectAllowed = "move"
                          event.dataTransfer.setData("text/plain", item.id)
                          setDrag({ sourceId: item.id, targetId: null })
                        },
                        onDragOver: (event: React.DragEvent<HTMLElement>) => {
                          if (!drag || !canDropOn(drag.sourceId, item)) return
                          event.preventDefault()
                          event.dataTransfer.dropEffect = "move"
                          if (drag.targetId !== item.id) setDrag({ ...drag, targetId: item.id })
                        },
                        onDrop: (event: React.DragEvent<HTMLElement>) => {
                          if (!drag || !canDropOn(drag.sourceId, item)) return
                          event.preventDefault()
                          const source = store.items.find((row) => row.id === drag.sourceId)
                          const moved = store.reorderTo(drag.sourceId, item.id, myOwnerId)
                          if (source) announceMove(source, moved)
                          setDrag(null)
                        },
                        onDragEnd: () => setDrag(null),
                        onHandlePointerDown: g.isMine ? (event: React.PointerEvent<HTMLButtonElement>) => touchDrag.begin(event, item.id) : undefined,
                      }
                      if (item.kind === "upstream") return renderUpstream(item.upstream, { g, position, total: peers.length, orderable: true, dragHandlers })
                      const status = statuses.get(item.id)
                      return (
                        <GroupCard key={item.id} item={item} status={status} index={position} total={peers.length} dragging={drag?.sourceId === item.id} dropTarget={drag?.targetId === item.id}
                          readOnly={!g.isMine} busy={groupActions.busy} {...dragHandlers}
                          onReorder={(d) => announceMove(item, store.reorder(item.id, d, myOwnerId))}
                          onToggleEnabled={() => groupActions.toggleEnabled(item.group)} onRename={() => groupActions.rename(item.group)} onDelete={() => groupActions.remove(item.group)}
                          onToggleSettings={() => groupActions.toggleSettings(item.group.id)} settingsOpen={groupActions.settingsOpenId === item.group.id}
                          footer={g.isMine ? groupActions.footer(item) : null}>
                          {item.members.map((u) => {
                            const member = status?.members.find((m) => m.upstreamId === u.id)
                            return (
                              <div key={u.id}>
                                {renderUpstream(u, { g, position: 0, total: 1, orderable: false, dragHandlers: null })}
                                {member ? <MemberQuotaRow member={member} group={item.group} nowMs={nowMs} busy={!!store.busy[u.id] || groupActions.busy || groupActions.isMemberBusy(u.id)} readOnly={!g.isMine}
                                  onRefresh={() => groupActions.refreshMember(u.id)} onCalibrate={() => groupActions.calibrate(u.id)} onRemove={() => groupActions.removeMember(u)} /> : null}
                                {member ? groupActions.calibrationFor(u.id, u.name, member.lastRead?.at ?? null) : null}
                              </div>
                            )
                          })}
                        </GroupCard>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </Card>

      <SyncDevicesSection upstreams={store.upstreams} myOwnerId={myOwnerId} />
      <SyncSourceSection onChanged={store.reload} />

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
