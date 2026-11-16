import { Hono } from "hono"
import { LOKI_MIN_CREDENTIAL_TTL_MS, LokiSyncError, readLokiState, touchLokiMirror } from "@vibe-llm/provider-loki"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import { digest, json, ownerId, safeError, upstreamId } from "./common"

const PULL_STAMP_INTERVAL_MS = 10 * 60 * 1000

export const lokiMirrorRouter = new Hono<{ Bindings: Env }>()

lokiMirrorRouter.get("/mirror/:id", async c => {
  try {
    const invalid = () => new LokiSyncError("invalid_mirror", 401)
    const raw = c.req.header("authorization")?.match(/^Bearer (lkm_[a-f0-9]{64})$/)?.[1]
    const parsedId = upstreamId.safeParse(c.req.param("id"))
    if (!raw || !parsedId.success) throw invalid()
    const secretHash = await digest(raw)
    const repo = getRepo()
    const row = await repo.upstreams.getById(parsedId.data)
    if (!row || row.provider !== "loki" || !row.ownerId) throw invalid()
    let state
    try { state = readLokiState(row.state) } catch { throw invalid() }
    const mirror = state.mirrors?.find(entry => entry.secretHash === secretHash)
    if (!mirror) throw invalid()
    const owner = await repo.users.getById(ownerId.parse(row.ownerId))
    if (!owner || owner.disabled) throw invalid()
    const now = Date.now()
    const credential = state.credential
    if (!credential || credential.expiresAt <= now + LOKI_MIN_CREDENTIAL_TTL_MS) throw new LokiSyncError("credential_unavailable", 503)
    if (mirror.lastPulledAt === undefined || now - mirror.lastPulledAt >= PULL_STAMP_INTERVAL_MS) {
      await repo.upstreams.saveState<unknown>(parsedId.data, current => touchLokiMirror(readLokiState(current), mirror.id, now), row)
        .catch(() => { /* The stamp is advisory; the pull still succeeds. */ })
    }
    return json({ version: 1, profileId: state.profileId, mirrorId: mirror.id, credential })
  } catch (error) { return safeError(error) }
})
