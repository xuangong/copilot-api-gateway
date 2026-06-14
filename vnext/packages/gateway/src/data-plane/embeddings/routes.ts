/**
 * Embeddings data-plane router — Week 5a-impl port of old src/routes/embeddings.ts.
 *
 * Routes: POST /embeddings and POST /v1/embeddings (both mounted for SDK compat).
 *
 * Phase A Task 4 (X-4) refactor: the per-call observability scaffolding
 * (quota gate → timer → call → record → usage) was extracted into
 * `runEmbeddingsAttempt`. This file keeps request validation, body normalization,
 * and binding resolution — i.e. everything embeddings-specific — and delegates
 * the call/observability shape to the attempt module. No behavior change.
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
import { runEmbeddingsAttempt } from '../observability/attempts/embeddings-attempt.ts'

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

  // Pricing lookup uses the post-pin-strip model id (same value handed to the
  // provider's binding resolver above). The provider returns null when no
  // pricing entry exists; we still record the usage row, just without prices.
  const pricing = binding.provider.getPricingForModelKey(body.model)
  const attempt = await runEmbeddingsAttempt({
    apiKeyId: auth.apiKeyId,
    model: body.model,
    modelKey: body.model,
    pricing,
    upstream: 'github_copilot',
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
    call: async () => {
      const pr = await binding.provider.fetch({
        endpoint: 'embeddings',
        payload: body,
        headers: new Headers({ 'content-type': 'application/json' }),
        sourceApi: 'openai',
        operationName: 'create embeddings',
        flags: { isStreaming: false },
      })
      return new Response(pr.body, { status: pr.status, headers: pr.headers })
    },
  })

  if (!attempt.ok && attempt.status === 429) {
    return c.json({
      error: {
        type: 'rate_limit_error',
        message: attempt.rateLimit.reason,
        ...(attempt.rateLimit.retryAfterSeconds != null
          ? { retry_after_seconds: attempt.rateLimit.retryAfterSeconds }
          : {}),
      },
    }, 429)
  }

  if (!attempt.ok) {
    // Forward the upstream JSON verbatim (matches the pre-refactor behavior:
    // the old handler always returned `Response.json(json, { status })`).
    const json = await attempt.response.json().catch(() => null)
    return Response.json(json, { status: attempt.status })
  }

  return Response.json(attempt.json, { status: attempt.status })
}

embeddingsRouter.post('/embeddings', handle)
embeddingsRouter.post('/v1/embeddings', handle)
