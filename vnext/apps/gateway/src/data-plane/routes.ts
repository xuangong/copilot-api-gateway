/**
 * Data-plane routes — pairwise translation pipeline.
 *
 * Flow per request:
 *   1. frontend.parse(raw)               — Zod-validate client payload
 *   2. enumerateBindingCandidates(...)   — pick binding + target endpoint via
 *                                          source-API preference (selectPair)
 *   3. getTranslator(source, target)     — uniform PairTranslator handle
 *   4. translator.translateRequest(...)  — client payload → hub payload
 *   5. runConversationAttempt(...)       — quota gate → timer → call → record
 *   6. streaming:   parse upstream SSE → translator.translateEvents → encodeClientSSE
 *      non-stream:  translator.translateBody(json) → JSON
 *
 * No IR (intermediate representation). The messages→messages route uses the
 * identity translator (zero-cost passthrough). Other routes pay one
 * translateRequest + one translateEvents/translateBody. HTTPError surfaces
 * from binding.provider.fetch and is repackaged into the client's native
 * error wire shape.
 */
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import {
  parseMessagesPayload,
  parseChatPayload,
  parseResponsesPayload,
  parseGeminiPayload,
} from './parsers.ts'
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { parseModelRouting } from './routing/binding-resolver.ts'
import { enumerateBindingCandidates } from './routing/candidates.ts'
import { repackageUpstreamError, type SourceApi as ErrorSourceApi } from './errors/repackage.ts'
import {
  HTTPError,
  parseMessagesSSEStream,
  parseChatSSEStream,
  parseResponsesSSEStream,
} from '@vnext/provider-copilot'
import { handleMessagesWebSearch, hasWebSearch } from './orchestrator/server-tools/plugins/web-search/index.ts'
import { handleResponsesImageGeneration, hasImageGeneration } from './orchestrator/server-tools/plugins/image-generation/index.ts'
import { runConversationAttempt } from './observability/attempts/conversation-attempt.ts'
import type { SourceApiInput, TargetApiInput } from '../shared/observability/latency-tracker.ts'
import { selectPair, type SourceApi } from './dispatch/pair-selector.ts'
import { getTranslator, type TranslateContext } from './dispatch/translator-registry.ts'
import { encodeClientSSE } from './dispatch/sse-writers.ts'
import {
  expandPreviousResponseId,
  PreviousResponseNotFoundError,
} from './dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from './errors/repackage.ts'

export const dataPlane = new Hono<{ Bindings: Env }>()

// Auth bridge — populated by future auth middleware; for now defaults to empty so
// downstream routers can read c.get('auth') without nullish surprises.
dataPlane.use('*', async (c, next) => {
  if (!c.get('auth' as never)) {
    c.set('auth' as never, {} as DataPlaneAuthCtx)
  }
  await next()
})

dataPlane.route('/', modelsRouter)
dataPlane.route('/', embeddingsRouter)
dataPlane.route('/', imagesRouter)

type DispatchObsCtx = {
  apiKeyId: string | undefined
  userAgent: string | undefined
  requestId: string | undefined
}

/**
 * Parse an upstream SSE byte stream into typed events for the given target
 * endpoint. The translator's translateEvents consumes these typed events.
 */
function parseTargetSSE(
  target: EndpointKey,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  if (target === 'messages') return parseMessagesSSEStream(body, signal)
  if (target === 'chat_completions') return parseChatSSEStream(body, signal)
  if (target === 'responses') return parseResponsesSSEStream(body, signal)
  // Other endpoints (embeddings, images) don't stream events through this path.
  return (async function* (): AsyncIterable<unknown> { /* empty */ })()
}

