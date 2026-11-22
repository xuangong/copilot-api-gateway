import { AffinityRoutingUnavailableError } from "../../../shared/affinity/analysis.ts"
import type { AffinityProtocol } from "../../../shared/affinity/analysis.ts"
import { selectAffinityCandidate, type AttemptAffinity, type AffinityPreparationOptions } from "../../shared/affinity-request"
import type { DumpAccumulator } from "../../../shared/dump/accumulator.ts"
/**
 * Routing helper for the chat-completions handler.
 *
 * Wraps `enumerateBindingCandidates` + `selectPair` with the chat-completions
 * preference chain (`chat_completions → messages → responses`) and looks up the
 * `PairTranslator` for the winning pair.
 *
 * The `enumerate` parameter is injectable for unit tests so tests can drive the
 * candidate set without depending on the live routing table.
 */
import type { EndpointKey, ModelEndpoints } from '@vibe-llm/protocols/common'
import type { LlmProviderBinding } from '@vibe-llm/provider-llm'
import {
  enumerateBindingCandidates,
  type EnumerateResult,
  type EnumerateOptions,
} from '../../routing/candidates.ts'
import { getTranslator, type PairTranslator } from '../../dispatch/translator-registry.ts'
import { describeGroupExhausted, describePausedRoute } from '../../routing/paused-route.ts'
import { getQuotaBalance } from '../../../quota-balance/runtime.ts'
import type { BalanceOutcome } from '../../../quota-balance/balance.ts'
import type { BalanceSession } from '../../../quota-balance/session-key.ts'
import { getProtection } from '../../../protection/runtime.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UpstreamPausedSelection { kind: 'upstream-paused'; bareModel: string; message: string; retryAfterSeconds: number; code?: 'upstream_paused' | 'group_quota_exhausted' }

export type SelectBindingResult =
  | UpstreamPausedSelection
  | { kind: 'ok'; binding: LlmProviderBinding; targetEndpoint: EndpointKey; translator: PairTranslator; bareModel: string }
  | { kind: 'catalog-unavailable'; bareModel: string; failedCatalogs: readonly string[] }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

export interface SelectBindingAuth {
  readonly ownerId?: string
  readonly upstreamIds?: readonly string[] | null
  readonly pin?: string
  readonly copilot?: EnumerateOptions['copilot']
  readonly apiKeyId?: ApiKeyId
  readonly balanceSession?: BalanceSession
}

type EnumerateFn = (args: {
  model: string
  pickTarget: (e: ModelEndpoints) => EndpointKey | null
  opts?: EnumerateOptions
}) => Promise<EnumerateResult>

export interface SelectBindingArgs {
  readonly affinity?: AttemptAffinity
  readonly affinityOptions?: AffinityPreparationOptions
  readonly dump?: DumpAccumulator | null
  readonly model: string
  readonly auth: SelectBindingAuth
  /** Injected in tests; defaults to `enumerateBindingCandidates`. */
  readonly enumerate?: EnumerateFn
}

// ─── Preference chain ────────────────────────────────────────────────────────

/**
 * chat_completions source prefers: chat_completions → messages → responses
 * (mirrors the PREFERENCE table in pair-selector.ts)
 */
const CHAT_COMPLETIONS_PREFERENCE: readonly EndpointKey[] = [
  'chat_completions',
  'messages',
  'responses',
]

