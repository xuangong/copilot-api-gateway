import { Hono } from "hono"
import { applyLokiSyncUpdate, LokiSyncError, parseLokiSyncUpdate, readLokiState } from "@vibe-llm/provider-loki"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import { boundedJson, digest, safeError, statusResponse, upstreamId, ownerId } from "./common"

export const lokiSyncRouter = new Hono<{ Bindings: Env }>()

for (const method of ["GET", "POST"] as const) lokiSyncRouter.on(method, "/sync/:id", async c => {
  try {
    const raw = c.req.header("authorization")?.match(/^Bearer (lks_[a-f0-9]{64})$/i)?.[1]
    const parsedId = upstreamId.safeParse(c.req.param("id"))
    if (!raw || !parsedId.success) throw new LokiSyncError("invalid_binding", 401)
    const secretHash = await digest(raw)
    const repo = getRepo()
    const row = await repo.upstreams.getById(parsedId.data)
    if (!row || row.provider !== "loki") throw new LokiSyncError("invalid_binding", 401)
    let state
    try { state = readLokiState(row.state) } catch { throw new LokiSyncError("invalid_binding", 401) }
    if (!state.syncSecretHash || state.syncSecretHash !== secretHash) throw new LokiSyncError("invalid_binding", 401)
    if (!row.ownerId) throw new LokiSyncError("invalid_binding", 401)
    const owner = await repo.users.getById(ownerId.parse(row.ownerId))
    if (!owner || owner.disabled) throw new LokiSyncError("invalid_binding", 401)
    if (method === "GET") return statusResponse(state)
    const update = parseLokiSyncUpdate(await boundedJson(c.req.raw))
    const payloadHash = await digest(JSON.stringify(update))
    const now = Date.now()
    await repo.upstreams.saveState<unknown>(parsedId.data, current => {
      const latest = readLokiState(current)
      if (latest.syncSecretHash !== secretHash) throw new LokiSyncError("invalid_binding", 401)
      return applyLokiSyncUpdate(latest, update, payloadHash, now)
    }, row)
    const saved = await repo.upstreams.getById(parsedId.data)
    if (!saved || saved.rowIncarnation !== row.rowIncarnation || saved.ownerId !== row.ownerId
      || saved.provider !== "loki") throw new LokiSyncError("binding_replaced", 409)
    const latest = readLokiState(saved.state)
    if (latest.syncSecretHash !== secretHash || latest.generation !== state.generation) throw new LokiSyncError("binding_replaced", 409)
    return statusResponse(latest)
  } catch (error) { return safeError(error) }
})
