import { Elysia } from "elysia"
import {
  createApiKey,
  listApiKeys,
  listApiKeysByOwner,
  getApiKeyById,
  renameApiKey,
  rotateApiKey,
  deleteApiKey,
  type ApiKey,
} from "~/lib/api-keys"
import { getRepo } from "~/repo"

function maskKey(key?: string): string | null {
  if (!key) return null
  if (key.length <= 8) return "****"
  return key.slice(0, 4) + "****" + key.slice(-4)
}

function keyToJson(k: ApiKey, ownerName?: string, isOwner?: boolean) {
  return { id: k.id, name: k.name, key: k.key, created_at: k.createdAt, last_used_at: k.lastUsedAt ?? null, owner_id: k.ownerId ?? null, owner_name: ownerName ?? null, is_owner: isOwner ?? true, quota_requests_per_day: k.quotaRequestsPerDay ?? null, quota_tokens_per_day: k.quotaTokensPerDay ?? null, web_search_enabled: k.webSearchEnabled ?? false, web_search_bing_enabled: k.webSearchBingEnabled ?? false, web_search_langsearch_key: maskKey(k.webSearchLangsearchKey), web_search_tavily_key: maskKey(k.webSearchTavilyKey) }
}

interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  apiKeyId?: string
  userId?: string
}

async function checkOwnership(keyId: string, ctx: AuthCtx): Promise<boolean> {
  if (ctx.isAdmin) return true
  if (!ctx.userId) return false
  const key = await getApiKeyById(keyId)
  return key?.ownerId === ctx.userId
}

