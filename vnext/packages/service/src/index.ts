/**
 * Domain-neutral around-middleware.
 * Charter §4.1 Contract A (with Spec 7 deviation noted below).
 *
 * NOTE on `next` arity: Charter §4.1 ideal form is `next: (req: Req) => Promise<Result>`,
 * propagating a fresh req down the chain. Current code uses `next: () => Promise<Result>`
 * and mutates shared invocation state. Spec 7 keeps zero-behavior-change: `next` stays
 * `() => Promise<Result>`. Migrating to req-propagation is a separate future spec
 * (breaks all existing interceptor implementations; requires Invocation immutability).
 */
export type Interceptor<Ctx, Req, Result> = (
  req: Req,
  ctx: Ctx,
  next: () => Promise<Result>,
) => Promise<Result>

/**
 * Service interface placeholder. Real terminal-handler wrapping
 * deferred to Spec 10 (chat-flow Codec convergence).
 */
export interface Service<Ctx, Req, Result> {
  invoke(req: Req, ctx: Ctx): Promise<Result>
}

export type Next<R> = () => Promise<R>

/**
 * Compose an interceptor chain with a terminal handler and run it.
 * Behaviorally identical to the legacy runInterceptors helper that previously
 * lived in the interceptor package; only the generic parameter order changes
 * to <Ctx, Req, R>.
 */
export const runInterceptors = async <Ctx, Req, R>(
  req: Req,
  ctx: Ctx,
  interceptors: readonly Interceptor<Ctx, Req, R>[],
  terminal: Next<R>,
): Promise<R> => {
  const run = (index: number): Promise<R> =>
    index < interceptors.length
      ? interceptors[index]!(req, ctx, () => run(index + 1))
      : terminal()
  return run(0)
}
