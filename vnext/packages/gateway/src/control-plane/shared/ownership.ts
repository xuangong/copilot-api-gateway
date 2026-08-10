// The single authorisation gate for owner-scoped control-plane resources
// (API keys, upstreams). Handlers must not re-implement the owner comparison;
// every one that did before this existed spelled it slightly differently —
// some answered 404 for a missing record and 403 for a foreign one, others the
// reverse, and the upstream DELETE handler ran its cascade branch before it had
// established that the record existed at all.
//
// `loadOwned` returns null both when the record is absent and when it belongs
// to another user. Collapsing the two cases is deliberate: if "not yours"
// answered 403 while "no such id" answered 404, a caller could enumerate other
// users' resources by status code alone.

export interface OwnerScopedAuth {
  isAdmin?: boolean
  userId?: string
}

export async function loadOwned<T extends { ownerId?: string | null }>(
  auth: OwnerScopedAuth | undefined,
  load: () => Promise<T | null | undefined>,
): Promise<T | null> {
  const { isAdmin = false, userId } = auth ?? {}
  if (!isAdmin && !userId) return null
  const record = await load()
  if (!record) return null
  if (isAdmin) return record
  return record.ownerId === userId ? record : null
}
