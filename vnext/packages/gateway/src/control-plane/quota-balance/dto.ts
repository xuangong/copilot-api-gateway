import { getRepo } from "../../repo/index.ts"
import type { GroupMembership, GroupSettings, MemberPlanFact, QuotaReadSource, UpstreamGroup } from "../../repo/quota-balance.ts"
import { getProtection } from "../../protection/runtime.ts"
import { effectiveK } from "../../quota-balance/estimator.ts"
import { kFallbackFor, kFallbackOf, kSourceOf, memberEstimate, paramsOf, seedKFor, viewMembers, type KSource } from "../../quota-balance/facts.ts"
import { getQuotaBalance } from "../../quota-balance/runtime.ts"
import { groupState, type GroupState, type MemberView } from "../../quota-balance/selection.ts"
import { HOUR_MS } from "../../quota-balance/time.ts"

/** The caller, for information hiding: a non-admin never sees an upstream (name, id, numbers) that they do not own. */
export interface Viewer { isAdmin: boolean; userId: string }
const mayView = (viewer: Viewer, ownerId: string | null | undefined): boolean => viewer.isAdmin || (ownerId ?? "") === viewer.userId

export interface GroupDto {
  id: string
  ownerId: string
  name: string
  enabled: boolean
  sortOrder: number
  settings: GroupSettings
  memberIds: string[]
  createdAt: string
  updatedAt: string
}
export const toGroupDto = (group: UpstreamGroup, memberIds: string[]): GroupDto => ({
  id: group.id, ownerId: group.ownerId, name: group.name, enabled: group.enabled, sortOrder: group.sortOrder, settings: group.settings,
  memberIds, createdAt: group.createdAt, updatedAt: group.updatedAt,
})

/** Member ids of a group that the viewer may see (memberships are read once by the caller). */
export const visibleMemberIds = (memberships: readonly GroupMembership[], groupId: string, viewer: Viewer): string[] =>
  memberships.filter(m => m.groupId === groupId && mayView(viewer, m.ownerId)).map(m => m.upstreamId)

export type IneligibleReason = "group_disabled" | "disabled" | "cut_off" | "paused" | "no_read" | "soft_line"
export type ReadFailingReason = "never_read" | "stale"
const failingReason = (view: MemberView): ReadFailingReason | null => view.neverRead === true ? "never_read" : view.readFailing === true ? "stale" : null
export interface MemberStatusDto {
  upstreamId: string
  name: string
  login: string | null
  enabled: boolean
  unlimited: boolean
  /** Estimated used share now (read + k x gateway cost + o x time); null before the first read. */
  usedShare: number | null
  /** Latest read's entitlement, in the snapshot's unit. */
  entitlement: number | null
  /** usedShare x the latest entitlement. */
  estimatedUsed: number | null
  projectedShare: number | null
  lastRead: { at: number; source: QuotaReadSource; used: number; entitlement: number; share: number } | null
  k: number | null
  kPrevious: number | null
  kSamples: number
  /** Where the k behind the numbers comes from: its own once learned, the same-plan peers' (seeded, D33) or the default fallback. */
  kSource: KSource
  /** Share per hour. */
  outsideRate: number
  /** Share of the last day's consumption that did not go through the gateway; null without data. */
  outsideShareLastDay: number | null
  lastErrorPoints: number | null
  intervalHours: number
  nextReadAt: number
  failures: number
  /** Status or error name of the last failed read; never a response body. */
  lastError: string | null
  /** The reads keep failing (D32): the numbers rest on a conservative gateway-only estimate or a stale read. */
  readFailing: boolean
  /** `never_read`: no successful read yet (not eligible); `stale`: reads keep failing on a cautious estimate (eligible). */
  readFailingReason: ReadFailingReason | null
  entitlementChange: { from: number; to: number; at: number } | null
  cutOff: { until: number; provisional: boolean; share: number } | null
  eligibility: { eligible: boolean; reason: IneligibleReason | null }
  activeSessions: number
}
export interface AttentionDto { upstreamId: string; kind: "large_error" | "read_failing" | "entitlement_changed" }
export type GroupStateDto = GroupState | "unknown"
export interface GroupStatusDto { group: GroupDto; state: GroupStateDto; members: MemberStatusDto[]; attention: AttentionDto[]; nowMs: number }

const DAY_MS = 24 * HOUR_MS
type Paused = Awaited<ReturnType<ReturnType<typeof getProtection>["activePauses"]>>[number]

