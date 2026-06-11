/**
 * Interceptor runner — Koa-style middleware chain.
 *
 * Generic `runInterceptors` plus the gateway's per-request typedefs
 * (`Invocation`, `RequestContext`, `CopilotInterceptor`). Providers compose
 * payload/header rewrites by stacking `CopilotInterceptor` functions; the
 * terminal handler issues the upstream fetch.
 */
import type { EndpointKey } from '@vnext/protocols/common'

/**
 * Mutable snapshot of a single proxy request. Interceptors read and write
 * this object; mutations are visible to every subsequent interceptor and to
 * the terminal handler because all parties share the same reference.
 */
export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  readonly sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  payload: Record<string, unknown>
  headers: Record<string, string>
}

export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
}

export type InterceptorRun<R> = () => Promise<R>

export type Interceptor<TInv, TCtx, R> = (
  inv: TInv,
  ctx: TCtx,
  run: InterceptorRun<R>,
) => Promise<R>

export const runInterceptors = async <TInv, TCtx, R>(
  inv: TInv,
  ctx: TCtx,
  interceptors: readonly Interceptor<TInv, TCtx, R>[],
  terminal: InterceptorRun<R>,
): Promise<R> => {
  const run = (index: number): Promise<R> =>
    index < interceptors.length
      ? interceptors[index]!(inv, ctx, () => run(index + 1))
      : terminal()
  return run(0)
}

export type CopilotInterceptor = Interceptor<Invocation, RequestContext, Response>
