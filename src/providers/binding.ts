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

import type { EndpointKey, ModelKind, ModelPricing, UpstreamKind } from "~/protocols/common"
import { endpointCompatibleWithKind } from "~/protocols/common"
import type { ModelProvider } from "~/providers/types"
import type { Model } from "~/services/copilot/models"

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
  /** Categorical kind — drives endpoint compatibility. Defaults to "chat". */
  kind?: ModelKind
  limits?: {
    maxOutputTokens?: number
    maxContextWindowTokens?: number
    maxPromptTokens?: number
  }
  /** USD-per-million-tokens pricing snapshot. */
  cost?: ModelPricing
  raw?: Model
}

export interface ProviderBinding {
  /** Stable upstream name (e.g. "copilot-business", "azure-us-east"). */
  upstream: string
  /** Categorical upstream kind. */
  kind: UpstreamKind
  /** The model as known to this upstream. */
  model: BindingModel
  /** Endpoints the upstream natively serves for this model. */
  upstreamEndpoints: readonly EndpointKey[]
  /** Effective flag set after defaults + overrides resolution. */
  enabledFlags: ReadonlySet<string>
  /** Concrete provider that executes the call. */
  provider: ModelProvider
}

/**
 * Does the binding natively serve the requested endpoint? Combines the
 * upstream's declared endpoints with the model's kind compatibility — an
 * embedding model on a chat-completions upstream still won't serve chat.
 * Models with no inferred kind (undefined) defer to upstream-declared
 * endpoints; that keeps unknown/legacy models routable without
 * registration changes.
 */
export function bindingServesEndpoint(
  binding: ProviderBinding,
  endpoint: EndpointKey,
): boolean {
  if (!binding.upstreamEndpoints.includes(endpoint)) return false
  const kind = binding.model.kind
  if (!kind) return true
  return endpointCompatibleWithKind(endpoint, kind)
}

/**
 * Filter bindings to those that natively serve the requested endpoint.
 */
export function bindingsForEndpoint(
  bindings: readonly ProviderBinding[],
  endpoint: EndpointKey,
): ProviderBinding[] {
  return bindings.filter((b) => bindingServesEndpoint(b, endpoint))
}