/** What every group of one request needs, loaded once: memberships, the viewer's upstreams (one query), member facts (one grouped load), active pauses. */
interface Context {
  nowMs: number
  viewer: Viewer
  memberships: readonly GroupMembership[]
  upstreams: Map<string, Awaited<ReturnType<ReturnType<typeof getRepo>["upstreams"]["list"]>>[number]>
  facts: Awaited<ReturnType<ReturnType<typeof getQuotaBalance>["facts"]["get"]>>
  unavailable: ReadonlySet<string>
  plans: readonly MemberPlanFact[]
  pauses: Paused[]
}

async function loadContext(groups: readonly UpstreamGroup[], nowMs: number, viewer: Viewer, memberships?: readonly GroupMembership[]): Promise<Context> {
  const repo = getRepo()
  const qb = getQuotaBalance()
  const all = memberships ?? await repo.quotaBalance.listMemberships()
  const groupIds = new Set(groups.map(g => g.id))
  const mine = all.filter(m => groupIds.has(m.groupId) && mayView(viewer, m.ownerId))
  const ids = mine.map(m => m.upstreamId)
  const [upstreams, facts, plans, pauses] = await Promise.all([
    ids.length === 0 ? [] : repo.upstreams.list({ ...(viewer.isAdmin ? {} : { ownerId: viewer.userId as never }), includeDisabled: true }),
    qb.facts.get(ids, { fresh: true }),
    qb.facts.plans(),
    getProtection().activePauses(),
  ])
  return {
    nowMs, viewer, memberships: mine, upstreams: new Map(upstreams.map(u => [u.id as string, u])), facts, plans, unavailable: qb.facts.unavailable,
    pauses: pauses.filter(p => p.mode === "pause" && p.targetKind === "upstream"),
  }
}

interface Assessed { id: string; view: MemberView; reason: IneligibleReason | null; quotaPause: Paused | undefined; kFallback: number; kSource: KSource }

/** Eligibility of every member and the group state, from the member views only (no DTO). */
function assess(group: UpstreamGroup, ctx: Context): { ids: string[]; assessed: Assessed[]; state: GroupStateDto } {
  const ids = ctx.memberships.filter(m => m.groupId === group.id).map(m => m.upstreamId)
  const views = viewMembers(ids, ctx.facts, group.settings, ctx.nowMs, ctx.unavailable, ctx.plans)
  const groupFallback = kFallbackOf(ids.map(id => ctx.facts.get(id)?.state ?? null))
  const assessed = ids.map((id, index): Assessed => {
    const view = views[index]!
    const own = ctx.pauses.filter(p => p.targetId === id)
    const quotaPause = own.filter(p => p.reason.trigger === "quota").sort((a, b) => b.endsAt - a.endsAt)[0]
    let reason: IneligibleReason | null = null
    if (!group.enabled) reason = "group_disabled"
    else if (!ctx.upstreams.get(id)?.enabled) reason = "disabled"
    else if (quotaPause) reason = "cut_off"
    else if (own.length > 0) reason = "paused"
    else if (!view.known) reason = "no_read"
    else if (group.settings.exhaustedPolicy === "stop" && !view.unavailable && view.usedShare >= group.settings.softShare) reason = "soft_line"
    const seed = seedKFor(id, ctx.plans)
    return { id, view, reason, quotaPause, kFallback: kFallbackFor(groupFallback, seed).kFallback, kSource: kSourceOf(paramsOf(ctx.facts.get(id)?.state ?? null), seed) }
  })
  // No data anywhere (or only unavailable facts): unknown. Data but nobody can take a session (cut off, paused, disabled): stopped.
  // Unavailable facts are never counted as room below the soft line.
  let state: GroupStateDto
  const withData = views.filter(v => v.known && !v.unavailable)
  if (!group.enabled) state = "normal"
  else if (withData.length === 0) state = "unknown"
  else {
    const takers = assessed.filter(a => (a.reason === null || a.reason === "soft_line") && a.view.known)
    const real = takers.filter(a => !a.view.unavailable).map(a => a.view)
    state = takers.length === 0 ? "stopped" : real.length === 0 ? "unknown" : groupState(real, group.settings)
  }
  return { ids, assessed, state }
}

