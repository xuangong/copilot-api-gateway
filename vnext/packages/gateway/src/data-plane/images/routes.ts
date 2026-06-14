/**
 * Images data-plane router — Week 5a-impl port of old src/routes/images.ts.
 *
 * Routes (all mounted both with and without /v1 to match SDKs):
 *   - POST /images/generations  + /v1/images/generations  (JSON in, raw forward out)
 *   - POST /images/edits        + /v1/images/edits        (multipart in, raw forward out)
 *
 * Phase A Task 4 (X-4) refactor: the per-call observability scaffolding
 * (quota gate → timer → call → record latency-only) was extracted into
 * `runImagesAttempt`. This file keeps request validation, multipart handling,
 * and binding resolution — i.e. everything image-specific — and delegates
 * the call/observability shape to the attempt module. No behavior change:
 * sourceApi/targetApi remain intentionally omitted from recordLatency so
 * perf fan-out stays skipped (images carry no perf-enum target).
 *
 * vnext deltas:
 *   - resolveBinding signature change (see binding-resolver.ts).
 *   - Body forwarding: response.body + status + headers verbatim, same as old.
 *   - Hono parses JSON / FormData on demand via c.req.json() / c.req.formData().
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../../app.ts'
import { resolveBinding, stripUpstreamPin } from '../routing/binding-resolver.ts'
import type { DataPlaneAuthCtx } from '../models/routes.ts'
import { runImagesAttempt } from '../observability/attempts/images-attempt.ts'

type Vars = { auth: DataPlaneAuthCtx }

interface GenerationsPayload {
  model: string
  prompt?: string
  n?: number
  size?: string
  response_format?: string
  user?: string
}

export const imagesRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

type ImagesCtx = Context<{ Bindings: Env; Variables: Vars }>

function rateLimitResponse(c: ImagesCtx, rl: { reason: string; retryAfterSeconds?: number }) {
  return c.json({
    error: {
      type: 'rate_limit_error',
      message: rl.reason,
      ...(rl.retryAfterSeconds != null ? { retry_after_seconds: rl.retryAfterSeconds } : {}),
    },
  }, 429)
}

function forwardUpstream(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

async function handleGenerations(c: ImagesCtx): Promise<Response> {
  const auth = c.get('auth') ?? {}
  let payload: GenerationsPayload
  try {
    payload = (await c.req.json()) as GenerationsPayload
  } catch {
    return c.json({ error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400)
  }
  if (!payload || typeof payload.model !== 'string') {
    return c.json({ error: { type: 'invalid_request_error', message: 'model is required' } }, 400)
  }

  stripUpstreamPin(payload as unknown as Record<string, unknown>)
  const binding = await resolveBinding(payload.model, 'images_generations', {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    return c.json(
      { error: { type: 'invalid_request_error', message: `No images_generations upstream available for model: ${payload.model}. Run GET /v1/models for available ids.` } },
      404,
    )
  }

  const attempt = await runImagesAttempt({
    apiKeyId: auth.apiKeyId,
    model: payload.model,
    upstream: 'github_copilot',
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
    call: () => binding.provider.fetch(
      'images_generations',
      { method: 'POST', body: JSON.stringify(payload) },
      { operationName: 'create image', enabledFlags: binding.enabledFlags },
    ),
  })

  if (!attempt.ok && attempt.status === 429 && 'rateLimit' in attempt) {
    return rateLimitResponse(c, attempt.rateLimit)
  }

  // Both success and non-2xx fall through here — the route has always
  // forwarded the upstream body verbatim regardless of status code.
  return forwardUpstream(attempt.response)
}

async function handleEdits(c: ImagesCtx): Promise<Response> {
  const auth = c.get('auth') ?? {}
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return c.json(
      { error: { type: 'invalid_request_error', message: '/images/edits requires multipart/form-data' } },
      400,
    )
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'failed to parse multipart body' } },
      400,
    )
  }

  const modelField = form.get('model')
  const model = typeof modelField === 'string' ? modelField : null
  if (!model) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'model field is required in multipart body' } },
      400,
    )
  }

  const binding = await resolveBinding(model, 'images_edits', {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    return c.json(
      { error: { type: 'invalid_request_error', message: `No images_edits upstream available for model: ${model}. Run GET /v1/models for available ids.` } },
      404,
    )
  }

  // Rebuild FormData so upstream sees File/Blob verbatim. Hono's formData() returns
  // entries where files are File instances; preserve filename via append(key, value, name).
  const forward = new FormData()
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      forward.append(key, value)
    } else {
      const name = (value as File).name ?? key
      forward.append(key, value, name)
    }
  }

  const attempt = await runImagesAttempt({
    apiKeyId: auth.apiKeyId,
    model,
    upstream: 'github_copilot',
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
    call: () => binding.provider.fetch(
      'images_edits',
      { method: 'POST', body: forward },
      { operationName: 'edit image', enabledFlags: binding.enabledFlags },
    ),
  })

  if (!attempt.ok && attempt.status === 429 && 'rateLimit' in attempt) {
    return rateLimitResponse(c, attempt.rateLimit)
  }

  return forwardUpstream(attempt.response)
}

imagesRouter.post('/images/generations', handleGenerations)
imagesRouter.post('/v1/images/generations', handleGenerations)
imagesRouter.post('/images/edits', handleEdits)
imagesRouter.post('/v1/images/edits', handleEdits)
