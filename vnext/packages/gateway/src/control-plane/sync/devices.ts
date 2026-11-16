import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../../app"
import { isSyncableProvider } from "../../data-plane/providers/registry"
import { getRepo } from "../../repo"
import type { UpstreamId, UserId } from "../../repo/branded-ids"
import type { SyncDeviceRecord } from "../../repo/sync"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { SYNC_DEVICE_ID_PATTERN, SYNC_MAX_DEVICES_PER_OWNER, SYNC_MAX_DEVICE_UPSTREAMS, syncDocument } from "../../sync/protocol"
import { SyncError, randomHex, readJsonBody, sha256Hex, syncFailure, syncJson } from "./common"

export const syncDevicesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const label = z.string().trim().min(1).max(64)
const upstreamIds = z.array(z.string().min(1).max(256)).max(SYNC_MAX_DEVICE_UPSTREAMS)
const createBody = z.object({ label, upstreamIds }).strict()
const patchBody = z.object({ label: label.optional(), upstreamIds: upstreamIds.optional() }).strict()
  .refine(body => body.label !== undefined || body.upstreamIds !== undefined)

const publicDevice = (device: SyncDeviceRecord) => ({
  id: device.id, label: device.label, upstreamIds: device.upstreamIds, createdAt: device.createdAt, lastSyncAt: device.lastSyncAt,
})

async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJsonBody(request))
  if (!parsed.success) throw new SyncError("invalid_request", 400)
  return parsed.data
}

/** Every id must be an upstream the caller owns whose provider is syncable. Administrators get no override. */
async function selection(ownerId: UserId, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)]
  for (const id of unique) {
    const row = await getRepo().upstreams.getById(id as UpstreamId)
    if (!row || row.ownerId !== ownerId || !isSyncableProvider(row.provider)) throw new SyncError("invalid_upstreams", 400)
  }
  return unique
}

/** The caller's device, or 404: another owner's device is indistinguishable from a missing one. */
async function ownedDevice(ownerId: UserId, id: string): Promise<SyncDeviceRecord> {
  const device = SYNC_DEVICE_ID_PATTERN.test(id) ? await getRepo().syncDevices.getById(id) : null
  if (!device || device.ownerId !== ownerId) throw new SyncError("device_not_found", 404)
  return device
}

syncDevicesRouter.get("/devices", async c => {
  try {
    const devices = await getRepo().syncDevices.listByOwner(c.get("auth").userId as UserId)
    return syncJson({ devices: devices.map(publicDevice) })
  } catch (error) { return syncFailure(error) }
})

syncDevicesRouter.post("/devices", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const url = new URL(c.req.url)
    // Behind a TLS-terminating proxy the original scheme must be preserved, or the document would name a dead origin.
    if (url.protocol !== "https:") throw new SyncError("https_required", 400)
    const body = await parseBody(c.req.raw, createBody)
    const ids = await selection(ownerId, body.upstreamIds)
    const secret = `sds_${randomHex(32)}`
    const device: SyncDeviceRecord = {
      id: `sdv_${randomHex(16)}`, ownerId, label: body.label, secretHash: await sha256Hex(secret), upstreamIds: ids,
      createdAt: new Date().toISOString(), lastSyncAt: null,
    }
    if (!(await getRepo().syncDevices.createWithinLimit(device, SYNC_MAX_DEVICES_PER_OWNER))) throw new SyncError("device_limit", 409)
    return syncJson({ device: publicDevice(device), document: syncDocument(url.origin, device.id, secret) }, 201)
  } catch (error) { return syncFailure(error) }
})

syncDevicesRouter.patch("/devices/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedDevice(ownerId, c.req.param("id"))
    const body = await parseBody(c.req.raw, patchBody)
    const ids = body.upstreamIds === undefined ? undefined : await selection(ownerId, body.upstreamIds)
    const updated = await getRepo().syncDevices.update(existing.id, ownerId, { label: body.label, upstreamIds: ids })
    if (!updated) throw new SyncError("device_not_found", 404)
    return syncJson({ device: publicDevice(updated) })
  } catch (error) { return syncFailure(error) }
})

syncDevicesRouter.delete("/devices/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedDevice(ownerId, c.req.param("id"))
    if (!(await getRepo().syncDevices.delete(existing.id, ownerId))) throw new SyncError("device_not_found", 404)
    return syncJson({ devices: (await getRepo().syncDevices.listByOwner(ownerId)).map(publicDevice) })
  } catch (error) { return syncFailure(error) }
})
