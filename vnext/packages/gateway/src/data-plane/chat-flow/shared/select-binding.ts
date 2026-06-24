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
import type { EndpointKey, ModelEndpoints } from '@vnext-llm/protocols/common'
import type { ProviderBinding } from '@vnext/provider'
import {
  enumerateBindingCandidates,
  type EnumerateResult,
  type EnumerateOptions,
} from '../../routing/candidates.ts'
import { getTranslator, type PairTranslator } from '../../dispatch/translator-registry.ts'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SelectBindingResult =
  | { kind: 'ok'; binding: ProviderBinding; targetEndpoint: EndpointKey; translator: PairTranslator; bareModel: string }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

export interface SelectBindingAuth {
  readonly ownerId?: string
  readonly pin?: string
  readonly copilot?: EnumerateOptions['copilot']
}

type EnumerateFn = (args: {
  model: string
  pickTarget: (e: ModelEndpoints) => EndpointKey | null
  opts?: EnumerateOptions
}) => Promise<EnumerateResult>

export interface SelectBindingArgs {
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
  const enumerate: EnumerateFn = args.enumerate ?? enumerateBindingCandidates

  const { candidates, sawModel, bareModel } = await enumerate({
    model: args.model,
    pickTarget: pickTargetForChatCompletions,
    opts: {
      ownerId: args.auth.ownerId,
      copilot: args.auth.copilot,
      pin: args.auth.pin,
    },
  })

  if (!sawModel) return { kind: 'model-not-found', bareModel }

  const first = candidates[0]
  if (!first) return { kind: 'no-eligible-binding', bareModel }

  const translator = getTranslator('chat_completions', first.targetEndpoint)
  if (!translator) return { kind: 'no-translator', bareModel, targetEndpoint: first.targetEndpoint }

  return {
    kind: 'ok',
    binding: first.binding,
    targetEndpoint: first.targetEndpoint,
    translator,
    bareModel,
  }
}
