/**
 * conversation-attempt — extracts the inline observability scaffolding that
 * dispatch() in `data-plane/routes.ts` had grown around a single upstream call.
 *
 * Why this lives in `data-plane/observability/attempts/` and not in
 * `shared/observability/`: the attempt module is a gateway-layer composition
 * concern (quota gate → start timer → call → record latency → tap usage),
 * NOT a primitive observability hook. The shared/* modules expose the hooks;
 * this file orchestrates them around one upstream conversational request.
 *
 * Phase A keeps the module consuming a `Response` directly (the existing
 * call shape from `binding.provider.fetch`); Phase B will introduce a parallel
 * overload that takes the typed `UpstreamResponse` from per-endpoint methods.
 *
 * Behavior preserved verbatim from the inline version it replaces:
 *   - Quota gate fires BEFORE the timer starts; rejection short-circuits
 *     observability writes (no latency row for a 429).
 *   - Both the throw path and the !response.ok path write an error-tagged
 *     latency row (request_total only, no upstream_success).
 *   - Streaming success wraps the response body via trackStreamingUsage so
 *     the SSE tee drains tokens; non-streaming success awaits trackNonStreamingUsage.
 *   - Latency recorded with stream + sourceApi + targetApi only on success
 *     (matches the existing perf fan-out invariant).
 *   - apiKeyId === undefined skips every observability hook; upstream still fires.
 */
import type { ModelPricing } from '@vnext/protocols/common'
import { checkQuota } from '../../../shared/observability/quota.ts'
import {
  recordLatency,
  startTimer,
  type SourceApiInput,
  type TargetApiInput,
} from '../../../shared/observability/latency-tracker.ts'
import {
  trackNonStreamingUsage,
  trackStreamingUsage,
} from '../../../shared/observability/usage-tracker.ts'
import { detectClient } from '../../../shared/observability/client-detect.ts'

export interface ConversationAttemptInput {
  apiKeyId: string | undefined
  model: string
  /**
   * Raw upstream model id used as the pricing-lookup key (post upstream-pin
   * strip). Persisted alongside the usage row so aggregate.ts can recover the
   * pricing snapshot deterministically.
   */
  modelKey: string
  /**
   * Pre-resolved pricing snapshot from `provider.getPricingForModelKey(modelKey)`.
   * `null` when the provider has no pricing entry for this key; the usage row
   * still writes the token columns, just without per-dimension unit prices.
   */
  pricing: ModelPricing | null
  sourceApi: SourceApiInput
  targetApi: TargetApiInput
  upstream: 'github_copilot'
  userAgent: string | undefined
  requestId: string | undefined
  stream: boolean
  /**
   * Wraps the upstream call. The caller decides streaming up-front because
   * the streaming flag shapes the upstream request — the attempt module just
   * fans out observability based on the same flag.
   */
  call: () => Promise<Response>
}

export type ConversationAttemptResult =
  | { ok: true; status: number; stream: true; response: Response }
  | { ok: true; status: number; stream: false; response: Response; json: unknown }
  | { ok: false; status: 429; rateLimit: { reason: string; retryAfterSeconds?: number } }
  | { ok: false; status: number; response: Response }

export async function runConversationAttempt(
  input: ConversationAttemptInput,
): Promise<ConversationAttemptResult> {
  const client = detectClient(input.userAgent)

  // 1. Quota gate — fires before any timer so a 429 carries no latency row.
  if (input.apiKeyId) {
    const quota = await checkQuota(input.apiKeyId)
    if (!quota.allowed) {
      return {
        ok: false,
        status: 429,
        rateLimit: {
          reason: quota.reason ?? 'Daily quota exceeded.',
          retryAfterSeconds: quota.retryAfterSeconds ?? undefined,
        },
      }
    }
  }

  const elapsed = startTimer()
  const upstreamStart = Date.now()
  let res: Response

  // 2. Upstream call. A throw before we get a Response still records an
  // error-tagged latency so the operator sees infra-level failures.
  try {
    res = await input.call()
  } catch (err) {
    const upstreamMs = Date.now() - upstreamStart
    if (input.apiKeyId) {
      await recordLatency(
        input.apiKeyId,
        input.model,
        'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        input.requestId,
        { isError: true, upstream: input.upstream, userAgent: input.userAgent },
      )
    }
    throw err
  }
  const upstreamMs = Date.now() - upstreamStart

  // 3. Non-2xx upstream. Same error-latency shape as the throw path; caller
  // decides whether to repackage the body via repackageUpstreamError.
  if (!res.ok) {
    if (input.apiKeyId) {
      await recordLatency(
        input.apiKeyId,
        input.model,
        'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        input.requestId,
        { isError: true, upstream: input.upstream, userAgent: input.userAgent },
      )
    }
    return { ok: false, status: res.status, response: res }
  }

  // 4. Streaming success: wrap body for usage tap, record latency now (the
  // tee fires fire-and-forget when the consumer drains the SSE).
  if (input.stream) {
    let response = res
    if (input.apiKeyId) {
      response = trackStreamingUsage(res, input.apiKeyId, input.model, client, input.upstream, input.modelKey, input.pricing)
      await recordLatency(
        input.apiKeyId,
        input.model,
        'local',
        { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
        input.requestId,
        {
          stream: true,
          sourceApi: input.sourceApi,
          targetApi: input.targetApi,
          upstream: input.upstream,
          userAgent: input.userAgent,
        },
      )
    }
    return { ok: true, status: res.status, stream: true, response }
  }

  // 5. Non-streaming success: parse JSON once, hand it back so the caller
  // can run backend.decodeBody on it; usage extracted from the same JSON.
  const json = await res.json()
  if (input.apiKeyId) {
    await trackNonStreamingUsage(json, input.apiKeyId, input.model, client, input.upstream, input.modelKey, input.pricing)
    await recordLatency(
      input.apiKeyId,
      input.model,
      'local',
      { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
      input.requestId,
      {
        stream: false,
        sourceApi: input.sourceApi,
        targetApi: input.targetApi,
        upstream: input.upstream,
        userAgent: input.userAgent,
      },
    )
  }
  return { ok: true, status: res.status, stream: false, response: res, json }
}
