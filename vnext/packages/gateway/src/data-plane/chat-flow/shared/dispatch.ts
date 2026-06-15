// packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
/**
 * Generic chat-flow orchestrator: rawJson → parse → preprocess → postParse
 * → enumerate → translate → call → render. No Hono dependency — the caller
 * (http.ts handlers) is responsible for c.req.json() + invalid-JSON 400.
 */
import type { EndpointKey, ModelEndpoints } from '@vnext/protocols/common'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { selectPair, type SourceApi } from '../../dispatch/pair-selector.ts'
import { getTranslator, type TranslateContext } from '../../dispatch/translator-registry.ts'
import { encodeClientSSE } from '../../dispatch/sse-writers.ts'
import { parseModelRouting } from '../../routing/binding-resolver.ts'
import { enumerateBindingCandidates } from '../../routing/candidates.ts'
import {
  repackageUpstreamError,
  renderPreviousResponseNotFound,
  type SourceApi as ErrorSourceApi,
} from '../../errors/repackage.ts'
import { PreviousResponseNotFoundError } from '../../dispatch/responses-store-bridge.ts'
import { runConversationAttempt } from '../../observability/attempts/conversation-attempt.ts'
import type {
  SourceApiInput,
  TargetApiInput,
} from '../../../shared/observability/latency-tracker.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { parseTargetSSE, mapSourceApiToProviderRequest } from './sse-readers.ts'
import type { DispatchObsCtx } from './obs-ctx.ts'

export type { DispatchObsCtx }

export interface DispatchInput<TPayload> {
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

export async function dispatch<TPayload>(
  rawJson: unknown,
  input: DispatchInput<TPayload>,
): Promise<Response> {
  let payload: TPayload
  try { payload = input.parse(rawJson) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return input.errorWrap(
      e.status ?? 400,
      e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } },
    )
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

  let isStream: boolean
  if (typeof input.forceStream === 'boolean') {
    isStream = input.forceStream
  } else {
    const upstreamObj = upstreamPayload as { stream?: unknown } | null
    isStream = upstreamObj?.stream === true
  }

  let attempt: Awaited<ReturnType<typeof runConversationAttempt>>
  try {
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
  let clientBody: unknown
  try {
    clientBody = await translator.translateBody(attempt.json, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'translation error'
    return input.errorWrap(502, { error: { type: 'api_error', message } })
  }
  return Response.json(clientBody)
}
