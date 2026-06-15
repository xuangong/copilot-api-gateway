// packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { handleResponsesImageGeneration } from '../../orchestrator/server-tools/plugins/image-generation/index.ts'

export async function invokeResponsesImageGenerationShortcut(
  c: Context<{ Bindings: Env }>,
  raw: unknown,
): Promise<Response> {
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  return handleResponsesImageGeneration(
    {
      userId: auth.userId,
      copilot: auth.copilot,
      apiKeyId: auth.apiKeyId,
      requestId: c.req.header('x-request-id') ?? undefined,
      userAgent: c.req.header('user-agent') ?? undefined,
    },
    raw as Parameters<typeof handleResponsesImageGeneration>[1],
  )
}
