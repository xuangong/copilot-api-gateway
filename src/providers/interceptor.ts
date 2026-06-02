import type { EndpointKey } from "~/protocols/common"

/**
 * Mutable snapshot of a single proxy request. Interceptors read and write
 * this object; mutations are visible to every subsequent interceptor and to
 * the terminal handler because all parties share the same reference.
 *
 * WHY mutable: the primary job of interceptors is header/payload rewriting
 * before the request is forwarded upstream. Immutable snapshots would require
 * each interceptor to return a new copy, making the signature asymmetric with
 * the response side and complicating future two-way (request + response) wrappers.
 */
export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  /** Which public API surface produced this invocation, if known. */
  readonly sourceApi?: "messages" | "chat_completions" | "responses"
  /** Mutable request body — interceptors may add, remove, or rename fields. */
  payload: Record<string, unknown>
  /** Mutable outbound headers — interceptors may inject auth tokens, tracing IDs, etc. */
  headers: Record<string, string>
}

/**
 * Immutable ambient data about the in-flight HTTP request that interceptors
 * may read for timing or cancellation but must never modify.
 *
 * WHY separate from Invocation: keeping read-only ambient context separate from
 * mutable invocation data makes it obvious at the type level which fields are
 * safe to cache (context) vs which might change mid-chain (invocation).
 */
export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
}

/**
 * Thunk that advances the chain to the next interceptor (or to the terminal
 * handler when the current interceptor is last). Calling it zero times
 * short-circuits; calling it more than once is allowed but typically unwise.
 */
export type InterceptorRun<R> = () => Promise<R>

/**
 * A single unit of middleware in the interceptor chain.
 *
 * @param inv  - Mutable invocation; mutate before calling `run()` to affect
 *               downstream interceptors and the terminal handler.
 * @param ctx  - Immutable ambient request context.
 * @param run  - Advance the chain. Await its result to wrap the response side.
 *               Skip calling it to short-circuit.
 *
 * WHY Koa-style (not Express-style): returning a value (rather than writing
 * to `res`) enables clean response wrapping via `const r = await run(); return transform(r)`
 * without shared mutable state on a response object.
 */
export type Interceptor<TInv, TCtx, R> = (
  inv: TInv,
  ctx: TCtx,
  run: InterceptorRun<R>,
) => Promise<R>

/**
 * Compose and execute a chain of interceptors followed by a terminal handler.
 *
 * Interceptors run in array order (index 0 first). Each receives a `run`
 * thunk that, when called, invokes the next interceptor in the chain; the
 * last interceptor's `run` invokes `terminal`.
 *
 * @example
 * ```ts
 * const response = await runInterceptors(inv, ctx, [authInject, traceInject], fetchUpstream)
 * ```
 */
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

/**
 * Concrete interceptor type for the Copilot provider pipeline.
 * Use this alias when writing interceptors that operate on the full
 * `Invocation` + `RequestContext` → `Response` contract.
 */
export type CopilotInterceptor = Interceptor<Invocation, RequestContext, Response>
