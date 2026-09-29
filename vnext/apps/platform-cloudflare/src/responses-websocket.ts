import { withBackground, type BackgroundExecutor } from "@vibe-core/platform"
import { withResponsesWebSocketIngress } from "@vibe-llm/gateway/ingress-capability"
import {
  authorizeResponsesSession,
  ConfigurationUnavailableError,
  createResponsesSession,
  isResponsesWebSocketUpgradeRequest,
  ResponsesSessionError,
  RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES,
} from "@vibe-llm/gateway/responses-session"
import type { CloudflareEnv } from "./bootstrap.ts"

interface ResponsesApp {
  fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Response | Promise<Response>
}

function upgradeFailure(error: unknown): Response {
  if (error instanceof ResponsesSessionError) {
    return Response.json({
      error: {
        type: error.status === 401 ? "authentication_error" : "invalid_request_error",
        code: error.code,
        message: error.message,
      },
    }, { status: error.status })
  }
  if (error instanceof ConfigurationUnavailableError) {
    return Response.json({ error: { type: "api_error", message: "Gateway configuration temporarily unavailable." } }, { status: 503 })
  }
  return Response.json({ error: { type: "api_error", message: "WebSocket upgrade failed." } }, { status: 500 })
}

export function createResponsesWebSocketHandler({ app }: { readonly app: ResponsesApp }) {
  return async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    const background: BackgroundExecutor = { waitUntil: promise => ctx.waitUntil(promise) }
    if (!isResponsesWebSocketUpgradeRequest(request)) {
      return withBackground(background, () => withResponsesWebSocketIngress(
        { maxConnectionOutboundBytes: RESPONSES_WS_UNOBSERVABLE_LIFETIME_BYTES },
        () => app.fetch(request, env, ctx),
      ))
    }

    try {
      const authorization = await withBackground(background, () => authorizeResponsesSession(request))
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      let closeSent = false
      const closeNative = (code: number, reason: string): void => {
        if (closeSent || server.readyState === WebSocket.CLOSED) return
        closeSent = true
        server.close(code, reason)
      }
      const session = createResponsesSession({
        authorization,
        request: { url: request.url, headers: new Headers(request.headers) },
        background,
        transport: {
          pressure: { kind: "unobservable" },
          sendText(text) {
            if (closeSent || server.readyState !== WebSocket.OPEN) return "failed"
            try {
              server.send(text)
              return "accepted"
            } catch { return "failed" }
          },
          close: closeNative,
        },
      })
      const closeSession = (reason: Error): void => {
        const completion = session.close(reason)
        // Register cleanup in the original connection context before returning
        // from the native event. Workerd can end a disconnected request soon after.
        background.waitUntil(completion)
        void completion.catch(() => {})
        if (server.readyState === WebSocket.CLOSING) {
          try { closeNative(1000, "Response session closed.") } catch { /* The peer may have disconnected. */ }
        }
      }
      server.addEventListener("message", event => {
        withBackground(background, () => {
          try {
            if (typeof event.data === "string") session.receiveText(event.data)
            else session.receiveBinary()
          } catch {
            closeSession(new Error("Native WebSocket message failed."))
          }
        })
      })
      server.addEventListener("close", () => {
        withBackground(background, () => closeSession(new Error("Native WebSocket disconnected.")))
      })
      server.addEventListener("error", () => {
        withBackground(background, () => closeSession(new Error("Native WebSocket error.")))
      })
      server.accept()
      return new Response(null, { status: 101, webSocket: client })
    } catch (error) {
      return upgradeFailure(error)
    }
  }
}
