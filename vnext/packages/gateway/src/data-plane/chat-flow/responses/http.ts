import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { hasImageGeneration } from '../../orchestrator/server-tools/plugins/image-generation/index.ts'
import { invokeResponsesImageGenerationShortcut } from './image-generation-shortcut.ts'
import { serveResponses } from './serve.ts'
import { attachStreamSidecar, attachNonStreamSidecar } from './snapshot-sidecar.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function responsesHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const rawObj = raw as { tools?: Array<Record<string, unknown>> } | null
  if (rawObj && hasImageGeneration(rawObj.tools as Parameters<typeof hasImageGeneration>[0])) {
    return invokeResponsesImageGenerationShortcut(c, raw)
  }
  const auth = readAuth(c)
  const obsCtx = readObsCtx(c, auth)
  const { response, mergedInputItems } = await serveResponses({ raw, auth, obsCtx })
  if (response.status !== 200) return response
  const ct = response.headers.get('content-type') ?? ''
  const fallbackModel = (raw as { model?: string }).model ?? ''
  const apiKeyId = auth.apiKeyId ?? null
  const requestId = obsCtx.requestId ?? null
  if (ct.includes('text/event-stream') && response.body) {
    return attachStreamSidecar({ c, response, fallbackModel, apiKeyId, requestId, mergedInputItems })
  }
  if (ct.includes('application/json')) {
    return attachNonStreamSidecar({ c, response, fallbackModel, apiKeyId, requestId, mergedInputItems })
  }
  return response
}
