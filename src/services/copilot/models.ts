import { getCopilotBaseUrl, type AccountType } from "~/config/constants"
import { copilotHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"

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

const CLAUDE_DATE_SUFFIX = /-\d{8}$/
const CLAUDE_1M_INTERNAL = /-1m-internal$/

/** Map a Copilot raw model id to the public-facing id we expose. */
function publicModelId(id: string): string {
  if (!id.startsWith("claude-")) return id
  return id.replace(CLAUDE_DATE_SUFFIX, "").replace(CLAUDE_1M_INTERNAL, "-1m")
}

export async function getModels(
  copilotToken: string,
  accountType: AccountType,
): Promise<ModelsResponse> {
  const raw = await getRawModels(copilotToken, accountType)
  return {
    object: raw.object,
    data: raw.data.map((m) => {
      const id = publicModelId(m.id)
      if (id === m.id) return m
      return { ...m, id, version: id }
    }),
  }
}

