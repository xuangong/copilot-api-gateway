import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../../app.ts"
import { getRepo } from "../../repo/index.ts"
import type { UpstreamId, UserId } from "../../repo/branded-ids.ts"
import { DEFAULT_GROUP_SETTINGS, type UpstreamGroup } from "../../repo/quota-balance.ts"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"
import { copilotCredentialOf, isCopilotUpstream } from "../../quota-balance/credential.ts"
import { warn } from "../../quota-balance/deps.ts"
import { CalibrationError, type ReadOutcome } from "../../quota-balance/reader.ts"
import { MANUAL_MIN_READ_GAP_MS } from "../../quota-balance/read-schedule.ts"
import { getQuotaBalance } from "../../quota-balance/runtime.ts"
import { GroupSettingsError, normalizeGroupSettings } from "../../quota-balance/settings.ts"
import { requireBrowserSession } from "../shared/session-guard.ts"
import { loadOwned } from "../shared/ownership.ts"
import { buildAlerts, buildGroupStatus, toGroupDto, visibleMemberIds, type Viewer } from "./dto.ts"

type Vars = { auth: FullAuthCtx }
const NO_STORE = { "cache-control": "no-store" }
const fail = (status: 400 | 404 | 409 | 429 | 502, code: string, message?: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { code, ...(message ? { message } : {}) }, ...extra }), { status, headers: { "content-type": "application/json", ...NO_STORE } })
const notFound = () => fail(404, "not_found")
const MAX_GROUPS_PER_OWNER = 16
const GROUP_ID = /^ug_[0-9a-f]{32}$/
const now = () => getQuotaBalance().deps.now()

const createBody = z.object({ name: z.string(), ownerId: z.string().optional(), enabled: z.boolean().optional(), sortOrder: z.number().finite().optional(), settings: z.unknown().optional() })
const patchBody = z.object({ name: z.string().optional(), enabled: z.boolean().optional(), sortOrder: z.number().finite().optional(), settings: z.unknown().optional() })
const calibrateBody = z.object({ used: z.number().optional(), entitlement: z.number().optional(), usedShare: z.number().optional(), at: z.number().optional() })

const viewerOf = (auth: FullAuthCtx): Viewer => ({ isAdmin: auth.isAdmin === true, userId: auth.userId ?? "" })
const ownedGroup = (auth: FullAuthCtx | undefined, id: string) => GROUP_ID.test(id) ? loadOwned(auth, () => getRepo().quotaBalance.getGroup(id)) : Promise.resolve(null)
const ownedUpstream = (auth: FullAuthCtx | undefined, id: string) => loadOwned(auth, () => getRepo().upstreams.getById(id as UpstreamId))
const changed = () => { const qb = getQuotaBalance(); qb.directory.invalidate(); qb.facts.invalidate() }
const cleanName = (value: string) => value.trim().slice(0, 80)

