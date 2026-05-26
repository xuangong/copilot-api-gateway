import type { ModelsResponse } from "~/services/copilot/models"

export type { UpstreamKind } from "~/protocols/common"
import type { UpstreamKind } from "~/protocols/common"

export interface ProviderCallOptions {
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
  timeout?: number
  operationName?: string
}

/**
 * Result of a control-plane probe — what the admin sees after clicking
 * "Test" on an upstream entry. Lightweight by design: every provider
 * implements it as a /models GET so admins can validate credentials and
 * see the model surface, without spending tokens.
 */
export interface ProbeResult {
  ok: boolean
  /** Upstream HTTP status, when known. */
  status?: number
  modelCount?: number
  /** First 50 model ids, sorted as the upstream returned them. */
  models?: string[]
  /** First 1000 chars of the error body / exception message on failure. */
  error?: string
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string

  getModels(): Promise<ModelsResponse>
  probe(): Promise<ProbeResult>

  callChatCompletions(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callResponses(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callMessages(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callMessagesCountTokens(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  callEmbeddings(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
}
