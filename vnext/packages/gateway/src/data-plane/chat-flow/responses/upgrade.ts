import type { Context } from "hono"
import type { Env } from "../../../app.ts"
import type { DataPlaneAuthCtx } from "../../models/routes.ts"

const RESPONSES_WEBSOCKET_PATHS = new Set([
  "/responses", "/v1/responses", "/azure-api.codex/responses", "/azure-api.codex/v1/responses",
])

export function hasCompleteWebSocketUpgradeHeaders(request: Request): boolean {
  const connection = request.headers.get("connection") ?? ""
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
    && connection.split(",").some((token) => token.trim().toLowerCase() === "upgrade")
    && !!request.headers.get("sec-websocket-key")
    && request.headers.get("sec-websocket-version") === "13"
}

export function isResponsesWebSocketUpgradeRequest(request: Request): boolean {
  return request.method === "GET"
    && RESPONSES_WEBSOCKET_PATHS.has(new URL(request.url).pathname)
    && hasCompleteWebSocketUpgradeHeaders(request)
}

// Shared Responses ingress seam: a supported transport can replace this
// handler before C12 advertises WebSockets. Until then, authenticated upgrade
// attempts receive the pinned Codex client's immediate HTTP fallback signal.
export function responsesUpgradeHandler(c: Context<{ Bindings: Env }>): Response | Promise<Response> {
  if (!hasCompleteWebSocketUpgradeHeaders(c.req.raw)) return c.notFound()
  const auth = c.get("auth" as never) as DataPlaneAuthCtx | undefined
  if (!auth?.apiKeyId && !auth?.userId) return c.notFound()
  return c.json({
    error: {
      type: "unsupported_transport",
      message: "WebSocket transport is not supported; use HTTP POST /v1/responses.",
    },
  }, 426)
}
