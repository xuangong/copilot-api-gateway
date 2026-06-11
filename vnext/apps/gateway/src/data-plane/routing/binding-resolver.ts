/**
 * Binding resolver — Week 5a-impl port of old src/lib/binding-resolver.ts.
 *
 * vnext deltas from the old shape:
 *   - Old project threads an AppState (legacy single-Copilot context) through
 *     resolveBinding to supply the request-scoped copilot token. vnext has no
 *     AppState yet; callers pass CreateProviderOptions directly via
 *     `copilot` so listProviderBindings can fall back when no stored upstream
 *     serves the model.
 *   - effectiveFlags drops the AppState path (binding.enabledFlags only).
 *   - Composite-model fallback (parseCompositeModelId) is reused verbatim.
 */
import type { EndpointKey } from '@vnext/protocols/common'
import { bindingsForEndpoint, type ProviderBinding } from './binding.ts'
import { listProviderBindings, type CreateProviderOptions } from '../providers/registry.ts'
import { parseCompositeModelId } from '@vnext/provider-copilot'

export interface ModelRoutingHint {
  upstreamPin?: string
  bareModel: string
}

export function parseModelRouting(model: string): ModelRoutingHint {
  const slash = model.indexOf('/')
  if (slash <= 0) return { bareModel: model }
  const prefix = model.slice(0, slash)
  if (!prefix.startsWith('up_')) return { bareModel: model }
  return { upstreamPin: prefix, bareModel: model.slice(slash + 1) }
}

export interface ResolveBindingOptions {
  ownerId?: string
  copilot?: CreateProviderOptions
  pin?: string
}

export async function resolveBinding(
  model: string,
  endpoint: EndpointKey,
  opts: ResolveBindingOptions = {},
): Promise<ProviderBinding | null> {
  const parsed = parseModelRouting(model)
  const upstreamPin = opts.pin ?? parsed.upstreamPin
  const bareModel = parsed.bareModel
  const bindings = await listProviderBindings({ ownerId: opts.ownerId, copilot: opts.copilot })
  const candidates = bindingsForEndpoint(bindings, endpoint)
  const matches = (b: ProviderBinding, id: string) =>
    b.model.id === id && (!upstreamPin || b.upstream === upstreamPin)

  const direct = candidates.find((b) => matches(b, bareModel))
  if (direct) return direct

  const composite = parseCompositeModelId(bareModel)
  if (composite.baseId && composite.baseId !== bareModel) {
    const base = candidates.find((b) => matches(b, composite.baseId))
    if (base) return base
  }

  return null
}

export function pinFromPayload(
  payload: { __upstreamPin?: unknown } | Record<string, unknown>,
): string | undefined {
  const v = (payload as { __upstreamPin?: unknown }).__upstreamPin
  return typeof v === 'string' ? v : undefined
}

export function effectiveFlags(
  binding: ProviderBinding | null | undefined,
): ReadonlySet<string> {
  return binding?.enabledFlags ?? new Set<string>()
}

export function stripUpstreamPin(
  payload: { model?: unknown } | Record<string, unknown>,
): void {
  const m = (payload as { model?: unknown }).model
  if (typeof m !== 'string') return
  const { upstreamPin, bareModel } = parseModelRouting(m)
  if (upstreamPin) (payload as Record<string, unknown>).__upstreamPin = upstreamPin
  if (bareModel !== m) (payload as { model?: string }).model = bareModel
}

export async function resolveBindingForRequest<P extends { model?: unknown }>(
  payload: P,
  endpoint: EndpointKey,
  opts: ResolveBindingOptions = {},
): Promise<{ binding: ProviderBinding | null; model: string }> {
  const rawModel = typeof payload.model === 'string' ? payload.model : ''
  const { bareModel } = parseModelRouting(rawModel)
  const binding = await resolveBinding(rawModel, endpoint, opts)
  if (rawModel !== bareModel) (payload as { model?: string }).model = bareModel
  return { binding, model: bareModel }
}
