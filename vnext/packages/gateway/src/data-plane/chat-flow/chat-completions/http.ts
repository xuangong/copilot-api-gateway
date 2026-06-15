// packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveChatCompletions } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function chatCompletionsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return serveChatCompletions({ raw, auth, obsCtx: readObsCtx(c, auth), signal: c.req.raw.signal })
}
