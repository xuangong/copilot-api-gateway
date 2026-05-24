/**
 * Provider binding — the four-tuple that a request planner consumes.
 *
 * A binding answers: "for this requested model, which provider should I
 * dispatch to, on which endpoint, with which flags effective?"
 *
 * The planner (phase 12) walks bindings in priority order, picking the
 * first one whose upstreamEndpoints satisfy the requested client protocol
 * after optional translation.
 *
 * Bindings are derived data — they are built fresh from the registry +
 * effective-flag resolver on each request. They do not need to be
 * persisted.
 */

import type { ModelEndpoint, ModelPricing, UpstreamKind } from "~/protocols/common"
import type { ModelProvider } from "~/providers/types"

/**
 * Per-binding model metadata. The neutral shape that source/target
 * routes consume; provider-internal raw fields stay inside the provider.
 */
export interface BindingModel {
  /** Raw upstream model id (e.g. `claude-opus-4-7-xhigh`). */
  id: string
  /** Public display name (post variant-merge). */
  displayName?: string
  ownedBy?: string
  created?: number
  limits?: {
    maxOutputTokens?: number
    maxContextWindowTokens?: number
    maxPromptTokens?: number
  }
  /** USD-per-million-tokens pricing snapshot. */
  cost?: ModelPricing
}

export interface ProviderBinding {
  /** Stable upstream name (e.g. "copilot-business", "azure-us-east"). */
  upstream: string
  /** Categorical upstream kind. */
  kind: UpstreamKind
  /** The model as known to this upstream. */
  model: BindingModel
  /** Endpoints the upstream natively serves for this model. */
  upstreamEndpoints: readonly ModelEndpoint[]
  /** Effective flag set after defaults + overrides resolution. */
  enabledFlags: ReadonlySet<string>
  /** Concrete provider that executes the call. */
  provider: ModelProvider
}

/**
 * Does the binding natively serve the requested endpoint?
 */
export function bindingServesEndpoint(
  binding: ProviderBinding,
  endpoint: ModelEndpoint,
): boolean {
  return binding.upstreamEndpoints.includes(endpoint)
}

/**
 * Filter bindings to those that natively serve the requested endpoint.
 */
export function bindingsForEndpoint(
  bindings: readonly ProviderBinding[],
  endpoint: ModelEndpoint,
): ProviderBinding[] {
  return bindings.filter((b) => bindingServesEndpoint(b, endpoint))
}
