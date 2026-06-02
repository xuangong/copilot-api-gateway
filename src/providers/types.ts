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
  /**
   * The protocol shape the caller originally received. Lets the provider
   * apply translation-aware transforms (e.g. strip `safety_identifier` only
   * on payloads we synthesized during translation, preserving values that
   * a native Responses caller explicitly sent).
   *
   * Defaults to the endpoint's matching shape when omitted (e.g. an
   * unannotated "responses" fetch is treated as native).
   */
  sourceApi?: "messages" | "chat_completions" | "responses"
  /**
   * Effective flag set for this request (defaults + per-upstream overrides,
   * already resolved). Providers gate optional transforms on this set.
   * When omitted, providers fall back to their kind's catalog defaults so
   * legacy callers retain current behavior.
   */
  enabledFlags?: ReadonlySet<string>
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
}