function pickTargetForChatCompletions(endpoints: ModelEndpoints): EndpointKey | null {
  for (const key of CHAT_COMPLETIONS_PREFERENCE) {
    if (endpoints[key]) return key
  }
  return null
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function selectBindingForChatCompletions(
  args: SelectBindingArgs,
): Promise<SelectBindingResult> {
  return selectBindingForProtocol({ ...args, protocol: "chat_completions", pickTarget: pickTargetForChatCompletions })
}

/** All chat protocols cross the same descriptor-to-execution boundary. */
export async function selectBindingForProtocol(
  args: SelectBindingArgs & { protocol: AffinityProtocol; pickTarget: (endpoints: ModelEndpoints) => EndpointKey | null },
): Promise<SelectBindingResult> {
  const enumeration = await (args.enumerate ?? enumerateBindingCandidates)({
    model: args.model, pickTarget: args.pickTarget,
    opts: { signal: args.affinityOptions?.signal, dump: args.dump, ownerId: args.auth.ownerId, upstreamIds: args.auth.upstreamIds, copilot: args.auth.copilot, pin: args.auth.pin },
  })
  const bareModel = enumeration.bareModel
  const catalogUnavailable = (): SelectBindingResult => {
    const failedCatalogs = enumeration.failedCatalogs ?? []
    console.warn(`[routing] ${bareModel} is in no catalog that loaded; failed catalogs: ${failedCatalogs.map(id => id || "(upstream list)").join(", ") || "unknown"}`)
    return { kind: "catalog-unavailable", bareModel, failedCatalogs }
  }
  const pausedFor = () => enumeration.pausedUpstreams && enumeration.pausedCandidates?.length
    ? describePausedRoute(enumeration.pausedCandidates.map(candidate => candidate.binding.upstream), enumeration.pausedUpstreams, args.auth.ownerId)
    : Promise.resolve(null)
  if (enumeration.candidates.length === 0) await enumeration.reconcile?.()
  if (enumeration.catalogUnavailable) return catalogUnavailable()
  if (!enumeration.sawModel) return { kind: "model-not-found", bareModel }

  // Quota balancing: not for pinned requests, not for requests whose owned opaque state binds them to an upstream. Fail-open (the original order).
  const constrained = !!args.affinity && 'analysis' in args.affinity && args.affinity.analysis.hasRouteConstraints
  const candidates = enumeration.candidates
  let balance: BalanceOutcome<(typeof candidates)[number]> | undefined
  if (!constrained && !args.auth.pin && !enumeration.upstreamPin) {
    try { balance = await getQuotaBalance().balance({ items: candidates, upstreamOf: candidate => candidate.binding.upstream, session: args.auth.balanceSession }) } catch { balance = undefined }
  }
  let first
  try {
    first = await selectAffinityCandidate(balance?.ordered ?? candidates, args.affinity, bareModel, args.affinityOptions, enumeration.materialize)
  } catch (error) {
    // Constructor failures remove catalog contributions; preparation failures
    // instead remain affinity proof errors for still-advertised candidates.
    if (error instanceof AffinityRoutingUnavailableError) {
      if (enumeration.catalogUnavailable) return catalogUnavailable()
      // The route that holds the opaque state may be a paused upstream: say so (with Retry-After) instead of a bare 503,
      // but only when a paused candidate would have been authorized (local proof, no inference).
      if (enumeration.pausedUpstreams && enumeration.pausedCandidates?.length) {
        const authorized = await selectAffinityCandidate(enumeration.pausedCandidates, args.affinity, bareModel, args.affinityOptions, enumeration.materialize).catch(() => undefined)
        const paused = authorized ? await describePausedRoute([authorized.binding.upstream], enumeration.pausedUpstreams, args.auth.ownerId) : null
        if (paused) return { kind: "upstream-paused", bareModel, ...paused }
      }
    }
    throw error
  }
  if (first) { try { balance?.commit(first.binding.upstream) } catch { /* the request is served regardless */ } }
  if (!first) {
    if (enumeration.catalogUnavailable) return catalogUnavailable()
    if (!enumeration.sawModel) return { kind: "model-not-found", bareModel }
    // D31: the quota answer only when every skipped group was skipped for quota; a group skipped for lack of data is not a quota statement.
    if (balance && balance.skipped.length > 0 && balance.unknown.length === 0) {
      const ends = (enumeration.pausedCandidates ?? []).flatMap(candidate => { const row = enumeration.pausedUpstreams?.get(candidate.binding.upstream); return row ? [row.endsAt] : [] })
      const exhausted = describeGroupExhausted(balance.skipped, ends, args.auth.ownerId, getProtection().now())
      return { kind: "upstream-paused", bareModel, code: "group_quota_exhausted", ...exhausted }
    }
    const paused = await pausedFor()
    if (paused) return { kind: "upstream-paused", bareModel, ...paused }
    return { kind: "no-eligible-binding", bareModel }
  }
  const translator = getTranslator(args.protocol, first.targetEndpoint)
  if (!translator) return { kind: "no-translator", bareModel, targetEndpoint: first.targetEndpoint }
  return { kind: "ok", binding: first.binding, targetEndpoint: first.targetEndpoint, translator, bareModel }
}
