/**
 * decision-attempt — gateway-layer observability scaffolding around a single
 * decision upstream call, the same shape as `images-attempt.ts`: quota → start
 * timer → call → usage + latency.
 *
 * Decision-specific:
 *   - The successful body is read as text and parsed with raw numbers, so the
 *     route can forward it byte for byte or translate it without rewriting a
 *     probability's digits. A body that does not parse is still returned; the
 *     route decides whether it can be forwarded.
 *   - Decision models are billed on input tokens only (the reference's rule):
 *     their output is a handful of probabilities, not generated text.
 *   - sourceApi/targetApi are omitted, so the perf fan-out is skipped as it is
 *     for images (the perf schema has no decision enum).
 *   - apiKeyId undefined → all observability skipped, upstream still fires.
 */
import { parseJSONWithRawNumbers } from '@vibe-llm/protocols/json'
import { parseDecisionUsage } from '@vibe-llm/protocols/decision'
import type { ModelPricing } from '@vibe-llm/protocols/common'
import { checkQuota } from '../quota.ts'
import { recordLatency, startTimer } from '../latency-tracker.ts'
import { detectClient } from '../client-detect.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'
import type { TokenUsage } from '../../../repo/types.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'
import { recordTokenUsage } from '../../shared/token-usage.ts'

export interface DecisionAttemptInput {
  apiKeyId: ApiKeyId | undefined
  /** Normalized client model before API-key mapping. */
  incomingModel: string
  model: string
  /** Raw upstream model id — same value handed to provider for pricing lookup. */
  modelKey: string
  /** Pre-resolved pricing snapshot from `provider.getPricingForModelKey(modelKey)`. */
  pricing: ModelPricing | null
  /** Upstream id from the resolved binding. */
  upstream: string
  userAgent: string | undefined
  requestId: string | undefined
  /** Per-request dump sink; null when the api key has no retention. */
  dump: DumpAccumulator | null
  /** Wraps the upstream call. Caller builds the request body / picks the binding. */
  call: () => Promise<Response>
}

export type DecisionAttemptResult =
  /** `body` is null when the upstream's 2xx body is not a JSON object. */
  | { ok: true; status: number; response: Response; text: string; body: Record<string, unknown> | null }
  | { ok: false; status: 429; rateLimit: { reason: string; retryAfterSeconds?: number } }
  | { ok: false; status: number; response: Response }

const parseBody = (text: string): Record<string, unknown> | null => {
  try {
    const value = parseJSONWithRawNumbers(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function runDecisionAttempt(input: DecisionAttemptInput): Promise<DecisionAttemptResult> {
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
  const latency = async (isError: boolean) => {
    if (!input.apiKeyId) return
    await recordLatency(
      input.apiKeyId,
      input.model,
      'local',
      { totalMs: elapsed(), upstreamMs: Date.now() - upstreamStart, ttfbMs: 0, tokenMiss: false },
      input.requestId,
      { isError, upstream: input.upstream, userAgent: input.userAgent },
    )
  }

  let res: Response
  try {
    res = await input.call()
  } catch (err) {
    input.dump?.error('upstream', input.upstream)
    input.dump?.failed(err)
    await latency(true)
    throw err
  }
  await latency(!res.ok)

  if (!res.ok) {
    input.dump?.error('upstream', input.upstream)
    return { ok: false, status: res.status, response: res }
  }

  const text = await res.text()
  const body = parseBody(text)
  const inputTokens = body ? parseDecisionUsage(body).inputTokens : undefined
  const usage: TokenUsage | null = inputTokens === undefined ? null : { input: inputTokens }
  if (input.apiKeyId) {
    try {
      await recordTokenUsage(input.apiKeyId, {
        incomingModel: input.incomingModel,
        model: input.model,
        upstream: input.upstream,
        modelKey: input.modelKey,
        cost: input.pricing,
        client: detectClient(input.userAgent),
      }, usage)
    } catch {
      // Telemetry must not change the upstream response delivered to the client.
    }
  }
  input.dump?.success(
    {
      incomingModel: input.incomingModel,
      model: input.model,
      upstream: input.upstream,
      modelKey: input.modelKey,
      cost: input.pricing,
    },
    usage,
  )
  return { ok: true, status: res.status, response: res, text, body }
}
