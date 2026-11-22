// packages/gateway/src/quota-balance/ordering.ts
import type { GroupDirectory } from "./directory.ts"

interface Orderable { id: string; sortOrder: number; createdAt: string }

/**
 * Routing order of upstreams with groups: an ungrouped upstream sorts by its own (sortOrder, createdAt, id), a group member by its group's, so the group is
 * one item; members of one group stay together, in a stable (createdAt, id) order (the balancer orders them per request). A member's own sortOrder is
 * ignored while it is in a group. With an empty directory this is the plain (sortOrder, createdAt, id) sort.
 */
export function orderUpstreamsForRouting<T extends Orderable>(upstreams: T[], directory: GroupDirectory): T[] {
  const itemOf = (upstream: T): { sortOrder: number; createdAt: string; id: string } => {
    const groupId = directory.memberOf.get(upstream.id)
    const group = groupId ? directory.groups.get(groupId) : undefined
    return group ? { sortOrder: group.sortOrder, createdAt: group.createdAt, id: group.id } : { sortOrder: upstream.sortOrder, createdAt: upstream.createdAt, id: upstream.id }
  }
  return upstreams.sort((a, b) => {
    const x = itemOf(a)
    const y = itemOf(b)
    return x.sortOrder - y.sortOrder || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  })
}
