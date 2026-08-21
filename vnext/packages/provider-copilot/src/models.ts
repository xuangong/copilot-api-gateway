import { getCopilotBaseUrl, type AccountType } from "./account-type"
import { copilotHeaders } from "./headers"
import { HTTPError } from "./lib/error"
import { directFetcher, type Fetcher } from "@vibe-core/upstream"

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
  /**
   * Wire paths Copilot will actually serve this model on, e.g.
   * `["/responses", "ws:/responses"]`. Present on the newer catalog entries
   * (grok, mai-code, gemini-3.x, gpt-5.x, claude-*) and absent on the legacy
   * tail (gpt-4o and older), so consumers must tolerate `undefined`.
   */
  supported_endpoints?: string[]
  policy?: {
    state: string
    terms: string
  }
  available_combinations?: Array<{ context1m: boolean; effort?: string }>
}

/**
 * The `fetcher` carries the upstream's egress proxy chain. It defaults to
 * `directFetcher` to match CopilotProvider's constructor default, so a caller
 * with no proxy configured needs no argument — but a proxied upstream MUST
 * pass its fetcher, or the /models hop leaves the host directly while the
 * token-exchange hop went through the proxy.
 */
export async function getRawModels(
  copilotToken: string,
  accountType: AccountType,
  baseUrlOverride?: string,
  fetcher: Fetcher = directFetcher,
): Promise<ModelsResponse> {
  const baseUrl = baseUrlOverride ?? getCopilotBaseUrl(accountType)
  const response = await fetcher(`${baseUrl}/models`, {
    headers: copilotHeaders(copilotToken),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export async function getModels(
  copilotToken: string,
  accountType: AccountType,
  baseUrlOverride?: string,
  fetcher: Fetcher = directFetcher,
): Promise<ModelsResponse> {
  return getRawModels(copilotToken, accountType, baseUrlOverride, fetcher)
}
