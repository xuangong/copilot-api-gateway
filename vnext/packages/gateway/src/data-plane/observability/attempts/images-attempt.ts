/**
 * images-attempt — gateway-layer observability scaffolding around a single
 * image upstream call. Both `images_generations` and `images_edits` use the
 * same shape: quota → start timer → call → recordLatency. Images carry no
 * token usage and the body is forwarded verbatim to the client, so this
 * module does NOT parse the response — it just hands the Response back to
 * the caller and leaves the body forwarding decision (response.body + status
 * + headers vs. JSON re-serialization) to the route.
 *
 * Behavior preserved verbatim from data-plane/images/routes.ts:
 *   - Quota gate before timer.
 *   - recordLatency fires with `isError: !response.ok` regardless of outcome.
 *   - sourceApi/targetApi intentionally OMITTED so the perf fan-out is
 *     skipped (images don't have a meaningful target-api enum in the perf
 *     schema).
 *   - No usage tracking.
 *   - apiKeyId undefined → all observability skipped, upstream still fires.
 */
import { checkQuota } from '../../../data-plane/observability/quota.ts'
import {
  recordLatency,
  startTimer,
} from '../../../data-plane/observability/latency-tracker.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'
import type { ModelPricing } from '@vibe-llm/protocols/common'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

export interface ImagesAttemptInput {
  apiKeyId: ApiKeyId | undefined
  /** Normalized client model before API-key mapping. */
  incomingModel: string
  model: string
  /** Raw upstream model id — same value handed to provider for pricing lookup. */
  modelKey: string
  /** Pre-resolved pricing snapshot from `provider.getPricingForModelKey(modelKey)`. */
  pricing: ModelPricing | null
  /** Upstream id from the resolved binding — surfaces the real provider (custom/azure/sdf/copilot) in latency rows. */
  upstream: string
  userAgent: string | undefined
  requestId: string | undefined
  /** Per-request dump sink; null when the api key has no retention. */
  dump: DumpAccumulator | null
  /** Wraps the upstream call. Caller builds the request body / picks the binding. */
  call: () => Promise<Response>
}

export type ImagesAttemptResult =
  | { ok: true; status: number; response: Response }
  | { ok: false; status: 429; rateLimit: { reason: string; retryAfterSeconds?: number } }
  | { ok: false; status: number; response: Response }

export async function runImagesAttempt(
  input: ImagesAttemptInput,
): Promise<ImagesAttemptResult> {
  if (input.apiKeyId) {
    const quota = await checkQuota(input.apiKeyId)
    if (!quota.allowed) {
      input.dump?.error('gateway')
      input.dump?.failed(quota.reason ?? 'Daily quota exceeded.')
      return {
        ok: false,
        status: 429,
        rateLimit: {
          reason: quota.reason ?? 'Daily quota exceeded.',
          ...(quota.retryAfterSeconds !== undefined && quota.retryAfterSeconds !== null && { retryAfterSeconds: quota.retryAfterSeconds }),
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
    input.dump?.error('upstream', input.upstream)
    input.dump?.failed(err)
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

  if (input.apiKeyId) {
    await recordLatency(
      input.apiKeyId,
      input.model,
      'local',
      { totalMs: elapsed(), upstreamMs, ttfbMs: 0, tokenMiss: false },
      input.requestId,
      { isError: !res.ok, upstream: input.upstream, userAgent: input.userAgent },
    )
  }

  if (!res.ok) {
    input.dump?.error('upstream', input.upstream)
    return { ok: false, status: res.status, response: res }
  }
  input.dump?.success(
    {
      incomingModel: input.incomingModel,
      model: input.model,
      upstream: input.upstream,
      modelKey: input.modelKey,
      cost: input.pricing,
    },
    null,
  )
  return { ok: true, status: res.status, response: res }
}
