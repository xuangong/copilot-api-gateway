/**
 * Provider binding — the four-tuple that a request planner consumes.
 *
 * Ported verbatim from old src/providers/binding.ts (logic unchanged).
 * A binding answers: "for this requested model, which provider should I
 * dispatch to, on which endpoint, with which flags effective?"
 */
import type { EndpointKey, ModelKind, ModelPricing, UpstreamKind } from '@vnext/protocols/common'
import { endpointCompatibleWithKind } from '@vnext/protocols/common'
import type { ModelProvider } from '../providers/types.ts'

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

export function bindingServesEndpoint(
  binding: ProviderBinding,
  endpoint: EndpointKey,
): boolean {
  if (!binding.upstreamEndpoints.includes(endpoint)) return false
  const kind = binding.model.kind
  if (!kind) return true
  return endpointCompatibleWithKind(endpoint, kind)
}

export function bindingsForEndpoint(
  bindings: readonly ProviderBinding[],
  endpoint: EndpointKey,
): ProviderBinding[] {
  return bindings.filter((b) => bindingServesEndpoint(b, endpoint))
}