interface DispatchInput<TPayload> {
  parse: (raw: unknown) => TPayload
  /** Extract the model id from the parsed payload. */
  modelOf: (payload: TPayload) => string
  /** Optional payload mutator (e.g. Gemini injects model + stream). */
  preprocess?: (payload: TPayload) => TPayload
  /** Fallback max-output-tokens for translators that need a default. */
  fallbackMaxOutputTokens?: number
  /** Force stream true/false for sources where the wire indicates it (Gemini verb). */
  forceStream?: boolean
  /** Source-API key used by pair-selector / translator registry. */
  sourceApi: SourceApi
  /** Error wrapping helper — produces the client's native 4xx/5xx wire shape. */
  errorWrap: (status: number, body: unknown) => Response
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

async function dispatch<TPayload>(
  c: { req: { json: () => Promise<unknown> } },
  input: DispatchInput<TPayload>,
): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return input.errorWrap(400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } })
  }

  let payload: TPayload
  try { payload = input.parse(raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return input.errorWrap(e.status ?? 400, e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } })
  }
  if (input.preprocess) payload = input.preprocess(payload)

  const requestedModel = input.modelOf(payload)
  const { bareModel } = parseModelRouting(requestedModel)

  const pickTarget = (e: ModelEndpoints): EndpointKey | null => selectPair(input.sourceApi, e)
  const { candidates, sawModel } = await enumerateBindingCandidates({
    model: requestedModel,
    pickTarget,
    opts: { ownerId: input.auth.userId, copilot: input.auth.copilot },
  })
  if (candidates.length === 0) {
    if (sawModel) {
      return input.errorWrap(400, {
        error: {
          type: 'invalid_request_error',
          message: `Model "${requestedModel}" does not support the "${input.sourceApi}" client protocol.`,
        },
      })
    }
    return input.errorWrap(404, {
      error: {
        type: 'invalid_request_error',
        message: `No upstream serves model "${requestedModel}". Run GET /v1/models for available ids.`,
      },
    })
  }
  const { binding, targetEndpoint } = candidates[0]!

  const translator = getTranslator(input.sourceApi, targetEndpoint)
  if (!translator) {
    // selectPair returned a target but no translator exists for the pair.
    // Should not happen for the four chat-flow endpoints; surface clearly.
    return input.errorWrap(400, {
      error: {
        type: 'invalid_request_error',
        message: `No translator for ${input.sourceApi}→${targetEndpoint}.`,
      },
    })
  }

  const controller = new AbortController()
  const ctx: TranslateContext = {
    signal: controller.signal,
    fallbackMaxOutputTokens: input.fallbackMaxOutputTokens,
    model: bareModel,
  }

  let upstreamPayload: unknown
  try {
    upstreamPayload = await translator.translateRequest(payload, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'translation error'
    return input.errorWrap(400, { error: { type: 'invalid_request_error', message } })
  }

  // Determine streaming intent. translators preserve the caller's `stream`
  // flag in the payload they produce; we infer from the upstream payload.
  let isStream: boolean
  if (typeof input.forceStream === 'boolean') {
    isStream = input.forceStream
  } else {
    const upstreamObj = upstreamPayload as { stream?: unknown } | null
    isStream = upstreamObj?.stream === true
  }

  let attempt: Awaited<ReturnType<typeof runConversationAttempt>>
  try {
    attempt = await runConversationAttempt({
      apiKeyId: input.obsCtx.apiKeyId,
      model: bareModel,
      sourceApi: input.sourceApi as SourceApiInput,
      targetApi: targetEndpoint as TargetApiInput,
      upstream: 'github_copilot',
      userAgent: input.obsCtx.userAgent,
      requestId: input.obsCtx.requestId,
      stream: isStream,
      call: () => binding.provider.fetch(
        targetEndpoint,
        { method: 'POST', body: JSON.stringify(upstreamPayload), headers: { 'content-type': 'application/json' } },
        { operationName: 'data-plane dispatch', enabledFlags: binding.enabledFlags, sourceApi: input.sourceApi },
      ),
    })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, input.sourceApi as ErrorSourceApi)
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return input.errorWrap(502, { error: { type: 'api_error', message } })
  }

  if (!attempt.ok && attempt.status === 429 && 'rateLimit' in attempt) {
    return input.errorWrap(429, {
      error: {
        type: 'rate_limit_error',
        message: attempt.rateLimit.reason,
        ...(attempt.rateLimit.retryAfterSeconds != null
          ? { retry_after_seconds: attempt.rateLimit.retryAfterSeconds }
          : {}),
      },
    })
  }
  if (!attempt.ok) {
    if ('response' in attempt) return await repackageUpstreamError(attempt.response, input.sourceApi as ErrorSourceApi)
    return input.errorWrap(502, { error: { type: 'api_error', message: 'upstream error' } })
  }

  if (attempt.stream) {
    const hubEvents = parseTargetSSE(targetEndpoint, attempt.response.body, ctx.signal)
    const clientEvents = translator.translateEvents(hubEvents, ctx)
    const out = encodeClientSSE(input.sourceApi, clientEvents)
    return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  // Non-streaming: attempt.json is the parsed upstream JSON.
  let clientBody: unknown
  try {
    clientBody = await translator.translateBody(attempt.json, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'translation error'
    return input.errorWrap(502, { error: { type: 'api_error', message } })
  }
  return Response.json(clientBody)
}

const messagesErrorWrap = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

dataPlane.post('/v1/messages', async (c) => {
  // Web-search intercept short-circuits the pairwise pipeline: the multi-turn
  // loop runs against upstream in non-streaming mode and we either return JSON
  // or replay as SSE. See plugins/web-search/index.ts for the rationale.
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  if (hasWebSearch(raw as Parameters<typeof hasWebSearch>[0])) {
    const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
    if (!auth.copilot?.copilotToken || !auth.githubToken) {
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'Copilot/GitHub credentials required for web search.' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    }
    return handleMessagesWebSearch(
      {
        copilotToken: auth.copilot.copilotToken,
        accountType: auth.copilot.accountType,
        githubToken: auth.githubToken,
        msGroundingKey: auth.msGroundingKey,
        apiKeyId: auth.apiKeyId,
        requestId: c.req.header('x-request-id') ?? undefined,
        userAgent: c.req.header('user-agent') ?? undefined,
      },
      raw as Parameters<typeof handleMessagesWebSearch>[1],
    )
  }
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  const obsCtx: DispatchObsCtx = {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
  return dispatch(
    { req: { json: async () => raw } },
    {
      parse: (r) => parseMessagesPayload(r),
      modelOf: (p) => (p as { model?: string }).model ?? '',
      sourceApi: 'messages',
      errorWrap: messagesErrorWrap,
      auth,
      obsCtx,
    },
  )
})

dataPlane.post('/v1/chat/completions', (c) => {
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  const obsCtx: DispatchObsCtx = {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
  return dispatch(c, {
    parse: (r) => parseChatPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'chat_completions',
    // Chat Completions has no required max_tokens — give chat→messages a default
    // so the Anthropic upstream contract (which requires max_tokens) is met.
    fallbackMaxOutputTokens: 4096,
    errorWrap: messagesErrorWrap,
    auth,
    obsCtx,
  })
})

dataPlane.post('/v1/responses', async (c) => {
  // image_generation server-tool intercept short-circuits the pairwise pipeline:
  // single-turn call to the image backend, returned as a Responses envelope
  // (JSON or synthesized SSE). See plugins/image-generation/index.ts.
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  const rawObj = raw as { tools?: Array<Record<string, unknown>> } | null
  if (rawObj && hasImageGeneration(rawObj.tools as Parameters<typeof hasImageGeneration>[0])) {
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
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  const store = c.env?.responsesStore
  if (store) {
    try {
      await expandPreviousResponseId(
        raw as { previous_response_id?: string | null; input?: unknown },
        store,
        auth.apiKeyId ?? null,
      )
    } catch (err) {
      if (err instanceof PreviousResponseNotFoundError) {
        return renderPreviousResponseNotFound(err)
      }
      throw err
    }
  }
  const obsCtx: DispatchObsCtx = {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
  return dispatch(
    { req: { json: async () => raw } },
    {
      parse: (r) => parseResponsesPayload(r),
      modelOf: (p) => (p as { model?: string }).model ?? '',
      sourceApi: 'responses',
      errorWrap: messagesErrorWrap,
      auth,
      obsCtx,
    },
  )
})

dataPlane.post('/v1beta/models/:model{.+}', (c) => {
  // Gemini path encodes model + verb: "gemini-1.5-pro:generateContent" or ":streamGenerateContent"
  const raw = c.req.param('model')
  const [model, verb] = raw.split(':')
  const stream = verb === 'streamGenerateContent'
  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  const obsCtx: DispatchObsCtx = {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
  return dispatch(c, {
    parse: (r) => parseGeminiPayload(r),
    modelOf: () => model ?? '',
    // Gemini payload has no top-level model; the translator reads it from
    // TranslateContext.model. Force-stream is decoded from the URL verb.
    forceStream: stream,
    fallbackMaxOutputTokens: 4096,
    sourceApi: 'gemini',
    errorWrap: messagesErrorWrap,
    auth,
    obsCtx,
  })
})
