/**
 * LlmProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call LlmModelProvider instance.
 *
 * Extends the framework UpstreamBinding<TAdapter> so the .provider field
 * is inherited unchanged and existing call sites (binding.provider.fetch)
 * keep working with no runtime rename.
 */
import type { UpstreamBinding } from '@vibe-core/upstream'
import type { ModelEndpoints, ModelPricing, UpstreamKind } from '@vibe-llm/protocols/common'
import type { LlmModelProvider } from './types'

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

export interface LlmProviderBinding extends UpstreamBinding<LlmModelProvider> {
  kind: UpstreamKind
  model: BindingModel
}
