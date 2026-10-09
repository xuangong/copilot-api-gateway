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
import type { ApiKeyId } from '../../../repo/branded-ids.ts'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SelectBindingResult =
  | { kind: 'ok'; binding: LlmProviderBinding; targetEndpoint: EndpointKey; translator: PairTranslator; bareModel: string }
  | { kind: 'catalog-unavailable'; bareModel: string }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

export interface SelectBindingAuth {
  readonly ownerId?: string
  readonly pin?: string
  readonly copilot?: EnumerateOptions['copilot']
  readonly apiKeyId?: ApiKeyId
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
    opts: { signal: args.affinityOptions?.signal, dump: args.dump, ownerId: args.auth.ownerId, copilot: args.auth.copilot, pin: args.auth.pin },
  })
  const bareModel = enumeration.bareModel
  if (enumeration.candidates.length === 0) await enumeration.reconcile?.()
  if (enumeration.catalogUnavailable) return { kind: "catalog-unavailable", bareModel }
  if (!enumeration.sawModel) return { kind: "model-not-found", bareModel }

  let first
  try {
    first = await selectAffinityCandidate(enumeration.candidates, args.affinity, bareModel, args.affinityOptions, enumeration.materialize)
  } catch (error) {
    // Constructor failures remove catalog contributions; preparation failures
    // instead remain affinity proof errors for still-advertised candidates.
    if (error instanceof AffinityRoutingUnavailableError && enumeration.catalogUnavailable) return { kind: "catalog-unavailable", bareModel }
    throw error
  }
  if (!first) {
    if (enumeration.catalogUnavailable) return { kind: "catalog-unavailable", bareModel }
    if (!enumeration.sawModel) return { kind: "model-not-found", bareModel }
    return { kind: "no-eligible-binding", bareModel }
  }
  const translator = getTranslator(args.protocol, first.targetEndpoint)
  if (!translator) return { kind: "no-translator", bareModel, targetEndpoint: first.targetEndpoint }
  return { kind: "ok", binding: first.binding, targetEndpoint: first.targetEndpoint, translator, bareModel }
}
