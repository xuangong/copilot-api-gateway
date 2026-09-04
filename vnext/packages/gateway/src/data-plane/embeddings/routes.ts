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
import { resolveBinding } from '../routing/binding-resolver.ts'
import { resolveKeyModel } from '../routing/key-model-mapping.ts'
import type { DataPlaneAuthCtx } from '../models/routes.ts'
import { runEmbeddingsAttempt } from '../observability/attempts/embeddings-attempt.ts'
import { openRequestDump, parseJsonBody } from '../chat-flow/shared/dump-open.ts'
import type { DumpAccumulator } from '../../shared/dump/accumulator.ts'
import { HTTPError } from '@vibe-llm/provider-llm'

type Vars = { auth: DataPlaneAuthCtx }

export interface EmbeddingsPayload {
  model: string
  input: string | string[] | number[] | number[][]
  encoding_format?: 'float' | 'base64'
  dimensions?: number
  user?: string
}

export const embeddingsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

type EmbeddingsCtx = Context<{ Bindings: Env; Variables: Vars }>

const wrapResponse = (dump: DumpAccumulator | null, response: Response): Response =>
  dump ? dump.finalize(response) : response

const upstreamErrorResponse = (err: unknown): Response | null => {
  if (!(err instanceof HTTPError) || !err.response) return null
  return new Response(err.response.body, {
    status: err.response.status,
    statusText: err.response.statusText,
    headers: err.response.headers,
  })
}

/**
 * `presetBody` lets a caller that has already parsed (and reshaped) the request
 * reuse this handler without re-reading the body — the Ollama `/api/embed`
 * shim does exactly that. The dump still records the bytes the client actually
 * sent, which is the honest thing to store.
 */
export async function embeddingsHandler(
  c: EmbeddingsCtx,
  presetBody?: EmbeddingsPayload,
): Promise<Response> {
  const auth = c.get('auth') ?? {}
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)

  let sourceBody: EmbeddingsPayload
  try {
    sourceBody = presetBody ?? (parseJsonBody(requestBody.bytes) as EmbeddingsPayload)
  } catch {
    dump?.failed('invalid JSON')
    return wrapResponse(dump, c.json({ error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400))
  }
  if (!sourceBody || typeof sourceBody.model !== 'string') {
    dump?.failed('model is required')
    return wrapResponse(dump, c.json({ error: { type: 'invalid_request_error', message: 'model is required' } }, 400))
  }
  dump?.requestedModel(sourceBody.model)

  const resolved = resolveKeyModel(sourceBody.model, auth.routingPolicy)
  // Never mutate `presetBody`: Ollama retains caller-owned parsed input. The
  // provider gets a shallow clone containing only the resolved bare model.
  const body: EmbeddingsPayload = {
    ...sourceBody,
    model: resolved.routedModel,
    ...(typeof sourceBody.input === 'string' ? { input: [sourceBody.input] } : {}),
  }
  const binding = await resolveBinding(resolved.routedModel, 'embeddings', {
    ownerId: auth.userId,
    copilot: auth.copilot,
    pin: resolved.upstreamPin,
  })
  if (!binding) {
    dump?.failed(`no embeddings upstream for model ${body.model}`)
    return wrapResponse(dump, c.json(
      { error: { type: 'invalid_request_error', message: `No embeddings upstream available for model: ${body.model}. Run GET /v1/models for available ids.` } },
      404,
    ))
  }

  // Pricing lookup uses the post-pin-strip model id (same value handed to the
  // provider's binding resolver above). The provider returns null when no
  // pricing entry exists; we still record the usage row, just without prices.
  const pricing = binding.provider.getPricingForModelKey(body.model)
  let attempt: Awaited<ReturnType<typeof runEmbeddingsAttempt>>
  try {
    attempt = await runEmbeddingsAttempt({
      apiKeyId: auth.apiKeyId,
      model: body.model,
      modelKey: body.model,
      pricing,
      upstream: binding.upstream,
      userAgent: c.req.header('user-agent') ?? undefined,
      requestId: c.req.header('x-request-id') ?? undefined,
      dump,
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
  } catch (err) {
    const upstream = upstreamErrorResponse(err)
    if (!upstream) throw err
    return wrapResponse(dump, upstream)
  }

  if (!attempt.ok && 'rateLimit' in attempt) {
    return wrapResponse(dump, c.json({
      error: {
        type: 'rate_limit_error',
        message: attempt.rateLimit.reason,
        ...(attempt.rateLimit.retryAfterSeconds != null
          ? { retry_after_seconds: attempt.rateLimit.retryAfterSeconds }
          : {}),
      },
    }, 429))
  }

  if (!attempt.ok) {
    // Forward the upstream JSON verbatim (matches the pre-refactor behavior:
    // the old handler always returned `Response.json(json, { status })`).
    const json = await attempt.response.json().catch(() => null)
    return wrapResponse(dump, Response.json(json, { status: attempt.status }))
  }

  return wrapResponse(dump, Response.json(attempt.json, { status: attempt.status }))
}

embeddingsRouter.post('/embeddings', (c) => embeddingsHandler(c))
embeddingsRouter.post('/v1/embeddings', (c) => embeddingsHandler(c))
