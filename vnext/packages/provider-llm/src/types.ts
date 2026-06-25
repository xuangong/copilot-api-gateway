/**
 * @vibe-llm/provider-llm/types — LLM business overlay over the framework
 * UpstreamAdapter contract from @vibe-core/upstream.
 *
 * Re-exports framework transport shapes so consumers don't need a second
 * import line. Defines the LLM-coupled request shapes (ProviderRequest /
 * ProviderRequestFlags / SourceApi) that carry EndpointKey and the three
 * source APIs. Defines LlmModelProvider — the business contract every
 * @vibe-llm/provider-* package implements.
 */
import type {
  ProbeResult,
  ProviderModelsResponse,
  ProviderResponse,
  UpstreamAdapter,
} from '@vibe-core/upstream'
import type { EndpointKey, ModelPricing, UpstreamKind } from '@vibe-llm/protocols/common'

export type { UpstreamKind }
export type { ProbeResult, ProviderModelsResponse, ProviderResponse }

export type SourceApi = 'anthropic' | 'openai' | 'gemini'

export interface ProviderRequestFlags {
  isStreaming: boolean
  hasWebSearch?: boolean
  hasImageGen?: boolean
}

export interface ProviderRequest {
  endpoint: EndpointKey
  /** Schema-validated JSON object. NOT a string. Interceptors mutate fields directly. */
  payload: unknown
  /** Mutable along the interceptor chain. Terminal HTTP reads the final state. */
  headers: Headers
  sourceApi: SourceApi
  flags?: ProviderRequestFlags
  signal?: AbortSignal
  /** Optional log-friendly label. Defaults to `call ${endpoint}` in the provider. */
  operationName?: string
  /** Defaults to true. Copilot-specific: count_tokens is the only endpoint where model is optional. Other providers ignore this field. */
  requireModel?: boolean
  /** Per-call timeout override in ms. */
  timeout?: number
}

/**
 * LlmModelProvider — extends framework UpstreamAdapter with the three
 * LLM-specific guarantees the gateway routing layer relies on:
 *   - kind: the UpstreamKind discriminator for plugin lookup
 *   - supportedEndpoints: the catalog of EndpointKeys this provider serves
 *   - getPricingForModelKey: per-model pricing resolver (returns null when
 *     this provider has no opinion — caller persists null unit_price).
 * Also narrows fetch's request type from `unknown` to `ProviderRequest`.
 */
export interface LlmModelProvider extends UpstreamAdapter {
  readonly kind: UpstreamKind
  readonly supportedEndpoints: readonly EndpointKey[]
  getPricingForModelKey(modelKey: string): ModelPricing | null
  fetch(req: ProviderRequest): Promise<ProviderResponse>
}
