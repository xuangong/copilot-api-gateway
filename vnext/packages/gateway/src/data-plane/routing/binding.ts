/**
 * Provider binding — the four-tuple that a request planner consumes.
 *
 * Ported verbatim from old src/providers/binding.ts (logic unchanged).
 * A binding answers: "for this requested model, which provider should I
 * dispatch to, on which endpoint, with which flags effective?"
 */
import type { EndpointKey } from '@vnext-llm/protocols/common'
import type { BindingModel, ProviderBinding } from '@vnext-llm/provider'
export type { BindingModel, ProviderBinding }

export function bindingServesEndpoint(
  binding: ProviderBinding,
  endpoint: EndpointKey,
): boolean {
  return binding.model.endpoints[endpoint] !== undefined
}

export function bindingsForEndpoint(
  bindings: readonly ProviderBinding[],
  endpoint: EndpointKey,
): ProviderBinding[] {
  return bindings.filter((b) => bindingServesEndpoint(b, endpoint))
}
