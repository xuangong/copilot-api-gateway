import type { Context } from "hono"
import type { Env } from "../../../app.ts"
import type { DataPlaneAuthCtx } from "../../models/routes.ts"

function isWebSocketUpgrade(c: Context<{ Bindings: Env }>): boolean {
  const connection = c.req.header("connection") ?? ""
  return c.req.header("upgrade")?.toLowerCase() === "websocket"
    && connection.split(",").some((token) => token.trim().toLowerCase() === "upgrade")
    && !!c.req.header("sec-websocket-key")
    && c.req.header("sec-websocket-version") === "13"
}

// Shared Responses ingress seam: a supported transport can replace this
// handler before C12 advertises WebSockets. Until then, authenticated upgrade
// attempts receive the pinned Codex client's immediate HTTP fallback signal.
export function responsesUpgradeHandler(c: Context<{ Bindings: Env }>): Response | Promise<Response> {
  if (!isWebSocketUpgrade(c)) return c.notFound()
  const auth = c.get("auth" as never) as DataPlaneAuthCtx | undefined
  if (!auth?.apiKeyId && !auth?.userId) return c.notFound()
  return c.json({
    error: {
      type: "unsupported_transport",
      message: "WebSocket transport is not supported; use HTTP POST /v1/responses.",
    },
  }, 426)
}
