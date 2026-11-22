import type { UpstreamRecord } from "../api/types"
import type { UpstreamGroup } from "../api/upstream-groups"
import type { ReorderRow } from "./reorder-upstreams"

export interface UpstreamItem extends ReorderRow { kind: "upstream"; ownerId: string; upstream: UpstreamRecord }
export interface GroupItem extends ReorderRow { kind: "group"; ownerId: string; group: UpstreamGroup; members: UpstreamRecord[] }
export type OrderItem = UpstreamItem | GroupItem

type Keyed = OrderItem & { createdAt: string }
const order = (a: Keyed, b: Keyed): number =>
  (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/**
 * The reorderable items of the Upstreams page: every ungrouped upstream and every group (members are inside their group's item and have no order of
 * their own), in the display order of the list (enabled first, then sort order). A member whose group is unknown is shown as an ordinary upstream.
 */
export function buildOrderItems(upstreams: readonly UpstreamRecord[], groups: readonly UpstreamGroup[]): OrderItem[] {
  const known = new Set(groups.map(group => group.id))
  const members = new Map<string, UpstreamRecord[]>()
  const items: Keyed[] = []
  for (const upstream of upstreams) {
    if (upstream.groupId && known.has(upstream.groupId)) members.set(upstream.groupId, [...(members.get(upstream.groupId) ?? []), upstream])
    else items.push({ kind: "upstream", id: upstream.id, ownerId: upstream.ownerId ?? "", enabled: upstream.enabled, sortOrder: upstream.sortOrder, upstream, createdAt: upstream.createdAt })
  }
  for (const group of groups) {
    const list = [...(members.get(group.id) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    items.push({ kind: "group", id: group.id, ownerId: group.ownerId, enabled: group.enabled, sortOrder: group.sortOrder, group, members: list, createdAt: group.createdAt })
  }
  return items.sort(order).map(({ createdAt: _createdAt, ...item }) => item as OrderItem)
}

/** The rows the reorder controller works on. */
export const toRows = (items: readonly OrderItem[]): ReorderRow[] => items.map(({ id, ownerId, enabled, sortOrder }) => ({ id, ownerId, enabled, sortOrder }))

/** Items in the order of `rows` (the controller's snapshot, pending moves included); items the rows do not know keep their place at the end. */
export function applyRowOrder<T extends { id: string }>(items: readonly T[], rows: ReadonlyArray<Partial<ReorderRow> & { id: string }>): T[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const ordered = rows.flatMap(row => { const item = byId.get(row.id); return item ? [item] : [] })
  const placed = new Set(ordered.map(item => item.id))
  return [...ordered, ...items.filter(item => !placed.has(item.id))]
}

export interface OwnerSection { ownerId: string; label: string; items: OrderItem[]; isMine: boolean }

/** Items grouped by owner (the viewer's own first, then by label); an owner is labelled by its Copilot login when one of its upstreams has it. */
export function ownerSections(items: readonly OrderItem[], myOwnerId: string, globalLabel: string): OwnerSection[] {
  const sections = new Map<string, OwnerSection>()
  for (const item of items) {
    let section = sections.get(item.ownerId)
    if (!section) { section = { ownerId: item.ownerId, label: "", items: [], isMine: item.ownerId === myOwnerId }; sections.set(item.ownerId, section) }
    section.items.push(item)
  }
  for (const section of sections.values()) {
    const rows = section.items.flatMap(item => item.kind === "upstream" ? [item.upstream] : item.members)
    const login = rows.find(row => row.provider === "copilot" && row.config?.user?.login)?.config?.user?.login
    section.label = login ? `@${login}` : section.ownerId ? `#${section.ownerId.slice(0, 8)}` : globalLabel
  }
  return [...sections.values()].sort((a, b) => (a.isMine !== b.isMine ? (a.isMine ? -1 : 1) : a.label.localeCompare(b.label)))
}
