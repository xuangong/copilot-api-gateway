import { Hono } from "hono"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { Env } from "../../app.ts"
import { getRepo } from "../../repo/index.ts"
import type { ApiKeyId, SessionToken, SetupLeaseId, UserId } from "../../repo/branded-ids.ts"
import type { ApiKey, SetupLease, User } from "../../repo/types.ts"
import { ADMIN_EMAILS } from "../../shared/config/constants.ts"
import { currentResponsesWebSocketIngress } from "../../shared/ingress-capability.ts"
import { publicOrigin } from "../auth/utils.ts"
import {
  buildSetupArtifact, canonicalJson, canonicalSettings, MAX_SETUP_BODY_BYTES, redactArtifact,
  setupMintSchema, setupSelectionSchema, sha256, touchedKeys,
} from "./artifact.ts"
import type { SetupSelection } from "./artifact.ts"

const LEASE_TTL_MS = 600_000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const leaseTokenPattern = /^stl_([0-9a-f]{64})$/

class SetupError extends Error {
  constructor(readonly status: ContentfulStatusCode, message: string) { super(message) }
}
const invalid = () => new SetupError(400, "Invalid setup request")
const unavailable = () => new SetupError(410, "Setup lease is no longer available; create a new lease")
const conflict = () => new SetupError(409, "Setup configuration changed; preview again")

function createRouter() {
  const router = new Hono<{ Bindings: Env }>()
  router.onError((error, c) => c.json({ error: error instanceof SetupError ? error.message : "Setup request failed" },
    error instanceof SetupError ? error.status : 500))
  return router
}
export const setupRouter = createRouter()
export const setupExchangeRouter = createRouter()

setupRouter.use("/:id/setup/*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
})
setupExchangeRouter.use("/api/setup/exchange", async (c, next) => {
  c.header("Cache-Control", "no-store")
  c.header("Referrer-Policy", "no-referrer")
  await next()
})

function trustedOrigin(request: Request): string {
  const url = new URL(request.url)
  const candidate = publicOrigin(request, url)
  // Forwarded headers alone are not a trust boundary. Reverse proxies must
  // preserve the public request URL; this slice adds no origin override system.
  // Reject components that URL parsing would normalize away, including an
  // explicit root path, empty query/fragment, and backslash path separators.
  if (!/^https?:\/\/[^/?#\\@\s]+$/i.test(candidate)) throw invalid()
  let parsed: URL
  try { parsed = new URL(candidate) } catch { throw invalid() }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
    !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== url.origin) throw invalid()
  return url.origin
}

function noQuery(request: Request): void {
  if (new URL(request.url).search) throw invalid()
}

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length")
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new SetupError(413, "Setup request is too large")
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => {})
        throw new SetupError(413, "Setup request is too large")
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new SetupError(415, "Setup requires application/json")
  }
  const bytes = await readBody(request, MAX_SETUP_BODY_BYTES)
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { throw invalid() }
}

async function emptyBody(request: Request): Promise<void> {
  const bytes = await readBody(request, MAX_SETUP_BODY_BYTES)
  if (bytes.byteLength !== 0) throw invalid()
}

async function actualSession(request: Request, origin: string): Promise<User> {
  noQuery(request)
  if (request.headers.has("x-api-key") || request.headers.has("x-goog-api-key")) throw new SetupError(401, "A valid user session is required")
  const authorization = request.headers.get("authorization")
  const token = authorization !== null ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
    : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(request.headers.get("cookie") ?? "")?.[1]
  if (!token || token.length > 4096) throw new SetupError(401, "A valid user session is required")
  const suppliedOrigin = request.headers.get("origin")
  if ((suppliedOrigin !== null && suppliedOrigin !== origin) || (authorization === null && suppliedOrigin === null)) {
    throw new SetupError(403, "Origin is not allowed")
  }
  const repo = getRepo()
  const session = await repo.sessions.findByToken(token as SessionToken)
  if (!session || !(Date.parse(session.expiresAt) > Date.now())) throw new SetupError(401, "A valid user session is required")
  const user = await repo.users.getById(session.userId)
  if (!user || user.disabled) throw new SetupError(401, "A valid user session is required")
  return user
}

