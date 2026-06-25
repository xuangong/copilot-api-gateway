// packages/gateway/src/data-plane/chat-flow/gemini/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveGemini } from './serve.ts'
import { serveGeminiCountTokens } from './count-tokens.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

// Gemini→Copilot model aliasing (parity with root src/routes/gemini.ts).
// Copilot's catalog doesn't publish gemini-2.5-* SKUs; route them to the
// closest available `gemini-3-flash-preview` so /v1beta/models requests
// don't 404 on the default Gemini SDK model id.
const GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-2.5-flash-lite': 'gemini-3-flash-preview',
  'gemini-2.5-flash': 'gemini-3-flash-preview',
}

function remapGeminiModel(raw: string): string {
  // Strip Gemini CLI suffixes like "-customtools" (parity with root).
  const stripped = raw.replace(/-customtools$/, '')
  return GEMINI_MODEL_MAP[stripped] ?? stripped
}

export async function geminiHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawParam = c.req.param('model') ?? ''
  const [rawModel, verb] = rawParam.split(':')
  const model = remapGeminiModel(rawModel ?? '')

  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)

  if (verb === 'countTokens') {
    return serveGeminiCountTokens({
      raw,
      model,
      auth,
      signal: c.req.raw.signal,
    })
  }

  return serveGemini({
    raw,
    model,
    forceStream: verb === 'streamGenerateContent',
    auth,
    obsCtx: readObsCtx(c, auth),
    signal: c.req.raw.signal,
  })
}
