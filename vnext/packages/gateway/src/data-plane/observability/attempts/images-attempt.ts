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
import { checkQuota } from '../../../shared/observability/quota.ts'
import {
  recordLatency,
  startTimer,
} from '../../../shared/observability/latency-tracker.ts'

export interface ImagesAttemptInput {
  apiKeyId: string | undefined
  model: string
  upstream: 'github_copilot'
  userAgent: string | undefined
  requestId: string | undefined
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
    return { ok: false, status: res.status, response: res }
  }
  return { ok: true, status: res.status, response: res }
}
