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

function keyToJson(k: ApiKey, ownerName?: string) {
  return { id: k.id, name: k.name, key: k.key, created_at: k.createdAt, last_used_at: k.lastUsedAt ?? null, owner_id: k.ownerId ?? null, owner_name: ownerName ?? null, quota_requests_per_day: k.quotaRequestsPerDay ?? null, quota_tokens_per_day: k.quotaTokensPerDay ?? null }
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

    if (isAdmin) {
      const keys = await listApiKeys()
      const repo = getRepo()
      const ownerIds = [...new Set(keys.map(k => k.ownerId).filter(Boolean))] as string[]
      const ownerMap = new Map<string, string>()
      await Promise.all(ownerIds.map(async (id) => {
        const user = await repo.users.getById(id)
        if (user) ownerMap.set(id, user.name)
      }))
      return keys.map(k => keyToJson(k, k.ownerId ? ownerMap.get(k.ownerId) : undefined))
    }

    // User: return their own keys
    if (isUser && userId) {
      const keys = await listApiKeysByOwner(userId)
      return keys.map(keyToJson)
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
    const { name, quota_requests_per_day, quota_tokens_per_day } = body as { name?: string; quota_requests_per_day?: number | null; quota_tokens_per_day?: number | null }
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
    return { ok: true }
  })