function isAdmin(user: User): boolean { return !!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()) }

async function allowedKey(id: ApiKeyId, user: User): Promise<ApiKey | null> {
  const repo = getRepo()
  const key = await repo.apiKeys.getById(id)
  if (!key) return null
  if (user.disabled || (key.ownerId !== user.id && !isAdmin(user))) throw new SetupError(403, "Key setup is not allowed")
  if (key.ownerId !== undefined) {
    const owner = await repo.users.getById(key.ownerId)
    if (!owner || owner.disabled) throw new SetupError(403, "Key setup is not allowed")
  }
  return key
}

async function revision(): Promise<number> {
  const read = getRepo().configurationRevision
  if (!read) throw new Error("Setup revision is unavailable")
  return read()
}

async function derive(request: Request, id: ApiKeyId, selection: SetupSelection) {
  const origin = trustedOrigin(request)
  const before = await revision()
  const user = await actualSession(request, origin)
  const key = await allowedKey(id, user)
  if (!key) throw new SetupError(404, "Key not found")
  const envelope = buildSetupArtifact(selection, key.key, origin, currentResponsesWebSocketIngress() !== null)
  const artifactDigest = await sha256(canonicalJson(envelope))
  if (await revision() !== before) throw conflict()
  return { user, key, envelope, artifactDigest, configurationRevision: before }
}

function keyId(c: Context): ApiKeyId {
  const id = c.req.param("id")
  if (!id || id.length > 256 || /[\s/]/.test(id) || Array.from(id).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid()
  return id as ApiKeyId
}

function boundedSettings(selection: SetupSelection): string {
  try { return canonicalSettings(selection) }
  catch { throw invalid() }
}

setupRouter.post("/:id/setup/preview", async c => {
  noQuery(c.req.raw)
  const parsed = setupSelectionSchema.safeParse(await jsonBody(c.req.raw))
  if (!parsed.success) throw invalid()
  boundedSettings(parsed.data)
  const value = await derive(c.req.raw, keyId(c), parsed.data)
  return c.json({ version: value.envelope.version, client: value.envelope.client, platform: value.envelope.platform,
    configurationRevision: value.configurationRevision, artifactDigest: value.artifactDigest,
    redactedArtifact: redactArtifact(value.envelope.artifact), touchedKeys: touchedKeys(value.envelope.artifact) })
})

setupRouter.post("/:id/setup/leases", async c => {
  noQuery(c.req.raw)
  const parsed = setupMintSchema.safeParse(await jsonBody(c.req.raw))
  if (!parsed.success) throw invalid()
  const { expectedConfigurationRevision, expectedArtifactDigest, ...input } = parsed.data
  const selection = setupSelectionSchema.parse(input)
  const settingsJson = boundedSettings(selection)
  const id = keyId(c)
  const value = await derive(c.req.raw, id, selection)
  if (value.configurationRevision !== expectedConfigurationRevision || value.artifactDigest !== expectedArtifactDigest) throw conflict()
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = "stl_" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
  const now = Date.now()
  const lease: SetupLease = {
    id: crypto.randomUUID() as SetupLeaseId, tokenHash: await sha256(bytes), minterUserId: value.user.id,
    keyId: id, keyOwnerId: value.key.ownerId ?? null, client: selection.client, platform: selection.platform,
    settingsJson, configurationRevision: value.configurationRevision, keyFingerprint: await sha256(value.key.key),
    artifactDigest: value.artifactDigest, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + LEASE_TTL_MS).toISOString(),
    consumedAt: null, revokedAt: null,
  }
  const beforeInsert = await derive(c.req.raw, id, selection)
  if (beforeInsert.configurationRevision !== lease.configurationRevision || beforeInsert.artifactDigest !== lease.artifactDigest) throw conflict()
  await getRepo().setupLeases.create(lease)
  try {
    const afterInsert = await derive(c.req.raw, id, selection)
    if (afterInsert.configurationRevision !== lease.configurationRevision || afterInsert.artifactDigest !== lease.artifactDigest) throw conflict()
  } catch (error) {
    await getRepo().setupLeases.revoke(lease.id, id, new Date().toISOString())
    if (error instanceof SetupError) throw conflict()
    throw error
  }
  return c.json({ leaseId: lease.id, leaseToken: token, expiresAt: lease.expiresAt, artifactDigest: lease.artifactDigest }, 201)
})

