/**
 * @vibe-core/upstream — framework-level upstream adapter contract.
 *
 * Domain-neutral: a "general gateway/proxy" abstraction with zero LLM
 * concepts. Business overlays extend UpstreamAdapter with their
 * domain-specific fields and narrow `fetch`'s request type.
 */

import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'

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
   
  data: Array<any>
}

export interface ProviderResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

/**
 * Runtime-neutral storage shape for a configured upstream row.
 *
 * Business packages narrow `TProvider` to their provider-kind union while
 * credential-bearing providers narrow `TState` to their persisted state.
 */
export interface UpstreamRecord<TProvider extends string = string, TState = null> {
  id: string
  ownerId?: string
  provider: TProvider
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown>
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
  state: TState
  createdAt: string
  updatedAt: string
  /**
   * Ordered proxy fallback list — dispatcher tries entries in order after
   * (or instead of) direct runtime fetch. Empty array means "runtime fetch
   * only". Special IDs `direct_fetch` / `direct_connect` are recognised by
   * the dispatcher and do not resolve through the proxies table.
   */
  proxyFallbackList: ProxyFallbackEntry[]
}

export interface UpstreamAdapter {
  readonly name: string
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  /**
   * Framework-level signature uses `unknown` so the framework does not
   * pull in business request types. Business overlays narrow this to a
   * concrete request type via interface extension.
   */
  fetch(req: unknown): Promise<ProviderResponse>
}
