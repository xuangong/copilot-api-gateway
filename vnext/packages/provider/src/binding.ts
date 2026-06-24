/**
 * ProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call ModelProvider instance. The shape every routing
 * helper (`enumerateBindingCandidates`, `resolveBinding`, ...) operates on.
 *
 * Spec 9 Part 1: now extends the framework `UpstreamBinding<TAdapter>` so
 * the field that carries the adapter (`.provider`) is inherited unchanged —
 * no consumer call site is touched. Business-only fields (kind, model)
 * stay on the local extension and will follow `ModelProvider` into
 * @vnext-llm/provider-llm during Part 2.
 */
import type { UpstreamBinding } from '@vnext-gateway/upstream'
import type { ModelEndpoints, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'
import type { ModelProvider } from './types'

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

export interface ProviderBinding extends UpstreamBinding<ModelProvider> {
  kind: UpstreamKind
  model: BindingModel
}
