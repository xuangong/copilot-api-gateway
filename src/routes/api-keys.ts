import { Elysia } from "elysia"
import {
  createApiKey,
  listApiKeys,
  getApiKeyById,
  renameApiKey,
  rotateApiKey,
  deleteApiKey,
  type ApiKey,
} from "~/lib/api-keys"

function keyToJson(k: ApiKey) {
  return { id: k.id, name: k.name, key: k.key, created_at: k.createdAt, last_used_at: k.lastUsedAt ?? null }
}

interface AuthCtx {
  isAdmin?: boolean
  apiKeyId?: string
}

export const apiKeysRoute = new Elysia({ prefix: "/api/keys" })
  // GET /api/keys - list API keys
  // Admin: all keys; API key user: only their own key
  .get("/", async (ctx) => {
    const { isAdmin, apiKeyId } = ctx as unknown as AuthCtx

    if (isAdmin) {
      const keys = await listApiKeys()
      return keys.map(keyToJson)
    }

    // Non-admin: return only the caller's own key
    if (apiKeyId) {
      const key = await getApiKeyById(apiKeyId)
      return key ? [keyToJson(key)] : []
    }

    return []
  })

  // POST /api/keys - create a new API key (admin only)
  .post("/", async ({ body }) => {
    const { name } = body as { name: string }
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "name is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const key = await createApiKey(name)
    return keyToJson(key)
  })

  // GET /api/keys/:id - get a specific API key
  .get("/:id", async ({ params }) => {
    const key = await getApiKeyById(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return keyToJson(key)
  })

  // PATCH /api/keys/:id - rename an API key (admin only)
  .patch("/:id", async ({ params, body }) => {
    const { name } = body as { name: string }
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "name is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const key = await renameApiKey(params.id, name)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return keyToJson(key)
  })

  // POST /api/keys/:id/rotate - rotate an API key (admin only)
  .post("/:id/rotate", async ({ params }) => {
    const key = await rotateApiKey(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return keyToJson(key)
  })

  // DELETE /api/keys/:id - delete an API key (admin only)
  .delete("/:id", async ({ params }) => {
    const deleted = await deleteApiKey(params.id)
    if (!deleted) {
      return new Response(JSON.stringify({ error: "Key not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return { ok: true }
  })
