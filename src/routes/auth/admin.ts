import { Elysia } from "elysia"

import { getRepo } from "~/repo"

import { type AuthContext, generateInviteCode } from "./utils"

export const adminRoute = new Elysia()
  // GET /auth/admin/invite-codes - list all invite codes
  .get("/admin/invite-codes", async (ctx) => {
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    return getRepo().inviteCodes.list()
  })

  // POST /auth/admin/invite-codes - create an invite code
  .post("/admin/invite-codes", async (ctx) => {
    const { body } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { name } = body as { name: string }
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "name is required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const code = {
      id: crypto.randomUUID(),
      code: generateInviteCode(),
      name,
      createdAt: new Date().toISOString(),
    }
    await getRepo().inviteCodes.create(code)
    return code
  })

  // DELETE /auth/admin/invite-codes/:id - delete an invite code
  .delete("/admin/invite-codes/:id", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().inviteCodes.delete(params.id)
    return { ok: true }
  })

  // GET /auth/admin/users - list all users
  .get("/admin/users", async (ctx) => {
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const users = await repo.users.list()

    const enriched = await Promise.all(users.map(async (u) => {
      const [accounts, keys, assignments] = await Promise.all([
        repo.github.listAccountsByOwner(u.id),
        repo.apiKeys.listByOwner(u.id),
        repo.keyAssignments.listByUser(u.id),
      ])
      return {
        ...u,
        githubAccounts: accounts.map(a => ({
          id: a.user.id,
          login: a.user.login,
          avatar_url: a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
          account_type: a.accountType,
        })),
        keyCount: keys.length,
        sharedKeyCount: assignments.length,
      }
    }))

    return enriched
  })

  // POST /auth/admin/users/:id/disable - disable a user
  .post("/admin/users/:id/disable", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().users.update(params.id, { disabled: true })
    return { ok: true }
  })

  // POST /auth/admin/users/:id/enable - enable a user
  .post("/admin/users/:id/enable", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().users.update(params.id, { disabled: false })
    return { ok: true }
  })

  // DELETE /auth/admin/users/:id - delete a user and all their data
  .delete("/admin/users/:id", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const userId = params.id

    await repo.sessions.deleteByUserId(userId)
    await repo.inviteCodes.clearUsedBy(userId)
    const keys = await repo.apiKeys.listByOwner(userId)
    for (const k of keys) {
      await repo.apiKeys.delete(k.id)
    }
    const accounts = await repo.github.listAccountsByOwner(userId)
    for (const a of accounts) {
      await repo.github.deleteAccount(a.user.id, userId)
    }
    await repo.github.clearActiveIdForUser(userId)
    await repo.keyAssignments.deleteByUser(userId)
    await repo.observabilityShares.deleteByOwner(userId)
    await repo.observabilityShares.deleteByViewer(userId)
    await repo.users.delete(userId)

    return { ok: true }
  })
