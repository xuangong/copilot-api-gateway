/**
 * Shared quota gate for the four chat-flow `serve.ts` files (chat-completions,
 * messages, responses, gemini).
 *
 * Why a shared helper: legacy `dispatch()` ran the quota check inside
 * `runConversationAttempt` and rendered the 429 envelope inline. Spec 3
 * deletes that helper but still needs the per-key daily quota to be enforced
 * for the new chain. This module re-implements the same gate as a stand-alone
 * call so each new serve.ts can drop it in right after building the
 * TelemetryRequestContext, before any binding/upstream work.
 *
 * The 429 envelope uses the same `{error: {type: 'rate_limit_error',
 * message, retry_after_seconds?}}` shape legacy `dispatch.ts` emitted, so
 * SDK consumers see no behavioral change. Anthropic / Gemini envelope shapes
 * already deviate from spec for parity reasons in the legacy chain, and we
 * preserve that here.
 */
import { checkQuota } from '../../../shared/observability/quota.ts'

/**
 * Run the daily quota gate for the given apiKeyId. Returns:
 *   - `null` when the key is allowed (no row, no quota set, or under cap)
 *   - a `Response` with status 429 + the legacy `rate_limit_error` envelope
 *     when the quota is exceeded
 *
 * Callers gate on the apiKeyId before invoking — most paths skip the check
 * for anonymous requests (no apiKeyId) so dev/test traffic never hits the
 * repo. The check is async because checkQuota queries `repo.usage` to sum the
 * current UTC day's weighted tokens.
 *
 * Failure mode: when `checkQuota` throws (e.g. tests with stub repos that
 * omit `apiKeys.getById`), we treat the request as allowed. Legacy
 * `dispatch()` had the same fail-open posture — quota enforcement should
 * never crash the data-plane path; it can only deny it.
 */
export async function runQuotaGate(apiKeyId: string | null | undefined): Promise<Response | null> {
  if (!apiKeyId) return null
  let quota: Awaited<ReturnType<typeof checkQuota>>
  try {
    quota = await checkQuota(apiKeyId)
  } catch {
    return null
  }
  if (quota.allowed) return null
  const body = {
    error: {
      type: 'rate_limit_error',
      message: quota.reason ?? 'Daily quota exceeded.',
      ...(quota.retryAfterSeconds != null
        ? { retry_after_seconds: quota.retryAfterSeconds }
        : {}),
    },
  }
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  })
}
