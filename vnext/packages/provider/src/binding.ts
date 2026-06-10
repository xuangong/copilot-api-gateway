/**
 * ProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call ModelProvider instance. The shape every routing
 * helper (`bindingsForEndpoint`, `resolveBinding`, ...) operates on.
 */
import type { EndpointKey, ModelKind, ModelPricing, UpstreamKind } from '@vnext/protocols/common'
import type { ModelProvider } from './types'

/** Per-binding model metadata. */
export interface BindingModel {
  id: string
  displayName?: string
  ownedBy?: string
  created?: number
  kind?: ModelKind
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
  upstreamEndpoints: readonly EndpointKey[]
  enabledFlags: ReadonlySet<string>
  provider: ModelProvider
}
