/**
 * Build a Codex `models.json`-shaped catalog entry for a vNext-listed model.
 *
 * vNext port of copilot-gateway `data-plane/codex/synthesize.ts`. The reference
 * project drives synthesis off `InternalModel` (rich `chat.modalities`,
 * `chat.reasoning.effort`, `pricing.entries[].selector.serviceTier`). vNext's
 * `listUpstreamModels().data` publishes a flatter shape — vendor `raw` spread
 * as top-level keys plus `capabilities.limits.{max_context_window_tokens,
 * max_output_tokens,max_prompt_tokens}` and `id` / `name`. This synthesizer
 * therefore uses a narrower registry-derived overlay:
 *
 *   - `slug` — always overwritten with the vNext model id (matches reference).
 *   - `display_name` — `model.name ?? source.display_name ?? model.id`.
 *   - `context_window` / `max_context_window` —
 *     `capabilities.limits.max_context_window_tokens ?? source ?? 128k`.
 *   - `service_tiers`, `input_modalities`, `supported_reasoning_levels`,
 *     `default_reasoning_level` — vNext does not carry modality/reasoning/
 *     pricing structs, so these ride through from the resolved catalog `source`
 *     (or BASELINE on miss) unchanged. Operators wanting richer Codex
 *     capabilities should ensure the model appears in the exact-version Codex
 *     catalog — the bundled snapshot is the fallback surface.
 *   - `multi_agent_version = 'v2'` is stamped ONLY when the exact catalog
 *     proves Ultra semantics AND the resulting model advertises Max reasoning
 *     (same rule as reference; here `advertisedReasoning` only mutates when
 *     Codex catalog already exposes Max, which vNext cannot manufacture).
 *   - Miss-path `base_instructions` — always overwritten with
 *     `synthesizedBaseInstructions(model.id, display_name)` so introspection
 *     ("what model are you?") resolves against the routed model and not a
 *     confabulated GPT-5 lineage.
 *
 * Reference: copilot-gateway `synthesize.ts` (field precedence rules copied
 * verbatim in doc comments above).
 */
import type { CatalogModel, CodexCatalogCapabilities, CodexReasoningLevel } from './catalog.ts'
import { synthesizedBaseInstructions } from './synthesized-base-instructions.ts'

// See BASELINE.context_window rationale in reference synthesize.ts — codex's
// `auto_compact_token_limit()` derives `(cw * 9) / 10`, absent/zero blows up.
const CONSERVATIVE_DEFAULT_CONTEXT_WINDOW = 128_000

// Hardcoded miss-path baseline. Mirrors reference BASELINE 1:1 — codex's
// `ModelInfo` deserialization requires every field listed here to be present,
// or the whole `/models` body is rejected and codex silently falls back to
// its bundled catalog.
const BASELINE = {
  slug: '', // always overwritten
  description: '',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  input_modalities: ['text'],
  supports_image_detail_original: false,
  web_search_tool_type: 'text',
  supports_parallel_tool_calls: true,
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  support_verbosity: false,
  default_verbosity: null,
  prefer_websockets: true,
  supported_in_api: true,
  supports_reasoning_summaries: false,
  apply_patch_tool_type: null,
  default_reasoning_summary: 'none',
  base_instructions: '',
  experimental_supported_tools: [],
  additional_speed_tiers: [],
  service_tiers: [],
  priority: 0,
  visibility: 'list',
  availability_nux: null,
  upgrade: null,
  auto_compact_token_limit: null,
  context_window: CONSERVATIVE_DEFAULT_CONTEXT_WINDOW,
  max_context_window: CONSERVATIVE_DEFAULT_CONTEXT_WINDOW,
} satisfies CatalogModel

/**
 * vNext-shaped model row consumed by the synthesizer. Structural subset of the
 * shape published by `listUpstreamModels().data`:
 *
 *   - `id` — public model id, becomes the Codex `slug`
 *   - `name` — optional display label
 *   - `capabilities.limits.max_context_window_tokens` — sole registry-derived
 *     window overlay in vNext (there is no separate `limits.max_output_tokens`
 *     field consumed by Codex's catalog wire)
 */
export interface CodexSynthesizeModel {
  id: string
  name?: string
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number
    }
  }
}

export const synthesizeCatalogEntry = (
  model: CodexSynthesizeModel,
  base?: CatalogModel,
  capabilities: CodexCatalogCapabilities = {},
): CatalogModel => {
  const source: CatalogModel = base ?? BASELINE

  const supportedReasoning: CodexReasoningLevel[] =
    source.supported_reasoning_levels ?? BASELINE.supported_reasoning_levels
  const ultraReasoningLevel = capabilities.ultraReasoningLevel
  const advertisedReasoning =
    ultraReasoningLevel !== undefined
      && supportedReasoning.some((level) => level.effort === 'max')
      && !supportedReasoning.some((level) => level.effort === 'ultra')
      ? [...supportedReasoning, ultraReasoningLevel]
      : supportedReasoning
  const shouldEnableUltra = advertisedReasoning !== supportedReasoning

  const registryWindow = model.capabilities?.limits?.max_context_window_tokens
  const contextWindow = (registryWindow
    ?? source.context_window
    ?? BASELINE.context_window) as number
  const maxContextWindow = (registryWindow
    ?? source.max_context_window
    ?? BASELINE.max_context_window) as number

  const displayName = model.name ?? (source.display_name as string | undefined) ?? model.id

  const entry: CatalogModel = {
    ...source,
    slug: model.id,
    display_name: displayName,
    supported_reasoning_levels: advertisedReasoning,
    context_window: contextWindow,
    max_context_window: maxContextWindow,
  }

  if (shouldEnableUltra) entry.multi_agent_version = 'v2'

  if (base === undefined) {
    entry.base_instructions = synthesizedBaseInstructions(model.id, displayName)
  }

  return entry
}
