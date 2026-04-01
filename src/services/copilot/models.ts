import { getCopilotBaseUrl, type AccountType } from "~/config/constants"
import { copilotHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

interface Model {
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
}

export async function getModels(
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