setupRouter.delete("/:id/setup/leases/:leaseId", async c => {
  noQuery(c.req.raw)
  await emptyBody(c.req.raw)
  const leaseId = c.req.param("leaseId")
  if (!uuid.test(leaseId)) throw invalid()
  const origin = trustedOrigin(c.req.raw)
  const user = await actualSession(c.req.raw, origin)
  const id = keyId(c)
  if (!await allowedKey(id, user)) throw new SetupError(404, "Key not found")
  const lease = await getRepo().setupLeases.findById(leaseId as SetupLeaseId)
  if (!lease || lease.keyId !== id) throw new SetupError(404, "Setup lease not found")
  await getRepo().setupLeases.revoke(lease.id, id, new Date().toISOString())
  return c.json({ ok: true })
})

async function currentMinter(id: UserId): Promise<User> {
  const minter = await getRepo().users.getById(id)
  if (!minter || minter.disabled) throw unavailable()
  return minter
}

setupExchangeRouter.post("/api/setup/exchange", async c => {
  noQuery(c.req.raw)
  await emptyBody(c.req.raw)
  const origin = trustedOrigin(c.req.raw)
  const suppliedOrigin = c.req.header("origin")
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) throw new SetupError(403, "Origin is not allowed")
  const match = leaseTokenPattern.exec(c.req.header("X-Setup-Lease") ?? "")
  const hex = match?.[1]
  if (!hex) throw new SetupError(401, "A valid setup lease is required")
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16))
  const repo = getRepo()
  const lease = await repo.setupLeases.findByTokenHash(await sha256(bytes))
  if (!lease) throw new SetupError(401, "A valid setup lease is required")
  try {
    if (lease.consumedAt !== null || lease.revokedAt !== null || !(Date.parse(lease.expiresAt) > Date.now())) throw unavailable()
    const minter = await currentMinter(lease.minterUserId)
    const key = await allowedKey(lease.keyId, minter)
    if (!key || (key.ownerId ?? null) !== lease.keyOwnerId || await sha256(key.key) !== lease.keyFingerprint) throw unavailable()
    if (await revision() !== lease.configurationRevision) throw unavailable()
    let settings: unknown
    try { settings = JSON.parse(lease.settingsJson) as unknown }
    catch { throw unavailable() }
    const parsed = setupSelectionSchema.safeParse({ client: lease.client, platform: lease.platform, settings })
    if (!parsed.success) throw unavailable()
    const selection = parsed.data
    if (boundedSettings(selection) !== lease.settingsJson) throw unavailable()
    const envelope = buildSetupArtifact(selection, key.key, origin, currentResponsesWebSocketIngress() !== null)
    if (await sha256(canonicalJson(envelope)) !== lease.artifactDigest) throw unavailable()
    if (!await repo.setupLeases.consume(lease, key.key, new Date().toISOString(), ADMIN_EMAILS)) throw unavailable()
    return c.json({ ...envelope, artifactDigest: lease.artifactDigest })
  } catch (error) {
    // A failed redemption is not replayable after a deployment/authority repair.
    await repo.setupLeases.revoke(lease.id, lease.keyId, new Date().toISOString())
    if (error instanceof SetupError) throw unavailable()
    throw error
  }
})
