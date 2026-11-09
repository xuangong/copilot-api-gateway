/**
 * Endpoint and model-kind taxonomy shared by all protocols.
 * Sourced verbatim from old src/protocols/common/index.ts; keep both in sync
 * until the old code is retired (shared D1 means schema drift is dangerous).
 */

export type UpstreamKind = 'copilot' | 'custom' | 'azure' | 'sdf' | 'codex' | 'claude-code' | 'loki'

export type EndpointKey =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'messages_count_tokens'
  | 'embeddings'
  | 'images_generations'
  | 'images_edits'
  | 'alpha_search'
  | 'decision'

export const ALL_ENDPOINT_KEYS = [
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
  'alpha_search',
  'decision',
] as const satisfies readonly EndpointKey[]

export type ModelKind = 'chat' | 'embedding' | 'image' | 'decision'

export const ALL_MODEL_KINDS = ['chat', 'embedding', 'image', 'decision'] as const satisfies readonly ModelKind[]

export const ENDPOINTS_BY_MODEL_KIND: Record<ModelKind, readonly EndpointKey[]> = {
  chat: ['chat_completions', 'responses', 'messages', 'messages_count_tokens', 'alpha_search'],
  embedding: ['embeddings'],
  image: ['images_generations', 'images_edits'],
  decision: ['decision'],
}

/**
 * Wire dialect of a decision model, which answers typed questions with
 * probabilities instead of generating text. One `decision` endpoint covers
 * both: the dialect belongs to each model, and the gateway translates between
 * them, so either ingress reaches any decision model.
 *   - `typesafe-systemone`: TypeSafe's `POST /v1/systemone` (`state` plus a
 *     name-keyed `questions` map), spoken by Copilot's microsoft-decision-1.
 *   - `openai-decisions`: OpenAI's `POST /v1/decisions` (`input` plus a
 *     `questions` array), spoken by Copilot's gpt-6-luna-decisions.
 */
export type DecisionProtocol = 'typesafe-systemone' | 'openai-decisions'

export function endpointCompatibleWithKind(endpoint: EndpointKey, kind: ModelKind): boolean {
  return ENDPOINTS_BY_MODEL_KIND[kind].includes(endpoint)
}

export type BillingDimension =
  | 'input'
  | 'input_cache_read'
  | 'input_cache_write'
  | 'input_image'
  | 'output'
  | 'output_image'

export const BILLING_DIMENSIONS: readonly BillingDimension[] = [
  'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image',
]

/** USD per million tokens, per billing dimension. Aligned with sst/models.dev `Cost`. */
export type ModelPricing = Partial<Record<BillingDimension, number>>

/**
 * Resolve unit price for a dimension with fallback chain:
 *   input_cache_read / input_cache_write / input_image → input
 *   output_image → output
 * Returns null if neither the dimension nor its fallback is set.
 */
export function unitPriceForDimension(
  pricing: ModelPricing | null,
  dimension: BillingDimension,
): number | null {
  if (!pricing) return null
  switch (dimension) {
    case 'input':            return pricing.input ?? null
    case 'input_cache_read': return pricing.input_cache_read ?? pricing.input ?? null
    case 'input_cache_write': return pricing.input_cache_write ?? pricing.input ?? null
    case 'input_image':      return pricing.input_image ?? pricing.input ?? null
    case 'output':           return pricing.output ?? null
    case 'output_image':     return pricing.output_image ?? pricing.output ?? null
  }
}

/** Client-visible protocol families. */
export type ClientProtocol = 'messages' | 'chat' | 'responses' | 'gemini'

export type { ModelEndpoints } from './model-endpoints'
export { kindForEndpoints } from './model-endpoints'

export type { UpstreamRecord } from './upstream'

export type { AccountType } from './account-type'

export type {
  LlmEventResult,
  NativeLlmEventResult,
  TranslatedLlmEventResult,
  TranslatedProducerProtocol,
  TranslatorProtocol,
  UpstreamErrorResult,
  InternalErrorResult,
  LlmExecuteResult,
  TelemetryModelIdentity,
  PerformanceTelemetryContext,
  EventResultMetadata,
  TranslateBodyContext,
} from './result'
export {
  llmEventResult,
  eventProducerProtocol,
  assertNativeEventResult,
  llmInternalErrorResult,
  readUpstreamError,
  upstreamErrorToResponse,
  decodeUpstreamErrorBody,
} from './result'

export * from './invocation'

export {
  decodeOpaqueValue,
  encodeOpaqueValue,
  appendOpaqueTrailer,
  splitOpaqueTrailer,
  concatBytes,
  uint16be,
  MAX_OPAQUE_TRAILER_BYTES,
  type OpaqueValueOrigin,
  type DecodedOpaqueValue,
  type SplitOpaqueTrailer,
} from './opaque-value'

export { isOpenAIUsageOnlyEventShape } from './openai-stream'

export * from './performance-metrics'
