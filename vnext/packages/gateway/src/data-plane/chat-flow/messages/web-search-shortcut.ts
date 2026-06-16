import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { handleMessagesWebSearch } from '../../orchestrator/server-tools/plugins/web-search/index.ts'

export async function invokeMessagesWebSearchShortcut(
  c: Context<{ Bindings: Env }>,
  raw: unknown,
): Promise<Response> {
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  if (!auth.copilot?.copilotToken || !auth.githubToken) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Copilot/GitHub credentials required for web search.' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
  }
  return handleMessagesWebSearch(
    {
      copilot: auth.copilot,
      githubToken: auth.githubToken,
      msGroundingKey: auth.msGroundingKey,
      apiKeyId: auth.apiKeyId,
      requestId: c.req.header('x-request-id') ?? undefined,
      userAgent: c.req.header('user-agent') ?? undefined,
    },
    raw as Parameters<typeof handleMessagesWebSearch>[1],
  )
}
