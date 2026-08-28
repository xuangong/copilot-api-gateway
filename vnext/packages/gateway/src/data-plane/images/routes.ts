/**
 * Images data-plane router — Week 5a-impl port of old src/routes/images.ts.
 *
 * Routes (all mounted both with and without /v1 to match SDKs):
 *   - POST /images/generations  + /v1/images/generations  (JSON in, raw forward out)
 *   - POST /images/edits        + /v1/images/edits        (multipart OR JSON in, raw forward out)
 *
 * `/images/edits` accepts two wire shapes. Multipart is what the OpenAI spec
 * documents and what every SDK sends. JSON with `images:[{image_url}]` is what
 * Codex's client-owned image extension sends; `json-edits.ts` decodes its
 * base64 data URLs and rebuilds the multipart form, so everything downstream
 * of the branch — binding resolution, provider.fetch, observability — is
 * identical for both.
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
import { openRequestDump, parseJsonBody } from '../chat-flow/shared/dump-open.ts'
import { readRequestBody } from '../../shared/dump/request-body.ts'
import { openDumpAccumulator, type DumpAccumulator } from '../../shared/dump/accumulator.ts'
import { getRepo } from '../../repo/index.ts'
import { formDataFromJsonEdits } from './json-edits.ts'
import { HTTPError } from '@vibe-llm/provider-llm'

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

/**
 * Providers signal a non-2xx upstream by throwing an `HTTPError` carrying the
 * real Response (provider-sdf :236, provider-custom :260). Every chat-flow
 * attempt unwraps it; without the same treatment here an upstream 400 like
 * "Transparent background is not supported for this model" reaches the client
 * as a bare 500 with the message gone.
 */
export function upstreamErrorResponse(err: unknown): Response | null {
  if (!(err instanceof HTTPError) || !err.response) return null
  return new Response(err.response.body, {
    status: err.response.status,
    headers: err.response.headers,
  })
}

