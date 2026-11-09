/**
 * Decision data-plane router — models that answer typed questions about a
 * state with calibrated probabilities instead of generating text. Ported from
 * the reference (`data-plane/decision/serve.ts`, commits d6b583b76 and
 * 9fab1be63) onto vNext's embeddings/images route shape.
 *
 * Routes (mounted with and without /v1, like the other data-plane routes):
 *   - POST /v1/systemone — TypeSafe System One: `state` plus a name-keyed
 *     `questions` map. Copilot's microsoft-decision-1 speaks it.
 *   - POST /v1/decisions — OpenAI Decisions: `input` plus a `questions` array.
 *     Copilot's gpt-6-luna-decisions speaks it.
 *
 * Each model speaks one dialect, named by its provider. A request in that
 * dialect is forwarded as sent (only `model` is replaced) and the answer comes
 * back byte for byte. A request in the other dialect is parsed into the
 * canonical form, re-serialized for the model, and its answer rendered back,
 * so either ingress reaches any decision model. Bodies are parsed with raw
 * numbers throughout: a probability keeps its digits across both paths.
 */
import { Hono, type Context } from 'hono'
import { withDumpExceptionCleanup } from '@vibe-core/chat-flow-kit'
import type { Env } from '../../app.ts'
import type { DecisionProtocol } from '@vibe-llm/protocols/common'
import { parseJSONWithRawNumbers } from '@vibe-llm/protocols/json'
import { parseDecisionRequest, parseDecisionResponse, renderDecisionResponse, serializeDecisionRequest, type ParsedDecisionRequest } from '@vibe-llm/protocols/decision'
import { HTTPError } from '@vibe-llm/provider-llm'
import { resolveBinding } from '../routing/binding-resolver.ts'
import { resolveKeyModel } from '../routing/key-model-mapping.ts'
import type { DataPlaneAuthCtx } from '../models/routes.ts'
import { runDecisionAttempt } from '../observability/attempts/decision-attempt.ts'
import { openRequestDump } from '../chat-flow/shared/dump-open.ts'
import type { DumpAccumulator } from '../../shared/dump/accumulator.ts'
import { forwardUpstreamError } from '../errors/forward.ts'

type Vars = { auth: DataPlaneAuthCtx }
type DecisionCtx = Context<{ Bindings: Env; Variables: Vars }>

export const decisionRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

const wrapResponse = (dump: DumpAccumulator | null, response: Response): Response =>
  dump ? dump.finalize(response) : response

const errorResponse = (type: 'invalid_request_error' | 'api_error', message: string, status: number): Response =>
  Response.json({ error: { type, message } }, { status })

const jsonResponse = (text: string, status: number): Response =>
  new Response(text, { status, headers: { 'content-type': 'application/json' } })

export async function decisionHandler(c: DecisionCtx, sourceProtocol: DecisionProtocol): Promise<Response> {
  const auth = c.get('auth') ?? {}
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)

  return withDumpExceptionCleanup(dump, async () => {
    const reject = (message: string, status = 400) => {
      dump?.failed(message)
      return wrapResponse(dump, errorResponse('invalid_request_error', message, status))
    }
    let parsed: ParsedDecisionRequest
    try {
      let json: unknown
      try {
        json = parseJSONWithRawNumbers(new TextDecoder().decode(requestBody.bytes))
      } catch {
        throw new Error('Decision request body must be valid JSON')
      }
      parsed = parseDecisionRequest(sourceProtocol, json)
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error))
    }
    dump?.requestedModel(parsed.model)

    const resolved = resolveKeyModel(parsed.model, auth.routingPolicy)
    const binding = await resolveBinding(resolved.routedModel, 'decision', {
      dump,
      ownerId: auth.userId,
      upstreamIds: auth.routingPolicy?.upstreamIds,
      copilot: auth.copilot,
      pin: resolved.upstreamPin,
    })
    const modelKey = binding ? binding.model.providerModelKey ?? binding.model.id : resolved.routedModel
    const target = binding?.provider.decisionProtocol?.(modelKey)
    if (!binding || !target) {
      return reject(`No decision upstream available for model: ${resolved.routedModel}. Run GET /v1/models for available ids.`, 404)
    }

    // A request the model's dialect cannot express is the caller's to fix, so it
    // fails here, before the upstream is billed for it.
    let payload: Record<string, unknown>
    try {
      payload = serializeDecisionRequest(target, modelKey, parsed.request)
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error))
    }

    let attempt: Awaited<ReturnType<typeof runDecisionAttempt>>
    try {
      attempt = await runDecisionAttempt({
        apiKeyId: auth.apiKeyId,
        incomingModel: resolved.incomingModel,
        model: binding.model.id,
        modelKey,
        pricing: binding.provider.getPricingForModelKey(modelKey),
        upstream: binding.upstream,
        userAgent: c.req.header('user-agent') ?? undefined,
        requestId: c.req.header('x-request-id') ?? undefined,
        dump,
        call: async () => {
          const pr = await binding.provider.fetch({
            endpoint: 'decision',
            payload,
            headers: new Headers({ 'content-type': 'application/json' }),
            sourceApi: 'openai',
            operationName: 'create decision',
            flags: { isStreaming: false },
          })
          return new Response(pr.body, { status: pr.status, headers: pr.headers })
        },
      })
    } catch (err) {
      if (!(err instanceof HTTPError) || !err.response) throw err
      return wrapResponse(dump, await forwardUpstreamError(err.response, 'chat_completions'))
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
    if (!attempt.ok) return wrapResponse(dump, await forwardUpstreamError(attempt.response, 'chat_completions'))

    if (target === sourceProtocol) return wrapResponse(dump, jsonResponse(attempt.text, attempt.status))
    // A cross-dialect client cannot read the model's own answer, so a body
    // that does not translate is a gateway failure, never a forwarded success.
    try {
      if (!attempt.body) throw new Error('Decision upstream returned a body that is not a JSON object')
      const rendered = renderDecisionResponse(sourceProtocol, parseDecisionResponse(target, attempt.body))
      return wrapResponse(dump, jsonResponse(JSON.stringify(rendered), attempt.status))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dump?.failed(message)
      return wrapResponse(dump, errorResponse('api_error', message, 502))
    }
  })
}

decisionRouter.post('/v1/systemone', c => decisionHandler(c, 'typesafe-systemone'))
decisionRouter.post('/systemone', c => decisionHandler(c, 'typesafe-systemone'))
decisionRouter.post('/v1/decisions', c => decisionHandler(c, 'openai-decisions'))
decisionRouter.post('/decisions', c => decisionHandler(c, 'openai-decisions'))
