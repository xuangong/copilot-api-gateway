/**
 * embeddings-attempt — gateway-layer observability scaffolding around a single
 * embeddings upstream call. Embeddings is point-to-point (sourceApi ===
 * targetApi === 'embeddings') and never streams.
 *
 * Behavior preserved verbatim from data-plane/embeddings/routes.ts handle():
 *   - Quota gate before timer.
 *   - On success: trackNonStreamingUsage (note: embeddings carry prompt_tokens
 *     only) + recordLatency with sourceApi='embeddings'+targetApi='embeddings'
 *     so the perf fan-out fires.
 *   - On non-2xx: error-tagged latency, sourceApi/targetApi omitted to mirror
 *     the existing route's error path.
 *   - apiKeyId undefined → all observability skipped, upstream still fires.
 *
 * Caller still handles request validation (model field, JSON parse, upstream
 * pin strip) and the binding resolution; this module only wraps the call site.
 */
import type { ModelPricing } from '@vnext/protocols/common'
import { checkQuota } from '../../../shared/observability/quota.ts'
import {
  recordLatency,
  startTimer,
} from '../../../shared/observability/latency-tracker.ts'
import { trackNonStreamingUsage } from '../../../shared/observability/usage-tracker.ts'
import { detectClient } from '../../../shared/observability/client-detect.ts'

export interface EmbeddingsAttemptInput {
  apiKeyId: string | undefined
  model: string
  /** Raw upstream model id — same value handed to provider for pricing lookup. */
  modelKey: string
  /** Pre-resolved pricing snapshot from `provider.getPricingForModelKey(modelKey)`. */
  pricing: ModelPricing | null
  upstream: 'github_copilot'
  userAgent: string | undefined
  requestId: string | undefined
  /** Wraps the upstream call. Caller builds the request body / picks the binding. */
  call: () => Promise<Response>
}

export type EmbeddingsAttemptResult =
  | { ok: true; status: number; response: Response; json: unknown }
  | { ok: false; status: 429; rateLimit: { reason: string; retryAfterSeconds?: number } }
  | { ok: false; status: number; response: Response }

export async function runEmbeddingsAttempt(
  input: EmbeddingsAttemptInput,
): Promise<EmbeddingsAttemptResult> {
  const client = detectClient(input.userAgent)

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

  // Success path — parse body once so the caller can forward verbatim and we
  // can extract usage from the same JSON.
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
        sourceApi: 'embeddings',
        targetApi: 'embeddings',
        upstream: input.upstream,
        userAgent: input.userAgent,
      },
    )
  }
  return { ok: true, status: res.status, response: res, json }
}
