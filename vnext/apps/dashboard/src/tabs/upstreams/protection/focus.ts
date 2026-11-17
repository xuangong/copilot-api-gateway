/** Which upstream's Protection section to open for the banner's "Open", and the owner group that must be expanded to show it. */
export function planFocus(
  rows: ReadonlyArray<{ id: string; ownerId?: string | null }>,
  id: string,
  viewer: { isAdmin: boolean; myOwnerId: string },
): { id: string; groupKey: string } | null {
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) return null
  const owner = row.ownerId || ""
  // The section is hidden in other people's groups (unless admin), so there is nothing to open.
  if (!viewer.isAdmin && owner !== viewer.myOwnerId) return null
  return { id, groupKey: owner || "__global__" }
}
