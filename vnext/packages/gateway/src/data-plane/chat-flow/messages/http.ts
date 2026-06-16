// packages/gateway/src/data-plane/chat-flow/messages/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { hasWebSearch } from '../../orchestrator/server-tools/plugins/web-search/index.ts'
import { invokeMessagesWebSearchShortcut } from './web-search-shortcut.ts'
import { serveMessages } from './serve.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function messagesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }

  if (hasWebSearch(raw as Parameters<typeof hasWebSearch>[0])) {
    return invokeMessagesWebSearchShortcut(c, raw)
  }

  const auth = readAuth(c)
  return serveMessages({ raw, auth, obsCtx: readObsCtx(c, auth), signal: c.req.raw.signal })
}
