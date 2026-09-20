import { Hono } from "hono"
import { env } from "@vibe-core/platform"
import { getRepo } from "../../repo/index.ts"
import type { UserId } from "../../repo/branded-ids.ts"
import { agentRemoteConfiguration } from "./config.ts"
import { validHostId } from "./control.ts"
import { readBody, verifyServiceProof } from "./lifecycle.ts"

interface HostKeyRequest { subject: string; hostId: string; hostName: string }
function validRequest(value: unknown): value is HostKeyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return Object.keys(body).length === 3 && typeof body.subject === "string" && body.subject.length > 0 && body.subject.length <= 256 &&
    validHostId(body.hostId) && typeof body.hostName === "string" && body.hostName.trim().length > 0 && body.hostName.length <= 256 &&
    [...body.hostName].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
}

export const agentRemoteHostKeysRouter = new Hono()
for (const operation of ["host-key", "revoke-host-key"] as const) {
  agentRemoteHostKeysRouter.post(`/api/agent-remote/${operation}`, async c => {
    c.header("cache-control", "no-store")
    c.header("referrer-policy", "no-referrer")
    if (c.req.header("origin") !== undefined || c.req.header("cookie") !== undefined) return c.json({ error: "Browser credentials are not allowed" }, 403)
    try {
      const config = agentRemoteConfiguration()
      if (!config) return c.json({ error: "Agent Remote is not configured" }, 503)
      const rawBody = await readBody(c.req.raw)
      if (!rawBody) return c.json({ error: "Request is too large" }, 413)
      if (!await verifyServiceProof(config, c.req.header("authorization"), operation, rawBody)) return c.json({ error: "Invalid service proof" }, 401)
      let body: unknown
      try { body = JSON.parse(new TextDecoder().decode(rawBody)) }
      catch { return c.json({ error: "Invalid request" }, 400) }
      if (!validRequest(body)) return c.json({ error: "Invalid request" }, 400)
      const repo = getRepo()
      const user = await repo.users.getById(body.subject as UserId)
      if (!user || user.disabled) return c.json({ error: "User access denied" }, 403)
      const scope = { ownerId: user.id, relay: config.target, hostId: body.hostId }
      if (operation === "revoke-host-key") {
        await repo.apiKeys.revokeAgentHostKey(scope)
        return c.json({ ok: true })
      }
      const model = env("AGENT_REMOTE_CODEX_MODEL") || "gpt-5.6-sol"
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) return c.json({ error: "Agent Remote model is not configured correctly" }, 503)
      const key = await repo.apiKeys.ensureAgentHostKey(scope, body.hostName.trim())
      if (!key) return c.json({ error: "Host key was revoked" }, 410)
      return c.json({ apiKey: key.key, keyId: key.id, baseUrl: `${config.issuer}/v1`, model })
    } catch {
      return c.json({ error: "Agent Remote authority temporarily unavailable" }, 503)
    }
  })
}
