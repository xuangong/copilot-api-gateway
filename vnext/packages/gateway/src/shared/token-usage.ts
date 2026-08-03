/**
 * Ported from copilot-gateway data-plane/shared/telemetry/usage.ts — ONLY the
 * two symbols the image_generation server-tool plugin imports:
 *   - `tokenUsageFromImagesBody` (pure parser, 1:1 port)
 *   - `recordTokenUsage`         (adapted to vNext's UsageRecord shape)
 *
 * vNext deviations from the reference:
 *  1. No pricing pipeline (`priceRequest`, `canonicalDecimalString`,
 *     `PricingRuntimeFacts`, `usageMetrics`). The reference project computes
 *     per-dimension costs at write time from a shared pricing catalog; vNext
 *     freezes `ModelPricing` on the TelemetryModelIdentity and writes it into
 *     the row via `cost` for reconstruction at read time.
 *  2. `UsageRecord` requires `client` (SDK distinguisher, e.g. from user-agent
 *     detection). Server-tool dispatch has no request user-agent in scope
 *     (the tool runs mid-response, decoupled from the inbound HTTP request),
 *     so we record '' — same sentinel `respond-telemetry.ts` uses when the
 *     detector returns nothing.
 *  3. No `apiKeys.touchLastUsed` here — the enclosing Responses request has
 *     already stamped it via the normal respond-telemetry path. A per-image
 *     touch would just add a redundant write.
 */
import type { ModelPricing } from '@vibe-llm/protocols/common'
import { getRepo } from './repo/index.ts'
import type { Repo, TokenUsage, UsageRecord } from './repo/types.ts'
import type { ApiKeyId } from './repo/branded-ids.ts'

const TOKEN_USAGE_KEYS = [
  'input',
  'input_cache_read',
  'input_cache_write',
  'input_image',
  'output',
  'output_image',
] as const satisfies readonly Exclude<keyof TokenUsage, never>[]

const tokenUsage = (counts: TokenUsage): TokenUsage => {
  const out: TokenUsage = {}
  for (const key of TOKEN_USAGE_KEYS) {
    const value = counts[key] ?? 0
    if (value > 0) out[key] = value
  }
  return out
}

// OpenAI Images responses report usage as
// `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`,
// where the details objects split each total into `text_tokens` and
// `image_tokens`. We map that split onto the billing metrics: bare
// input/output for the text modality, input_image/output_image for the image
// modality. The details splits are disjoint and sum to their respective total.
//
// When a details object is missing but its total is present, the whole total is
// charged on the bare metric rather than inventing a split. A present field
// that is a non-number is treated as a malformed upstream payload (return
// null) rather than silently coerced.
export const tokenUsageFromImagesBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null
  const { usage } = body as { usage?: unknown }
  if (!usage || typeof usage !== 'object') return null
  const {
    input_tokens: inputTotal,
    output_tokens: outputTotal,
    input_tokens_details: inputDetails,
    output_tokens_details: outputDetails,
  } = usage as ImagesUsageShape

  if (inputTotal !== undefined && typeof inputTotal !== 'number') return null
  if (outputTotal !== undefined && typeof outputTotal !== 'number') return null
  if (inputTotal === undefined && outputTotal === undefined) return null

  const input = splitModalityCounts('input', 'input_image', inputTotal, inputDetails)
  if (input === null) return null
  const output = splitModalityCounts('output', 'output_image', outputTotal, outputDetails)
  if (output === null) return null

  return tokenUsage({ ...input, ...output })
}

interface ImagesUsageShape {
  input_tokens?: unknown
  output_tokens?: unknown
  input_tokens_details?: unknown
  output_tokens_details?: unknown
}

const splitModalityCounts = (
  textDimension: keyof TokenUsage,
  imageDimension: keyof TokenUsage,
  total: number | undefined,
  details: unknown,
): TokenUsage | null => {
  if (total === undefined) return {}
  if (details === undefined) return { [textDimension]: total }
  if (!details || typeof details !== 'object') return null
  const { text_tokens: text, image_tokens: image } = details as {
    text_tokens?: unknown
    image_tokens?: unknown
  }
  if (text !== undefined && typeof text !== 'number') return null
  if (image !== undefined && typeof image !== 'number') return null
  // A details object that carries neither split is as good as absent.
  if (text === undefined && image === undefined) return { [textDimension]: total }
  return { [textDimension]: text ?? 0, [imageDimension]: image ?? 0 }
}

export interface ImageUsageModelIdentity {
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  readonly cost: ModelPricing | null
}

const nonZero = (tokens: TokenUsage): boolean => {
  for (const key in tokens) {
    if ((tokens as Record<string, number | undefined>)[key]) return true
  }
  return false
}

const currentHour = (): string => new Date().toISOString().slice(0, 13)

/**
 * Persist a usage row for a standalone image backend call issued by the
 * image_generation server-tool shim. No-op when usage is empty or unparseable.
 */
export const recordTokenUsage = async (
  apiKeyId: ApiKeyId,
  modelIdentity: ImageUsageModelIdentity,
  usage: TokenUsage | null,
  repo: Repo = getRepo(),
): Promise<void> => {
  if (usage === null) return
  const tokens = tokenUsage(usage)
  if (!nonZero(tokens)) return
  const row: UsageRecord = {
    keyId: apiKeyId,
    model: modelIdentity.model,
    modelKey: modelIdentity.modelKey,
    upstream: modelIdentity.upstream,
    client: '',
    hour: currentHour(),
    requests: 1,
    tokens,
    cost: modelIdentity.cost,
  }
  await repo.usage.record(row)
}
