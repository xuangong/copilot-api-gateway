import type { ModelsResponse } from "~/services/copilot/models"

export type UpstreamKind = "copilot" | "azure" | "custom"

export interface ProviderCallOptions {
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
  timeout?: number
  operationName?: string
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string

  getModels(): Promise<ModelsResponse>

  callChatCompletions(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callResponses(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callMessages(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callMessagesCountTokens(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
}
