import type { ModelsResponse } from "~/services/copilot/models"

export type { UpstreamKind } from "~/protocols/common"
import type { UpstreamKind } from "~/protocols/common"
import type { EndpointKey } from "~/protocols/common"

export interface ProviderCallOptions {
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
  timeout?: number
  operationName?: string
}

export interface ProviderFetchOptions extends ProviderCallOptions {
  /**
   * For Copilot's count_tokens endpoint, payload.model is optional. All other
   * endpoints require it. Defaults to true.
   */
  requireModel?: boolean
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
  /** One-line "what to check next" suggestion (only populated on failure). */
  hint?: string
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string

  /**
   * Set of endpoints this provider can serve. Used by the binding layer to
   * decide whether a request can be routed here without translation.
   */
  readonly supportedEndpoints: readonly EndpointKey[]

  getModels(): Promise<ModelsResponse>
  probe(): Promise<ProbeResult>

  /**
   * Single dispatch method. `init.body` is forwarded as-is; providers do
   * NOT re-serialize. Variant filtering, deployment resolution, and other
   * provider-specific transforms happen inside fetch() before the wire call.
   *
   * Throws HTTPError on non-2xx upstream responses.
   */
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>

  /** @deprecated Use fetch('responses', ...). Removed in Plan 2. */
  callResponses(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  /** @deprecated Use fetch('messages', ...). Removed in Plan 3. */
  callMessages(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  /** @deprecated Use fetch('messages_count_tokens', ...). Removed in Plan 3. */
  callMessagesCountTokens(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  /** @deprecated Use fetch('embeddings', ...). Removed in Plan 4. */
  callEmbeddings(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
}
