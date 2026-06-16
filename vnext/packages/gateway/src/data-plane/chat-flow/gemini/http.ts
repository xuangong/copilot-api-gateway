// packages/gateway/src/data-plane/chat-flow/gemini/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveGemini } from './serve.ts'
import { serveGeminiCountTokens } from './count-tokens.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function geminiHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawParam = c.req.param('model')
  const [model, verb] = rawParam.split(':')

  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)

  if (verb === 'countTokens') {
    return serveGeminiCountTokens({
      raw,
      model: model ?? '',
      auth,
      signal: c.req.raw.signal,
    })
  }

  return serveGemini({
    raw,
    model: model ?? '',
    forceStream: verb === 'streamGenerateContent',
    auth,
    obsCtx: readObsCtx(c, auth),
    signal: c.req.raw.signal,
  })
}