function forwardUpstream(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

const wrapResponse = (dump: DumpAccumulator | null, response: Response): Response =>
  dump ? dump.finalize(response) : response

async function handleGenerations(c: ImagesCtx): Promise<Response> {
  const auth = c.get('auth') ?? {}
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)

  let payload: GenerationsPayload
  try {
    payload = parseJsonBody(requestBody.bytes) as GenerationsPayload
  } catch {
    dump?.failed('invalid JSON')
    return wrapResponse(dump, c.json({ error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400))
  }
  if (!payload || typeof payload.model !== 'string') {
    dump?.failed('model is required')
    return wrapResponse(dump, c.json({ error: { type: 'invalid_request_error', message: 'model is required' } }, 400))
  }
  dump?.requestedModel(payload.model)

  stripUpstreamPin(payload as unknown as Record<string, unknown>)
  const binding = await resolveBinding(payload.model, 'images_generations', {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    dump?.failed(`no images_generations upstream for model ${payload.model}`)
    return wrapResponse(dump, c.json(
      { error: { type: 'invalid_request_error', message: `No images_generations upstream available for model: ${payload.model}. Run GET /v1/models for available ids.` } },
      404,
    ))
  }

  const pricing = binding.provider.getPricingForModelKey(payload.model)
  let attempt: Awaited<ReturnType<typeof runImagesAttempt>>
  try {
    attempt = await runImagesAttempt({
    apiKeyId: auth.apiKeyId,
    model: payload.model,
    modelKey: payload.model,
    pricing,
    upstream: binding.upstream,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
    dump,
    call: async () => {
      const pr = await binding.provider.fetch({
        endpoint: 'images_generations',
        payload,
        headers: new Headers({ 'content-type': 'application/json' }),
        sourceApi: 'openai',
        operationName: 'create image',
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
    return wrapResponse(dump, rateLimitResponse(c, attempt.rateLimit))
  }

  // Both success and non-2xx fall through here — the route has always
  // forwarded the upstream body verbatim regardless of status code.
  return wrapResponse(dump, forwardUpstream(attempt.response))
}

async function handleEdits(c: ImagesCtx): Promise<Response> {
  const auth = c.get('auth') ?? {}
  const contentType = c.req.header('content-type') ?? ''

  // Multipart bodies aren't JSON — open the dump seam manually so we still
  // record the raw request bytes (up to retention limits) and can call the
  // mid-flight hooks on error paths.
  const requestBody = await readRequestBody(c)
  let dump: DumpAccumulator | null = null
  if (auth.apiKeyId) {
    try {
      const apiKey = await getRepo().apiKeys.getById(auth.apiKeyId)
      if (apiKey) dump = openDumpAccumulator(c, c.req.method, apiKey, requestBody)
    } catch { /* best-effort */ }
  }

  const lowerContentType = contentType.toLowerCase()
  const isJson = lowerContentType.startsWith('application/json')
  const isMultipart = lowerContentType.startsWith('multipart/form-data')
  if (!isJson && !isMultipart) {
    dump?.failed('/images/edits requires multipart/form-data or application/json')
    return wrapResponse(dump, c.json(
      { error: { type: 'invalid_request_error', message: '/images/edits requires multipart/form-data or application/json' } },
      400,
    ))
  }

  let form: FormData
  let model: string

  if (isJson) {
    // Codex's image extension posts edits as JSON with base64 data URLs
    // instead of multipart. Normalize to the documented multipart shape so
    // the provider seam below is identical for both wire forms.
    let parsed: unknown
    try {
      parsed = parseJsonBody(requestBody.bytes)
    } catch {
      dump?.failed('invalid JSON')
      return wrapResponse(dump, c.json({ error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400))
    }
    const normalized = formDataFromJsonEdits(parsed)
    if (!normalized.ok) {
      dump?.failed(normalized.message)
      return wrapResponse(dump, c.json({ error: { type: 'invalid_request_error', message: normalized.message } }, 400))
    }
    form = normalized.form
    model = normalized.model
  } else {
    try {
      // Rebuild a Request over the buffered bytes so Hono's formData() parser
      // can consume them (we already drained the original stream via readRequestBody).
      const rebuilt = new Request(c.req.url, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: requestBody.bytes,
      })
      form = await rebuilt.formData()
    } catch {
      dump?.failed('failed to parse multipart body')
      return wrapResponse(dump, c.json(
        { error: { type: 'invalid_request_error', message: 'failed to parse multipart body' } },
        400,
      ))
    }

    const modelField = form.get('model')
    if (typeof modelField !== 'string' || modelField.length === 0) {
      dump?.failed('model field is required in multipart body')
      return wrapResponse(dump, c.json(
        { error: { type: 'invalid_request_error', message: 'model field is required in multipart body' } },
        400,
      ))
    }
    model = modelField
  }
  dump?.requestedModel(model)

  const binding = await resolveBinding(model, 'images_edits', {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    dump?.failed(`no images_edits upstream for model ${model}`)
    return wrapResponse(dump, c.json(
      { error: { type: 'invalid_request_error', message: `No images_edits upstream available for model: ${model}. Run GET /v1/models for available ids.` } },
      404,
    ))
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

  const pricing = binding.provider.getPricingForModelKey(model)
  let attempt: Awaited<ReturnType<typeof runImagesAttempt>>
  try {
    attempt = await runImagesAttempt({
    apiKeyId: auth.apiKeyId,
    model,
    modelKey: model,
    pricing,
    upstream: binding.upstream,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
    dump,
    call: async () => {
      const pr = await binding.provider.fetch({
        endpoint: 'images_edits',
        payload: forward,
        headers: new Headers(),
        sourceApi: 'openai',
        operationName: 'edit image',
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
    return wrapResponse(dump, rateLimitResponse(c, attempt.rateLimit))
  }

  return wrapResponse(dump, forwardUpstream(attempt.response))
}

imagesRouter.post('/images/generations', handleGenerations)
imagesRouter.post('/v1/images/generations', handleGenerations)
imagesRouter.post('/images/edits', handleEdits)
imagesRouter.post('/v1/images/edits', handleEdits)
