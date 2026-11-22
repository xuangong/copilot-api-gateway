// packages/gateway/src/quota-balance/balance.ts
import type { SessionAssignment, UpstreamGroup } from "../repo/quota-balance.ts"
import { touchIntervalMs, type AssignmentStore } from "./assignments.ts"
import { warn, type QuotaDeps } from "./deps.ts"
import type { GroupDirectoryCache } from "./directory.ts"
import { UNAVAILABLE_PROJECTED_SHARE, viewMembers, type MemberFactsCache } from "./facts.ts"
import { planGroupChoice, type GroupChoice, type MemberView } from "./selection.ts"
import { resolveSessionKey, type BalanceSession } from "./session-key.ts"

export interface BalanceParts { deps: QuotaDeps; directory: GroupDirectoryCache; facts: MemberFactsCache; assignments: AssignmentStore }
export interface BalanceArgs<T> {
  /** Candidates in routing order (a group's members are contiguous, or scattered under a key whitelist). */
  items: readonly T[]
  upstreamOf: (item: T) => string
  /** Absent for requests without a session (embeddings, images, count tokens): balanced per request, nothing is stored. */
  session?: BalanceSession
  /** Requests that consume no premium quota (count_tokens): no soft line, every member that is not cut off is ranked (members without data last). */
  ignoreSoftLine?: boolean
}
export interface SkippedGroup { groupId: string; name: string; ownerId: string }
export interface BalanceOutcome<T> {
  ordered: T[]
  /** Groups left out because of quota: every member that has a read is at or above the soft line under `stop`. */
  skipped: SkippedGroup[]
  /** Groups left out only because no member has quota data (no read yet): not a quota statement (D31). */
  unknown: SkippedGroup[]
  /** Call with the upstream that actually served; stores or refreshes the session's assignment. */
  commit(servedUpstreamId: string): void
}

/** Fail-open: any error leaves the candidates as they were. */
export async function balanceCandidates<T>(parts: BalanceParts, args: BalanceArgs<T>): Promise<BalanceOutcome<T>> {
  try { return await balance(parts, args) } catch (error) {
    warn("quota_balance_failed", error)
    return { ordered: [...args.items], skipped: [], unknown: [], commit: () => {} }
  }
}

