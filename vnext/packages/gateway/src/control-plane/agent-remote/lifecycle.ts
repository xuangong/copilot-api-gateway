import { Hono } from "hono"
import { getRepo } from "../../repo/index.ts"
import type { UserId } from "../../repo/branded-ids.ts"
import { agentRemoteConfiguration, type AgentRemoteConfiguration } from "./config.ts"

const encoder = new TextEncoder()
const maxBodyBytes = 8192

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding")
  const result = Buffer.from(value, "base64url")
  if (result.toString("base64url") !== value) throw new Error("Invalid encoding")
  return new Uint8Array(result)
}
export async function continuationHash(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(value))).toString("base64url")
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBodyBytes) return undefined
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > maxBodyBytes) { await reader.cancel(); return undefined }
      chunks.push(result.value)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } finally { reader.releaseLock() }
}
async function verifyServiceProof(config: AgentRemoteConfiguration, authorization: string | undefined, operation: string, body: Uint8Array<ArrayBuffer>) {
  const token = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization ?? "")?.[1]
  if (!token || token.length > 4096) return false
  try {
    const [headerPart, payloadPart, signaturePart, extra] = token.split(".")
    if (!headerPart || !payloadPart || !signaturePart || extra !== undefined) return false
    const header: unknown = JSON.parse(new TextDecoder().decode(decode(headerPart)))
    const claims: unknown = JSON.parse(new TextDecoder().decode(decode(payloadPart)))
    if (!record(header) || header.alg !== "HS256" || header.typ !== "arc-relay-service+jwt" || Object.keys(header).length !== 2 || !record(claims)) return false
    const now = Math.floor(Date.now() / 1000)
    if (claims.iss !== config.target || claims.aud !== config.issuer || claims.op !== operation ||
      typeof claims.iat !== "number" || !Number.isInteger(claims.iat) || claims.iat > now || claims.iat < now - 60 ||
      typeof claims.exp !== "number" || !Number.isInteger(claims.exp) || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60) return false
    const key = await crypto.subtle.importKey("raw", encoder.encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
    if (!await crypto.subtle.verify("HMAC", key, decode(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`))) return false
    return claims.bodyHash === Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("base64url")
  } catch { return false }
}

export const agentRemoteLifecycleRouter = new Hono()
for (const operation of ["renew", "user-status"] as const) {
  agentRemoteLifecycleRouter.post(`/api/agent-remote/${operation}`, async c => {
    c.header("cache-control", "no-store")
    c.header("referrer-policy", "no-referrer")
    // Service proofs must never be combined with ambient browser credentials.
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
      const field = operation === "renew" ? "continuation" : "subject"
      if (!record(body) || Object.keys(body).length !== 1 || typeof body[field] !== "string" || !body[field] ||
        (body[field] as string).length > (operation === "renew" ? 7000 : 256)) return c.json({ error: "Invalid request" }, 400)
      const value = body[field] as string
      const repo = getRepo()
      const now = Date.now()
      if (operation === "user-status") {
        const user = await repo.users.getById(value as UserId)
        if (!user || user.disabled) return c.json({ error: "User access denied" }, 403)
        return c.json({ active: true, subject: user.id, validUntil: now + 120_000 })
      }
      if (!/^arc2_[A-Za-z0-9_-]{43}$/.test(value)) return c.json({ error: "Invalid continuation" }, 401)
      const original = await repo.agentRemoteContinuations.findActive(await continuationHash(value), config.issuer, config.target, now)
      if (!original) return c.json({ error: "Login session expired or revoked" }, 401)
      const { expiresAt, authenticatedAt } = original
      const user = await repo.users.getById(original.subject)
      if (!user || user.disabled) return c.json({ error: "User access denied" }, 403)
      return c.json({ active: true, subject: user.id, profile: { name: user.name, ...(user.email ? { email: user.email } : {}) }, expiresAt, authenticatedAt, validUntil: Math.min(now + 120_000, expiresAt) })
    } catch {
      return c.json({ error: "Agent Remote authority temporarily unavailable" }, 503)
    }
  })
}
