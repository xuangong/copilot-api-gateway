// packages/protocols/src/common/result.ts
import type { ModelPricing } from './index.ts'

export interface TelemetryModelIdentity {
  readonly model: string
  readonly upstream: string
  readonly modelKey: string
  readonly cost: ModelPricing | null
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

export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
  readonly modelIdentity: TelemetryModelIdentity
  readonly performance?: PerformanceTelemetryContext
  readonly finalMetadata?: Promise<EventResultMetadata>
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
): EventResult<T> => ({
  type: 'events',
  events,
  modelIdentity,
  performance,
  finalMetadata,
})

export const internalErrorResult = (
  status: number,
  error: Error,
  performance?: PerformanceTelemetryContext,
): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  performance,
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
