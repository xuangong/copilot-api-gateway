import { Hono } from "hono"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import { TelemetryError, readBoundedJson, sha256Hex, telemetryClock, telemetryFailure, telemetryJson } from "./common"
import { PUSH_KEY_PATTERN, PUSH_LIMITS, parsePushBody } from "./protocol"

/** Mounted before session auth: the push key is the only credential this route knows. */
export const telemetryPushRouter = new Hono<{ Bindings: Env }>()

const invalidKey = () => new TelemetryError("invalid_key", 401)

telemetryPushRouter.post("/push", async c => {
  try {
    const key = /^[Bb][Ee][Aa][Rr][Ee][Rr] (tlm_[a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1]
    if (!key || !PUSH_KEY_PATTERN.test(key)) throw invalidKey()
    const repo = getRepo()
    const source = await repo.telemetry.findSourceByKeyHash(await sha256Hex(key))
    if (!source) throw invalidKey()
    const owner = await repo.users.getById(source.ownerId)
    if (!owner || owner.disabled) throw invalidKey()

    // Authenticated: only now is the body read.
    const now = telemetryClock.now()
    const points = parsePushBody(await readBoundedJson(c.req.raw, PUSH_LIMITS.bodyBytes), now)
    if (!(await repo.telemetry.replaceHours(source.id, points, new Date(now).toISOString()))) throw invalidKey()
    return telemetryJson({ accepted: points.length })
  } catch (error) { return telemetryFailure(error) }
})

// Any other method answers here, so a credential-less probe never falls through to session auth and its caching rules.
telemetryPushRouter.all("/push", () => telemetryJson({ error: { code: "method_not_allowed" } }, 405, { allow: "POST" }))
