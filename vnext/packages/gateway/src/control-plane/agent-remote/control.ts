import { Hono, type Context } from "hono"
import { getRepo } from "../../repo/index.ts"
import { agentRemoteConfiguration, type AgentRemoteConfiguration } from "./config.ts"
import { userSession } from "./user-session.ts"

type Operation = "hosts" | "shares" | "share" | "revoke-share"
interface ControlRequest {
  subject: string
  operation: Operation
  hostId?: string
  targetSubject?: string
  targetLabel?: string
  sessionLimit?: number
}
const encoder = new TextEncoder()
export function validHostId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)
}

async function relayControl(config: AgentRemoteConfiguration, body: ControlRequest) {
  const raw = JSON.stringify(body)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const iat = Math.floor(Date.now() / 1000)
  const header = encode({ alg: "HS256", typ: "arc-gateway-service+jwt" })
  const payload = encode({ iss: config.issuer, aud: config.target, op: "control",
    bodyHash: Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(raw))).toString("base64url"), iat, exp: iat + 60, jti: crypto.randomUUID() })
  const input = `${header}.${payload}`
  const key = await crypto.subtle.importKey("raw", encoder.encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(input))).toString("base64url")
  return fetch(`${config.target}/gateway/control`, {
    method: "POST", headers: { authorization: `Bearer ${input}.${signature}`, "content-type": "application/json" },
    body: raw, redirect: "manual", signal: AbortSignal.timeout(10_000),
  })
}

async function mutationBody(request: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > 1024) return undefined
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 1024) { await reader.cancel(); return undefined }
      chunks.push(next.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
  finally { reader.releaseLock() }
}

async function control(c: Context, operation: Operation) {
  try {
    const config = agentRemoteConfiguration()
    if (!config) return c.json({ error: "Agent Remote is not configured" }, 503)
    const caller = await userSession(c.req.raw)
    if (!caller) return c.json({ error: "An active user login session is required" }, 401)
    const origin = c.req.header("origin")
    if (origin !== undefined && origin !== config.issuer) return c.json({ error: "Origin is not allowed" }, 403)
    const body: ControlRequest = { subject: caller.user.id, operation }
    if (operation !== "hosts") {
      const hostId = c.req.param("hostId")
      if (!validHostId(hostId)) return c.json({ error: "Invalid Host" }, 400)
      body.hostId = hostId
    }
    if (operation === "share" || operation === "revoke-share") {
      if (!origin && !c.req.header("authorization")) return c.json({ error: "Origin is required" }, 403)
      if (c.req.header("content-type")?.split(";")[0] !== "application/json") return c.json({ error: "JSON is required" }, 415)
      const input = await mutationBody(c.req.raw)
      const fields = operation === "share" ? ["email", "sessionLimit"] : ["email"]
      if (!input || Object.keys(input).some(key => !fields.includes(key)) || typeof input.email !== "string" ||
        input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return c.json({ error: "An existing user email is required" }, 400)
      if (operation === "share" && (typeof input.sessionLimit !== "number" || !Number.isSafeInteger(input.sessionLimit) || input.sessionLimit < 0 || input.sessionLimit > 10_000)) return c.json({ error: "Session limit must be a whole number from 0 to 10000" }, 400)
      // Resolve recipients from the authoritative directory, never from browser subjects or a cached user view.
      const recipient = await getRepo().users.findByEmail(input.email.trim().toLowerCase())
      if (!recipient) return c.json({ error: "No existing user has this email" }, 404)
      if (recipient.id === caller.user.id) return c.json({ error: "A Host owner already has access" }, 400)
      if (operation === "share" && recipient.disabled) return c.json({ error: "This user is disabled" }, 400)
      body.targetSubject = recipient.id
      if (operation === "share") {
        body.targetLabel = recipient.email
        body.sessionLimit = input.sessionLimit as number
      }
    }
    const response = await relayControl(config, body)
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 403) return c.json({ error: "Only the Host owner can manage sharing" }, 403)
      if (response.status === 404) return c.json({ error: "Host or share was not found" }, 404)
      if (response.status === 400) return c.json({ error: "Relay rejected the sharing request" }, 400)
      if (response.status === 409) return c.json({ error: "Host sharing changed; refresh and try again" }, 409)
      return c.json({ error: "Agent Remote is temporarily unavailable" }, 503)
    }
    return c.json(await response.json())
  } catch {
    return c.json({ error: "Agent Remote is temporarily unavailable" }, 503)
  }
}

export const agentRemoteControlRouter = new Hono()
agentRemoteControlRouter.get("/api/agent-remote/hosts", c => control(c, "hosts"))
agentRemoteControlRouter.get("/api/agent-remote/hosts/:hostId/shares", c => control(c, "shares"))
agentRemoteControlRouter.put("/api/agent-remote/hosts/:hostId/shares", c => control(c, "share"))
agentRemoteControlRouter.delete("/api/agent-remote/hosts/:hostId/shares", c => control(c, "revoke-share"))
