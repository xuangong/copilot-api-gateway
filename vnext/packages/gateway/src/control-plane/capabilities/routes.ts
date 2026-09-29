import { Hono } from "hono"
import type { Env } from "../../app.ts"
import type { FullAuthCtx } from "../auth/session-auth.ts"
import { currentResponsesWebSocketIngress } from "../../shared/ingress-capability.ts"

export const capabilitiesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

capabilitiesRouter.get("/capabilities", c => {
  const auth = c.get("auth")
  if (!auth?.userId && !auth?.apiKeyId && !auth?.isAdmin) {
    return c.json({ error: "Unauthorized" }, 401, { "Cache-Control": "no-store" })
  }
  const ingress = currentResponsesWebSocketIngress()
  return c.json({ codex: { responsesWebSocket: {
    available: ingress !== null,
    mode: "single_turn",
    multiplex: false,
    fork: false,
    reconnectHistory: false,
    maxConnectionOutboundBytes: ingress?.maxConnectionOutboundBytes ?? null,
  } } }, 200, { "Cache-Control": "no-store" })
})
