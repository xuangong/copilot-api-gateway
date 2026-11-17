// packages/gateway/src/control-plane/protection/dto.ts
import { getRepo } from "../../repo/index.ts"
import type { ApiKeyId, UpstreamId } from "../../repo/branded-ids.ts"
import type { PauseMode, PauseReason, PauseRecord, PauseTargetKind } from "../../repo/protection.ts"
import type { OwnerScopedAuth } from "../shared/ownership.ts"

export interface PauseDto {
  id: string
  targetKind: PauseTargetKind
  targetId: string
  targetName: string
  upstreamId: string
  upstreamName: string
  mode: PauseMode
  reason: PauseReason
  startedAt: number
  endsAt: number
  resolvedAt: number | null
  /** `resolvedBy`, or `auto` once the cooldown has passed (the sweep stamps the row later). */
  endedBy: "auto" | "owner" | null
  /** The caller may resume it (key pauses: the key's owner; upstream pauses: the upstream's owner; admins both). */
  canResume: boolean
}

export const endedBy = (row: PauseRecord, nowMs: number): PauseDto["endedBy"] => row.resolvedBy ?? (row.endsAt <= nowMs ? "auto" : null)

/** Per-request memo of upstream and key lookups (one load per distinct id). */
export interface Lookup {
  upstream(id: string): Promise<{ name: string; ownerId?: string | null } | null>
  key(id: string): Promise<{ name: string; ownerId?: string | null } | null>
}
export function createLookup(): Lookup {
  const upstreams = new Map<string, Promise<{ name: string; ownerId?: string | null } | null>>()
  const keys = new Map<string, Promise<{ name: string; ownerId?: string | null } | null>>()
  const memo = (cache: typeof upstreams, id: string, load: () => Promise<{ name: string; ownerId?: string | null } | null | undefined>) => {
    let hit = cache.get(id)
    if (!hit) { hit = load().then(row => row ?? null).catch(() => null); cache.set(id, hit) }
    return hit
  }
  return {
    upstream: id => memo(upstreams, id, () => getRepo().upstreams.getById(id as UpstreamId)),
    key: id => memo(keys, id, () => getRepo().apiKeys.getById(id as ApiKeyId)),
  }
}

const owns = (auth: OwnerScopedAuth | undefined, row: { ownerId?: string | null } | null): boolean =>
  !!auth && (auth.isAdmin === true || (!!auth.userId && row !== null && row.ownerId === auth.userId))

/** Who may see a row: admins, the owner of its upstream, and (for key pauses) the owner of the key. */
export async function canViewPause(auth: OwnerScopedAuth | undefined, row: PauseRecord, lookup: Lookup = createLookup()): Promise<boolean> {
  if (owns(auth, await lookup.upstream(row.upstreamId))) return true
  return row.targetKind === "key" && owns(auth, await lookup.key(row.targetId))
}

/**
 * Who may resume: a key pause applies across all upstreams, so only the key's owner (or an admin); an upstream pause only
 * that upstream's owner (or an admin). Anything else behaves as missing.
 */
export async function canManagePause(auth: OwnerScopedAuth | undefined, row: PauseRecord, lookup: Lookup = createLookup()): Promise<boolean> {
  return owns(auth, row.targetKind === "key" ? await lookup.key(row.targetId) : await lookup.upstream(row.upstreamId))
}

/**
 * Live names (falling back to the names captured in the reason, then the ids). A viewer who does not own the upstream (a key
 * owner whose key was paused because of someone else's upstream) gets no upstream id or name and only their own keys in `topKeys`.
 */
export async function toPauseDto(row: PauseRecord, nowMs: number, auth?: OwnerScopedAuth, lookup: Lookup = createLookup()): Promise<PauseDto> {
  const upstream = await lookup.upstream(row.upstreamId)
  const seesUpstream = owns(auth, upstream)
  const upstreamName = upstream?.name ?? row.reason.upstreamName ?? row.upstreamId
  let targetName = upstreamName
  if (row.targetKind === "key") {
    const key = await lookup.key(row.targetId)
    targetName = key?.name ?? row.reason.targetName ?? row.targetId
  } else if (row.targetId !== row.upstreamId) targetName = row.reason.targetName ?? row.targetId
  let reason = row.reason
  if (!seesUpstream) {
    const { upstreamName: _hidden, ...rest } = row.reason
    const topKeys: PauseReason["topKeys"] = []
    for (const entry of row.reason.topKeys) if (owns(auth, await lookup.key(entry.keyId))) topKeys.push(entry)
    reason = { ...rest, topKeys }
  }
  return {
    id: row.id, targetKind: row.targetKind, targetId: row.targetId, targetName,
    upstreamId: seesUpstream ? row.upstreamId : "", upstreamName: seesUpstream ? upstreamName : "", mode: row.mode,
    reason, startedAt: row.startedAt, endsAt: row.endsAt, resolvedAt: row.resolvedAt, endedBy: endedBy(row, nowMs),
    canResume: await canManagePause(auth, row, lookup),
  }
}
