import { Hono } from "hono"
import type { Env } from "../../app.ts"
import { getRepo } from "../../repo/index.ts"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"
import { getProtection } from "../../protection/runtime.ts"
import { loadOwned } from "../shared/ownership.ts"
import type { UpstreamId } from "../../repo/branded-ids.ts"
import { requireBrowserSession, requireBrowserSessionAllowingQuery } from "../shared/session-guard.ts"
import { parseErrorQuery } from "./query.ts"
import { canManagePause, canViewPause, createLookup, toPauseDto } from "./dto.ts"

type Vars = { auth: FullAuthCtx }
const PAUSE_ID = /^pp_[0-9a-f]{32}$/
const notFound = () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } })
const NO_STORE = { "cache-control": "no-store" }

/** `/api/protection`: session-guarded, no query strings. */
export const protectionRouter = new Hono<{ Bindings: Env; Variables: Vars }>()
protectionRouter.use("*", requireBrowserSession)

protectionRouter.get("/active", async (c) => {
  const nowMs = getProtection().now()
  const auth = c.get("auth")
  const lookup = createLookup()
  const pauses = []
  for (const row of await getRepo().protection.listActive(nowMs)) {
    if (await canViewPause(auth, row, lookup)) pauses.push(await toPauseDto(row, nowMs, auth, lookup))
  }
  return c.json({ pauses }, 200, NO_STORE)
})

protectionRouter.post("/pauses/:id/resume", async (c) => {
  const id = c.req.param("id")
  if (!PAUSE_ID.test(id)) return notFound()
  const runtime = getProtection()
  const row = await getRepo().protection.getPause(id)
  if (!row || row.resolvedAt !== null || row.endsAt <= runtime.now() || !(await canManagePause(c.get("auth"), row))) return notFound()
  if (!(await runtime.resume(id, "owner"))) return notFound()
  return c.json({ ok: true }, 200, NO_STORE)
})


/** `/api/upstreams/:id/{errors,error-samples,pauses}`: session-guarded, owner-only (admins see all). Mounted next to `upstreamsRouter`. */
export const upstreamProtectionRouter = new Hono<{ Bindings: Env; Variables: Vars }>()
const bad = (code: string) => new Response(JSON.stringify({ error: { code } }), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } })
const ownedUpstream = (auth: FullAuthCtx | undefined, id: string) => loadOwned(auth, () => getRepo().upstreams.getById(id as UpstreamId))

upstreamProtectionRouter.get("/:id/errors", requireBrowserSessionAllowingQuery, async (c) => {
  const id = c.req.param("id")
  if (!(await ownedUpstream(c.get("auth"), id))) return notFound()
  const query = parseErrorQuery(new URL(c.req.url).searchParams, Math.floor(getProtection().now() / 1000))
  if ("error" in query) return bad(query.error)
  const buckets = await getRepo().protection.errorBuckets(id, query.from, query.to, query.bucketSeconds, query.keyId)
  return c.json({ upstreamId: id, from: query.from, to: query.to, bucket: query.bucketSeconds === 60 ? "minute" : "hour", buckets }, 200, NO_STORE)
})

upstreamProtectionRouter.get("/:id/error-samples", requireBrowserSessionAllowingQuery, async (c) => {
  const id = c.req.param("id")
  if (!(await ownedUpstream(c.get("auth"), id))) return notFound()
  return c.json({ samples: await getRepo().protection.listSamples(id) }, 200, NO_STORE)
})

upstreamProtectionRouter.get("/:id/pauses", requireBrowserSessionAllowingQuery, async (c) => {
  const id = c.req.param("id")
  if (!(await ownedUpstream(c.get("auth"), id))) return notFound()
  const raw = new URL(c.req.url).searchParams.get("limit")
  const limit = raw === null ? 20 : /^\d{1,3}$/.test(raw) ? Number(raw) : 0
  if (limit < 1 || limit > 100) return bad("invalid_limit")
  const nowMs = getProtection().now()
  const rows = await getRepo().protection.listPauses(id, limit)
  const lookup = createLookup()
  return c.json({ pauses: await Promise.all(rows.map(row => toPauseDto(row, nowMs, c.get("auth"), lookup))) }, 200, NO_STORE)
})
