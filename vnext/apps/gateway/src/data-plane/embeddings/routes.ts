/**
 * Embeddings data-plane router — Week 5a-impl port of old src/routes/embeddings.ts.
 *
 * Routes: POST /embeddings and POST /v1/embeddings (both mounted for SDK compat).
 *
 * vnext deltas:
 *   - resolveBinding no longer takes AppState; CreateProviderOptions ride on the
 *     request-scoped auth ctx (see modelsRouter for the shape).
 *   - Forwards upstream JSON verbatim (mirrors old behavior).
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../../app.ts'
import { resolveBinding, stripUpstreamPin } from '../routing/binding-resolver.ts'
import type { DataPlaneAuthCtx } from '../models/routes.ts'
import { checkQuota } from '../../shared/observability/quota.ts'
import { recordLatency, startTimer } from '../../shared/observability/latency-tracker.ts'
import { trackNonStreamingUsage } from '../../shared/observability/usage-tracker.ts'
import { detectClient } from '../../shared/observability/client-detect.ts'

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
  // Copilot upstream rejects scalar `input` with 400 Bad Request; OpenAI spec
  // accepts both string and array, so normalize to array for upstream compat.
  if (typeof body.input === 'string') {
    body.input = [body.input]
  }
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

  const apiKeyId = auth.apiKeyId
  const userAgent = c.req.header('user-agent') ?? undefined
  const requestId = c.req.header('x-request-id') ?? undefined
  const client = detectClient(userAgent)

  if (apiKeyId) {
    const quota = await checkQuota(apiKeyId)
    if (!quota.allowed) {
      return c.json({
        error: {
          type: 'rate_limit_error',
          message: quota.reason ?? 'Daily quota exceeded.',
          ...(quota.retryAfterSeconds != null ? { retry_after_seconds: quota.retryAfterSeconds } : {}),
        },
      }, 429)
    }
  }

  const elapsed = startTimer()
  const upstreamStart = Date.now()
  const response = await binding.provider.fetch(
    'embeddings',
    { method: 'POST', body: JSON.stringify(body) },
    { operationName: 'create embeddings', enabledFlags: binding.enabledFlags },
  )
  const upstreamMs = Date.now() - upstreamStart

  const json = await response.json()

  if (apiKeyId) {
    if (response.ok) {
      await trackNonStreamingUsage(json, apiKeyId, body.model, client, 'github_copilot')
      await recordLatency(
        apiKeyId,
        body.model,
        'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        requestId,
        {
          stream: false,
          sourceApi: 'embeddings',
          targetApi: 'embeddings',
          upstream: 'github_copilot',
          userAgent,
        },
      )
    } else {
      await recordLatency(
        apiKeyId,
        body.model,
        'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        requestId,
        { isError: true, upstream: 'github_copilot', userAgent },
      )
    }
  }

  return Response.json(json, { status: response.status })
}

embeddingsRouter.post('/embeddings', handle)
embeddingsRouter.post('/v1/embeddings', handle)
