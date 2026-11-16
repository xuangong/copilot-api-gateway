import { Hono } from "hono"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { UserId } from "../../repo/branded-ids"
import type { SyncSourceRecord } from "../../repo/sync"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { connectSource, deviceSyncAvailable, disconnectSource, type ConnectOutcome } from "../../sync/engine"
import { SyncDocumentError, parseSyncDocument, type SyncDocument } from "../../sync/protocol"
import { SyncError, readJsonBody, syncFailure, syncJson } from "./common"

export const syncSourceRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

/** Never includes the secret. */
async function publicSource(source: SyncSourceRecord) {
  return {
    origin: source.origin, deviceId: source.deviceId, status: source.status, lastAttemptAt: source.lastAttemptAt,
    lastSuccessAt: source.lastSuccessAt, lastError: source.lastError,
    upstreamCount: (await getRepo().upstreams.listSynced(source.id)).length,
  }
}

const mayManage = (auth: FullAuthCtx, source: SyncSourceRecord) => auth.isAdmin === true || source.ownerId === auth.userId

async function readDocument(request: Request): Promise<SyncDocument> {
  const body = await readJsonBody(request)
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "document")) {
    throw new SyncError("invalid_request", 400)
  }
  try { return parseSyncDocument((body as { document?: unknown }).document) }
  catch (error) {
    if (error instanceof SyncDocumentError) throw new SyncError("invalid_sync_document", 400)
    throw error
  }
}

function requireAvailable(): void {
  if (!deviceSyncAvailable()) throw new SyncError("device_sync_unavailable", 501)
}

async function respond(outcome: ConnectOutcome, status: number): Promise<Response> {
  switch (outcome.kind) {
    case "connected": return syncJson({ source: await publicSource(outcome.source) }, status)
    case "invalid_document": throw new SyncError("invalid_sync_document", 400)
    case "exists": throw new SyncError("sync_source_exists", 409)
    case "unreachable": throw new SyncError("sync_unreachable", 502)
    case "not_found": throw new SyncError("sync_source_not_found", 404)
  }
}

syncSourceRouter.get("/source", async c => {
  try {
    const source = await getRepo().syncSources.get()
    const visible = source && mayManage(c.get("auth"), source) ? await publicSource(source) : null
    return syncJson({ available: deviceSyncAvailable(), source: visible })
  } catch (error) { return syncFailure(error) }
})

syncSourceRouter.post("/source", async c => {
  try {
    requireAvailable()
    const document = await readDocument(c.req.raw)
    return await respond(await connectSource({ mode: "create", ownerId: c.get("auth").userId as UserId, document }), 201)
  } catch (error) { return syncFailure(error) }
})

syncSourceRouter.put("/source", async c => {
  try {
    requireAvailable()
    const auth = c.get("auth")
    const current = await getRepo().syncSources.get()
    if (!current || !mayManage(auth, current)) throw new SyncError("sync_source_not_found", 404)
    const document = await readDocument(c.req.raw)
    return await respond(await connectSource({ mode: "replace", ownerId: current.ownerId, document }), 200)
  } catch (error) { return syncFailure(error) }
})

syncSourceRouter.delete("/source", async c => {
  try {
    const current = await getRepo().syncSources.get()
    if (!current || !mayManage(c.get("auth"), current)) throw new SyncError("sync_source_not_found", 404)
    if (!(await disconnectSource())) throw new SyncError("sync_source_not_found", 404)
    return syncJson({ source: null })
  } catch (error) { return syncFailure(error) }
})
