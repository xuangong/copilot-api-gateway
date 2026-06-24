/**
 * @vnext-gateway/upstream — framework-level upstream adapter contract.
 *
 * Domain-neutral: a "general gateway/proxy" abstraction with zero LLM
 * concepts. Business overlays (e.g. @vnext-llm/provider-llm) extend
 * UpstreamAdapter with LLM-specific fields like kind/supportedEndpoints/
 * pricing and narrow `fetch`'s request type.
 */

export interface ProbeResult {
  ok: boolean
  status?: number
  modelCount?: number
  models?: string[]
  error?: string
  hint?: string
}

/** Minimal shape every UpstreamAdapter.getModels must satisfy. */
export interface ProviderModelsResponse {
  object: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Array<any>
}

export interface ProviderResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export interface UpstreamAdapter {
  readonly name: string
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  /**
   * Framework-level signature uses `unknown` so the framework does not
   * pull in business request types (EndpointKey, SourceApi, ...). Business
   * overlays narrow this to a concrete request type via interface extension.
   */
  fetch(req: unknown): Promise<ProviderResponse>
}
