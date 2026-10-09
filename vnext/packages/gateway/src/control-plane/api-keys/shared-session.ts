import type { Hono } from "hono"
import type { Env } from "../../app"
import type { AuthCtx } from "./routes"
import type { ApiKeyId } from "../../repo/branded-ids"
import { getRepo } from "../../repo"
import { normalizeSharedSessionSecret } from "../../repo/shared-session-secret"

export function mountSharedSessionRoutes(router: Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>): void {
  const owned = async (rawId: string, auth: AuthCtx) => {
    if (auth.apiKeyId || auth.authKind === "apiKey") return null
    const key = await getRepo().apiKeys.getById(rawId as ApiKeyId)
    return key?.ownerId && (auth.isAdmin || auth.userId === key.ownerId) ? key : null
  }
  router.put("/:id/shared-session", async c => {
    c.header("Cache-Control", "no-store")
    const key = await owned(c.req.param("id"), c.get("auth") ?? {})
    if (!key?.ownerId) return c.json({ error: "Forbidden" }, 403)
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid shared session configuration" }, 400)
    const input = body as Record<string, unknown>
    if (Object.keys(input).some(k => k !== "enabled" && k !== "secret") || typeof input.enabled !== "boolean") return c.json({ error: "Invalid shared session configuration" }, 400)
    const secret = Object.hasOwn(input, "secret") ? normalizeSharedSessionSecret(input.secret) : undefined
    if (secret === null) return c.json({ error: "Secret must be 64 hexadecimal characters" }, 400)
    const saved = await getRepo().apiKeys.setSharedSessionConfig(key.id, key.ownerId, { enabled: input.enabled, ...(secret === undefined ? {} : { secret }) })
    if (!saved) return c.json({ error: "A secret is required to enable shared sessions" }, 400)
    return c.json({ enabled: input.enabled })
  })
  router.get("/:id/shared-session/secret", async c => {
    c.header("Cache-Control", "no-store")
    const key = await owned(c.req.param("id"), c.get("auth") ?? {})
    if (!key?.ownerId) return c.json({ error: "Forbidden" }, 403)
    const config = await getRepo().apiKeys.getSharedSessionConfig(key.id, key.ownerId)
    return c.json({ secret: config?.secret ?? null })
  })
}
