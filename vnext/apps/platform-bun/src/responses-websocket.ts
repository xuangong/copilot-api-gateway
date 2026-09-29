import type { BackgroundExecutor } from "@vibe-core/platform"
import { withResponsesWebSocketIngress } from "@vibe-llm/gateway/ingress-capability"
import {
  authorizeResponsesSession,
  createResponsesSession,
  ConfigurationUnavailableError,
  isResponsesWebSocketUpgradeRequest,
  ResponsesSessionError,
  RESPONSES_WS_MAX_INBOUND_BYTES,
  RESPONSES_WS_SEND_HIGH_WATER_BYTES,
  type ResponsesSession,
  type ResponsesSessionAuthorization,
} from "@vibe-llm/gateway/responses-session"

interface ResponsesApp {
  fetch(request: Request): Response | Promise<Response>
}

interface SocketData {
  readonly authorization: ResponsesSessionAuthorization
  readonly request: { readonly url: string; readonly headers: Headers }
  session?: ResponsesSession
  nativeClosed: boolean
}

function upgradeFailure(error: unknown): Response {
  if (error instanceof ResponsesSessionError) {
    return Response.json({ error: { type: error.status === 401 ? "authentication_error" : "invalid_request_error", code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof ConfigurationUnavailableError) {
    return Response.json({ error: { type: "api_error", message: "Gateway configuration temporarily unavailable." } }, { status: 503 })
  }
  return Response.json({ error: { type: "api_error", message: "WebSocket upgrade failed." } }, { status: 500 })
}

export function createResponsesWebSocketHandlers({ app }: { readonly app: ResponsesApp }) {
  return {
    async fetch(request: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
      if (!isResponsesWebSocketUpgradeRequest(request)) {
        if (new URL(request.url).pathname.startsWith("/v1/")) server.timeout(request, 0)
        return withResponsesWebSocketIngress({ maxConnectionOutboundBytes: null }, () => app.fetch(request))
      }
      try {
        const authorization = await authorizeResponsesSession(request)
        const data: SocketData = {
          authorization,
          request: { url: request.url, headers: new Headers(request.headers) },
          nativeClosed: false,
        }
        if (!server.upgrade(request, { data })) {
          return Response.json({ error: { type: "invalid_request_error", message: "WebSocket upgrade failed." } }, { status: 400 })
        }
        return undefined
      } catch (error) {
        return upgradeFailure(error)
      }
    },
    websocket: {
      maxPayloadLength: RESPONSES_WS_MAX_INBOUND_BYTES,
      backpressureLimit: RESPONSES_WS_SEND_HIGH_WATER_BYTES,
      closeOnBackpressureLimit: false,
      // Quiet model generation can exceed Bun's default 120-second socket idle timer.
      idleTimeout: 0,
      open(ws: Bun.ServerWebSocket<SocketData>) {
        const data = ws.data
        try {
          const background: BackgroundExecutor = {
            waitUntil(promise) { void promise.catch(() => {}) },
          }
          data.session = createResponsesSession({
            authorization: data.authorization,
            request: data.request,
            background,
            transport: {
              pressure: { kind: "observable", bufferedBytes: () => ws.getBufferedAmount() },
              sendText(text) {
                const sent = ws.send(text)
                return sent > 0 ? "accepted" : sent === -1 ? "backpressured" : "failed"
              },
              close(code, reason) {
                if (data.nativeClosed) return
                ws.close(code, reason)
              },
            },
          })
        } catch {
          data.nativeClosed = true
          ws.close(1011, "Response session unavailable.")
        }
      },
      message(ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer<ArrayBuffer>) {
        const session = ws.data.session
        if (!session) { ws.close(1011, "Response session unavailable."); return }
        try {
          if (typeof message === "string") session.receiveText(message)
          else session.receiveBinary()
        } catch (error) { void session.close(error).catch(() => {}) }
      },
      drain(ws: Bun.ServerWebSocket<SocketData>) { ws.data.session?.drain() },
      close(ws: Bun.ServerWebSocket<SocketData>) {
        ws.data.nativeClosed = true
        const session = ws.data.session
        if (session) void session.close(new Error("Native WebSocket disconnected.")).catch(() => {})
      },
    },
  }
}