export async function buildGroupStatus(group: UpstreamGroup, nowMs: number, viewer: Viewer, memberships?: readonly GroupMembership[]): Promise<GroupStatusDto> {
  const repo = getRepo()
  const ctx = await loadContext([group], nowMs, viewer, memberships)
  const { ids, assessed, state: groupStateValue } = assess(group, ctx)
  const [sessions, cost24h] = await Promise.all([
    repo.quotaBalance.countActiveSessions(group.id, nowMs - group.settings.sessionIdleHours * HOUR_MS),
    repo.quotaBalance.costBetweenMany(ids, nowMs - DAY_MS, nowMs),
  ])
  const attention: AttentionDto[] = []
  const members: MemberStatusDto[] = assessed.map(({ id, view, reason, quotaPause, kFallback, kSource }) => {
    const f = ctx.facts.get(id)
    const state = f?.state ?? null
    const upstream = ctx.upstreams.get(id)
    const estimate = memberEstimate(f, nowMs, kFallback)
    const entitlement = state?.entitlement ?? null
    const k = state?.k ?? null
    const outside = (state?.o ?? 0) * 24
    const denominator = outside + effectiveK({ k, kSamples: state?.kSamples ?? 0 }, kFallback) * (cost24h.get(id) ?? 0)
    const shown = view.known && !view.unavailable
    const change = state && state.entitlementChangedAt !== null && state.entitlementFrom !== null && state.entitlement !== null
      ? { from: state.entitlementFrom, to: state.entitlement, at: state.entitlementChangedAt } : null
    const readFailingReason = failingReason(view)
    const readFailing = readFailingReason !== null
    if (state && state.lastErrorPoints !== null && Math.abs(state.lastErrorPoints) > 10) attention.push({ upstreamId: id, kind: "large_error" })
    if (readFailing) attention.push({ upstreamId: id, kind: "read_failing" })
    if (change && nowMs - change.at < 7 * DAY_MS) attention.push({ upstreamId: id, kind: "entitlement_changed" })
    const config = upstream?.config as { user?: { login?: unknown } } | undefined
    return {
      upstreamId: id, name: upstream?.name ?? id, login: typeof config?.user?.login === "string" ? config.user.login : null, enabled: upstream?.enabled ?? false,
      unlimited: estimate.unlimited,
      usedShare: shown ? view.usedShare : null, entitlement,
      estimatedUsed: shown && entitlement !== null ? view.usedShare * entitlement : null,
      projectedShare: shown ? view.projectedShare : null,
      lastRead: state && state.lastReadAt !== null && state.lastReadShare !== null && entitlement !== null && state.lastReadSource
        ? { at: state.lastReadAt, source: state.lastReadSource, used: state.lastReadShare * entitlement, entitlement, share: state.lastReadShare } : null,
      k, kPrevious: state?.kPrev ?? null, kSamples: state?.kSamples ?? 0, kSource, outsideRate: state?.o ?? 0,
      outsideShareLastDay: denominator > 0 ? outside / denominator : null,
      lastErrorPoints: state?.lastErrorPoints ?? null, intervalHours: state?.intervalHours ?? group.settings.readIntervalHours, nextReadAt: state?.nextReadAt ?? 0,
      failures: state?.failures ?? 0, lastError: state?.lastError ?? null, readFailing, readFailingReason, entitlementChange: change,
      cutOff: quotaPause?.reason.quota ? { until: quotaPause.endsAt, provisional: quotaPause.reason.quota.provisional, share: quotaPause.reason.quota.share } : null,
      eligibility: { eligible: reason === null, reason },
      activeSessions: sessions.get(id) ?? 0,
    }
  })
  return { group: toGroupDto(group, ids), state: groupStateValue, members, attention, nowMs }
}

export type AlertDto =
  | { kind: "stopped" | "overage"; groupId: string; groupName: string }
  /** A member whose reads keep failing (the numbers rest on a cautious estimate); named for viewers who may see the upstream only. */
  | { kind: "read_failing"; reason: ReadFailingReason; groupId: string; groupName: string; upstreamId: string; upstreamName: string }

/** Groups that cannot take new sessions (`stopped`) or serve them above the soft line (`overage`), and members whose reads keep failing (`read_failing`). Disabled groups are not reported. One context load for all groups, no DTOs. */
export async function buildAlerts(groups: readonly UpstreamGroup[], nowMs: number, viewer: Viewer): Promise<AlertDto[]> {
  const enabled = groups.filter(g => g.enabled)
  if (enabled.length === 0) return []
  const ctx = await loadContext(enabled, nowMs, viewer)
  const alerts: AlertDto[] = []
  for (const group of enabled) {
    const { state, assessed } = assess(group, ctx)
    if (state === "stopped" || state === "overage") alerts.push({ kind: state, groupId: group.id, groupName: group.name })
    for (const member of assessed) {
      const reason = failingReason(member.view)
      if (reason !== null) alerts.push({ kind: "read_failing", reason, groupId: group.id, groupName: group.name, upstreamId: member.id, upstreamName: ctx.upstreams.get(member.id)?.name ?? member.id })
    }
  }
  return alerts
}
