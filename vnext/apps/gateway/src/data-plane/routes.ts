/** Data-plane routes. Week 3a: unified dispatcher for all 4 frontend protocols via FakeProvider. */
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import { messagesIn } from './adapters/frontend/messages-in.ts'
import { chatIn } from './adapters/frontend/chat-in.ts'
import { responsesIn } from './adapters/frontend/responses-in.ts'
import { geminiIn } from './adapters/frontend/gemini-in.ts'
import { responsesOut } from './adapters/backend/responses-out.ts'
import { FakeProvider } from './providers/types.ts'
import type { FrontendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent } from '@vnext/protocols/ir'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { handleMessagesWebSearch, hasWebSearch } from './orchestrator/server-tools/plugins/web-search/index.ts'
import { handleResponsesImageGeneration, hasImageGeneration } from './orchestrator/server-tools/plugins/image-generation/index.ts'

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

async function dispatch<TPayload>(
  c: { req: { json: () => Promise<unknown> }; json: (b: unknown, s?: number) => Response; body: (b: BodyInit, s?: number, h?: Record<string, string>) => Response },
  adapter: FrontendAdapter<TPayload>,
  toIR: (payload: TPayload) => IRRequest,
  errorWrap: (status: number, body: unknown) => Response,
): Promise<Response> {
  let raw: unknown
  try { raw = await c.req.json() } catch {
    return errorWrap(400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } })
  }
  let payload: TPayload
  try { payload = adapter.parse(raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return errorWrap(e.status ?? 400, e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } })
  }
  const ir = toIR(payload)
  const provider = new FakeProvider()
  const upstreamPayload = responsesOut.toUpstream(ir)
  const upstreamRes = await provider.fetch(
    'responses',
    { method: 'POST', body: JSON.stringify(upstreamPayload), headers: { 'content-type': 'application/json' } },
  )
  if (!upstreamRes.ok) {
    const body = await upstreamRes.text()
    return new Response(body, { status: upstreamRes.status, headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' } })
  }
  if (ir.stream) {
    const events = upstreamRes.body
      ? responsesOut.decodeSSE(upstreamRes.body)
      : (async function* (): AsyncIterable<IREvent> { /* empty */ })()
    const out = adapter.encodeSSE(events)
    return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  const upstreamJson = await upstreamRes.json()
  const events = responsesOut.decodeBody(upstreamJson)
  const body = await adapter.encodeBody(events)
  return Response.json(body)
}

dataPlane.post('/v1/messages', async (c) => {
  // Web-search intercept short-circuits the IR pipeline: the multi-turn loop
  // runs against upstream in non-streaming mode and we either return JSON
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
      },
      raw as Parameters<typeof handleMessagesWebSearch>[1],
    )
  }
  // Re-inject raw body into the dispatcher's JSON reader by wrapping the
  // c.req shape; cheaper than re-parsing once here, then again inside dispatch.
  return dispatch(
    { ...c, req: { json: async () => raw }, json: c.json.bind(c), body: c.body.bind(c) } as Parameters<typeof dispatch>[0],
    messagesIn,
    (p) => messagesIn.toIR(p),
    (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
})

dataPlane.post('/v1/chat/completions', (c) =>
  dispatch(c, chatIn, (p) => chatIn.toIR(p), (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })))

dataPlane.post('/v1/responses', async (c) => {
  // image_generation server-tool intercept short-circuits the IR pipeline:
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
      },
      raw as Parameters<typeof handleResponsesImageGeneration>[1],
    )
  }
  return dispatch(
    { ...c, req: { json: async () => raw }, json: c.json.bind(c), body: c.body.bind(c) } as Parameters<typeof dispatch>[0],
    responsesIn,
    (p) => responsesIn.toIR(p),
    (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
})

dataPlane.post('/v1beta/models/:model{.+}', (c) => {
  // Gemini path encodes model + verb: "gemini-1.5-pro:generateContent" or ":streamGenerateContent"
  const raw = c.req.param('model')
  const [model, verb] = raw.split(':')
  const stream = verb === 'streamGenerateContent'
  return dispatch(c, geminiIn, (p) => {
    const ir = geminiIn.toIRForModel(p, model ?? '')
    ir.stream = stream
    return ir
  }, (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
})
