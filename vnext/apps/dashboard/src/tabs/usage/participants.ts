/**
 * Who can use a given API key, and how that answers the Usage tab's two
 * filters.
 *
 * The Usage tab used to derive its user list from each usage row's `ownerId`,
 * which made a key shared through `key_assignments` look like it belonged to
 * its owner alone — everyone it was shared with was invisible. These helpers
 * take the participants the server reports per key and fold them into the
 * filter dropdowns: a shared key gets a badge, and everyone who can reach a
 * key with usage appears in the user list.
 *
 * The two dropdowns stay independent — neither narrows the other. Cascading
 * them would strand you on whatever you picked last.
 *
 * Note what is *not* here: any attempt to attribute usage to a person. The
 * `usage` and `usage_requests` tables carry only `key_id`, so a shared key's
 * traffic cannot be split. Selecting a user therefore counts the *whole* usage
 * of every key they can reach, and `sharedInScope` tells the UI to say so.
 */

export interface ParticipantBrief {
  id: string
  name: string
}

/** One row of `GET /api/token-usage/participants`. */
export interface ParticipantRow {
  keyId: string
  ownerId: string | null
  ownerName: string | null
  /** Users the key is assigned to. Empty when the caller may not see them. */
  sharedWith: ParticipantBrief[]
}

export type ParticipantIndex = Map<string, ParticipantRow>

export interface KeyDimension {
  id: string
  name: string
  shared: boolean
}

export interface UsageDimensionsResult {
  keys: KeyDimension[]
  users: ParticipantBrief[]
  /** True when any listed key has assignees — drives the double-count notice. */
  sharedInScope: boolean
}

/** Only the fields these helpers read, so tests need no token/cost fixtures. */
interface UsageRowLike {
  keyId: string
  keyName?: string | undefined
}

export const indexParticipants = (rows: ParticipantRow[]): ParticipantIndex =>
  new Map(rows.map((r) => [r.keyId, r]))

export const isShared = (participants: ParticipantIndex, keyId: string): boolean =>
  (participants.get(keyId)?.sharedWith.length ?? 0) > 0

/**
 * Owner first — they are the one accountable for the key — then assignees by
 * name, so the order is stable across reloads regardless of assignment order.
 */
export const usersForKey = (participants: ParticipantIndex, keyId: string): ParticipantBrief[] => {
  const row = participants.get(keyId)
  if (!row) return []
  const assignees = [...row.sharedWith].sort((a, b) => a.name.localeCompare(b.name))
  return row.ownerId ? [{ id: row.ownerId, name: row.ownerName ?? row.ownerId.slice(0, 8) }, ...assignees] : assignees
}

/** True when the key is owned by, or shared with, this user. */
export const rowMatchesUser = (
  participants: ParticipantIndex,
  keyId: string,
  userId: string,
): boolean => {
  const row = participants.get(keyId)
  if (!row) return false
  return row.ownerId === userId || row.sharedWith.some((u) => u.id === userId)
}

/**
 * How a usage row should be labelled when grouping "by user".
 *
 * A shared key names everyone who could have used it rather than its owner:
 * `usage` records a key, never who held it, so crediting the owner alone
 * asserts something the data cannot support. Keys with the same participants
 * collapse into one group — the ambiguity is identical, and separate
 * look-alike series would only add noise.
 */
export function usageAttribution(
  participants: ParticipantIndex,
  keyId: string,
): { id: string; label: string } {
  const people = usersForKey(participants, keyId)
  if (people.length > 1) {
    const ids = people.map((u) => u.id).sort()
    return { id: `shared:${ids.join("+")}`, label: people.map((u) => u.name).join(", ") }
  }
  const only = people[0]
  return only ? { id: only.id, label: only.name } : { id: "_admin", label: "Admin" }
}

export const hasSharedKeyInScope = (participants: ParticipantIndex, keyIds: string[]): boolean =>
  keyIds.some((id) => isShared(participants, id))

export function buildDimensions({
  rows,
  participants,
  isAdmin,
}: {
  rows: UsageRowLike[]
  participants: ParticipantIndex
  isAdmin: boolean
}): UsageDimensionsResult {
  const names = new Map<string, string>()
  for (const r of rows) names.set(r.keyId, r.keyName ?? r.keyId.slice(0, 8))
  const keyIds = [...names.keys()]

  // Everyone who can reach a key that has usage — owners and assignees alike.
  // Non-admins get nothing: the server sends them no owner names, and the
  // Usage tab hides the user filter for them anyway.
  const users = new Map<string, string>()
  if (isAdmin) {
    for (const id of keyIds) {
      for (const u of usersForKey(participants, id)) users.set(u.id, u.name)
    }
  }

  return {
    keys: keyIds
      .map((id) => ({ id, name: names.get(id)!, shared: isShared(participants, id) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    users: [...users.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sharedInScope: hasSharedKeyInScope(participants, keyIds),
  }
}
