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
  parseMessagesCountTokensPayload,
  parseChatPayload,
  parseResponsesPayload,
  parseGeminiPayload,
} from './parsers.ts'
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { parseModelRouting, resolveBinding, stripUpstreamPin } from './routing/binding-resolver.ts'
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
  savePostTurnSnapshot,
} from './dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from './errors/repackage.ts'
import { getResponsesStore } from '../shared/runtime/responses-store.ts'

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
function mapSourceApiToProviderRequest(src: 'messages' | 'chat_completions' | 'responses' | 'gemini'): 'anthropic' | 'openai' | 'gemini' {
  if (src === 'messages') return 'anthropic'
  if (src === 'chat_completions') return 'openai'
  if (src === 'responses') return 'openai'
  return 'gemini'
}

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
  /**
   * Optional async hook invoked after parse + preprocess succeed and before
   * candidate enumeration. Used by /v1/responses to expand
   * previous_response_id once Zod has validated the merged shape — running
   * the expansion before parse would let a non-array `input` slip past
   * validation. Throwing from the hook is honoured: PreviousResponseNotFoundError
   * is rendered as the OpenAI 400 envelope; any other Error is repackaged as
   * an upstream-shaped error via errorWrap.
   */
  postParse?: (payload: TPayload) => Promise<void>
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

  if (input.postParse) {
    try {
      await input.postParse(payload)
    } catch (err) {
      if (err instanceof PreviousResponseNotFoundError) {
        return renderPreviousResponseNotFound(err)
      }
      const message = err instanceof Error ? err.message : 'request error'
      return input.errorWrap(400, { error: { type: 'invalid_request_error', message } })
    }
  }

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
    // Resolve pricing once per call; the provider owns the lookup table
    // (Copilot static table / Azure config.models / Custom auto-parse).
    // `bareModel` is the post-pin-strip upstream id used everywhere else.
    const pricing = binding.provider.getPricingForModelKey(bareModel)
    attempt = await runConversationAttempt({
      apiKeyId: input.obsCtx.apiKeyId,
      model: bareModel,
      modelKey: bareModel,
      pricing,
      sourceApi: input.sourceApi as SourceApiInput,
      targetApi: targetEndpoint as TargetApiInput,
      upstream: 'github_copilot',
      userAgent: input.obsCtx.userAgent,
      requestId: input.obsCtx.requestId,
      stream: isStream,
      call: async () => {
        const pr = await binding.provider.fetch({
          endpoint: targetEndpoint,
          payload: upstreamPayload,
          headers: new Headers({ 'content-type': 'application/json' }),
          sourceApi: mapSourceApiToProviderRequest(input.sourceApi),
          operationName: 'data-plane dispatch',
          flags: { isStreaming: isStream },
          signal: ctx.signal,
        })
        return new Response(pr.body, { status: pr.status, headers: pr.headers })
      },
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

dataPlane.post('/v1/messages/count_tokens', async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  let payload
  try { payload = parseMessagesCountTokensPayload(raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return new Response(
      JSON.stringify(e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } }),
      { status: e.status ?? 400, headers: { 'content-type': 'application/json' } },
    )
  }
  stripUpstreamPin(payload as unknown as Record<string, unknown>)

  const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
  const binding = await resolveBinding(payload.model, 'messages_count_tokens', {
    ownerId: auth.userId,
    copilot: auth.copilot,
  })
  if (!binding) {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `No messages_count_tokens upstream available for model: ${payload.model}. Run GET /v1/models for available ids.` } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }

  const reqHeaders = c.req.raw.headers
  const extraHeaders: Record<string, string> = {}
  const beta = reqHeaders.get('anthropic-beta')
  if (beta) extraHeaders['anthropic-beta'] = beta
  const version = reqHeaders.get('anthropic-version')
  if (version) extraHeaders['anthropic-version'] = version

  try {
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
    const pr = await binding.provider.fetch({
      endpoint: 'messages_count_tokens',
      payload,
      headers,
      sourceApi: 'anthropic',
      operationName: 'count tokens',
      flags: { isStreaming: false },
      signal: c.req.raw.signal,
    })
    const response = new Response(pr.body, { status: pr.status, headers: pr.headers })
    const json = await response.json()
    return Response.json(json, { status: response.status })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, 'messages')
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }
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
  const store = getResponsesStore()
  const obsCtx: DispatchObsCtx = {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
  // Capture the post-parse, post-expand input items so the snapshot writer
  // saves the merged turn history (previous turn + current turn) rather than
  // the un-expanded raw input. The hook mutates the parsed payload in place,
  // so we read it back here.
  let mergedInputItems: unknown[] = []
  const response = await dispatch(
    { req: { json: async () => raw } },
    {
      parse: (r) => parseResponsesPayload(r),
      modelOf: (p) => (p as { model?: string }).model ?? '',
      sourceApi: 'responses',
      errorWrap: messagesErrorWrap,
      auth,
      obsCtx,
      postParse: async (payload) => {
            await expandPreviousResponseId(
              payload as { previous_response_id?: string | null; input?: unknown },
              store,
              auth.apiKeyId ?? null,
            )
            const expanded = (payload as { input?: unknown }).input
            mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
          },
    },
  )

  if (response.status !== 200) return response
  const ct = response.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream') && response.body) {
    const [forClient, forSidecar] = response.body.tee()
    const inputItems = mergedInputItems
    const fallbackModel = (raw as { model?: string }).model ?? ''
    const apiKeyIdSnap = auth.apiKeyId ?? null
    const requestIdSnap = obsCtx.requestId ?? null
    // Sidecar snapshot writer. Lives at route level because it needs
    // auth.apiKeyId, obsCtx.requestId, the responses-store handle, and
    // c.executionCtx — none of which the interceptor chain currently
    // carries. Relocation deferred to a future plan; commits 33a16c9 +
    // 69d489c semantics must hold here.
    const sidecarPromise = (async () => {
      let responseId: string | null = null
      let model = fallbackModel
      const outputItems: unknown[] = []
      try {
        for await (const evt of parseResponsesSSEStream(forSidecar)) {
          const e = evt as { type?: string; response?: { id?: string; model?: string }; item?: unknown }
          if (e.type === 'response.created' && e.response?.id) {
            responseId = e.response.id
            if (e.response.model) model = e.response.model
          } else if (e.type === 'response.output_item.done' && e.item) {
            outputItems.push(e.item)
          } else if (e.type === 'response.completed') {
            if (e.response?.id && !responseId) responseId = e.response.id
            if (e.response?.model) model = e.response.model
          }
        }
        if (responseId) {
          await savePostTurnSnapshot(store, {
            responseId,
            apiKeyId: apiKeyIdSnap,
            model,
            inputItems,
            outputItems,
          })
        }
      } catch (err) {
        console.warn(JSON.stringify({
          evt: '[responses-snapshot] stream save failed',
          rid: requestIdSnap,
          responseId,
          apiKeyId: apiKeyIdSnap,
          model,
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    })()
    // Bind the sidecar to the CFW ExecutionContext so the runtime keeps the
    // worker alive past response settlement; on local Bun there is no
    // executionCtx, so we fall back to fire-and-forget with a logged catch.
    try {
      c.executionCtx?.waitUntil(sidecarPromise)
    } catch {
      sidecarPromise.catch(() => { /* swallowed; sidecar already logs */ })
    }
    return new Response(forClient, { status: response.status, headers: response.headers })
  }
  if (!ct.includes('application/json')) return response

  const cloned = response.clone()
  const apiKeyIdSnap = auth.apiKeyId ?? null
  const fallbackModel = (raw as { model?: string }).model ?? ''
  const requestIdSnap = obsCtx.requestId ?? null
  const savePromise = (async () => {
    try {
      const json = await cloned.json() as {
        id?: string
        model?: string
        output?: unknown[]
      }
      // snapshot key === translator-preserved upstream id; bridge never rewrites
      if (typeof json.id === 'string' && Array.isArray(json.output)) {
        await savePostTurnSnapshot(store, {
          responseId: json.id,
          apiKeyId: apiKeyIdSnap,
          model: typeof json.model === 'string' ? json.model : fallbackModel,
          inputItems: mergedInputItems,
          outputItems: json.output,
        })
      }
    } catch (err) {
      console.warn(JSON.stringify({
        evt: '[responses-snapshot] non-stream save failed',
        rid: requestIdSnap,
        apiKeyId: apiKeyIdSnap,
        model: fallbackModel,
        message: err instanceof Error ? err.message : String(err),
      }))
    }
  })()
  // Match the streaming branch: hand the save off to the runtime so it never
  // blocks the user-perceived response. On local Bun there is no
  // executionCtx, so we fall back to fire-and-forget with a swallowed catch
  // (the IIFE above already logs failures).
  try {
    c.executionCtx?.waitUntil(savePromise)
  } catch {
    savePromise.catch(() => { /* swallowed; save IIFE already logs */ })
  }
  return response
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
