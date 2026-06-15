// packages/gateway/src/data-plane/chat-flow/gemini/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveGemini } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function geminiHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawParam = c.req.param('model')
  const [model, verb] = rawParam.split(':')
  const forceStream = verb === 'streamGenerateContent'

  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return serveGemini({
    raw,
    model: model ?? '',
    forceStream,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
}
