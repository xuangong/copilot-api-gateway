import { Hono } from "hono"
import { z } from "zod"
import { LokiSyncError, LOKI_PROFILE_ID, lokiBaseUrl, type LokiState } from "@vibe-llm/provider-loki"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { FullAuthCtx } from "../../shared/credential-auth"
import type { SessionToken } from "../../repo/branded-ids"
import { loadOwned } from "../shared/ownership"
import { serializeUpstream } from "../upstreams/public-dto"
import { boundedJson, json, newBinding, safeError, upstreamId } from "./common"
export { lokiSyncRouter } from "./sync"

export const lokiManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const endpoint = z.string().max(2048)
const createBody = z.object({ name: z.string().trim().min(1).max(120), baseUrl: endpoint.optional() }).strict()
const settingsBody = z.object({ baseUrl: endpoint }).strict()
function parseEndpoint(value: unknown): string {
  try { return lokiBaseUrl(value) } catch { throw new LokiSyncError("invalid_endpoint", 400) }
}
const pairing = (origin: string, id: string, state: LokiState, syncSecret: string) => ({
  version: 1, gatewayOrigin: origin, upstreamId: id, profileId: LOKI_PROFILE_ID, generation: state.generation, syncSecret,
})

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
    const auth = c.get("auth")
    const { state, syncSecret } = await newBinding()
    const now = new Date().toISOString()
    const id = upstreamId.parse(`up_loki_${crypto.randomUUID().replaceAll("-", "")}`)
    const saved = await getRepo().upstreams.createIfAbsent({
      id, ownerId: auth.userId, provider: "loki", name: parsed.data.name, enabled: true, sortOrder: 0,
      config: { profileId: LOKI_PROFILE_ID, ...(parsed.data.baseUrl === undefined ? {} : { baseUrl }) },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
      state, createdAt: now, updatedAt: now,
    })
    if (!saved) throw new LokiSyncError("temporarily_unavailable", 503)
    return json({ upstream: serializeUpstream(saved), pairing: pairing(new URL(c.req.url).origin, id, state, syncSecret) }, 201)
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.patch("/upstreams/:id", async c => {
  try {
    const parsedId = upstreamId.safeParse(c.req.param("id"))
    if (!parsedId.success) throw new LokiSyncError("upstream_not_found", 404)
    const repo = getRepo()
    const row = await loadOwned(c.get("auth"), () => repo.upstreams.getById(parsedId.data))
    if (!row || row.provider !== "loki") throw new LokiSyncError("upstream_not_found", 404)
    const parsed = settingsBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const baseUrl = parseEndpoint(parsed.data.baseUrl)
    // Metadata CAS preserves concurrent token renewal and advances the catalog generation.
    const saved = await repo.upstreams.patchMetadata(row, current => ({
      ...current, config: { ...current.config, baseUrl },
    }))
    return json({ upstream: serializeUpstream(saved) })
  } catch (error) { return safeError(error) }
})

for (const method of ["POST", "DELETE"] as const) lokiManagementRouter.on(method, "/upstreams/:id/pair", async c => {
  try {
    const parsedId = upstreamId.safeParse(c.req.param("id"))
    if (!parsedId.success) throw new LokiSyncError("upstream_not_found", 404)
    const repo = getRepo()
    const row = await loadOwned(c.get("auth"), () => repo.upstreams.getById(parsedId.data))
    if (!row || row.provider !== "loki") throw new LokiSyncError("upstream_not_found", 404)
    const { state, syncSecret } = await newBinding()
    if (method === "DELETE") state.syncSecretHash = ""
    const saved = await repo.upstreams.replaceCredentials(row, { config: row.config, state })
    return json({ upstream: serializeUpstream(saved), ...(method === "POST"
      ? { pairing: pairing(new URL(c.req.url).origin, row.id, state, syncSecret) } : {}) })
  } catch (error) { return safeError(error) }
})
