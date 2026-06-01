import type { AppState } from "~/lib/state"
import { bindingsForEndpoint, type ProviderBinding } from "~/providers/binding"
import { listProviderBindings } from "~/providers/registry"
import type { EndpointKey } from "~/protocols/common"
import { parseCompositeModelId } from "~/services/copilot/variants"

/**
 * Parse the optional `<upstreamId>/<modelId>` syntax callers can use to
 * pin a request to a specific upstream when the same model id exists on
 * more than one. Returns the resolved upstream pin (if any) plus the
 * naked model id that should be forwarded upstream.
 *
 * Heuristic: only treat the prefix as an upstream pin when it actually
 * looks like one (`up_*`). Real model ids never start with `up_`, but
 * may legitimately contain slashes (e.g. `accounts/msft/routers/...`).
 */
export interface ModelRoutingHint {
  upstreamPin?: string
  bareModel: string
}

export function parseModelRouting(model: string): ModelRoutingHint {
  const slash = model.indexOf("/")
  if (slash <= 0) return { bareModel: model }
  const prefix = model.slice(0, slash)
  if (!prefix.startsWith("up_")) return { bareModel: model }
  return { upstreamPin: prefix, bareModel: model.slice(slash + 1) }
}

/**
 * Resolve the (provider, upstream-id) pair for a request.
 *
 * Walks the visible upstream registry (global + owner-scoped), filters to
 * those that natively serve `endpoint`, and picks a binding by:
 *
 *   1. If the model id is prefixed `up_<id>/<model>`, require that
 *      binding's upstream id matches.
 *   2. Otherwise pick the first matching binding in sort order — the
 *      single-binding case is unambiguous, and the multi-binding case
 *      with no pin lets admins control routing via sortOrder.
 *
 * Falls back to the request's single-Copilot context when no managed
 * upstream serves the model, keeping pre-registry deployments working.
 *
 * Returns `null` when nothing matches — caller is responsible for
 * emitting the appropriate 404 in the right protocol shape.
 */
export async function resolveBinding(
  state: AppState | null,
  ownerId: string | undefined,
  model: string,
  endpoint: EndpointKey,
  pin?: string,
): Promise<ProviderBinding | null> {
  const copilot = state?.copilotToken
    ? { copilotToken: state.copilotToken, accountType: state.accountType }
    : undefined
  // Pin priority: caller arg > in-band `up_X/model` syntax.
  const parsed = parseModelRouting(model)
  const upstreamPin = pin ?? parsed.upstreamPin
  const bareModel = parsed.bareModel
  const bindings = await listProviderBindings({ ownerId, copilot })
  const candidates = bindingsForEndpoint(bindings, endpoint)
  const matches = (b: ProviderBinding, id: string) => b.model.id === id && (!upstreamPin || b.upstream === upstreamPin)

  // 1) Direct literal match — covers the common case and exact ids
  //    like `claude-opus-4.7-1m-internal` that /v1/models advertises.
  const direct = candidates.find((b) => matches(b, bareModel))
  if (direct) return direct

  // 2) Composite id fallback: claude clients can request shorthand
  //    `claude-opus-4.7-1m` / `claude-opus-4.7-xhigh` etc. The bare
  //    model id is the family base (`claude-opus-4.7`); the upstream
  //    serves the variant under a -internal suffix that the provider
  //    rewrites at call time. Falling back here lets binding selection
  //    succeed on the shorthand without forcing the caller to know the
  //    full internal id.
  const composite = parseCompositeModelId(bareModel)
  if (composite.baseId && composite.baseId !== bareModel) {
    const base = candidates.find((b) => matches(b, composite.baseId))
    if (base) return base
  }

  return null
}

/**
 * Helper for routes that have already called stripUpstreamPin on a
 * payload and want to resolve a binding honoring the parked
 * `__upstreamPin` value.
 */
export function pinFromPayload(payload: { __upstreamPin?: unknown } | Record<string, unknown>): string | undefined {
  const v = (payload as { __upstreamPin?: unknown }).__upstreamPin
  return typeof v === "string" ? v : undefined
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

/**
 * If the caller used the `up_X/model` pinning syntax, rewrite the
 * payload's `model` field to the bare model id (so downstream sees the
 * upstream-native name) and stash the pin on `__upstreamPin` so a later
 * resolveBinding picks the right candidate. Idempotent.
 */
export function stripUpstreamPin(payload: { model?: unknown } | Record<string, unknown>): void {
  const m = (payload as { model?: unknown }).model
  if (typeof m !== "string") return
  const { upstreamPin, bareModel } = parseModelRouting(m)
  if (upstreamPin) (payload as Record<string, unknown>).__upstreamPin = upstreamPin
  if (bareModel !== m) (payload as { model?: string }).model = bareModel
}

/**
 * One-shot helper for routes: parse the pin, resolve a binding, and
 * mutate the payload's model field to the bare id. Returns
 * { binding, model } where `model` is the bare id callers should use
 * for usage tracking / latency keys / downstream calls.
 */
export async function resolveBindingForRequest<P extends { model?: unknown }>(
  state: AppState | null,
  ownerId: string | undefined,
  payload: P,
  endpoint: EndpointKey,
): Promise<{ binding: ProviderBinding | null; model: string }> {
  const rawModel = typeof payload.model === "string" ? payload.model : ""
  const { bareModel } = parseModelRouting(rawModel)
  const binding = await resolveBinding(state, ownerId, rawModel, endpoint)
  if (rawModel !== bareModel) (payload as { model?: string }).model = bareModel
  return { binding, model: bareModel }
}