/** Groups and upstreams share one sort order space per owner: the routing items of an owner (groups and ungrouped upstreams), in routing order. */
async function ownerItems(ownerId: string, exclude: string) {
  const repo = getRepo()
  const grouped = new Set((await repo.quotaBalance.listMemberships()).map(m => m.upstreamId))
  const groups = (await repo.quotaBalance.listGroups({ ownerId })).map(g => ({ kind: "group" as const, id: g.id, sortOrder: g.sortOrder, createdAt: g.createdAt }))
  const upstreams = (await repo.upstreams.list({ ownerId: ownerId as never, includeDisabled: true }))
    .filter(u => !grouped.has(u.id) && u.id !== exclude).map(u => ({ kind: "upstream" as const, id: u.id, sortOrder: u.sortOrder, createdAt: u.createdAt }))
  return [...groups, ...upstreams].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** Placements of one owner are serialised in this isolate; each one is a single atomic batch. */
let placing: Promise<unknown> = Promise.resolve()

/**
 * A member that leaves its group goes right after the group in the routing order. The group's number space is shared with the owner's upstreams, so the
 * owner's items are renumbered 0, 1, 2 ... with the member right behind the group, and every changed sort order is written in one repo batch (atomic, so a
 * concurrent reader never sees a half-renumbered order). Only items whose number changes are written.
 */
function placeAfterGroup(group: UpstreamGroup, upstreamId: string): Promise<void> {
  const run = placing.catch(() => {}).then(async () => {
    const repo = getRepo()
    const upstream = await repo.upstreams.getById(upstreamId as UpstreamId)
    if (!upstream) return
    const items = await ownerItems(group.ownerId, upstreamId)
    const at = items.findIndex(item => item.kind === "group" && item.id === group.id)
    if (at < 0) return
    const sequence = [...items.slice(0, at + 1), { kind: "upstream" as const, id: upstreamId, sortOrder: Number.NaN, createdAt: "" }, ...items.slice(at + 1)]
    const changedItems = sequence.flatMap((item, index) => item.sortOrder === index ? [] : [{ kind: item.kind, id: item.id, sortOrder: index }])
    await repo.quotaBalance.reorderItems({
      groups: changedItems.filter(i => i.kind === "group"), upstreams: changedItems.filter(i => i.kind === "upstream"),
    }, new Date(now()).toISOString())
  })
  placing = run
  return run
}

/** `/api/upstream-groups`: session-guarded, owner-only (admins see all). */
export const upstreamGroupsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()
upstreamGroupsRouter.use("*", requireBrowserSession)

const visibleGroups = (auth: FullAuthCtx) => getRepo().quotaBalance.listGroups(auth.isAdmin ? {} : { ownerId: auth.userId ?? "" })

upstreamGroupsRouter.get("/", async (c) => {
  const auth = c.get("auth")
  const groups = await visibleGroups(auth)
  const memberships = await getRepo().quotaBalance.listMemberships()
  const viewer = viewerOf(auth)
  return c.json({ groups: groups.map(group => toGroupDto(group, visibleMemberIds(memberships, group.id, viewer))) }, 200, NO_STORE)
})

upstreamGroupsRouter.get("/alerts", async (c) => {
  const auth = c.get("auth")
  return c.json({ alerts: await buildAlerts(await visibleGroups(auth), now(), viewerOf(auth)) }, 200, NO_STORE)
})

upstreamGroupsRouter.post("/", async (c) => {
  const auth = c.get("auth")
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(400, "invalid_body")
  const name = cleanName(parsed.data.name)
  if (name === "") return fail(400, "invalid_name", "name required")
  const ownerId = auth.isAdmin && parsed.data.ownerId !== undefined ? parsed.data.ownerId : auth.userId ?? ""
  // An admin creating for someone else needs an existing user ('' is the global owner).
  if (ownerId !== "" && ownerId !== auth.userId && !(await getRepo().users.getById(ownerId as UserId))) return fail(400, "invalid_owner", "owner not found")
  if ((await getRepo().quotaBalance.listGroups({ ownerId })).length >= MAX_GROUPS_PER_OWNER) return fail(409, "group_limit", `at most ${MAX_GROUPS_PER_OWNER} groups per owner`)
  let settings = DEFAULT_GROUP_SETTINGS
  try { if (parsed.data.settings !== undefined) settings = normalizeGroupSettings(parsed.data.settings) } catch (error) {
    if (error instanceof GroupSettingsError) return fail(400, "invalid_settings", error.message)
    throw error
  }
  const repo = getRepo()
  // The same number space as the owner's upstreams: the new group goes after everything the owner has (members keep their own, unused number).
  const siblings = [...(await repo.quotaBalance.listGroups({ ownerId })).map(g => g.sortOrder), ...(await repo.upstreams.list({ ownerId: ownerId as never, includeDisabled: true })).map(u => u.sortOrder)]
  const stamp = new Date(now()).toISOString()
  const group: UpstreamGroup = {
    id: `ug_${crypto.randomUUID().replace(/-/g, "")}`, ownerId, name, enabled: parsed.data.enabled !== false,
    sortOrder: parsed.data.sortOrder ?? Math.max(-1, ...siblings) + 1, settings, createdAt: stamp, updatedAt: stamp,
  }
  await repo.quotaBalance.createGroup(group)
  changed()
  return c.json({ group: toGroupDto(group, []) }, 201, NO_STORE)
})

upstreamGroupsRouter.patch("/:id", async (c) => {
  const auth = c.get("auth")
  const group = await ownedGroup(auth, c.req.param("id"))
  if (!group) return notFound()
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(400, "invalid_body")
  const patch: Parameters<ReturnType<typeof getRepo>["quotaBalance"]["updateGroup"]>[1] = {}
  if (parsed.data.name !== undefined) {
    const name = cleanName(parsed.data.name)
    if (name === "") return fail(400, "invalid_name", "name required")
    patch.name = name
  }
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled
  if (parsed.data.sortOrder !== undefined) patch.sortOrder = parsed.data.sortOrder
  if (parsed.data.settings !== undefined) {
    try { patch.settings = normalizeGroupSettings(parsed.data.settings, group.settings) } catch (error) {
      if (error instanceof GroupSettingsError) return fail(400, "invalid_settings", error.message)
      throw error
    }
  }
  const updated = await getRepo().quotaBalance.updateGroup(group.id, patch, new Date(now()).toISOString())
  if (!updated) return notFound()
  changed()
  return c.json({ group: toGroupDto(updated, visibleMemberIds(await getRepo().quotaBalance.listMemberships(), group.id, viewerOf(auth))) }, 200, NO_STORE)
})

upstreamGroupsRouter.delete("/:id", async (c) => {
  const group = await ownedGroup(c.get("auth"), c.req.param("id"))
  if (!group || !(await getRepo().quotaBalance.deleteGroup(group.id, now()))) return notFound()
  changed()
  return c.json({ ok: true }, 200, NO_STORE)
})

upstreamGroupsRouter.get("/:id/status", async (c) => {
  const auth = c.get("auth")
  const group = await ownedGroup(auth, c.req.param("id"))
  if (!group) return notFound()
  return c.json(await buildGroupStatus(group, now(), viewerOf(auth)), 200, NO_STORE)
})

type ReadStatus = "read" | "reused" | "error" | "unsupported"
const statusOf = (outcome: ReadOutcome): ReadStatus => outcome.status === "read" ? "read" : outcome.status === "floor" ? "reused" : outcome.status === "error" ? "error" : "unsupported"

/**
 * Page open: reads the members that were not read in the last 10 minutes and answers with the fresh status. The reader's atomic claim enforces the
 * 10 minute floor (concurrent page opens, the sweep and other isolates cannot get two reads through), so this never reads more often than a manual refresh.
 */
upstreamGroupsRouter.post("/:id/live", async (c) => {
  const auth = c.get("auth")
  const group = await ownedGroup(auth, c.req.param("id"))
  if (!group) return notFound()
  const viewer = viewerOf(auth)
  const qb = getQuotaBalance()
  const reads: Array<{ upstreamId: string; status: ReadStatus }> = []
  if (group.enabled) {
    const memberships = (await getRepo().quotaBalance.listMemberships()).filter(m => m.groupId === group.id && (viewer.isAdmin || m.ownerId === viewer.userId))
    const states = await getRepo().quotaBalance.getStates(memberships.map(m => m.upstreamId))
    await Promise.all(memberships.map(async (m) => {
      const state = states.get(m.upstreamId)
      // Not read in the last 10 minutes; a failing member also waits out its failure backoff (a manual refresh may still retry).
      const recent = state?.lastAttemptAt != null && now() - state.lastAttemptAt < MANUAL_MIN_READ_GAP_MS
      const backingOff = state !== undefined && state.failures > 0 && now() < state.nextReadAt
      if (recent || backingOff) { reads.push({ upstreamId: m.upstreamId, status: "reused" }); return }
      try { reads.push({ upstreamId: m.upstreamId, status: statusOf(await qb.reader.readNow(m.upstreamId, { reason: "manual", manual: true })) }) } catch (error) {
        warn("quota_live_read_failed", error)
        reads.push({ upstreamId: m.upstreamId, status: "error" })
      }
    }))
  }
  return c.json({ ...(await buildGroupStatus(group, now(), viewer)), reads }, 200, NO_STORE)
})

/** `/api/upstreams/:id/{group,quota/*}`: mounted next to `upstreamsRouter`. */
export const upstreamQuotaRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

upstreamQuotaRouter.put("/:id/group", requireBrowserSession, async (c) => {
  const auth = c.get("auth")
  const upstream = await ownedUpstream(auth, c.req.param("id"))
  if (!upstream) return notFound()
  const body = z.object({ groupId: z.string().nullable() }).safeParse(await c.req.json().catch(() => null))
  if (!body.success) return fail(400, "invalid_body")
  const repo = getRepo()
  const previous = (await repo.quotaBalance.listMemberships()).find(m => m.upstreamId === upstream.id)?.groupId ?? null
  if (body.data.groupId === null) {
    await repo.quotaBalance.setMembership(upstream.id, null, { nowMs: now(), intervalHours: DEFAULT_GROUP_SETTINGS.readIntervalHours })
    if (previous !== null) {
      const group = await repo.quotaBalance.getGroup(previous)
      if (group) await placeAfterGroup(group, upstream.id)
    }
    changed()
    return c.json({ ok: true, groupId: null }, 200, NO_STORE)
  }
  if (!isCopilotUpstream(upstream)) return fail(400, "unsupported_provider", "only Copilot upstreams can join a group")
  if (!copilotCredentialOf(upstream)) return fail(400, "no_credential", "the upstream has no stored GitHub credential, so its quota cannot be read")
  const group = await ownedGroup(auth, body.data.groupId)
  if (!group) return notFound()
  // Only the group owner's own upstreams (an admin adding another user's upstream gets a clear refusal).
  if ((upstream.ownerId ?? "") !== group.ownerId) return fail(400, "owner_mismatch", "the upstream and the group must have the same owner")
  await repo.quotaBalance.setMembership(upstream.id, group.id, { nowMs: now(), intervalHours: group.settings.readIntervalHours })
  changed()
  if (previous !== group.id) {
    // Joining: the first read in the background (the reader enforces the floors and the month-start window).
    const qb = getQuotaBalance()
    qb.deps.schedule(qb.reader.evaluateMember(upstream.id, { allowScheduled: true }).catch(error => warn("quota_join_read_failed", error)))
  }
  return c.json({ ok: true, groupId: group.id }, 200, NO_STORE)
})

/** The member's group, or null when the upstream is not (or no longer) in one. */
const memberGroup = async (upstreamId: string) => {
  const directory = await getQuotaBalance().directory.get({ fresh: true })
  const groupId = directory.memberOf.get(upstreamId)
  return groupId ? directory.groups.get(groupId) ?? null : null
}

upstreamQuotaRouter.post("/:id/quota/refresh", requireBrowserSession, async (c) => {
  const upstream = await ownedUpstream(c.get("auth"), c.req.param("id"))
  if (!upstream) return notFound()
  if (!isCopilotUpstream(upstream)) return fail(400, "unsupported_provider", "only Copilot upstreams have a readable quota")
  if (!(await memberGroup(upstream.id))) return fail(400, "not_a_member", "the upstream is not in a group")
  const outcome = await getQuotaBalance().reader.readNow(upstream.id, { reason: "manual", manual: true })
  if (outcome.status === "read") return c.json({ status: "read", lastReadAt: outcome.read.at }, 200, NO_STORE)
  if (outcome.status === "floor") {
    // Within the floor the stored read is reused (opening the page must not turn into frequent reads).
    const state = (await getRepo().quotaBalance.getStates([upstream.id])).get(upstream.id)
    return c.json({ status: "reused", lastReadAt: state?.lastReadAt ?? null, blockedUntil: outcome.blockedUntil }, 200, NO_STORE)
  }
  // Status code or error name only, never an upstream body.
  if (outcome.status === "error") return fail(502, "read_failed", outcome.error)
  return fail(400, "unsupported", outcome.status === "unsupported" ? outcome.error : undefined)
})

upstreamQuotaRouter.post("/:id/quota/calibrate", requireBrowserSession, async (c) => {
  const upstream = await ownedUpstream(c.get("auth"), c.req.param("id"))
  if (!upstream) return notFound()
  if (!isCopilotUpstream(upstream)) return fail(400, "unsupported_provider", "only Copilot upstreams can be calibrated")
  if (!(await memberGroup(upstream.id))) return fail(400, "not_a_member", "the upstream is not in a group")
  const body = calibrateBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return fail(400, "invalid_calibration", "used, entitlement, usedShare and at must be numbers")
  try {
    const outcome = await getQuotaBalance().reader.calibrate(upstream.id, body.data)
    if (outcome.status === "read") return c.json({ status: "read" }, 200, NO_STORE)
    if (outcome.status === "floor") return fail(429, "too_soon", "a manual read is allowed every 10 minutes", { blockedUntil: outcome.blockedUntil })
    return fail(400, "unsupported", outcome.status === "unsupported" ? outcome.error : undefined)
  } catch (error) {
    if (error instanceof CalibrationError) return fail(400, "invalid_calibration", error.message)
    throw error
  }
})
