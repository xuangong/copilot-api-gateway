// packages/gateway/src/data-plane/chat-flow/count-tokens/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveCountTokens } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth } from '../shared/gateway-ctx.ts'
import { openRequestDump, parseJsonBody } from '../shared/dump-open.ts'

export async function countTokensHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = readAuth(c)
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)
  let raw: unknown
  try { raw = parseJsonBody(requestBody.bytes) } catch { return dump ? dump.finalize(invalidJsonResponse()) : invalidJsonResponse() }

  const reqHeaders = c.req.raw.headers
  const forwardedHeaders: Record<string, string> = {}
  const beta = reqHeaders.get('anthropic-beta')
  if (beta) forwardedHeaders['anthropic-beta'] = beta
  const version = reqHeaders.get('anthropic-version')
  if (version) forwardedHeaders['anthropic-version'] = version

  return serveCountTokens({
    raw,
    auth,
    forwardedHeaders,
    signal: c.req.raw.signal,
    dump,
  })
}
