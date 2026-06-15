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
  parseMessagesCountTokensPayload,
  parseChatPayload,
  parseResponsesPayload,
  parseGeminiPayload,
} from './parsers.ts'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { resolveBinding, stripUpstreamPin } from './routing/binding-resolver.ts'
import { repackageUpstreamError } from './errors/repackage.ts'
import { HTTPError, parseResponsesSSEStream } from '@vnext/provider-copilot'
import { handleResponsesImageGeneration, hasImageGeneration } from './orchestrator/server-tools/plugins/image-generation/index.ts'
import {
  expandPreviousResponseId,
  savePostTurnSnapshot,
} from './dispatch/responses-store-bridge.ts'
import { getResponsesStore } from '../shared/runtime/responses-store.ts'
import { dispatch, type DispatchObsCtx } from './chat-flow/shared/dispatch.ts'
import { invalidJsonResponse, jsonErrorWrap } from './chat-flow/shared/error-wrap.ts'
import { readAuth, readObsCtx } from './chat-flow/shared/gateway-ctx.ts'
import { messagesHandler } from './chat-flow/messages/http.ts'

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

dataPlane.post('/v1/messages', messagesHandler)

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

dataPlane.post('/v1/chat/completions', async (c) => {
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return dispatch(raw, {
    parse: (r) => parseChatPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'chat_completions',
    // Chat Completions has no required max_tokens — give chat→messages a default
    // so the Anthropic upstream contract (which requires max_tokens) is met.
    fallbackMaxOutputTokens: 4096,
    errorWrap: jsonErrorWrap,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
})

dataPlane.post('/v1/responses', async (c) => {
  // image_generation server-tool intercept short-circuits the pairwise pipeline:
  // single-turn call to the image backend, returned as a Responses envelope
  // (JSON or synthesized SSE). See plugins/image-generation/index.ts.
  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const rawObj = raw as { tools?: Array<Record<string, unknown>> } | null
  if (rawObj && hasImageGeneration(rawObj.tools as Parameters<typeof hasImageGeneration>[0])) {
    const auth = readAuth(c)
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
  const auth = readAuth(c)
  const store = getResponsesStore()
  const obsCtx: DispatchObsCtx = readObsCtx(c, auth)
  // Capture the post-parse, post-expand input items so the snapshot writer
  // saves the merged turn history (previous turn + current turn) rather than
  // the un-expanded raw input. The hook mutates the parsed payload in place,
  // so we read it back here.
  let mergedInputItems: unknown[] = []
  const response = await dispatch(raw, {
    parse: (r) => parseResponsesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'responses',
    errorWrap: jsonErrorWrap,
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
  })

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

dataPlane.post('/v1beta/models/:model{.+}', async (c) => {
  // Gemini path encodes model + verb: "gemini-1.5-pro:generateContent" or ":streamGenerateContent"
  const raw = c.req.param('model')
  const [model, verb] = raw.split(':')
  const stream = verb === 'streamGenerateContent'
  let body: unknown
  try { body = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)
  return dispatch(body, {
    parse: (r) => parseGeminiPayload(r),
    modelOf: () => model ?? '',
    // Gemini payload has no top-level model; the translator reads it from
    // TranslateContext.model. Force-stream is decoded from the URL verb.
    forceStream: stream,
    fallbackMaxOutputTokens: 4096,
    sourceApi: 'gemini',
    errorWrap: jsonErrorWrap,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
})
