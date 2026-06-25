/**
 * Provider binding — the four-tuple that a request planner consumes.
 *
 * Ported verbatim from old src/providers/binding.ts (logic unchanged).
 * A binding answers: "for this requested model, which provider should I
 * dispatch to, on which endpoint, with which flags effective?"
 */
import type { EndpointKey } from '@vibe-llm/protocols/common'
import type { BindingModel, LlmProviderBinding } from '@vibe-llm/provider-llm'
export type { BindingModel, LlmProviderBinding }

export function bindingServesEndpoint(
  binding: LlmProviderBinding,
  endpoint: EndpointKey,
): boolean {
  return binding.model.endpoints[endpoint] !== undefined
}

export function bindingsForEndpoint(
  bindings: readonly LlmProviderBinding[],
  endpoint: EndpointKey,
): LlmProviderBinding[] {
  return bindings.filter((b) => bindingServesEndpoint(b, endpoint))
}
