// packages/protocols/src/common/result.ts
import type { ModelPricing } from './index.ts'
import type { ProtocolFrame } from '@vibe-core/result'

/**
 * Narrow protocol set for translator domains and translator-pair telemetry.
 * Only the four chat protocols can appear as a translator source/hub;
 * embedding/image endpoints don't traverse the translator. Distinct from
 * `EndpointKey` (which includes `embeddings`, `images_*`, etc.).
 */
export type TranslatorProtocol = 'chat_completions' | 'messages' | 'responses' | 'gemini'

export interface TelemetryModelIdentity {
  /** Client-requested model after protocol normalization, before routing. */
  readonly incomingModel: string
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  /** Exact provider-selected pricing identity; response model echoes cannot override it. */
  readonly executedModelKey?: string
  readonly executedServiceTier?: string
  readonly cost: ModelPricing | null
  /**
   * Set when the attempt traversed a translator (cross-protocol fan-out).
   * `source` is the client-facing protocol; `hub` is the upstream protocol
   * actually invoked. Absent for same-protocol attempts. Telemetry only;
   * event consumers use the result producer domain instead.
   */
  readonly translatorPair?: {
    readonly source: TranslatorProtocol
    readonly hub: TranslatorProtocol
  }
}

/**
 * Sub-operation discriminator for performance rows. Absent (undefined) for
 * the enclosing request row; set only when a request internally dispatches
 * one or more sub-calls that we want to profile independently (e.g. the
 * Responses image_generation shim fires an `image_generation` / `image_edit`
 * sub-call per model turn). Persisted as a nullable column so legacy rows
 * (all NULL) coexist with the new dimension.
 */
export type PerformanceOperation = 'image_generation' | 'image_edit'

export interface PerformanceTelemetryContext {
  readonly keyId: string
  readonly model: string
  readonly upstream: string | null
  readonly modelKey: string
  readonly stream: boolean
  readonly runtimeLocation: 'bun' | 'cloudflare'
  /** See PerformanceOperation. Absent for request-level rows. */
  readonly operation?: PerformanceOperation
}

export interface EventResultMetadata {
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
}

/**
 * Context passed to `LlmEventResult.translateBody` when a translator is reused for
 * non-streaming JSON envelopes (e.g. `gemini → responses` countTokens).
 */
export interface TranslateBodyContext {
  readonly signal?: AbortSignal
  readonly fallbackMaxOutputTokens?: number
  readonly model?: string
  /**
   * Original client-side request payload. Threaded through cross-protocol
   * `translateBody` so the hub→client envelope mapper can echo request-side
   * fields the upstream never returned (e.g. responses-via-chat needs
   * `instructions`, `metadata`, `parallel_tool_calls`, `tool_choice`, `tools`,
   * `temperature`, `top_p` — all stripped during the client→hub translation
   * and absent from the chat-completion body the hub returns).
   * Same-protocol attempts leave this undefined.
   */
  readonly sourcePayload?: Record<string, unknown>
}

export interface LlmEventResultMetadata {
  readonly type: 'events'
  /** Release the concrete upstream body if this result is rejected before iteration. */
  readonly discardProducer?: () => void | Promise<void>
  readonly modelIdentity: TelemetryModelIdentity
  /**
   * Resolves an upstream-reported model key into this attempt's public model,
   * provider and price identity. This stays runtime-only; it is never part of
   * a persisted telemetry payload.
   */
  readonly resolveModelIdentity?: (modelKey: string) => TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
  /** Set by an interceptor when it replaces the upstream event stream. */
  readonly __interceptorReplaced?: true
  readonly finalMetadata?: Promise<EventResultMetadata>
  /** Convert the complete producer JSON envelope to the source protocol. */
  readonly translateBody?: (
    hubJson: unknown,
    ctx: TranslateBodyContext,
  ) => unknown | Promise<unknown>
  /** Map bare producer events to bare source events lazily. `events` itself
   * retains ProtocolFrame wrappers in the producer domain. JSON consumers use
   * translateBody independently; they never synthesize a body via this adapter. */
  readonly translateEvents?: (
    events: AsyncIterable<unknown>,
    ctx: TranslateBodyContext,
  ) => AsyncIterable<unknown>
}

/** Native frames have the endpoint-declared type. No telemetry field selects
 * their parser or collector. Legacy constructors remain native. */
export interface NativeLlmEventResult<T> extends LlmEventResultMetadata {
  readonly producer?: undefined
  readonly translateBody?: undefined
  readonly translateEvents?: undefined
  readonly events: AsyncIterable<T>
}

/** A translated attempt still owns hub frames. The source adapter chooses
 * exactly one lazy body/event conversion; the frames are never typed as source. */
export interface TranslatedLlmEventResult extends LlmEventResultMetadata {
  readonly producer: {
    readonly kind: 'translated'
    readonly source: TranslatorProtocol
    readonly protocol: TranslatorProtocol
  }
  readonly events: AsyncIterable<ProtocolFrame<unknown>>
  readonly translateBody: NonNullable<LlmEventResultMetadata['translateBody']>
  readonly translateEvents: NonNullable<LlmEventResultMetadata['translateEvents']>
}

export type LlmEventResult<T> = NativeLlmEventResult<T> | TranslatedLlmEventResult

/** Validate the runtime boundary without consulting mutable telemetry. */
export function eventProducerProtocol<T>(result: LlmEventResult<T>, source: TranslatorProtocol): TranslatorProtocol {
  const producer = result.producer
  if (!producer) {
    if (result.translateBody || result.translateEvents) throw new Error('Translated event result is missing its producer domain')
    return source
  }
  if (producer.kind !== 'translated' || producer.source !== source
    || !['chat_completions', 'messages', 'responses'].includes(producer.protocol)
    || typeof result.translateBody !== 'function' || typeof result.translateEvents !== 'function') {
    throw new Error('Invalid translated event producer domain')
  }
  return producer.protocol
}

/** Native-only attempt chains fail explicitly if a translated result leaks in. */
export function assertNativeEventResult<T>(result: LlmEventResult<T>): asserts result is NativeLlmEventResult<T> {
  if (result.producer || result.translateBody || result.translateEvents) throw new Error('Native interceptor received a translated event producer')
}

export interface UpstreamErrorResult {
  readonly type: 'upstream-error'
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
  readonly performance?: PerformanceTelemetryContext
  /** Actual protocol reached after cross-protocol translation, when known. */
  readonly targetApi?: 'messages' | 'responses' | 'chat-completions'
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

export type LlmExecuteResult<T> =
  | LlmEventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult

export const llmEventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
  translateBody?: undefined,
  translateEvents?: undefined,
  resolveModelIdentity?: LlmEventResult<T>['resolveModelIdentity'],
): NativeLlmEventResult<T> => ({
  type: 'events',
  events,
  modelIdentity,
  performance,
  finalMetadata,
  translateBody,
  translateEvents,
  resolveModelIdentity,
})

export const llmInternalErrorResult = (
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
