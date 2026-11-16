import { Hono } from "hono"
import { z } from "zod"
import { directFetcher } from "@vibe-core/upstream"
import { addLokiMirror, LokiSyncError, LOKI_MIRROR_ID_PATTERN, LOKI_PROFILE_ID, lokiBaseUrl, lokiMirrorDocument, newLokiMirrorState,
  normalizeLokiStaticModels, parseLokiMirrorDocument, pullLokiMirror, readLokiState, removeLokiMirror,
  type LokiMirrorSource, type LokiState } from "@vibe-llm/provider-loki"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { FullAuthCtx } from "../../shared/credential-auth"
import type { SessionToken } from "../../repo/branded-ids"
import { loadOwned } from "../shared/ownership"
import { serializeUpstream } from "../upstreams/public-dto"
import { boundedJson, json, newBinding, newMirror, publicMirror, safeError, upstreamId } from "./common"
export { lokiSyncRouter } from "./sync"
export { lokiMirrorRouter } from "./mirror"

export const lokiManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const endpoint = z.string().max(2048)
const staticModels = z.array(z.string()).max(256).optional()
const createBody = z.object({ name: z.string().trim().min(1).max(120), baseUrl: endpoint.optional(), staticModels,
  mirror: z.unknown().optional() }).strict()
const mirrorSourceBody = z.object({ mirror: z.unknown() }).strict()
const settingsBody = z.object({ baseUrl: endpoint, staticModels }).strict()
function parseStaticModels(value: unknown): string[] {
  try { return normalizeLokiStaticModels(value) } catch { throw new LokiSyncError("invalid_static_models", 400) }
}
function parseEndpoint(value: unknown): string {
  try { return lokiBaseUrl(value) } catch { throw new LokiSyncError("invalid_endpoint", 400) }
}
const pairing = (origin: string, id: string, state: LokiState, syncSecret: string) => ({
  version: 1, gatewayOrigin: origin, upstreamId: id, profileId: LOKI_PROFILE_ID, generation: state.generation, syncSecret,
})

const mirrorBody = z.object({ label: z.string().trim().min(1).max(64) }).strict()
const mirrorId = z.string().regex(LOKI_MIRROR_ID_PATTERN)

async function ownedLoki(auth: FullAuthCtx, rawId: string) {
  const parsedId = upstreamId.safeParse(rawId)
  if (!parsedId.success) throw new LokiSyncError("upstream_not_found", 404)
  const row = await loadOwned(auth, () => getRepo().upstreams.getById(parsedId.data))
  if (!row || row.provider !== "loki") throw new LokiSyncError("upstream_not_found", 404)
  return { row, id: parsedId.data }
}
/** Mirror management is owner-only: unlike loadOwned, an admin gets no bypass. */
async function ownedLokiStrict(auth: FullAuthCtx, rawId: string) {
  const found = await ownedLoki(auth, rawId)
  if (found.row.ownerId !== auth?.userId) throw new LokiSyncError("upstream_not_found", 404)
  return found
}
/** Validates a document and pulls once. A revoked secret is a client error, an unreachable or misbehaving
 *  central creates nothing, and a central that is merely waiting for its credential is not an error. */
async function mirrorStateFrom(document: unknown): Promise<{ state: LokiState; warning?: "credential_unavailable" }> {
  const source: LokiMirrorSource = parseLokiMirrorDocument(document)
  const now = Date.now()
  const pull = await pullLokiMirror(source, directFetcher, now)
  if (pull.kind === "revoked") throw new LokiSyncError("invalid_mirror", 400)
  if (pull.kind === "failed") throw new LokiSyncError("mirror_unreachable", 502)
  return pull.kind === "ok" ? { state: newLokiMirrorState(source, pull.credential, now) }
    : { state: newLokiMirrorState(source, undefined, now), warning: "credential_unavailable" }
}
const currentState = (state: unknown): LokiState | undefined => { try { return readLokiState(state) } catch { return undefined } }

lokiManagementRouter.use("*", async (c, next) => {
  const auth = c.get("auth")
  if (auth?.authKind !== "session" || !auth.userId || auth.apiKeyId) return json({ error: { code: "session_required" } }, 401)
  const url = new URL(c.req.url)
  const headers = c.req.raw.headers
  const authorization = headers.get("authorization")
  const token = authorization !== null ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
    : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(headers.get("cookie") ?? "")?.[1]
  if (!token || token.length > 4096 || url.search || headers.has("x-api-key") || headers.has("x-goog-api-key")) {
    return json({ error: { code: "session_required" } }, 401)
  }
  const origin = headers.get("origin")
  if ((origin !== null && origin !== url.origin) || (authorization === null && origin === null)) {
    return json({ error: { code: "origin_not_allowed" } }, 403)
  }
  // Legacy user keys share authKind=session; require an actual, current session record.
  const session = await getRepo().sessions.findByToken(token as SessionToken)
  if (!session || session.userId !== auth.userId || !(Date.parse(session.expiresAt) > Date.now())) {
    return json({ error: { code: "session_required" } }, 401)
  }
  await next()
})

