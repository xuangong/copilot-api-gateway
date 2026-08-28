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
import type {
  EndpointKey,
  ModelPricing,
  ResponsesStreamInterceptor,
  UpstreamKind,
} from '@vibe-llm/protocols/common'

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
  /**
   * Semantic verb forwarded from `Invocation.action`. Providers that expose a
   * distinct compaction wire (codex `/responses/compact`) dispatch on this;
   * providers that don't (copilot / openai-style) ignore it — the compact-shim
   * has already rewritten the payload into a plain generate turn before
   * reaching the provider. `undefined` ≡ `'generate'`.
   */
  action?: 'generate' | 'compact'
}

/**
 * A client-authored header name this provider can consume. Strings are exact,
 * ASCII-case-insensitive names; regular expressions run against the normalized
 * lowercase name.
 */
export type InboundHeaderMatcher = string | RegExp

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
  /**
   * Client headers this provider is allowed to see on `ProviderRequest.headers`.
   * The gateway filters the inbound request through this list at the binding
   * boundary, so a provider that omits it receives no client headers at all —
   * the default, and the status quo for every provider but claude-code, which
   * needs the caller's own Claude Code fingerprint to survive to the wire.
   */
  readonly inboundHeaderAllowlist?: readonly InboundHeaderMatcher[]
  /**
   * Frame-level Responses interceptors this provider needs. The gateway appends
   * them at the innermost position of the shared `/v1/responses` chain, so they
   * wrap the terminal directly and never observe frames synthesized by outer
   * shims (the server-tool ReAct loop, the compact shim).
   *
   * This is vNext's stand-in for the reference project's in-provider boundary
   * chain. There, `callResponses` returns parsed events, so a provider can run
   * its own frame interceptors internally. Here the provider contract is
   * byte-level (`fetch -> ProviderResponse`) and SSE parsing happens gateway-side
   * in `responses/attempt.ts`, so anything needing frames has to run there — but
   * it stays *declared* by the provider, which keeps it scoped to that upstream
   * instead of being applied to every one.
   *
   * Distinct from a provider's internal payload/header chain (e.g. Copilot's
   * `responsesChain`), which mutates the outgoing request and never sees a
   * response.
   */
  readonly responsesInterceptors?: readonly ResponsesStreamInterceptor[]
}
