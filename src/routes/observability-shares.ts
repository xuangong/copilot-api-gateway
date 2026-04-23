import { Elysia } from "elysia"
import { getRepo } from "~/repo"

interface AuthCtx {
  userId?: string
  authKind?: 'public' | 'admin' | 'session' | 'apiKey'
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
}

function badRequest(msg: string) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } })
}

function notFound(msg: string) {
  return new Response(JSON.stringify({ error: msg }), { status: 404, headers: { "Content-Type": "application/json" } })
}

export const observabilitySharesRoute = new Elysia()
  .post("/api/observability-shares", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const { viewerEmail } = (ctx.body ?? {}) as { viewerEmail?: string }
    if (!viewerEmail) return badRequest("viewerEmail is required")
    const repo = getRepo()
    const viewer = await repo.users.findByEmail(viewerEmail.toLowerCase())
    if (!viewer) return notFound("viewer email not found")
    if (viewer.id === userId) return badRequest("cannot share with yourself")
    await repo.observabilityShares.share(userId, viewer.id, userId)
    return { ownerId: userId, viewerId: viewer.id, viewerEmail: viewer.email, viewerName: viewer.name }
  })

  .delete("/api/observability-shares/:viewerId", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const { viewerId } = ctx.params as { viewerId: string }
    await getRepo().observabilityShares.unshare(userId, viewerId)
    return { ok: true }
  })

  .get("/api/observability-shares/granted-by-me", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const repo = getRepo()
    const grants = await repo.observabilityShares.listByOwner(userId)
    const viewers = await Promise.all(grants.map(g => repo.users.getById(g.viewerId)))
    return grants.map((g, i) => ({
      viewerId: g.viewerId,
      viewerEmail: viewers[i]?.email,
      viewerName: viewers[i]?.name,
      grantedAt: g.grantedAt,
    }))
  })

  .get("/api/observability-shares/granted-to-me", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const repo = getRepo()
    const grants = await repo.observabilityShares.listByViewer(userId)
    const owners = await Promise.all(grants.map(g => repo.users.getById(g.ownerId)))
    return grants.map((g, i) => ({
      ownerId: g.ownerId,
      ownerEmail: owners[i]?.email,
      ownerName: owners[i]?.name,
      grantedAt: g.grantedAt,
    }))
  })
