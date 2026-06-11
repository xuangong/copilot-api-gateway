/**
 * ProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call ModelProvider instance. The shape every routing
 * helper (`enumerateBindingCandidates`, `resolveBinding`, ...) operates on.
 *
 * Plan 2 (Task #27) cutover:
 *   - `BindingModel.endpoints: ModelEndpoints` is now the single source of
 *     truth for per-model endpoint capability.
 *   - `BindingModel.kind` is removed; consumers derive via kindForEndpoints.
 *   - `ProviderBinding.upstreamEndpoints` is removed.
 */
import type { ModelEndpoints, ModelPricing, UpstreamKind } from '@vnext/protocols/common'
import type { ModelProvider } from './types'

/** Per-binding model metadata. */
export interface BindingModel {
  id: string
  displayName?: string
  ownedBy?: string
  created?: number
  endpoints: ModelEndpoints
  limits?: {
    maxOutputTokens?: number
    maxContextWindowTokens?: number
    maxPromptTokens?: number
  }
  cost?: ModelPricing
}

export interface ProviderBinding {
  upstream: string
  kind: UpstreamKind
  model: BindingModel
  enabledFlags: ReadonlySet<string>
  provider: ModelProvider
}