lokiManagementRouter.post("/upstreams", async c => {
  try {
    const parsed = createBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const baseUrl = parseEndpoint(parsed.data.baseUrl)
    const models = parseStaticModels(parsed.data.staticModels)
    const auth = c.get("auth")
    let state: LokiState
    let extra: (id: string) => Record<string, unknown>
    if (parsed.data.mirror !== undefined) {
      const fromMirror = await mirrorStateFrom(parsed.data.mirror)
      state = fromMirror.state
      extra = () => (fromMirror.warning ? { warning: fromMirror.warning } : {})
    } else {
      const binding = await newBinding()
      state = binding.state
      extra = id => ({ pairing: pairing(new URL(c.req.url).origin, id, binding.state, binding.syncSecret) })
    }
    const now = new Date().toISOString()
    const id = upstreamId.parse(`up_loki_${crypto.randomUUID().replaceAll("-", "")}`)
    const saved = await getRepo().upstreams.createIfAbsent({
      id, ownerId: auth.userId, provider: "loki", name: parsed.data.name, enabled: true, sortOrder: 0,
      config: { profileId: LOKI_PROFILE_ID, ...(parsed.data.baseUrl === undefined ? {} : { baseUrl }),
        ...(models.length ? { staticModels: models } : {}) },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
      state, createdAt: now, updatedAt: now,
    })
    if (!saved) throw new LokiSyncError("temporarily_unavailable", 503)
    return json({ upstream: serializeUpstream(saved), ...extra(id) }, 201)
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.patch("/upstreams/:id", async c => {
  try {
    const { row } = await ownedLoki(c.get("auth"), c.req.param("id"))
    const repo = getRepo()
    const parsed = settingsBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const baseUrl = parseEndpoint(parsed.data.baseUrl)
    const models = parsed.data.staticModels === undefined ? undefined : parseStaticModels(parsed.data.staticModels)
    // Metadata CAS preserves concurrent token renewal and advances the catalog generation.
    const saved = await repo.upstreams.patchMetadata(row, current => ({
      ...current, config: { ...current.config, baseUrl, ...(models === undefined ? {} : { staticModels: models }) },
    }))
    return json({ upstream: serializeUpstream(saved) })
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.put("/upstreams/:id/mirror-source", async c => {
  try {
    const auth = c.get("auth")
    const first = await ownedLoki(auth, c.req.param("id"))
    if (!currentState(first.row.state)?.source) throw new LokiSyncError("mirror_unsupported", 400)
    const parsed = mirrorSourceBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const { state, warning } = await mirrorStateFrom(parsed.data.mirror)
    // Reload so the compare-and-swap window does not span the network pull.
    const { row } = await ownedLoki(auth, c.req.param("id"))
    if (!currentState(row.state)?.source) throw new LokiSyncError("mirror_unsupported", 400)
    const saved = await getRepo().upstreams.replaceCredentials(row, { config: row.config, state })
    return json({ upstream: serializeUpstream(saved), ...(warning ? { warning } : {}) })
  } catch (error) { return safeError(error) }
})

for (const method of ["POST", "DELETE"] as const) lokiManagementRouter.on(method, "/upstreams/:id/pair", async c => {
  try {
    const { row } = await ownedLoki(c.get("auth"), c.req.param("id"))
    const repo = getRepo()
    const previous = currentState(row.state)
    if (previous?.source) throw new LokiSyncError("mirror_unsupported", 400)
    const { state, syncSecret } = await newBinding()
    if (method === "DELETE") state.syncSecretHash = ""
    else if (previous?.mirrors?.length) state.mirrors = previous.mirrors
    const saved = await repo.upstreams.replaceCredentials(row, { config: row.config, state })
    return json({ upstream: serializeUpstream(saved), ...(method === "POST"
      ? { pairing: pairing(new URL(c.req.url).origin, row.id, state, syncSecret) } : {}) })
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.get("/upstreams/:id/mirrors", async c => {
  try {
    const { row } = await ownedLokiStrict(c.get("auth"), c.req.param("id"))
    return json({ mirrors: (currentState(row.state)?.mirrors ?? []).map(publicMirror) })
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.post("/upstreams/:id/mirrors", async c => {
  try {
    const { row, id } = await ownedLokiStrict(c.get("auth"), c.req.param("id"))
    const origin = new URL(c.req.url)
    // Self-hosted deployments behind a TLS-terminating proxy must preserve the original scheme
    // (same requirement as the pairing gatewayOrigin).
    if (origin.protocol !== "https:") throw new LokiSyncError("https_required", 400)
    const parsed = mirrorBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const { mirror, mirrorSecret } = await newMirror(parsed.data.label, Date.now())
    await getRepo().upstreams.saveState<unknown>(id, current => addLokiMirror(readLokiState(current), mirror), row)
    return json({ mirror: publicMirror(mirror), document: lokiMirrorDocument(origin.origin, id, mirror.id, mirrorSecret) }, 201)
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.delete("/upstreams/:id/mirrors/:mirrorId", async c => {
  try {
    const { row, id } = await ownedLokiStrict(c.get("auth"), c.req.param("id"))
    const parsedMirror = mirrorId.safeParse(c.req.param("mirrorId"))
    if (!parsedMirror.success) throw new LokiSyncError("mirror_not_found", 404)
    let remaining: LokiState["mirrors"]
    await getRepo().upstreams.saveState<unknown>(id, current => {
      const next = removeLokiMirror(readLokiState(current), parsedMirror.data)
      remaining = next.mirrors
      return next
    }, row)
    return json({ mirrors: (remaining ?? []).map(publicMirror) })
  } catch (error) { return safeError(error) }
})
