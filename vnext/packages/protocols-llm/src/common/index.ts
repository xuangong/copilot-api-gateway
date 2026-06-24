/**
 * Endpoint and model-kind taxonomy shared by all protocols.
 * Sourced verbatim from old src/protocols/common/index.ts; keep both in sync
 * until the old code is retired (shared D1 means schema drift is dangerous).
 */

export type UpstreamKind = 'copilot' | 'custom' | 'azure' | 'sdf'

export type EndpointKey =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'messages_count_tokens'
  | 'embeddings'
  | 'images_generations'
  | 'images_edits'

export const ALL_ENDPOINT_KEYS = [
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
] as const satisfies readonly EndpointKey[]

export type ModelKind = 'chat' | 'embedding' | 'image'

export const ALL_MODEL_KINDS = ['chat', 'embedding', 'image'] as const satisfies readonly ModelKind[]

export const ENDPOINTS_BY_MODEL_KIND: Record<ModelKind, readonly EndpointKey[]> = {
  chat: ['chat_completions', 'responses', 'messages', 'messages_count_tokens'],
  embedding: ['embeddings'],
  image: ['images_generations', 'images_edits'],
}

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

export type { SseFrame, SseCommentFrame, SseWritableFrame, EventFrame, DoneFrame, ProtocolFrame } from './sse'
export { sseFrame, sseCommentFrame, eventFrame, doneFrame } from './sse'

export type {
  LlmEventResult,
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
  llmInternalErrorResult,
  readUpstreamError,
  upstreamErrorToResponse,
  decodeUpstreamErrorBody,
} from './result'

export * from '@vnext-gateway/result/parse'

export * from './invocation'