async function balance<T>(parts: BalanceParts, args: BalanceArgs<T>): Promise<BalanceOutcome<T>> {
  const passthrough: BalanceOutcome<T> = { ordered: [...args.items], skipped: [], unknown: [], commit: () => {} }
  const directory = await parts.directory.get()
  if (directory.memberOf.size === 0) return passthrough
  const blocks = new Map<string, T[]>()
  const order: Array<{ item: T } | { groupId: string }> = []
  for (const item of args.items) {
    const groupId = directory.memberOf.get(args.upstreamOf(item))
    if (!groupId || !directory.groups.has(groupId)) { order.push({ item }); continue }
    let block = blocks.get(groupId)
    if (!block) { block = []; blocks.set(groupId, block); order.push({ groupId }) }
    block.push(item)
  }
  if (blocks.size === 0) return passthrough

  const now = parts.deps.now()
  const sessionKey = args.session ? await resolveSessionKey(args.session) : null
  const nonce = crypto.randomUUID()
  const ordered: T[] = []
  const skipped: SkippedGroup[] = []
  const unknown: SkippedGroup[] = []
  const commits = new Map<string, (served: string) => void>()
  for (const [position, entry] of order.entries()) {
    if ("item" in entry) { ordered.push(entry.item); continue }
    const group = directory.groups.get(entry.groupId)!
    if (!group.enabled) continue
    const block = blocks.get(entry.groupId)!
    // A single candidate skips only the ranking: `planGroupChoice` still applies the soft line (skip or overage).
    const memberIds = block.map(args.upstreamOf)
    const facts = await parts.facts.get(memberIds)
    const viewed = viewMembers(memberIds, facts, group.settings, now, parts.facts.unavailable)
    const members = args.ignoreSoftLine ? viewed.map(m => m.known ? m : { ...m, known: true, projectedShare: UNAVAILABLE_PROJECTED_SHARE }) : viewed
    const settings = args.ignoreSoftLine ? { ...group.settings, exhaustedPolicy: "overage" as const } : group.settings
    const assignment = sessionKey !== null ? await parts.assignments.get(group.id, sessionKey) : null
    const choice = planGroupChoice({ assignment: assignment ?? null, members, settings, sessionKey: sessionKey ?? nonce, now })
    if (choice.kind === "skip") {
      const info = { groupId: group.id, name: group.name, ownerId: group.ownerId }
      ;(quotaSkipped(members, group) ? skipped : unknown).push(info)
      continue
    }
    let list = choice.ordered
    // Writes only for a session with an identity and a successful lookup (`undefined`: choose, but write nothing).
    const writes = sessionKey !== null && assignment !== undefined
    let created: SessionAssignment | undefined
    if (writes && choice.kind === "assign" && assignment === null && position === 0) {
      // The group is tried first: store the new session now and follow the winner when another isolate stored a member first.
      created = await parts.assignments.create(newAssignment(group.id, sessionKey, list[0]!, now))
      if (created.upstreamId !== list[0] && list.includes(created.upstreamId)) list = [created.upstreamId, ...list.filter(id => id !== created!.upstreamId)]
    }
    const byId = new Map<string, T[]>()
    for (const item of block) { const id = args.upstreamOf(item); byId.set(id, [...(byId.get(id) ?? []), item]) }
    for (const id of list) ordered.push(...(byId.get(id) ?? []))
    if (writes) commits.set(group.id, served => commitChoice(parts, args.session, group, sessionKey, assignment, created, choice, served, now))
  }
  return {
    ordered, skipped, unknown,
    commit(served) {
      const groupId = directory.memberOf.get(served)
      if (groupId) commits.get(groupId)?.(served)
    },
  }
}

/** The skip is a quota statement when a member with a read exists (at or above the soft line); otherwise nothing is known yet. */
const quotaSkipped = (members: readonly MemberView[], group: UpstreamGroup): boolean =>
  group.settings.exhaustedPolicy === "stop" && members.some(m => m.known && !m.unavailable)

const newAssignment = (groupId: string, sessionKey: string, upstreamId: string, now: number): SessionAssignment =>
  ({ groupId, sessionKey, upstreamId, createdAt: now, lastSeenAt: now, movedAt: now, recentCostUsd: 0, recentCostAt: now })

function commitChoice(
  parts: BalanceParts, session: BalanceSession | undefined, group: UpstreamGroup, sessionKey: string,
  current: SessionAssignment | null | undefined, created: SessionAssignment | undefined, choice: Exclude<GroupChoice, { kind: "skip" }>, served: string, now: number,
): void {
  const remember = () => { if (session) session.assigned = { groupId: group.id, sessionKey, upstreamId: served } }
  const idle = touchIntervalMs(group.settings.idleRebalanceMinutes)
  if (choice.kind === "keep") {
    // A fallback served a kept session: the assignment stays where it is.
    if (current && current.upstreamId === served) { parts.assignments.touch(current, now, idle); remember() }
    return
  }
  if (!current) {
    if (!created) {
      // A later group than the first item: stored only now that one of its members served.
      parts.deps.schedule(parts.assignments.create(newAssignment(group.id, sessionKey, served, now)).catch(error => warn("quota_assignment_write_failed", error)))
    } else if (created.upstreamId !== served) {
      parts.assignments.move({ ...created, upstreamId: served, lastSeenAt: now, movedAt: now }, created.upstreamId)
    }
    remember()
    return
  }
  if (current.upstreamId === served) parts.assignments.touch(current, now, idle)
  else parts.assignments.move({ ...current, upstreamId: served, lastSeenAt: now, movedAt: now }, current.upstreamId)
  remember()
}
