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

interface RefDescriptor {
  id: string
  name: string | null
  owner_id: string | null
  broken: true | undefined
}

/**
 * Build the GET-shape ref descriptor for a borrowed engine key. If the
 * source still exists, returns { id, name, owner_id }. If not, returns
 * { id, name: null, owner_id: null, broken: true }. Caller passes the
 * pre-loaded source map to avoid N+1 lookups.
 */
function refDescriptor(refId: string, sourceMap: Map<string, ApiKey>): RefDescriptor {
  const src = sourceMap.get(refId)
  if (!src) return { id: refId, name: null, owner_id: null, broken: true }
  return { id: refId, name: src.name, owner_id: src.ownerId ?? null, broken: undefined }
}

/**
 * Load the source map for a given API key's web search references.
 * Fetches all referenced engine keys (langsearch, tavily, ms-grounding) in parallel.
 */
async function loadSourceMapForKey(k: ApiKey): Promise<Map<string, ApiKey>> {
  const map = new Map<string, ApiKey>()
  for (const refId of [k.webSearchLangsearchRef, k.webSearchTavilyRef, k.webSearchMsGroundingRef]) {
    if (refId) {
      const s = await getApiKeyById(refId)
      if (s) map.set(refId, s)
    }
  }
  return map
}

function keyToJson(k: ApiKey, ownerName?: string, isOwner?: boolean, sourceMap?: Map<string, ApiKey>) {
  const map = sourceMap ?? new Map<string, ApiKey>()
  const langsearchRef = k.webSearchLangsearchRef ? refDescriptor(k.webSearchLangsearchRef, map) : null
  const tavilyRef = k.webSearchTavilyRef ? refDescriptor(k.webSearchTavilyRef, map) : null
  const msGroundingRef = k.webSearchMsGroundingRef ? refDescriptor(k.webSearchMsGroundingRef, map) : null
  return {
    id: k.id, name: k.name, key: k.key, created_at: k.createdAt,
    last_used_at: k.lastUsedAt ?? null, owner_id: k.ownerId ?? null,
    owner_name: ownerName ?? null, is_owner: isOwner ?? true,
    quota_requests_per_day: k.quotaRequestsPerDay ?? null,
    quota_tokens_per_day: k.quotaTokensPerDay ?? null,
    web_search_enabled: k.webSearchEnabled ?? false,
    web_search_bing_enabled: k.webSearchBingEnabled ?? false,
    web_search_langsearch_key: langsearchRef ? null : maskKey(k.webSearchLangsearchKey),
    web_search_langsearch_ref: langsearchRef,
    web_search_tavily_key: tavilyRef ? null : maskKey(k.webSearchTavilyKey),
    web_search_tavily_ref: tavilyRef,
    web_search_ms_grounding_key: msGroundingRef ? null : maskKey(k.webSearchMsGroundingKey),
    web_search_ms_grounding_ref: msGroundingRef,
    web_search_copilot_enabled: k.webSearchCopilotEnabled ?? false,
    web_search_copilot_priority: k.webSearchCopilotPriority ?? false,
    web_search_priority: k.webSearchPriority ?? null,
  }
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
      const refIds = new Set<string>()
      for (const k of keys) {
        if (k.webSearchLangsearchRef) refIds.add(k.webSearchLangsearchRef)
        if (k.webSearchTavilyRef) refIds.add(k.webSearchTavilyRef)
        if (k.webSearchMsGroundingRef) refIds.add(k.webSearchMsGroundingRef)
      }
      const sourceMap = new Map<string, ApiKey>()
      await Promise.all([...refIds].map(async (id) => {
        const src = await getApiKeyById(id)
        if (src) sourceMap.set(id, src)
      }))
      return keys.map((k, i) => {
        const json = keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined, true, sourceMap)
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

      const ownRefIds = new Set<string>()
      for (const k of ownKeys) {
        if (k.webSearchLangsearchRef) ownRefIds.add(k.webSearchLangsearchRef)
        if (k.webSearchTavilyRef) ownRefIds.add(k.webSearchTavilyRef)
        if (k.webSearchMsGroundingRef) ownRefIds.add(k.webSearchMsGroundingRef)
      }
      const ownSourceMap = new Map<string, ApiKey>()
      await Promise.all([...ownRefIds].map(async (id) => {
        const src = await getApiKeyById(id)
        if (src) ownSourceMap.set(id, src)
      }))

      const result = ownKeys.map((k, i) => {
        const json = keyToJson(k, undefined, true, ownSourceMap)
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
        const assignedRefIds = new Set<string>()
        for (const k of assignedKeys) {
          if (!k) continue
          if (k.webSearchLangsearchRef) assignedRefIds.add(k.webSearchLangsearchRef)
          if (k.webSearchTavilyRef) assignedRefIds.add(k.webSearchTavilyRef)
          if (k.webSearchMsGroundingRef) assignedRefIds.add(k.webSearchMsGroundingRef)
        }
        const assignedSourceMap = new Map<string, ApiKey>()
        await Promise.all([...assignedRefIds].map(async (id) => {
          const src = await getApiKeyById(id)
          if (src) assignedSourceMap.set(id, src)
        }))
        for (const k of assignedKeys) {
          if (k && !ownKeys.some(o => o.id === k.id)) {
            result.push({ ...keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined, false, assignedSourceMap), assignees: [] })
          }
        }
      }

      return result
    }

    // Legacy API key user (no owner): return only the caller's own key
    if (apiKeyId) {
      const key = await getApiKeyById(apiKeyId)
      if (!key) return []
      const sourceMap = await loadSourceMapForKey(key)
      return [keyToJson(key, undefined, true, sourceMap)]
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
    return keyToJson(key, undefined, true, new Map())
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
    const sourceMap = await loadSourceMapForKey(key)
    return keyToJson(key, undefined, true, sourceMap)
  })

  // PATCH /api/keys/:id - rename an API key or update quota
  .patch("/:id", async (ctx) => {
    const { params, body } = ctx
    const authCtx = ctx as unknown as AuthCtx
    if (!(await checkOwnership(params.id, authCtx))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { name, quota_requests_per_day, quota_tokens_per_day, web_search_enabled, web_search_bing_enabled, web_search_langsearch_key, web_search_tavily_key, web_search_copilot_enabled, web_search_copilot_priority } = body as { name?: string; quota_requests_per_day?: number | null; quota_tokens_per_day?: number | null; web_search_enabled?: boolean; web_search_bing_enabled?: boolean; web_search_langsearch_key?: string | null; web_search_tavily_key?: string | null; web_search_copilot_enabled?: boolean; web_search_copilot_priority?: boolean }
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
    if (web_search_copilot_enabled !== undefined) {
      updated.webSearchCopilotEnabled = web_search_copilot_enabled
    }
    if (web_search_copilot_priority !== undefined) {
      updated.webSearchCopilotPriority = web_search_copilot_priority
    }
    await getRepo().apiKeys.save(updated)
    const sourceMap = await loadSourceMapForKey(updated)
    return keyToJson(updated, undefined, true, sourceMap)
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
    const sourceMap = await loadSourceMapForKey(key)
    return keyToJson(key, undefined, true, sourceMap)
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
      webSearchCopilotEnabled: source.webSearchCopilotEnabled,
      webSearchCopilotPriority: source.webSearchCopilotPriority,
    }
    await getRepo().apiKeys.save(updated)
    const sourceMap = await loadSourceMapForKey(updated)
    return keyToJson(updated, undefined, true, sourceMap)
  })