export const apiKeysRoute = new Elysia({ prefix: "/api/keys" })
  // GET /api/keys - list API keys
  // Admin: all keys; User: only their own keys
  .get("/", async (ctx) => {
    const { isAdmin, isUser, apiKeyId, userId } = ctx as unknown as AuthCtx
    const repo = getRepo()

    if (isAdmin) {
      const keys = await listApiKeys()
      const ownerIds = [...new Set(keys.map(k => k.ownerId).filter(Boolean))] as string[]
      const ownerMap = new Map<string, string>()
      await Promise.all(ownerIds.map(async (id) => {
        const user = await repo.users.getById(id)
        if (user) ownerMap.set(id, user.name)
      }))
      // Fetch assignees for all keys
      const allAssignments = await Promise.all(keys.map(k => repo.keyAssignments.listByKey(k.id)))
      const assigneeUserIds = new Set<string>()
      for (const aList of allAssignments) {
        for (const a of aList) assigneeUserIds.add(a.userId)
      }
      const assigneeNameMap = new Map<string, string>()
      if (assigneeUserIds.size > 0) {
        const assigneeUsers = await Promise.all([...assigneeUserIds].map(id => repo.users.getById(id)))
        for (const u of assigneeUsers) {
          if (u) assigneeNameMap.set(u.id, u.name)
        }
      }
      return keys.map((k, i) => {
        const json = keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined, true)
        const assignees = allAssignments[i]!.map(a => ({
          user_id: a.userId,
          user_name: assigneeNameMap.get(a.userId) ?? null,
        }))
        return { ...json, assignees }
      })
    }

    // User: own keys + assigned keys
    if (isUser && userId) {
      const [ownKeys, assignments] = await Promise.all([
        listApiKeysByOwner(userId),
        repo.keyAssignments.listByUser(userId),
      ])

      // For owned keys, fetch assignees
      const ownKeyAssignments = await Promise.all(ownKeys.map(k => repo.keyAssignments.listByKey(k.id)))
      const assigneeUserIds = new Set<string>()
      for (const aList of ownKeyAssignments) {
        for (const a of aList) assigneeUserIds.add(a.userId)
      }
      const assigneeNameMap = new Map<string, string>()
      if (assigneeUserIds.size > 0) {
        const assigneeUsers = await Promise.all([...assigneeUserIds].map(id => repo.users.getById(id)))
        for (const u of assigneeUsers) {
          if (u) assigneeNameMap.set(u.id, u.name)
        }
      }

      const result = ownKeys.map((k, i) => {
        const json = keyToJson(k, undefined, true)
        const assignees = ownKeyAssignments[i]!.map(a => ({
          user_id: a.userId,
          user_name: assigneeNameMap.get(a.userId) ?? null,
        }))
        return { ...json, assignees }
      })

      if (assignments.length > 0) {
        const assignedKeys = await Promise.all(assignments.map(a => getApiKeyById(a.keyId)))
        const ownerIds = [...new Set(assignedKeys.filter(Boolean).map(k => k!.ownerId).filter(Boolean))] as string[]
        const ownerMap = new Map<string, string>()
        await Promise.all(ownerIds.map(async (id) => {
          const user = await repo.users.getById(id)
          if (user) ownerMap.set(id, user.name)
        }))
        for (const k of assignedKeys) {
          if (k && !ownKeys.some(o => o.id === k.id)) {
            result.push({ ...keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined, false), assignees: [] })
          }
        }
      }

      return result
    }

    // Legacy API key user (no owner): return only the caller's own key
    if (apiKeyId) {
      const key = await getApiKeyById(apiKeyId)
      return key ? [keyToJson(key)] : []
    }

    return []
  })

  // POST /api/keys - create a new API key
  // Admin: creates unowned key; User: creates key bound to themselves
  .post("/", async (ctx) => {
    const { body } = ctx
    const { isAdmin, isUser, userId } = ctx as unknown as AuthCtx
    const { name } = body as { name: string }
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "name is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const ownerId = isUser && userId ? userId : undefined
    const key = await createApiKey(name, ownerId)
    return keyToJson(key)
  })

  // GET /api/keys/:id - get a specific API key
  .get("/:id", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    const key = await getApiKeyById(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (!authCtx.isAdmin && key.ownerId !== authCtx.userId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    }
    return keyToJson(key)
  })

  // PATCH /api/keys/:id - rename an API key or update quota
  .patch("/:id", async (ctx) => {
    const { params, body } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!(await checkOwnership(params.id, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { name, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_bing_enabled, web_search_langsearch_key, web_search_tavily_key } = body as { name?: string; quota_requests_per_day?: number | null; quota_tokens_per_day?: number | null; web_search_enabled?: boolean; web_search_bing_enabled?: boolean; web_search_langsearch_key?: string | null; web_search_tavily_key?: string | null }
    const existing = await getApiKeyById(params.id)
    if (!existing) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    const updated = { ...existing }
    if (name !== undefined) {
      if (!name || typeof name !== "string") {
        return new Response(JSON.stringify({ error: "name must be a non-empty string" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }
      updated.name = name
    }
    if (quota_requests_per_day !== undefined) {
      updated.quotaRequestsPerDay = quota_requests_per_day === null ? undefined : quota_requests_per_day
    }
    if (quota_tokens_per_day !== undefined) {
      updated.quotaTokensPerDay = quota_tokens_per_day === null ? undefined : quota_tokens_per_day
    }
    if (web_search_enabled !== undefined) {
      updated.webSearchEnabled = web_search_enabled
    }
    if (web_search_bing_enabled !== undefined) {
      updated.webSearchBingEnabled = web_search_bing_enabled
    }
    if (web_search_langsearch_key !== undefined) {
      updated.webSearchLangsearchKey = web_search_langsearch_key === null ? undefined : web_search_langsearch_key
    }
    if (web_search_tavily_key !== undefined) {
      updated.webSearchTavilyKey = web_search_tavily_key === null ? undefined : web_search_tavily_key
    }
    await getRepo().apiKeys.save(updated)
    return keyToJson(updated)
  })

  // POST /api/keys/:id/rotate - rotate an API key
  .post("/:id/rotate", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!(await checkOwnership(params.id, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const key = await rotateApiKey(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return keyToJson(key)
  })

  // DELETE /api/keys/:id - delete an API key
  .delete("/:id", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!(await checkOwnership(params.id, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const deleted = await deleteApiKey(params.id)
    if (!deleted) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    await getRepo().keyAssignments.deleteByKey(params.id)
    return { ok: true }
  })

  // GET /api/keys/:id/web-search-usage - get web search usage for a key
  .get("/:id/web-search-usage", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!(await checkOwnership(params.id, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const now = new Date()
    const todayStart = now.toISOString().slice(0, 10) + "T00"
    const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + "T00"
    const records = await getRepo().webSearchUsage.query({ keyId: params.id, start: todayStart, end: tomorrowStart })
    let searches = 0, successes = 0, failures = 0
    for (const r of records) {
      searches += r.searches
      successes += r.successes
      failures += r.failures
    }
    return { searches, successes, failures, records }
  })

  // POST /api/keys/:id/assign - assign key to a user (admin or key owner)
  // Body: { user_id?: string, email?: string }  (exactly one required)
  .post("/:id/assign", async (ctx) => {
    const { params, body } = ctx
    const authCtx = ctx as unknown as AuthCtx
    const key = await getApiKeyById(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    const isOwner = !!authCtx.userId && key.ownerId === authCtx.userId
    if (!authCtx.isAdmin && !isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { user_id, email } = (body ?? {}) as { user_id?: string; email?: string }
    if (!user_id && !email) {
      return new Response(JSON.stringify({ error: "user_id or email is required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    let targetUser = null as Awaited<ReturnType<typeof repo.users.getById>>
    if (user_id) {
      targetUser = await repo.users.getById(user_id)
      if (!targetUser) {
        return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
      }
    } else if (email) {
      targetUser = await repo.users.findByEmail(email.trim().toLowerCase())
      if (!targetUser) {
        return new Response(JSON.stringify({ error: "No user with that email" }), { status: 404, headers: { "Content-Type": "application/json" } })
      }
    }
    if (!targetUser) {
      return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    if (targetUser.id === key.ownerId) {
      return new Response(JSON.stringify({ error: "Cannot share key with yourself" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const existing = await repo.keyAssignments.listByKey(params.id)
    if (existing.some(a => a.userId === targetUser!.id)) {
      return new Response(JSON.stringify({ error: "Already shared with this user" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    await repo.keyAssignments.assign(params.id, targetUser.id, authCtx.userId || "admin")
    return { ok: true }
  })

  // DELETE /api/keys/:id/assign/:userId - unassign key from a user (admin or key owner)
  .delete("/:id/assign/:userId", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    const key = await getApiKeyById(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    const isOwner = !!authCtx.userId && key.ownerId === authCtx.userId
    if (!authCtx.isAdmin && !isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().keyAssignments.unassign(params.id, params.userId)
    return { ok: true }
  })

  // GET /api/keys/:id/assignments - list assignments for a key (admin or key owner)
  .get("/:id/assignments", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!authCtx.isAdmin) {
      // Allow key owner to see assignments
      if (!authCtx.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
      }
      const key = await getApiKeyById(params.id)
      if (!key || key.ownerId !== authCtx.userId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
      }
    }
    const repo = getRepo()
    const assignments = await repo.keyAssignments.listByKey(params.id)
    const users = await Promise.all(assignments.map(a => repo.users.getById(a.userId)))
    return assignments.map((a, i) => ({
      key_id: a.keyId,
      user_id: a.userId,
      user_name: users[i]?.name ?? null,
      assigned_by: a.assignedBy,
      assigned_at: a.assignedAt,
    }))
  })

  // POST /api/keys/:id/copy-web-search-from/:sourceId - copy web search config from another key
  .post("/:id/copy-web-search-from/:sourceId", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!(await checkOwnership(params.id, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    if (!(await checkOwnership(params.sourceId, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden: no access to source key" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const target = await getApiKeyById(params.id)
    const source = await getApiKeyById(params.sourceId)
    if (!target || !source) {
      return new Response(JSON.stringify({ error: "Key not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    const updated = {
      ...target,
      webSearchEnabled: source.webSearchEnabled,
      webSearchBingEnabled: source.webSearchBingEnabled,
      webSearchLangsearchKey: source.webSearchLangsearchKey,
      webSearchTavilyKey: source.webSearchTavilyKey,
    }
    await getRepo().apiKeys.save(updated)
    return keyToJson(updated)
  })
