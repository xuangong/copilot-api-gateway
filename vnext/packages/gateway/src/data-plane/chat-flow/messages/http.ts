// packages/gateway/src/data-plane/chat-flow/messages/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveMessages } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'
import { openRequestDump, parseJsonBody } from '../shared/dump-open.ts'

export async function messagesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = readAuth(c)
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)
  let raw: unknown
  try { raw = parseJsonBody(requestBody.bytes) } catch { return dump ? dump.finalize(invalidJsonResponse()) : invalidJsonResponse() }
  return serveMessages({ raw, auth, obsCtx: readObsCtx(c, auth), signal: c.req.raw.signal, dump })
}
