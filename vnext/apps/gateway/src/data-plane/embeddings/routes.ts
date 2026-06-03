/**
 * Embeddings data-plane router — Week 5a-impl port of old src/routes/embeddings.ts.
 *
 * Routes: POST /embeddings and POST /v1/embeddings (both mounted for SDK compat).
 *
 * vnext deltas:
 *   - quota / latency-tracker / usage trackers not yet ported to vnext; skipped
 *     with TODO markers. When ported, hook them in around binding.provider.fetch.
 *   - resolveBinding no longer takes AppState; CreateProviderOptions ride on the
 *     request-scoped auth ctx (see modelsRouter for the shape).
 *   - Forwards upstream JSON verbatim (mirrors old behavior).
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../../app.ts'
import { resolveBinding, stripUpstreamPin } from '../routing/binding-resolver.ts'
import type { DataPlaneAuthCtx } from '../models/routes.ts'

type Vars = { auth: DataPlaneAuthCtx }

interface EmbeddingsPayload {
  model: string
  input: string | string[] | number[] | number[][]
  encoding_format?: 'float' | 'base64'
  dimensions?: number
  user?: string
}

export const embeddingsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

type EmbeddingsCtx = Context<{ Bindings: Env; Variables: Vars }>

async function handle(c: EmbeddingsCtx): Promise<Response> {
  const auth = c.get('auth') ?? {}
  let body: EmbeddingsPayload
  try {
    body = (await c.req.json()) as EmbeddingsPayload
  } catch {
    return c.json({ error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400)
  }
  if (!body || typeof body.model !== 'string') {
    return c.json({ error: { type: 'invalid_request_error', message: 'model is required' } }, 400)
  }

  stripUpstreamPin(body as unknown as Record<string, unknown>)
  const binding = await resolveBinding(body.model, 'embeddings', {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    return c.json(
      { error: { type: 'invalid_request_error', message: `No embeddings upstream available for model: ${body.model}. Run GET /v1/models for available ids.` } },
      404,
    )
  }

  const response = await binding.provider.fetch(
    'embeddings',
    { method: 'POST', body: JSON.stringify(body) },
    { operationName: 'create embeddings', enabledFlags: binding.enabledFlags },
  )

  // TODO(week5+): quota check / recordLatency / trackNonStreamingUsage once
  // those modules are ported into vnext.

  const json = await response.json()
  return Response.json(json, { status: response.status })
}

embeddingsRouter.post('/embeddings', handle)
embeddingsRouter.post('/v1/embeddings', handle)
