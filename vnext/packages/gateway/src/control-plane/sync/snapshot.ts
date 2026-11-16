import { Hono } from "hono"
import type { Env } from "../../app"
import { providerPlugin } from "../../data-plane/providers/registry"
import { getRepo } from "../../repo"
import type { StoredUpstreamRecord } from "../../repo/types"
import { SYNC_LAST_SYNC_STAMP_MS, SYNC_VERSION, type SyncedUpstream } from "../../sync/protocol"
import { SyncError, sha256Hex, syncFailure } from "./common"

/** Mounted before session auth: the device secret is the only credential this route knows. */
export const syncSnapshotRouter = new Hono<{ Bindings: Env }>()

const invalidDevice = () => new SyncError("invalid_device", 401)

/** What one upstream contributes, or null when it must not leave this gateway. A throwing sync view omits the upstream. */
function entry(row: StoredUpstreamRecord): SyncedUpstream | null {
  const plugin = providerPlugin(row.provider)
  if (!plugin?.syncable) return null
  try {
    const view = plugin.syncView ? plugin.syncView(row) : { config: row.config, state: row.state }
    return { id: row.id, provider: row.provider, name: row.name, config: view.config, state: view.state ?? null,
      flagOverrides: row.flagOverrides, disabledPublicModelIds: row.disabledPublicModelIds }
  } catch { return null }
}

const matches = (header: string | undefined, etag: string) =>
  header !== undefined && header.split(",").some(value => { const candidate = value.trim(); return candidate === etag || candidate === `W/${etag}` })

syncSnapshotRouter.get("/snapshot", async c => {
  try {
    const secret = /^[Bb][Ee][Aa][Rr][Ee][Rr] (sds_[a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1]
    if (!secret) throw invalidDevice()
    const repo = getRepo()
    const device = await repo.syncDevices.findBySecretHash(await sha256Hex(secret))
    if (!device) throw invalidDevice()
    const owner = await repo.users.getById(device.ownerId)
    if (!owner || owner.disabled) throw invalidDevice()

    // Stale ids are ignored; the central `enabled` flag does not filter (enabled is device-local).
    // One read of the owner's rows. A row synced from another gateway is never re-shared (no chaining).
    const selected = new Set(device.upstreamIds)
    const rows = (await repo.upstreams.list({ ownerId: device.ownerId, includeDisabled: true }))
      .filter(row => selected.has(row.id) && !row.syncSourceId)
    rows.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    const upstreams = rows.flatMap(row => { const item = entry(row); return item ? [item] : [] })
    const body = JSON.stringify({ version: SYNC_VERSION, deviceId: device.id, upstreams })
    const etag = `"${await sha256Hex(body)}"`

    const now = Date.now()
    await repo.syncDevices.touchLastSync(device.id, new Date(now).toISOString(), new Date(now - SYNC_LAST_SYNC_STAMP_MS).toISOString())
      .catch(() => { /* Advisory: a failed stamp never affects the response. */ })
    if (matches(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } })
    return new Response(body, { status: 200, headers: { "content-type": "application/json", etag, "cache-control": "no-store" } })
  } catch (error) { return syncFailure(error) }
})
