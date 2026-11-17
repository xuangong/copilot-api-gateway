import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { UserId } from "../../repo/branded-ids"
import type { TelemetrySourceRecord } from "../../repo/telemetry"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { installCommand } from "./agent-release"
import { TelemetryError, randomHex, readBoundedJson, sha256Hex, telemetryClock, telemetryFailure, telemetryJson } from "./common"
import { MAX_SOURCES_PER_OWNER, SETTINGS_MAX_BYTES, SOURCE_ID_PATTERN, settingsSchema } from "./protocol"

export const telemetrySourcesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const name = z.string().trim().min(1).max(64)
const createBody = z.object({ name }).strict()
const patchBody = z.object({ name: name.optional(), settings: settingsSchema.optional() }).strict()
  .refine(body => body.name !== undefined || body.settings !== undefined)

export const publicSource = (source: TelemetrySourceRecord) => ({
  id: source.id, name: source.name, createdAt: source.createdAt, lastPushAt: source.lastPushAt, settings: source.settings,
})

async function parseBody<S extends z.ZodType>(request: Request, schema: S, maxBytes = 65_536): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readBoundedJson(request, maxBytes))
  if (!parsed.success) throw new TelemetryError("invalid_request", 400)
  return parsed.data
}

/** The caller's source, or 404: another owner's source is indistinguishable from a missing one. Administrators get no override. */
export async function ownedSource(ownerId: UserId, id: string): Promise<TelemetrySourceRecord> {
  const source = SOURCE_ID_PATTERN.test(id) ? await getRepo().telemetry.getSource(id) : null
  if (!source || source.ownerId !== ownerId) throw new TelemetryError("source_not_found", 404)
  return source
}

/** Behind a TLS-terminating proxy the original scheme must be preserved, or the install command would name a dead origin. */
function secureOrigin(requestUrl: string): string {
  const url = new URL(requestUrl)
  if (url.protocol !== "https:") throw new TelemetryError("https_required", 400)
  return url.origin
}

telemetrySourcesRouter.get("/sources", async c => {
  try {
    const sources = await getRepo().telemetry.listSources(c.get("auth").userId as UserId)
    return telemetryJson({ sources: sources.map(publicSource) })
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.post("/sources", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const origin = secureOrigin(c.req.url)
    const body = await parseBody(c.req.raw, createBody)
    const key = `tlm_${randomHex(32)}`
    const source: TelemetrySourceRecord = {
      id: `tls_${randomHex(16)}`, ownerId, name: body.name, keyHash: await sha256Hex(key), settings: {},
      createdAt: new Date(telemetryClock.now()).toISOString(), lastPushAt: null,
    }
    if (!(await getRepo().telemetry.createSourceWithinLimit(source, MAX_SOURCES_PER_OWNER))) throw new TelemetryError("source_limit", 409)
    return telemetryJson({ source: publicSource(source), key, install: installCommand(origin, key) }, 201)
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.patch("/sources/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedSource(ownerId, c.req.param("id"))
    const body = await parseBody(c.req.raw, patchBody)
    if (body.settings !== undefined && new TextEncoder().encode(JSON.stringify(body.settings)).length > SETTINGS_MAX_BYTES) {
      throw new TelemetryError("invalid_request", 400)
    }
    const updated = await getRepo().telemetry.updateSource(existing.id, ownerId, { name: body.name, settings: body.settings })
    if (!updated) throw new TelemetryError("source_not_found", 404)
    return telemetryJson({ source: publicSource(updated) })
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.post("/sources/:id/rotate-key", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const origin = secureOrigin(c.req.url)
    const existing = await ownedSource(ownerId, c.req.param("id"))
    const key = `tlm_${randomHex(32)}`
    if (!(await getRepo().telemetry.rotateKey(existing.id, ownerId, await sha256Hex(key)))) throw new TelemetryError("source_not_found", 404)
    return telemetryJson({ key, install: installCommand(origin, key) })
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.delete("/sources/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedSource(ownerId, c.req.param("id"))
    if (!(await getRepo().telemetry.deleteSource(existing.id, ownerId))) throw new TelemetryError("source_not_found", 404)
    return telemetryJson({ sources: (await getRepo().telemetry.listSources(ownerId)).map(publicSource) })
  } catch (error) { return telemetryFailure(error) }
})
