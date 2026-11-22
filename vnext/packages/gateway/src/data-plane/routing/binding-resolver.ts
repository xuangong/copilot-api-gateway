import type { DumpAccumulator } from "../../shared/dump/accumulator.ts"
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
import type { EndpointKey } from '@vibe-llm/protocols/common'
import { type LlmProviderBinding } from './binding.ts'
import { ModelCatalogUnavailableError } from '../errors/model-catalog.ts'
import { listRoutingBindings, routingScope, type CreateProviderOptions } from '../providers/registry.ts'
import { parseCompositeModelId } from '@vibe-llm/provider-copilot'
import { parseModelRouting } from './model-routing.ts'
import { getProtection } from '../../protection/runtime.ts'
import { describeGroupExhausted, describePausedRoute } from './paused-route.ts'
import { getQuotaBalance } from '../../quota-balance/runtime.ts'
import type { BalanceOutcome, SkippedGroup } from '../../quota-balance/balance.ts'
import type { RoutingBindingDescriptor } from '../providers/routing-projection.ts'
import { UpstreamPausedError } from '../errors/upstream-paused.ts'

export { parseModelRouting } from './model-routing.ts'
export type { ModelRoutingHint } from './model-routing.ts'

export interface ResolveBindingOptions {
  dump?: DumpAccumulator | null
  ownerId?: string
  upstreamIds?: readonly string[] | null
  copilot?: CreateProviderOptions
  pin?: string
  errorFormat?: 'gemini'
  /** Render a paused-upstream error in the Anthropic error shape (count_tokens). */
  anthropicErrors?: boolean
}

export async function resolveBinding(
  model: string,
  endpoint: EndpointKey,
  opts: ResolveBindingOptions = {},
): Promise<LlmProviderBinding | null> {
  const parsed = parseModelRouting(model)
  const upstreamPin = opts.pin ?? parsed.upstreamPin
  const bareModel = parsed.bareModel
  let incomplete = false
  const bindings = await listRoutingBindings(routingScope(opts.ownerId), {
    upstreamIds: opts.upstreamIds,
    pin: upstreamPin,
    copilot: opts.copilot,
    dump: opts.dump,
    onCatalogError: (upstreamId) => {
      if (!upstreamPin || upstreamId === undefined || upstreamId === upstreamPin) incomplete = true
    },
  })
  const composite = parseCompositeModelId(bareModel)
  const ids = composite.baseId && composite.baseId !== bareModel ? [bareModel, composite.baseId] : [bareModel]
  const paused = await getProtection().pausedUpstreams() // never throws; fail-open
  const skipped: string[] = []
  // This resolver intentionally prefers all direct matches before any base
  // fallback; chat candidate enumeration preserves upstream order instead.
  const exhaustedGroups: SkippedGroup[] = []
  let unknownGroups = 0
  for (const id of ids) {
    const usable: RoutingBindingDescriptor[] = []
    for (const descriptor of bindings.find([id])) {
      if ((upstreamPin && descriptor.upstream !== upstreamPin) || descriptor.model.endpoints[endpoint] === undefined) continue
      if (paused.has(descriptor.upstream)) { skipped.push(descriptor.upstream); continue }
      usable.push(descriptor)
    }
    // Groups: balanced per request without a session (embeddings, images, decisions, count tokens); a pinned request is not balanced.
    let balance: BalanceOutcome<RoutingBindingDescriptor> | undefined
    if (!upstreamPin) { try { balance = await getQuotaBalance().balance({ items: usable, upstreamOf: descriptor => descriptor.upstream, ignoreSoftLine: endpoint === 'messages_count_tokens' }) } catch { balance = undefined } }
    for (const group of balance?.skipped ?? []) if (!exhaustedGroups.some(known => known.groupId === group.groupId)) exhaustedGroups.push(group)
    unknownGroups += balance?.unknown.length ?? 0
    for (const descriptor of balance?.ordered ?? usable) {
      const binding = await bindings.materialize(descriptor)
      if (binding) return binding
    }
  }
  await bindings.reconcile()

  // D31: the quota answer only when every skipped group was skipped for quota.
  if (exhaustedGroups.length > 0 && unknownGroups === 0) {
    const ends = skipped.flatMap(upstreamId => { const row = paused.get(upstreamId); return row ? [row.endsAt] : [] })
    const route = describeGroupExhausted(exhaustedGroups, ends, opts.ownerId, getProtection().now())
    throw new UpstreamPausedError(route.message, route.retryAfterSeconds, opts.errorFormat ?? (opts.anthropicErrors ? 'anthropic' : undefined), 'group_quota_exhausted')
  }

  // A candidate dropped only because it is paused is a known answer: prefer it over an unrelated failed catalog (as chat does).
  const route = await describePausedRoute(skipped, paused, opts.ownerId)
  if (route) throw new UpstreamPausedError(route.message, route.retryAfterSeconds, opts.errorFormat ?? (opts.anthropicErrors ? 'anthropic' : undefined))
  if (incomplete) throw new ModelCatalogUnavailableError(opts.errorFormat)
  return null
}

export function pinFromPayload(
  payload: { __upstreamPin?: unknown } | Record<string, unknown>,
): string | undefined {
  const v = (payload as { __upstreamPin?: unknown }).__upstreamPin
  return typeof v === 'string' ? v : undefined
}

export function effectiveFlags(
  binding: LlmProviderBinding | null | undefined,
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
): Promise<{ binding: LlmProviderBinding | null; model: string }> {
  const rawModel = typeof payload.model === 'string' ? payload.model : ''
  const { bareModel } = parseModelRouting(rawModel)
  const binding = await resolveBinding(rawModel, endpoint, opts)
  if (rawModel !== bareModel) (payload as { model?: string }).model = bareModel
  return { binding, model: bareModel }
}
