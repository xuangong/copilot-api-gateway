// packages/protocols/src/common/result.ts
export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
}

export interface UpstreamErrorResult {
  readonly type: 'upstream-error'
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
}

export interface InternalErrorResult {
  readonly type: 'internal-error'
  readonly status: number
  readonly error: Error
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult

export const eventResult = <T>(events: AsyncIterable<T>): EventResult<T> => ({
  type: 'events',
  events,
})

export const internalErrorResult = (status: number, error: Error): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
})

export const readUpstreamError = async (response: Response): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
})

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  })

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string =>
  new TextDecoder().decode(error.body)
