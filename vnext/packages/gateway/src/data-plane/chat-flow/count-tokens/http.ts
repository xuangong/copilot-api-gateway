// packages/gateway/src/data-plane/chat-flow/count-tokens/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveCountTokens } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth } from '../shared/gateway-ctx.ts'

export async function countTokensHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  const reqHeaders = c.req.raw.headers
  const forwardedHeaders: Record<string, string> = {}
  const beta = reqHeaders.get('anthropic-beta')
  if (beta) forwardedHeaders['anthropic-beta'] = beta
  const version = reqHeaders.get('anthropic-version')
  if (version) forwardedHeaders['anthropic-version'] = version

  return serveCountTokens({
    raw,
    auth: readAuth(c),
    forwardedHeaders,
    signal: c.req.raw.signal,
  })
}
