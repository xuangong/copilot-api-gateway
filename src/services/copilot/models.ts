import { getCopilotBaseUrl, type AccountType } from "~/config/constants"
import { copilotHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"

import { buildCompositeModelId, mergeClaudeVariants } from "./variants"

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

export interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

export interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
}

export interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  /**
   * For merged Claude entries: the (context, effort) combinations supported by
   * the underlying raw variants. Clients use this to drive a single composite
   * model picker (effort + 1M) that maps back to one of these tuples.
   */
  available_combinations?: Array<{ context1m: boolean; effort?: string }>
}

export async function getRawModels(
  copilotToken: string,
  accountType: AccountType,
): Promise<ModelsResponse> {
  const baseUrl = getCopilotBaseUrl(accountType)
  const response = await fetch(`${baseUrl}/models`, {
    headers: copilotHeaders(copilotToken),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export async function getModels(
  copilotToken: string,
  accountType: AccountType,
): Promise<ModelsResponse> {
  const raw = await getRawModels(copilotToken, accountType)
  const merged = mergeClaudeVariants(raw)
  return expandCompositeModels(merged)
}

/**
 * Append composite model id entries for each Claude model that has
 * available_combinations. The base id itself is kept as-is; each
 * (effort, context1m) combination that differs from the base gets an
 * extra entry with a suffixed id (e.g. `claude-opus-4.7-xhigh-1m`).
 *
 * Low/medium efforts are not surfaced as separate model ids — they are the
 * default behavior of the base model.
 *
 * Composite entries carry the same metadata as the base but with:
 *   - adjusted id / version
 *   - available_combinations cleared (they are leaf entries, not group headers)
 *   - max_context_window_tokens set to 1_000_000 for 1m variants
 */
function expandCompositeModels(models: ModelsResponse): ModelsResponse {
  const out: Model[] = []
  for (const model of models.data) {
    out.push(model)
    const combos = model.available_combinations
    if (!combos || combos.length === 0) continue

    for (const combo of combos) {
      // Base model already represents low/medium/no-effort + no-1m
      if (!combo.context1m && (!combo.effort || combo.effort === "low" || combo.effort === "medium")) {
        continue
      }
      const compositeId = buildCompositeModelId(model.id, {
        effort: combo.effort,
        context1m: combo.context1m,
      })
      // Skip if composite id is the same as base (e.g. effort not in EFFORT_SUFFIXES)
      if (compositeId === model.id) continue

      const limits = { ...(model.capabilities?.limits ?? {}) }
      if (combo.context1m) limits.max_context_window_tokens = 1_000_000

      out.push({
        ...model,
        id: compositeId,
        version: compositeId,
        capabilities: {
          ...model.capabilities,
          limits,
        },
        available_combinations: undefined,
      })
    }
  }
  return { object: models.object, data: out }
}
