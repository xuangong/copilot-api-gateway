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
import type { ModelPricing } from '@vibe-llm/protocols/common'
import { checkQuota } from '../../../shared/observability/quota.ts'
import {
  recordLatency,
  startTimer,
} from '../../../shared/observability/latency-tracker.ts'
import { detectClient } from '../../../shared/observability/client-detect.ts'
import { extractFromJson, pickUsageModelId } from '../../../shared/observability/usage-extractor.ts'
import { getRepo } from '../../../shared/repo/index.ts'
import type { TokenUsage, UsageRecord } from '../../../shared/repo/types.ts'

const currentHour = (): string => new Date().toISOString().slice(0, 13)

const hasAnyTokens = (usage: TokenUsage): boolean => {
  for (const value of Object.values(usage)) {
    if ((value ?? 0) > 0) return true
  }
  return false
}

/**
 * Inlined from the deleted `shared/observability/usage-tracker.ts` (Spec 3
 * Part 4). Embeddings is the last consumer of the legacy non-streaming usage
 * writer — Spec 3 migrated chat-flow off this helper into
 * `chat-flow/shared/respond-telemetry.ts`. We keep the same wire shape here
 * (model coalescing via `pickUsageModelId`, hour-bucket key, paired
 * `apiKeys.touchLastUsed`) so embeddings rows look identical to the legacy
 * pipeline.
 */
async function trackNonStreamingUsage(
  json: unknown,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Promise<void> {
  const info = extractFromJson(json)
  if (!info) return
  if (!hasAnyTokens(info.tokens)) return
  const rec: UsageRecord = {
    keyId,
    model: pickUsageModelId(info.model, model),
    modelKey,
    upstream,
    client,
    hour: currentHour(),
    requests: 1,
    tokens: info.tokens,
    cost: pricing,
  }
  const repo = getRepo()
  await Promise.all([
    repo.usage.record(rec),
    repo.apiKeys.touchLastUsed(keyId),
  ])
}

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
