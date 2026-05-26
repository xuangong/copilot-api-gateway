import type { AppState } from "~/lib/state"
import { bindingsForEndpoint, type ProviderBinding } from "~/providers/binding"
import { listProviderBindings } from "~/providers/registry"
import type { ModelEndpoint } from "~/protocols/common"

/**
 * Resolve the (provider, upstream-id) pair for a request.
 *
 * Walks the visible upstream registry (global + owner-scoped), filters to
 * those that natively serve `endpoint`, and picks the first binding whose
 * model id matches `model`. Falls back to the request's single-Copilot
 * context when no managed upstream serves the model, keeping pre-registry
 * deployments working.
 *
 * Returns `null` when nothing matches — caller is responsible for emitting
 * the appropriate 404 in the right protocol shape (Anthropic / OpenAI /
 * Gemini differ).
 */
export async function resolveBinding(
  state: AppState | null,
  ownerId: string | undefined,
  model: string,
  endpoint: ModelEndpoint,
): Promise<ProviderBinding | null> {
  const copilot = state?.copilotToken
    ? { copilotToken: state.copilotToken, accountType: state.accountType }
    : undefined
  const bindings = await listProviderBindings({ ownerId, copilot })
  const candidates = bindingsForEndpoint(bindings, endpoint)
  return candidates.find((b) => b.model.id === model) ?? null
}

/**
 * Pick the flag set that should govern transform / retry behavior for this
 * request. Prefer the binding's resolved set (defaults + per-upstream
 * overrides) when present, fall back to the request's state-level set for
 * the legacy single-Copilot path.
 */
export function effectiveFlags(
  state: AppState | null | undefined,
  binding: ProviderBinding | null | undefined,
): ReadonlySet<string> {
  return binding?.enabledFlags ?? state?.enabledFlags ?? new Set<string>()
}
