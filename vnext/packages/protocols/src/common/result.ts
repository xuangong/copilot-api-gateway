// packages/protocols/src/common/result.ts
import type { ModelPricing } from './index.ts'

/**
 * Narrow protocol set valid for translator pair telemetry. Kept file-local
 * because only the four chat protocols can appear as a translator source/hub;
 * embedding/image endpoints don't traverse the translator. Distinct from
 * `EndpointKey` (which includes `embeddings`, `images_*`, etc.).
 */
type TranslatorProtocol = 'chat_completions' | 'messages' | 'responses' | 'gemini'

export interface TelemetryModelIdentity {
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  readonly cost: ModelPricing | null
  /**
   * Set when the attempt traversed a translator (cross-protocol fan-out).
   * `source` is the client-facing protocol; `hub` is the upstream protocol
   * actually invoked. Absent for same-protocol attempts.
   */
  readonly translatorPair?: {
    readonly source: TranslatorProtocol
    readonly hub: TranslatorProtocol
  }
}

export interface PerformanceTelemetryContext {
  readonly keyId: string
  readonly model: string
  readonly upstream: string | null
  readonly modelKey: string
  readonly stream: boolean
  readonly runtimeLocation: 'bun' | 'cloudflare'
}

export interface EventResultMetadata {
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
}

/**
 * Context passed to `EventResult.translateBody` when a translator is reused for
 * non-streaming JSON envelopes (e.g. `gemini → responses` countTokens).
 */
export interface TranslateBodyContext {
  readonly signal?: AbortSignal
  readonly fallbackMaxOutputTokens?: number
  readonly model?: string
}

export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
  readonly finalMetadata?: Promise<EventResultMetadata>
  /**
   * Optional escape hatch for cross-protocol attempts that need to translate a
   * non-streaming hub-protocol JSON envelope back into the client protocol's
   * shape. Producers populate this only when reusing a translator for a
   * non-event response (e.g. count-tokens). Most attempts leave it undefined.
   */
  readonly translateBody?: (
    hubJson: unknown,
    ctx: TranslateBodyContext,
  ) => unknown | Promise<unknown>
}

export interface UpstreamErrorResult {
  readonly type: 'upstream-error'
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  readonly performance?: PerformanceTelemetryContext
}

export interface InternalErrorResult {
  readonly type: 'internal-error'
  readonly status: number
  readonly error: Error
  readonly performance?: PerformanceTelemetryContext
  /**
   * Free-form failure tag used by translator/dispatch layers to distinguish
   * categories of internal error (e.g. `'translator-validation'`,
   * `'no-translator'`). Optional — legacy callers may omit it.
   */
  readonly reason?: string
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
  translateBody?: EventResult<T>['translateBody'],
): EventResult<T> => ({
  type: 'events',
  events,
  modelIdentity,
  performance,
  finalMetadata,
  translateBody,
})

export const internalErrorResult = (
  status: number,
  error: Error,
  performance?: PerformanceTelemetryContext,
  reason?: string,
): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  performance,
  reason,
})

export const readUpstreamError = async (
  response: Response,
  performance?: PerformanceTelemetryContext,
): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
  performance,
})

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  })

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string =>
  new TextDecoder().decode(error.body)
